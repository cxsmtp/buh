/**
 * Review fixes for the accountant role and UAE VAT (BUH-02.17):
 *  - a setup link's door never outlives the invite, however often it is renewed; an accountant's
 *    door (the setup link's, and the one the setup gives) ends with a revoke or a new setup link;
 *    the owner's door is as before;
 *  - restoring a backup revokes the accountants it brings back, audited once, "Re-invite";
 *  - a revoked account invited again counts towards the limit;
 *  - VAT: invoice and credit-note entries in the audit log only once committed; a card payment of
 *    unknown mode is never invoiced; documents synced once per VAT return and only for orders not
 *    final (no write lock for those); reports and sales.csv without VAT too; orders placed after
 *    VAT started without a breakdown are flagged.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
const link = await import('@/lib/server/adminLink');
const gate = await import('@/lib/server/frontGate');
const staff = await import('@/lib/server/staffAuth');
const backup = await import('@/lib/server/backup');
const vat = await import('@/lib/server/vat');
const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const reports = await import('@/lib/server/reports');
const doc = await import('@/lib/server/taxDocument');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getDb, inTransaction } = await import('@/lib/server/db');
const { dubaiToday } = await import('@/lib/reportPeriods');
const { readZip } = await import('@/lib/server/zip');

const OWNER = 'owner@shop.test';
const DAY = 24 * 60 * 60 * 1000;
const auditLines = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> }));
const tokenIn = (cookie: string) => /^buh_door=([^;]+)/.exec(cookie)![1];
const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

link.createLinkIfAbsent('test');

// ── M1: doors ───────────────────────────────────────────────────────────────

test('a setup link’s door never outlives the invite: renewed after a day, it still ends at the 72 hours', () => {
  const invite = staff.inviteAccountant('renew@firm.test', '', OWNER, OWNER);
  const now = Date.now();
  const hub = gate.decide(`/${invite.grant}`, '', now);
  assert.equal(hub.kind, 'hub');
  const first = tokenIn((hub as { cookie: string }).cookie);
  // A day later the door is renewed on an admin call…
  const later = now + DAY + 60_000;
  const renewed = gate.decide('/api/admin/session', `buh_door=${first}`, later);
  assert.equal(renewed.kind, 'renew');
  const second = tokenIn((renewed as { cookie: string }).cookie);
  assert.ok(link.verifyDoorToken(second, later).ok);
  // …but never past the invite's end (not a 30-day door).
  const end = now + staff.STAFF_SETUP_TTL_MS + 1000;
  assert.equal(link.verifyDoorToken(second, end).ok, false, 'the renewed door ends with the invite');
  assert.equal(link.verifyDoorToken(first, end).ok, false);
  // Renewing again after the cap gives nothing.
  assert.equal(gate.decide('/api/admin/session', `buh_door=${second}`, end).kind, 'unknown');
});

test('revoking (or a new setup link) ends the doors the setup link gave at once; the owner’s door carries on', async () => {
  const owner = link.issueDoorToken()!;
  const invite = staff.inviteAccountant('door@firm.test', '', OWNER, OWNER);
  const grantDoor = tokenIn((gate.decide(`/${invite.grant}`, '') as { cookie: string }).cookie);
  assert.ok(link.verifyDoorToken(grantDoor).ok);
  // A new setup link: the old one's door ends.
  const again = staff.inviteAccountant('door@firm.test', '', OWNER, OWNER);
  assert.equal(link.verifyDoorToken(grantDoor).ok, false, 'the old setup link’s door ended');
  const door2 = tokenIn((gate.decide(`/${again.grant}`, '') as { cookie: string }).cookie);
  // The setup itself (the route): the door it gives this browser is the accountant's.
  const { POST } = await import('@/app/api/admin/staff/setup/route');
  const res = await POST(
    new Request('https://shop.example/api/admin/staff/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://shop.example', host: 'shop.example', cookie: `buh_door=${door2}` },
      body: JSON.stringify({ token: again.token, password: 'Ledger-Reader-2026!' }),
    })
  );
  assert.equal(res.status, 200, await res.clone().text());
  const setupDoor = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('buh_door='))!.slice('buh_door='.length);
  assert.ok(link.verifyDoorToken(setupDoor).ok);
  assert.equal(link.verifyDoorToken(door2).ok, false, 'the setup link’s door ends once it is used');
  staff.revokeStaff(again.account.id, OWNER);
  assert.equal(link.verifyDoorToken(setupDoor).ok, false, 'revoked: the door the setup gave ends too');
  // The owner's door is exactly as before: no cap, no account, renewed into another 30 days.
  assert.ok(link.verifyDoorToken(owner).ok);
  staff.endAllStaffSessions();
  assert.ok(link.verifyDoorToken(owner).ok);
  const renewed = gate.decide('/api/admin/session', `buh_door=${owner}`, Date.now() + DAY + 60_000);
  assert.equal(renewed.kind, 'renew');
  assert.ok(link.verifyDoorToken(tokenIn((renewed as { cookie: string }).cookie), Date.now() + 29 * DAY).ok, '30 days from the renewal');
});

test('the owner signing out everywhere ends every accountant session (endAllStaffSessions)', async () => {
  const auth = await import('@/lib/server/adminAuth');
  const inv = staff.inviteAccountant('everywhere@firm.test', '', OWNER, OWNER);
  await staff.completeStaffSetup(inv.token, 'Ledger-Reader-2026!');
  const s = await auth.signIn('everywhere@firm.test', 'Ledger-Reader-2026!');
  assert.ok(await auth.verifySessionToken(s.token));
  assert.ok(staff.endAllStaffSessions() >= 1);
  assert.equal(await auth.verifySessionToken(s.token), null);
  // The route calls it for the owner's sign-out.
  assert.match(fs.readFileSync('src/app/api/admin/logout/route.ts', 'utf8'), /endAllSessions\(\);\s*const staff = endAllStaffSessions\(\);/);
});

// ── L8: the limit ───────────────────────────────────────────────────────────

test('inviting a revoked account again counts towards the limit of accountant accounts', () => {
  const live = () => getDb().prepare("SELECT COUNT(*) FROM staff_accounts WHERE status <> 'revoked'").pluck().get() as number;
  const revoked = staff.inviteAccountant('limit-old@firm.test', '', OWNER, OWNER);
  staff.revokeStaff(revoked.account.id, OWNER);
  for (let i = 0; live() < staff.MAX_STAFF; i++) staff.inviteAccountant(`limit-${i}@firm.test`, '', OWNER, OWNER);
  assert.equal(statusOf(() => staff.inviteAccountant('limit-new@firm.test', '', OWNER, OWNER)), 409, 'a new one is refused');
  assert.equal(statusOf(() => staff.inviteAccountant('limit-old@firm.test', '', OWNER, OWNER)), 409, 'and so is the revoked one invited again');
  // Someone already counted can still get a new setup link.
  assert.equal(statusOf(() => staff.inviteAccountant('limit-0@firm.test', '', OWNER, OWNER)), 0);
  // Back under the limit for the tests below.
  for (const a of staff.listStaff()) if (a.status !== 'revoked') staff.revokeStaff(a.id, OWNER);
});

// ── M2: a restore revokes the accountants ───────────────────────────────────

test('backup → revoke → restore: the revoked accountant does not come back; audited once; the owner is told to re-invite', async () => {
  const kept = staff.inviteAccountant('kept@firm.test', 'Kept', OWNER, OWNER);
  await staff.completeStaffSetup(kept.token, 'Ledger-Reader-2026!');
  const gone = staff.inviteAccountant('gone@firm.test', 'Gone', OWNER, OWNER);
  await staff.completeStaffSetup(gone.token, 'Ledger-Reader-2026!');
  const pending = staff.inviteAccountant('pending@firm.test', '', OWNER, OWNER);
  const result = await backup.createBackup();
  // After the backup, the owner revokes one…
  staff.revokeStaff(gone.account.id, OWNER);
  // …then restores the backup (taken before the revoke).
  const target = path.join(os.tmpdir(), `buh-restore-staff-${Date.now()}`);
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target], { encoding: 'utf8' });
  assert.match(out, /Re-invite your accountant/);
  const db = new Database(path.join(target, 'shop.db'));
  const rows = db.prepare('SELECT id, status, password_hash, setup_hash, setup_grant_hash, revoked_by FROM staff_accounts WHERE id IN (?, ?, ?)').all(kept.account.id, gone.account.id, pending.account.id) as Array<{ id: string; status: string; password_hash: string | null; setup_hash: string | null; setup_grant_hash: string | null; revoked_by: string }>;
  db.close();
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.status, 'revoked', `${r.id} revoked`);
    assert.equal(r.password_hash, null);
    assert.equal(r.setup_hash, null);
    assert.equal(r.setup_grant_hash, null, 'the setup link no longer opens the hub');
    assert.equal(r.revoked_by, 'restore');
  }
  // The restored shop: audited once on its first start, and the hub says "Re-invite".
  const { _closeDb } = await import('@/lib/server/db');
  const { _resetAuditState } = await import('@/lib/server/audit');
  _closeDb();
  _resetAuditState();
  process.env.DATA_DIR = target;
  try {
    assert.equal(staff.auditStaffRestoreOnce(), true);
    assert.equal(staff.auditStaffRestoreOnce(), false, 'once');
    const entries = fs.readdirSync(target).filter((f) => /^audit-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(target, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const e = entries.filter((x) => x.action === 'accountant.revoked_by_restore');
    assert.equal(e.length, 1);
    assert.ok((e[0].details.staffIds as string[]).includes(kept.account.id));
    // Every one the backup held as active or invited (the shop can't tell which the owner had revoked since).
    assert.deepEqual(staff.revokedByRestore().map((a) => a.email).sort(), ['gone@firm.test', 'kept@firm.test', 'pending@firm.test']);
    assert.equal(staff.activeStaffByEmail('gone@firm.test'), undefined, 'the revoked accountant can’t sign in');
    assert.equal(link.resetGrantExpiry(pending.grant), 0);
    // Re-inviting takes one off the list.
    staff.inviteAccountant('kept@firm.test', '', OWNER, OWNER);
    assert.deepEqual(staff.revokedByRestore().map((a) => a.email).sort(), ['gone@firm.test', 'pending@firm.test']);
  } finally {
    _closeDb();
    _resetAuditState();
    process.env.DATA_DIR = dir;
  }
  for (const f of ['src/app/api/admin/staff/route.ts', 'src/app/api/admin/restore-notice/route.ts']) assert.match(fs.readFileSync(f, 'utf8'), /auditStaffRestoreOnce|revokedByRestore/, f);
  assert.match(fs.readFileSync('src/components/admin/settings/AccountantAccessCard.tsx', 'utf8'), /Re-invite your accountant/);
  assert.match(fs.readFileSync('src/lib/server/startup.ts', 'utf8'), /auditStaffRestoreOnce/);
});

// ── VAT ─────────────────────────────────────────────────────────────────────

let n = 0;
function placeCod(quantity = 1) {
  const list = products.listProducts();
  const p = list[n % list.length];
  return orders.placeOrder({
    idempotencyKey: `fix-key-${++n}-${Date.now()}`,
    verificationToken: issuePhoneToken(`+9715077${String(n).padStart(5, '0')}`),
    customer: { fullName: 'Noura Customer', email: 'buyer@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity }],
    paymentMethod: 'cod',
  }).order;
}
const fils = (aed: number) => Math.round(aed * 100);

test('VAT: an order placed after VAT started without a breakdown (a rollback) is flagged in the VAT return', () => {
  const before = placeCod();
  vat.saveVatSettings({ enabled: true, trn: '100123456700003', effectiveFrom: dubaiToday(), legalName: 'BUH LLC', address: 'Shop 4, Dubai', confirm: 'TURN ON VAT' }, OWNER);
  const withVat = placeCod();
  assert.ok(vat.orderVat(withVat.id));
  // An older version of the shop (a rollback) placed one without VAT.
  const old = placeCod();
  getDb().prepare('DELETE FROM order_vat WHERE order_id = ?').run(old.id);
  const r = vat.vatReturn(dubaiToday(), dubaiToday());
  assert.equal(r.missingVat.count, 1);
  assert.deepEqual(r.missingVat.orderIds, [old.id], 'not the order placed before VAT was switched on');
  assert.ok(!r.missingVat.orderIds.includes(before.id));
  assert.match(vat.vatReturnCsv(dubaiToday(), dubaiToday()), new RegExp(`without VAT worked out.*${old.id}`));
  assert.match(fs.readFileSync('src/components/admin/money/VatPanel.tsx', 'utf8'), /data-testid="vat-missing"/);
});

test('VAT: invoice and credit-note entries reach the audit log only once committed (never for a rolled-back number)', () => {
  const a = placeCod();
  const b = placeCod();
  assert.throws(() =>
    inTransaction(() => {
      vat.issueInvoice(a.id);
      throw new Error('the order change failed');
    })
  );
  assert.equal(vat.invoiceFor(a.id), null);
  assert.equal(auditLines().filter((l) => l.action === 'vat.invoice_issued' && l.details.orderId === a.id).length, 0, 'no entry for the rolled-back invoice');
  // Nested: the inner part commits, the outer rolls back: nothing logged either.
  assert.throws(() =>
    inTransaction(() => {
      inTransaction(() => vat.issueInvoice(a.id));
      throw new Error('later step failed');
    })
  );
  assert.equal(auditLines().filter((l) => l.action === 'vat.invoice_issued' && l.details.orderId === a.id).length, 0);
  // Committed: logged once, with the number the series holds.
  const inv = vat.issueInvoice(b.id);
  const logged = auditLines().filter((l) => l.action === 'vat.invoice_issued' && l.details.orderId === b.id);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].details.number, inv.number);
  // A credit note made inside a committed order change is logged after it.
  orders.updateOrderByAdmin(b.id, { status: 'cancelled' }, OWNER);
  const cn = vat.creditNotesFor(b.id);
  assert.equal(cn.length, 1);
  assert.equal(auditLines().filter((l) => l.action === 'vat.credit_note_issued' && l.details.number === cn[0].number).length, 1);
});

test('VAT: a card payment whose live mode is unknown (null) is never invoiced; only live mode (1) is', () => {
  const o = placeCod();
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'paid', card_livemode = NULL WHERE id = ?").run(o.id);
  vat.syncVatDocuments(o.id);
  assert.equal(vat.invoiceFor(o.id), null, 'unknown mode: not invoiced');
  getDb().prepare('UPDATE orders SET card_livemode = 1 WHERE id = ?').run(o.id);
  vat.syncVatDocuments(o.id);
  assert.ok(vat.invoiceFor(o.id), 'live: invoiced');
});

test('VAT: documents are synced once per VAT return (also for the CSV), and an order that is final takes no write lock', () => {
  const o = placeCod();
  orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, OWNER);
  assert.ok(vat.invoiceFor(o.id));
  const from = dubaiToday();
  let at = vat.vatSyncStats.all;
  vat.vatReturn(from, from);
  assert.equal(vat.vatSyncStats.all - at, 1, 'the JSON: once');
  at = vat.vatSyncStats.all;
  vat.vatReturnCsv(from, from);
  assert.equal(vat.vatSyncStats.all - at, 1, 'the CSV: once (not twice)');
  // Another copy of the shop holds the write lock: a final order is only read (the public invoice page, the VAT return).
  getDb().pragma('wal_checkpoint(FULL)');
  const other = new Database(path.join(dir, 'shop.db'));
  other.pragma('busy_timeout = 5000');
  other.exec('BEGIN IMMEDIATE');
  try {
    const writes = vat.vatSyncStats.writes;
    const started = Date.now();
    vat.syncVatDocuments(o.id);
    doc.orderDocumentHtml(orders.getOrder(o.id)!);
    vat.vatReturn(from, from);
    assert.ok(Date.now() - started < 2000, `no wait for the write lock (${Date.now() - started} ms)`);
    assert.equal(vat.vatSyncStats.writes, writes, 'nothing written');
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
  assert.match(fs.readFileSync('src/app/invoice/[token]/route.ts', 'utf8') + fs.readFileSync('src/lib/server/taxDocument.ts', 'utf8'), /syncVatDocuments\(order\.id\)/);
  assert.doesNotMatch(fs.readFileSync('src/lib/server/taxDocument.ts', 'utf8'), /syncAllVatDocuments/);
});

test('reports with VAT: net-of-VAT sales and profit beside the gross; sales.csv has vat_aed and total_excl_vat_aed', async () => {
  const o = placeCod(2);
  orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, OWNER);
  const from = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  const report = reports.buildReport(from, to);
  assert.ok(report.exVat, 'orders with VAT: the figures without it');
  const ex = report.exVat!;
  const counted = orders.allOrders().filter((x) => reports.classifyOrder(x).counted && vat.orderVat(x.id));
  assert.equal(ex.salesVatFils, counted.reduce((s, x) => s + vat.orderVat(x.id)!.vatFils, 0));
  assert.equal(ex.grossSalesFils, report.sales.grossFils - ex.salesVatFils);
  assert.equal(ex.netSalesFils, report.netSalesFils - ex.salesVatFils + ex.refundVatFils);
  assert.equal(ex.profitFils, ex.netSalesFils - ex.expensesFils);
  assert.ok(ex.netSalesFils < report.netSalesFils);
  const result = await reports.writeAccountantZip(from, to, 'Beautiful UAE Home');
  const zip = readZip(fs.readFileSync(result.file));
  const sales = zip.get('sales.csv')!.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const header = sales[0].split(',');
  assert.deepEqual(header.slice(-2), ['vat_aed', 'total_excl_vat_aed']);
  const row = sales.find((l) => l.includes(`,${o.id},`))!.split(',');
  const v = vat.orderVat(o.id)!;
  assert.equal(row.at(-2), (v.vatFils / 100).toFixed(2));
  assert.equal(row.at(-1), ((fils(o.total) - v.vatFils) / 100).toFixed(2));
  const summary = zip.get('summary.csv')!.toString('utf8');
  assert.match(summary, /Profit including VAT/);
  assert.match(summary, /Net sales excluding VAT/);
  assert.match(summary, /Profit excluding VAT/);
  assert.match(zip.get('README.txt')!.toString('utf8'), /total_excl_vat_aed/);
});

test('reports without any VAT order: no excluding-VAT figures (nothing changes)', () => {
  const r = reports.buildReport('2020-01-01', '2020-01-31');
  assert.equal(r.exVat, null);
});

test('the VAT settings warn that prices excluding VAT show shoppers prices before VAT; inclusive stays the default', () => {
  assert.equal(vat.DEFAULT_VAT.pricesIncludeVat, true);
  const src = fs.readFileSync('src/components/admin/settings/VatSettingsCard.tsx', 'utf8');
  assert.match(src, /!draft\.pricesIncludeVat && \(/);
  assert.match(src, /shoppers see every price before VAT/);
});
