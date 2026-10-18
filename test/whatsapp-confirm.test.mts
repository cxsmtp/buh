/**
 * BUH-02.09: "Confirm on WhatsApp", with no WhatsApp API. The server makes a 4-digit code with
 * each order (only when the shop has a WhatsApp number and the setting is on), the customer's
 * wa.me link carries the order number and code, the owner's confirm / mismatch is idempotent
 * and audited, "hold until confirmed" really holds, the customer's "opened" note can't touch
 * another order, the migration only adds, and backups keep it all.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const orders = await import('@/lib/server/orders');
const { dispatchOrder } = await import('@/lib/server/dispatch');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings } = await import('@/lib/server/settings');
const { getDb } = await import('@/lib/server/db');
const wa = await import('@/lib/whatsappConfirm');

let n = 0;
function place(phone = `+9715030${String(++n).padStart(5, '0')}`) {
  const p = listProducts()[0];
  return orders.placeOrder({
    idempotencyKey: `wa-test-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Mariam Test', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
}
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
const store = (s: Record<string, unknown>) => updateSettings('store', s);
const column = (id: string) => getDb().prepare('SELECT data, wa_code, phone_check, wa_hold, wa_opened_at, phone_checked_at, phone_checked_by FROM orders WHERE id = ?').get(id) as Record<string, string | number | null>;

/** Everything printed while fn runs (console), to check the code never reaches the logs. */
async function captured<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(saved) as Array<keyof typeof saved>) console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('the wa.me link: the shop number’s digits, the order number and code, URL-encoded (Arabic and emoji safe)', () => {
  const link = wa.confirmLink('+971 50 123-4567', 'BUH-261018-ABC234', '0427')!;
  assert.ok(link.startsWith('https://wa.me/971501234567?text='), link);
  const text = decodeURIComponent(new URL(link).search.slice('?text='.length));
  assert.equal(text, 'Confirm my order BUH-261018-ABC234 · code 0427');
  assert.ok(!/[\s·]/.test(link), 'no raw spaces or "·" in the link');
  const tricky = 'تم تأكيد طلبك ✓ 🛏️ & #1 + 100% ?x=1';
  const l2 = wa.waMeLink('+971501234567', tricky)!;
  assert.equal(new URL(l2).searchParams.get('text'), tricky, 'URLSearchParams reads back exactly what was written');
  assert.equal(decodeURIComponent(l2.split('?text=')[1]), tricky);
  assert.ok(!/[ &#+]/.test(l2.split('?text=')[1]), 'reserved characters are escaped');
  assert.equal(wa.waMeLink('', 'x'), null, 'no number, no link');
  assert.equal(wa.waMeLink('abc', 'x'), null);
  assert.match(wa.confirmedReply('BUH-1'), /^Thank you, your order BUH-1 is confirmed ✓$/);
});

test('no WhatsApp number: nothing is asked; number set but switched off: nothing either', async () => {
  await store({ whatsappNumber: '' });
  const a = place();
  assert.equal(a.whatsappCheck, undefined);
  assert.equal(column(a.id).phone_check, 'none');
  assert.equal(column(a.id).wa_code, null);
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: false });
  const b = place();
  assert.equal(b.whatsappCheck, undefined);
  assert.equal(column(b.id).phone_check, 'none');
  assert.equal(orders.customerView(b).whatsappCheck, undefined);
});

test('on by default once a number is set: a 4-digit server code, stored in its own columns, never in the order JSON or the logs', async () => {
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: true, holdUntilWhatsAppConfirmed: false });
  const { value: o, lines } = await captured(() => place());
  const check = o.whatsappCheck!;
  assert.equal(check.status, 'awaiting');
  assert.match(check.code, /^\d{4}$/);
  assert.equal(check.hold, false);
  const row = column(o.id);
  assert.equal(row.wa_code, check.code);
  assert.equal(row.phone_check, 'awaiting');
  assert.ok(!('whatsappCheck' in JSON.parse(String(row.data))), 'not in the JSON');
  assert.deepEqual(orders.getOrder(o.id)!.whatsappCheck, check);
  assert.deepEqual(orders.customerView(o).whatsappCheck, { status: 'awaiting', code: check.code, hold: false });
  assert.ok(!lines.some((l) => l.includes(`code ${check.code}`) || l.includes(`"${check.code}"`)), lines.join('\n'));
  // The order's own events don't carry it either.
  assert.ok(!JSON.stringify(orders.orderEvents(o.id)).includes(`"${check.code}"`));
  assert.deepEqual(orders.orderEvents(o.id).map((e) => e.event), ['created', 'whatsapp_asked']);
  // Random (crypto), not one code for everyone.
  const codes = new Set(Array.from({ length: 12 }, () => place().whatsappCheck!.code));
  assert.ok(codes.size > 3, `${codes.size} different codes`);
  assert.ok(fs.readFileSync('src/lib/server/orders.ts', 'utf8').includes('crypto.randomInt(0, 10_000)'), 'crypto, not Math.random');
});

test('Track Order shows the check to whoever has the order number and phone', async () => {
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: true });
  const o = place('+971504440001');
  assert.deepEqual(orders.lookupOrder(o.id, '+971504440001')!.whatsappCheck, { status: 'awaiting', code: o.whatsappCheck!.code, hold: false });
  assert.equal(orders.lookupOrder(o.id, '+971504440002'), null);
});

test('confirm / mismatch: idempotent (a second tap changes nothing), audited, unknown order 404, order never asked 409', async () => {
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: true });
  const o = place();
  const before = auditEntries().length;
  const { value: first, lines } = await captured(() => orders.checkWhatsApp(o.id, 'confirmed', 'owner@shop.test'));
  assert.equal(first.changed, true);
  assert.equal(first.order.whatsappCheck!.status, 'confirmed');
  assert.equal(first.order.whatsappCheck!.checkedBy, 'owner@shop.test');
  assert.ok(first.order.whatsappCheck!.checkedAt);
  assert.ok(!lines.some((l) => l.includes(o.whatsappCheck!.code)));
  const again = orders.checkWhatsApp(o.id, 'confirmed', 'someone-else@shop.test');
  assert.equal(again.changed, false);
  assert.equal(again.order.whatsappCheck!.checkedBy, 'owner@shop.test', 'the second tap changed nothing');
  const audited = auditEntries().slice(before);
  assert.equal(audited.length, 1, 'one audit entry for one change');
  assert.equal(audited[0].action, 'order.whatsapp_confirmed');
  assert.equal(audited[0].details.orderId, o.id);
  assert.ok(!JSON.stringify(audited[0]).includes(`"${o.whatsappCheck!.code}"`), 'no code in the audit log');
  assert.deepEqual(orders.orderEvents(o.id).map((e) => e.event), ['created', 'whatsapp_asked', 'whatsapp_confirmed']);

  const m = place();
  assert.equal(orders.checkWhatsApp(m.id, 'mismatch', 'owner@shop.test').order.whatsappCheck!.status, 'mismatch');
  assert.equal(orders.checkWhatsApp(m.id, 'mismatch', 'owner@shop.test').changed, false);
  assert.equal(orders.checkWhatsApp(m.id, 'confirmed', 'owner@shop.test').changed, true, 'a mismatch can be corrected');

  assert.equal(await status(() => orders.checkWhatsApp('BUH-000000-NOSUCH', 'confirmed', 'x')), 404);
  await store({ confirmOrdersOnWhatsApp: false });
  assert.equal(await status(() => orders.checkWhatsApp(place().id, 'confirmed', 'x')), 409);
});

test('hold until confirmed: the order can’t be confirmed or booked until then (cancel still works), then it is released', async () => {
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: true, holdUntilWhatsAppConfirmed: true });
  const o = place();
  assert.equal(o.whatsappCheck!.hold, true);
  assert.equal(o.status, 'pending_confirmation');
  assert.equal(await status(() => orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, 'owner')), 409);
  assert.equal(await status(() => dispatchOrder({ orderId: o.id, provider: 'jeebly', rebook: false, actor: 'owner' })), 409, 'no courier booking');
  assert.equal(orders.getOrder(o.id)!.courier.awbNumber, '', 'nothing booked');
  // A mismatch keeps it held.
  orders.checkWhatsApp(o.id, 'mismatch', 'owner');
  assert.equal(await status(() => orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, 'owner')), 409);
  orders.checkWhatsApp(o.id, 'confirmed', 'owner');
  assert.equal(orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, 'owner').status, 'confirmed', 'released');
  // Cancelling a held order is always possible.
  const c = place();
  assert.equal(orders.updateOrderByAdmin(c.id, { status: 'cancelled' }, 'owner').status, 'cancelled');
  // Off: orders go through as before.
  await store({ holdUntilWhatsAppConfirmed: false });
  const free = place();
  assert.equal(orders.updateOrderByAdmin(free.id, { status: 'confirmed' }, 'owner').status, 'confirmed');
});

test('"Customer opened WhatsApp": only with the order’s own phone, once, and never another order', async () => {
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: true, holdUntilWhatsAppConfirmed: false });
  const mine = place('+971505550001');
  const theirs = place('+971505550002');
  assert.equal(orders.markWhatsAppOpened(theirs.id, '+971505550001'), false, 'my phone does not open their order');
  assert.equal(column(theirs.id).wa_opened_at, null);
  assert.equal(orders.markWhatsAppOpened(mine.id, '+971505550001'), true);
  assert.equal(orders.markWhatsAppOpened(mine.id.toLowerCase(), '+971505550001'), false, 'once');
  assert.ok(column(mine.id).wa_opened_at);
  assert.equal(column(theirs.id).wa_opened_at, null);
  assert.ok(orders.getOrder(mine.id)!.whatsappCheck!.openedAt);
  assert.ok(orders.orderEvents(mine.id).some((e) => e.event === 'whatsapp_opened'));
  // Only the opened time: status and code untouched.
  assert.equal(column(mine.id).phone_check, 'awaiting');
  assert.equal(column(mine.id).wa_code, mine.whatsappCheck!.code);
});

test('the awaiting count and the daily summary line', async () => {
  const { dailySummary } = await import('@/lib/server/monitor');
  const n0 = orders.awaitingWhatsAppCount();
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: true });
  place();
  assert.equal(orders.awaitingWhatsAppCount(), n0 + 1);
  assert.match(dailySummary().text, new RegExp(`Waiting for the customer's WhatsApp message: ${n0 + 1}\\.`));
});

test('migration 8 only adds (columns and an index); an older shop’s orders upgrade as "none"', () => {
  const src = fs.readFileSync('src/lib/server/db.ts', 'utf8');
  const m8 = src.slice(src.indexOf('// 8: "Confirm on WhatsApp"'), src.indexOf('];', src.indexOf('// 8: "Confirm on WhatsApp"')));
  const statements = m8.slice(m8.indexOf('db.exec(`') + 9, m8.indexOf('`);')).split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  assert.ok(statements.length >= 6);
  for (const s of statements) assert.match(s, /^(ALTER TABLE orders ADD COLUMN|CREATE INDEX)/, s);

  // A database at version 7 with one order: after the upgrade, the order is intact and "none".
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-wa-upgrade-'));
  const run = (code: string) => spawnSync(process.execPath, ['--import', 'tsx', '-e', `process.env.DATA_DIR=${JSON.stringify(old)}; ${code}`], { encoding: 'utf8' });
  const seven = run(`const m = await import('@/lib/server/db'); const db = (m.getDb ?? m.default.getDb)(); console.log(db.pragma('user_version', { simple: true }));`);
  assert.equal(seven.status, 0, seven.stderr);
  const db = new Database(path.join(old, 'shop.db'));
  // Recreate the version-7 orders table (drop the new columns) and put an old order in.
  db.exec(`DROP INDEX orders_awaiting_whatsapp; ${['wa_code', 'phone_check', 'wa_hold', 'wa_opened_at', 'phone_checked_at', 'phone_checked_by'].map((c) => `ALTER TABLE orders DROP COLUMN ${c};`).join(' ')}`);
  db.prepare("INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, data) VALUES ('BUH-OLD-1', '2026-01-01', '2026-01-01', '+971501234567', 'delivered', 'cod', 'paid', 100, '{\"id\":\"BUH-OLD-1\"}')").run();
  db.pragma('user_version = 7');
  db.close();
  const up = run(`const m = await import('@/lib/server/db'); const db = (m.getDb ?? m.default.getDb)(); console.log(JSON.stringify({ v: db.pragma('user_version', { simple: true }), row: db.prepare("SELECT id, status, data, phone_check, wa_code, wa_hold FROM orders WHERE id = 'BUH-OLD-1'").get() }));`);
  assert.equal(up.status, 0, up.stderr);
  const out = JSON.parse(up.stdout.trim().split('\n').pop()!);
  assert.equal(out.v, 8);
  assert.deepEqual(out.row, { id: 'BUH-OLD-1', status: 'delivered', data: '{"id":"BUH-OLD-1"}', phone_check: 'none', wa_code: null, wa_hold: 0 });
});

test('a backup keeps the confirmation (database and orders.csv), and the restore script restores it', async () => {
  await store({ whatsappNumber: '+971501112233', confirmOrdersOnWhatsApp: true, holdUntilWhatsAppConfirmed: true });
  const confirmed = place();
  orders.checkWhatsApp(confirmed.id, 'confirmed', 'owner@shop.test');
  const awaiting = place('+971506660001');
  orders.markWhatsAppOpened(awaiting.id, '+971506660001');
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const csv = result.csv.find((c) => c.name === 'orders.csv')!.data.toString('utf8');
  const header = csv.split('\r\n')[0] || csv.split('\n')[0];
  assert.match(header, /whatsapp_check,whatsapp_checked_at,whatsapp_checked_by/);
  const line = csv.split(/\r?\n/).find((l) => l.includes(confirmed.id))!;
  assert.match(line, /,confirmed,[^,]+,owner@shop\.test/);

  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-wa-restore-'));
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const restored = new Database(path.join(target, 'shop.db'), { readonly: true });
  const get = (id: string) => restored.prepare('SELECT wa_code, phone_check, wa_hold, wa_opened_at, phone_checked_by FROM orders WHERE id = ?').get(id) as Record<string, unknown>;
  assert.deepEqual(get(confirmed.id), { wa_code: confirmed.whatsappCheck!.code, phone_check: 'confirmed', wa_hold: 1, wa_opened_at: null, phone_checked_by: 'owner@shop.test' });
  const a = get(awaiting.id);
  assert.equal(a.phone_check, 'awaiting');
  assert.equal(a.wa_code, awaiting.whatsappCheck!.code);
  assert.ok(a.wa_opened_at, 'the opened time survives');
  restored.close();
});
