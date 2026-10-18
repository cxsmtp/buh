/**
 * Review of Settings → Phone check "WhatsApp (free)" (no code costs an attacker anything, so an
 * order no code proved must not be able to hold the catalogue):
 *  - such an order gets the small bag (at most 2 of each item, 5 lines), and orders not yet
 *    confirmed hold at most half of any size's pieces (at least 2): beyond it, a polite refusal;
 *  - an order whose customer never opened WhatsApp is cancelled sooner (default 6 h), audited;
 *  - IPv6 connections are counted by their /64; without TRUST_PROXY the shop cap is stricter;
 *    near the cap (80%), or when it refuses someone, the owner is alerted and the monitor says so;
 *  - a bank transfer is never auto-cancelled (flagged instead: see phone-check.test.mts);
 *  - the owner can't confirm an order the sweep (or they) cancelled, or a delivered one, and can
 *    correct a wrong number later (audited, the old one kept; Track Order takes any of them);
 *  - "ship anyway" stops the auto-cancel, and its audit entry never outlives a rollback;
 *  - bank-details emails are limited per address and per connection;
 *  - a shop with an SMS gateway that never chose a phone check gets a one-time notice.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY', 'SMS_WEBHOOK_URL', 'TWILIO_ACCOUNT_SID', 'INFOBIP_API_KEY']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const settings = await import('@/lib/server/settings');
const products = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getDb } = await import('@/lib/server/db');
const { currentProblems } = await import('@/lib/server/monitor');
const { updateSettings } = settings;

const SHOP_WA = '+971501112244';
await updateSettings('bank', { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' });
await updateSettings('store', { whatsappNumber: SHOP_WA, confirmOrdersOnWhatsApp: false, holdUntilWhatsAppConfirmed: false });

let n = 0;
const nextPhone = () => `+9715270${String(++n).padStart(5, '0')}`;
type Item = { productId: string; profileId: string; quantity: number };
function place(over: Record<string, unknown> = {}, opts: { phone?: string; ip?: string | null; token?: boolean; items?: Item[] } = {}) {
  const p = products.listProducts()[0];
  const phone = opts.phone ?? nextPhone();
  const { customer: extra, ...rest } = over;
  return orders.placeOrder(
    {
      idempotencyKey: `pcr-test-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...(opts.token ? { verificationToken: issuePhoneToken(phone) } : {}),
      customer: { fullName: 'Noor Test', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7', ...((extra as object) ?? {}) },
      items: opts.items ?? [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...rest,
    },
    { ip: opts.ip === undefined ? `10.1.${n % 250}.${(n * 7) % 250}` : opts.ip }
  ).order;
}
const refusal = (fn: () => unknown): { status: number; code: string; message: string } => {
  try {
    fn();
  } catch (e) {
    const err = e as { status?: number; message: string; details?: { code?: string } };
    return { status: err.status ?? -1, code: String(err.details?.code ?? ''), message: err.message };
  }
  return { status: 0, code: '', message: '' };
};
const stockOf = (productId: string, sizeId: string) => getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').pluck().get(productId, sizeId) as number;
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
function closeOpen() {
  for (const o of orders.listOrders({ status: 'pending_confirmation', limit: 2000 })) orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, 'test');
}
const H = 3600_000;

test('an order no code proved gets the small bag: at most 2 of each item and 5 lines; a code-proven order does not', () => {
  closeOpen();
  const [a, b] = products.listProducts();
  const size = a.profiles[0].id;
  const three = refusal(() => place({}, { items: [{ productId: a.id, profileId: size, quantity: 3 }] }));
  assert.equal(three.status, 400);
  assert.equal(three.code, 'unconfirmed_bag_limit');
  assert.match(three.message, /At most 2 of each item per order until we have confirmed your number/);
  const split = refusal(() => place({}, { items: [{ productId: a.id, profileId: size, quantity: 2 }, { productId: a.id, profileId: size, quantity: 1 }] }));
  assert.equal(split.code, 'unconfirmed_bag_limit', 'the same size over two lines counts together');
  const lines = Array.from({ length: 6 }, (_, i) => ({ productId: [a, b][i % 2].id, profileId: [a, b][i % 2].profiles[Math.floor(i / 2)]?.id ?? size, quantity: 1 }));
  assert.equal(refusal(() => place({}, { items: lines })).code, 'unconfirmed_bag_limit', '6 lines');
  assert.equal(place({}, { items: [{ productId: a.id, profileId: size, quantity: 2 }] }).items[0].quantity, 2, '2 is fine');
  assert.equal(place({}, { token: true, items: [{ productId: a.id, profileId: size, quantity: 3 }] }).items[0].quantity, 3, 'a proven phone: the usual bag');
  closeOpen();
});

test('orders not yet confirmed hold at most half of a size’s pieces (at least 2): beyond it a polite refusal; confirming frees it', () => {
  closeOpen();
  const p = products.listProducts()[1];
  const size = p.profiles[0].id;
  products.updateProduct(p.id, { stockBySize: { ...p.stockBySize, [size]: 4 } });
  const items = (quantity: number) => [{ productId: p.id, profileId: size, quantity }];
  const first = place({}, { items: items(2) });
  const busy = refusal(() => place({}, { items: items(1) }));
  assert.equal(busy.status, 409);
  assert.equal(busy.code, 'popular_piece');
  assert.match(busy.message, /^This piece is very popular right now — please message us on WhatsApp/);
  assert.equal(stockOf(p.id, size), 2, 'nothing taken by the refused one');
  assert.ok(place({}, { token: true, items: items(1) }).id, 'a proven phone is not held back');
  // Confirmed (here by phone call): it no longer counts.
  orders.checkWhatsApp(first.id, 'call', 'owner@shop.test');
  assert.ok(place({}, { items: items(1) }).id);
  // A one-of-a-kind piece can still be ordered (at least 2 may be held).
  products.updateProduct(p.id, { stockBySize: { ...p.stockBySize, [size]: 1 } });
  closeOpen();
  products.updateProduct(p.id, { stockBySize: { ...p.stockBySize, [size]: 1 } });
  assert.ok(place({}, { items: items(1) }).id, 'the last piece');
  closeOpen();
  products.updateProduct(p.id, { stockBySize: { ...p.stockBySize, [size]: 50 } });
});

test('never opened WhatsApp: cancelled sooner (default 6 h), audited, pieces back; opened: the full hours; the setting is validated', async () => {
  closeOpen();
  assert.equal(settings.getSettings('phoneCheck').unopenedCancelHours, 6, 'the default');
  const p = products.listProducts()[0];
  const size = p.profiles[0].id;
  const start = stockOf(p.id, size);
  const quiet = place();
  const opened = place();
  assert.ok(Math.abs(Date.parse(quiet.whatsappCheck!.openBy!) - Date.parse(quiet.createdAt) - 6 * H) < 60_000, 'openBy in 6 h');
  assert.equal(orders.customerView(quiet).whatsappCheck?.openBy, quiet.whatsappCheck!.openBy, 'the customer is told');
  assert.equal(orders.markWhatsAppOpened(opened.id, opened.customer.phone), true);
  assert.equal(orders.getOrder(opened.id)!.whatsappCheck!.openBy, undefined, 'opened: no sooner deadline');
  const before = auditEntries().length;
  assert.equal(orders.sweepUnconfirmedOrders(Date.now() + 6 * H + 60_000), 1);
  assert.equal(orders.getOrder(quiet.id)!.status, 'cancelled');
  assert.equal(orders.getOrder(opened.id)!.status, 'pending_confirmation', 'opened: waits for the full 24 h');
  assert.equal(stockOf(p.id, size), start - 1, 'its piece back, once');
  const added = auditEntries().slice(before);
  assert.deepEqual(added.map((e) => [e.action, e.details.orderId, e.details.why, e.details.hours]), [['order.auto_cancelled_unconfirmed', quiet.id, 'whatsapp_never_opened', 6]]);
  assert.ok(orders.orderEvents(quiet.id).some((e) => e.event === 'auto_cancelled_unopened'));
  assert.equal(orders.sweepUnconfirmedOrders(Date.now() + 6 * H + 60_000), 0, 'once');
  assert.equal(orders.sweepUnconfirmedOrders(Date.now() + 24 * H + 60_000), 1, 'the opened one at 24 h');
  // A bank transfer never gets the sooner deadline (it is never auto-cancelled).
  assert.equal(place({ paymentMethod: 'bank_transfer' }).whatsappCheck!.openBy, undefined);
  // Validated: 2 to 48, never later than the main hours (typed later: refused; the main hours lowered: brought down).
  for (const bad of [{ unopenedCancelHours: 1 }, { unopenedCancelHours: 49 }, { unopenedCancelHours: 2.5 }, { unopenedCancelHours: 'soon' }, { unconfirmedCancelHours: 4, unopenedCancelHours: 5 }]) {
    assert.equal(await statusOf(() => updateSettings('phoneCheck', bad)), 400, JSON.stringify(bad));
  }
  await updateSettings('phoneCheck', { unconfirmedCancelHours: 4 });
  assert.equal(settings.getSettings('phoneCheck').unopenedCancelHours, 4);
  await updateSettings('phoneCheck', { unconfirmedCancelHours: 24, unopenedCancelHours: 6 });
  closeOpen();
});
async function statusOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

test('IPv6 connections are counted by their /64 (one home can pick any address in it)', () => {
  const key = orders.connectionKey;
  assert.equal(key('2001:db8:1:2:aaaa::1'), key('2001:0db8:0001:0002:bbbb:cccc:dddd:eeee'));
  assert.equal(key('2001:db8:1:2::'), '2001:db8:1:2::/64');
  assert.notEqual(key('2001:db8:1:2::1'), key('2001:db8:1:3::1'));
  assert.equal(key('::ffff:10.1.2.3'), '10.1.2.3', 'IPv4-mapped is its IPv4 address');
  assert.equal(key('[2001:db8:1:2::9]'), key('2001:db8:1:2::8'));
  assert.equal(key('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(key('10.0.0.1'), '10.0.0.1');
  closeOpen();
  for (let i = 0; i < orders.UNCONFIRMED_LIMITS.perIp; i++) place({}, { ip: `2001:db8:77:1:${i + 1}::${i + 7}` });
  assert.equal(refusal(() => place({}, { ip: '2001:db8:77:1:ffff::1' })).code, 'unconfirmed_limit', 'another address in the same /64');
  assert.ok(place({}, { ip: '2001:db8:77:2::1' }).id, 'another /64 is fine');
  closeOpen();
});

test('without TRUST_PROXY (no address): a stricter shop cap; Settings → Phone check is told', () => {
  closeOpen();
  const saved = orders.UNCONFIRMED_LIMITS.shopNoProxy;
  orders.UNCONFIRMED_LIMITS.shopNoProxy = 2;
  try {
    assert.equal(orders.UNCONFIRMED_LIMITS.shopNoProxy < orders.UNCONFIRMED_LIMITS.shop, true);
    place({}, { ip: null });
    place({}, { ip: null });
    assert.equal(refusal(() => place({}, { ip: null })).code, 'shop_busy', 'no address: the stricter cap');
    assert.ok(place({}, { ip: '10.77.0.1' }).id, 'with an address: the usual cap');
  } finally {
    orders.UNCONFIRMED_LIMITS.shopNoProxy = saved;
  }
  assert.equal(orders.UNCONFIRMED_LIMITS.shopNoProxy, 15);
  assert.equal(settings.behindProxy(), false);
  process.env.TRUST_PROXY = '1';
  assert.equal(settings.behindProxy(), true);
  delete process.env.TRUST_PROXY;
  const card = fs.readFileSync('src/components/admin/settings/PhoneCheckCard.tsx', 'utf8');
  assert.ok(card.includes('Behind no proxy, the shop can&apos;t tell customers apart: limits are stricter'));
  closeOpen();
});

test('near the shop cap (80%) and when it refuses someone: a monitor problem and an owner alert (at most every 6 hours)', () => {
  closeOpen();
  process.env.TRUST_PROXY = '1';
  const saved = orders.UNCONFIRMED_LIMITS.shop;
  orders.UNCONFIRMED_LIMITS.shop = 5;
  try {
    getDb().prepare("DELETE FROM kv WHERE key LIKE 'unconfirmed:%'").run();
    for (let i = 0; i < 3; i++) place();
    assert.equal(currentProblems().some((p) => p.id === 'unconfirmed'), false, '3 of 5: fine');
    assert.equal(getDb().prepare("SELECT COUNT(*) FROM kv WHERE key = 'unconfirmed:near'").pluck().get(), 0, 'no alert yet');
    place(); // 4 of 5 = 80%
    const near = JSON.parse(getDb().prepare("SELECT data FROM kv WHERE key = 'unconfirmed:near'").pluck().get() as string);
    assert.equal(near.open, 4);
    assert.ok(near.alertedAt, 'the owner is alerted');
    const problem = currentProblems().find((p) => p.id === 'unconfirmed');
    assert.match(problem!.text, /^4 orders are waiting for their WhatsApp confirmation \(new ones are refused at 5\)/);
    place();
    assert.equal(JSON.parse(getDb().prepare("SELECT data FROM kv WHERE key = 'unconfirmed:near'").pluck().get() as string).alertedAt, near.alertedAt, 'not alerted again within 6 hours');
    assert.equal(refusal(() => place()).code, 'shop_busy');
    const refused = JSON.parse(getDb().prepare("SELECT data FROM kv WHERE key = 'unconfirmed:refused'").pluck().get() as string);
    assert.ok(refused.alertedAt, 'a refusal is alerted');
    assert.match(currentProblems().find((p) => p.id === 'unconfirmed')!.text, /the cap refused a customer in the last day/);
    refusal(() => place());
    assert.equal(JSON.parse(getDb().prepare("SELECT data FROM kv WHERE key = 'unconfirmed:refused'").pluck().get() as string).alertedAt, refused.alertedAt, 'rate-limited');
  } finally {
    orders.UNCONFIRMED_LIMITS.shop = saved;
    delete process.env.TRUST_PROXY;
  }
  closeOpen();
  getDb().prepare("DELETE FROM kv WHERE key LIKE 'unconfirmed:%'").run();
  assert.equal(currentProblems().some((p) => p.id === 'unconfirmed'), false, 'cleared');
});

test('the owner can’t confirm an order the sweep (or they) cancelled, or a delivered one: 409, nothing changes', () => {
  closeOpen();
  const p = products.listProducts()[0];
  const size = p.profiles[0].id;
  const auto = place();
  orders.sweepUnconfirmedOrders(Date.now() + 25 * H);
  assert.equal(orders.getOrder(auto.id)!.status, 'cancelled');
  const stock = stockOf(p.id, size);
  for (const result of ['confirmed', 'call', 'use_sender'] as const) {
    const r = refusal(() => orders.checkWhatsApp(auto.id, result, 'owner@shop.test', { phone: '0552220001' }));
    assert.equal(r.status, 409, result);
    assert.match(r.message, /^Auto-cancelled at .+ — its pieces are back on sale, so ask the customer to place a new order\.$/, result);
  }
  const after = orders.getOrder(auto.id)!;
  assert.equal(after.whatsappCheck!.status, 'awaiting', 'not confirmed');
  assert.equal(after.customer.phone, auto.customer.phone, 'number unchanged');
  assert.equal(stockOf(p.id, size), stock);
  const byOwner = place();
  orders.updateOrderByAdmin(byOwner.id, { status: 'cancelled' }, 'owner@shop.test');
  assert.match(refusal(() => orders.checkWhatsApp(byOwner.id, 'confirmed', 'owner@shop.test')).message, /is cancelled — ask the customer to place a new order/);
  const delivered = place();
  orders.checkWhatsApp(delivered.id, 'call', 'owner@shop.test');
  for (const s of ['confirmed', 'dispatched', 'delivered']) orders.updateOrderByAdmin(delivered.id, { status: s }, 'owner@shop.test');
  assert.equal(refusal(() => orders.checkWhatsApp(delivered.id, 'call', 'owner@shop.test')).status, 409);
  // "Confirmed by phone call" only for an order still waiting: not a code-proven one.
  const proven = place({}, { token: true });
  assert.equal(refusal(() => orders.checkWhatsApp(proven.id, 'call', 'owner@shop.test')).status, 409);
  closeOpen();
});

test('a wrong number can be corrected after confirming: validated, audited, the old one in the history; Track Order takes any of them', () => {
  closeOpen();
  const o = place({}, { phone: '+971527770001' });
  orders.checkWhatsApp(o.id, 'mismatch', 'owner@shop.test');
  orders.checkWhatsApp(o.id, 'use_sender', 'owner@shop.test', { phone: '055 777 0002' }); // a typo
  assert.equal(refusal(() => orders.checkWhatsApp(o.id, 'correct_phone', 'owner@shop.test', { phone: '04 234 5678' })).status, 400, 'a landline');
  assert.equal(refusal(() => orders.checkWhatsApp(o.id, 'correct_phone', 'owner@shop.test', {})).status, 400);
  const before = auditEntries().length;
  const fixed = orders.checkWhatsApp(o.id, 'correct_phone', 'owner@shop.test', { phone: '٠٥٥٧٧٧٠٠٠٣' });
  assert.equal(fixed.changed, true);
  assert.equal(fixed.order.customer.phone, '+971557770003');
  assert.equal(fixed.order.whatsappCheck!.status, 'confirmed', 'still confirmed');
  assert.equal(getDb().prepare('SELECT phone FROM orders WHERE id = ?').pluck().get(o.id), '+971557770003');
  assert.deepEqual(auditEntries().slice(before).map((e) => [e.action, e.details.from, e.details.to, e.details.why]), [['order.phone_changed', '+971***02', '+971***03', 'owner_correction']], 'masked in the audit log');
  assert.equal(orders.checkWhatsApp(o.id, 'correct_phone', 'owner@shop.test', { phone: '+971557770003' }).changed, false, 'the same again: nothing');
  const history = orders.orderEvents(o.id).filter((e) => e.event === 'phone_changed').map((e) => [e.detail.from, e.detail.to]);
  assert.deepEqual(history, [['+971527770001', '+971557770002'], ['+971557770002', '+971557770003']]);
  for (const phone of ['+971527770001', '+971557770002', '+971557770003']) assert.ok(orders.lookupOrder(o.id, phone), `Track Order with ${phone}`);
  assert.equal(orders.lookupOrder(o.id, '+971557770009'), null, 'never another number');
  orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, 'owner@shop.test');
  assert.equal(refusal(() => orders.checkWhatsApp(o.id, 'correct_phone', 'owner@shop.test', { phone: '0557770004' })).status, 409, 'not on a cancelled order');
  // The hub shows the number the server will store before the owner confirms (same rules).
  const shared = fs.readFileSync('src/components/admin/OrderWhatsAppCheck.tsx', 'utf8');
  assert.ok(shared.includes("from '@/lib/phoneNumber'"));
  closeOpen();
});

test('"ship anyway" stops the auto-cancel in the same audited step (courier, or by hand)', () => {
  closeOpen();
  const o = place();
  orders.assertShipAllowed(o.id, 'owner@shop.test', true);
  assert.equal(orders.sweepUnconfirmedOrders(Date.now() + 25 * H), 0);
  assert.equal(orders.getOrder(o.id)!.status, 'pending_confirmation', 'not cancelled under the courier');
  assert.equal(getDb().prepare('SELECT wa_cancel_at FROM orders WHERE id = ?').pluck().get(o.id), null);
  assert.equal(getDb().prepare('SELECT wa_unopened_cancel_at FROM orders WHERE id = ?').pluck().get(o.id), null);
  const entry = auditEntries().filter((e) => e.action === 'order.ship_unconfirmed').pop()!;
  assert.equal(entry.details.orderId, o.id);
  assert.equal(entry.details.autoCancelStopped, true);
  closeOpen();
});

test('updateOrderByAdmin: the "ship anyway" audit entry never outlives a rollback (a rolled_back note follows it)', () => {
  closeOpen();
  const o = place();
  const before = auditEntries().length;
  const r = refusal(() => orders.updateOrderByAdmin(o.id, { status: 'confirmed', shipUnconfirmed: true, adminNotes: 'x'.repeat(1001) }, 'owner@shop.test'));
  assert.equal(r.status, 400);
  assert.equal(orders.getOrder(o.id)!.status, 'pending_confirmation', 'nothing saved');
  const added = auditEntries().slice(before).map((e) => [e.action, e.details.action ?? null]);
  assert.deepEqual(added, [['order.ship_unconfirmed', null], ['audit.rolled_back', 'order.ship_unconfirmed']]);
  closeOpen();
});

test('bank-details emails: at most 3 a day to one address and 5 a day per connection; a failed send gives its slot back', () => {
  closeOpen();
  const limits = orders.BANK_EMAIL_LIMITS;
  // Code-proven phones, so the caps on unconfirmed orders don't come first.
  const bank = (email: string, ip?: string) => place({ paymentMethod: 'bank_transfer', customer: { email } }, { token: true, ...(ip ? { ip } : {}) });
  const a = [1, 2, 3, 4].map(() => bank('Victim@Example.com'));
  assert.deepEqual(a.slice(0, 3).map((o) => orders.claimBankEmail(o.id)), ['claimed', 'claimed', 'claimed']);
  assert.equal(orders.claimBankEmail(a[3].id), 'limited', 'a 4th to the same address (any case)');
  assert.equal(orders.claimBankEmail(a[0].id), 'already', 'once per order');
  orders.bankEmailDone(a[2].id, false); // failed: not counted
  assert.equal(orders.claimBankEmail(a[3].id), 'claimed');
  const ip = '10.200.0.9';
  const b = Array.from({ length: limits.perConnection + 1 }, (_, i) => bank(`c${i}@example.com`, ip));
  assert.deepEqual(b.map((o) => orders.claimBankEmail(o.id)), [...Array(limits.perConnection).fill('claimed'), 'limited'], 'per connection');
  closeOpen();
});

test('one-time hub notice: an SMS gateway switched on and no phone check ever chosen; gone once dismissed or chosen', async () => {
  getDb().prepare("DELETE FROM settings WHERE key = 'phoneCheck'").run();
  settings._clearSettingsCache();
  assert.equal(settings.phoneCheckNoticeDue(), false, 'no gateway: nothing changed for this shop');
  process.env.SMS_WEBHOOK_URL = 'https://sms.example.com/hook';
  try {
    assert.equal(settings.phoneCheckNoticeDue(), true);
    settings.dismissPhoneCheckNotice();
    assert.equal(settings.phoneCheckNoticeDue(), false, 'dismissed');
    getDb().prepare("DELETE FROM kv WHERE key = 'notice:phone-check-whatsapp'").run();
    assert.equal(settings.phoneCheckNoticeDue(), true);
    await updateSettings('phoneCheck', { mode: 'whatsapp' });
    assert.equal(settings.phoneCheckNoticeDue(), false, 'chosen');
    assert.equal(settings.phoneCheckMode(), 'whatsapp', 'WhatsApp stays the default');
  } finally {
    delete process.env.SMS_WEBHOOK_URL;
  }
  const hub = fs.readFileSync('src/components/admin/AdminApp.tsx', 'utf8');
  assert.ok(hub.includes('Customers now confirm on WhatsApp instead of an SMS code</strong> — change in Settings → Phone check.'));
});

test('the admin order PATCH route takes only the fields it uses', () => {
  const src = fs.readFileSync('src/app/api/admin/orders/[id]/route.ts', 'utf8');
  assert.match(src, /allowFields\(body, PATCH_FIELDS\)/);
  assert.match(src, /const PATCH_FIELDS = \['status', 'paymentStatus', 'adminNotes', 'clearAttention', 'shipUnconfirmed'\] as const;/);
});
