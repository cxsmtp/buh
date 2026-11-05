/**
 * Jeebly's courier charges in Money (BUH-02.36.00): taken from Jeebly (its replies when they carry
 * a charge, and its statement CSV), one courier expense per AWB, never twice, a statement correcting
 * a figure in place, past shipments asked about too, in the backup and back with the restore.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { installJeeblyMock, REPLIES } from './fixtures/jeebly-mock.mjs';

const dir = tempDataDir();
const orders = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings } = await import('@/lib/server/settings');
const { dispatchOrder } = await import('@/lib/server/dispatch');
const charges = await import('@/lib/server/courierCharges');
const expenses = await import('@/lib/server/expenses');
const backup = await import('@/lib/server/backup');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');

type Mock = { calls: Array<{ path: string; body: Record<string, unknown> }>; restore: () => void };
// Each booking gets its own AWB across the whole file (a fresh mock would start counting again).
let awbN = 770000;
const jeebly = (script: Record<string, unknown> = {}): Mock => installJeeblyMock({ create: () => REPLIES.created(`JB${++awbN}`), ...script });
let mock: Mock = jeebly();
afterEach(() => {
  mock.restore();
  mock = jeebly();
  _clearAllRateLimits();
});

const PICKUP = { pickupPhone: '+971501112222', pickupUnit: 'Shop 4', pickupBuilding: 'Barsha Tower', pickupArea: 'Al Barsha 1', pickupLandmark: 'Near the mall', pickupEmirate: 'Dubai' };
await updateSettings('courier', { jeebly: { ...PICKUP, isLive: true, liveBaseUrl: 'https://live.jeebly.com', apiKey: 'LIVE-KEY-1', clientKey: 'LIVE-CLIENT-1', sandboxApiKey: 'SB-KEY-1', sandboxClientKey: 'SB-CLIENT-1' } }, { liveOverride: true });

let n = 5000;
async function booked(): Promise<{ id: string; awb: string }> {
  const p = listProducts()[0];
  const phone = `+97150${String(++n).padStart(7, '0')}`;
  const id = orders.placeOrder({
    idempotencyKey: `cc-${n}-${Date.now()}-abcdefgh`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Aisha Test', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order.id;
  const res = await dispatchOrder({ orderId: id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test', weightKg: 1.4 });
  assert.equal(res.status, 200, String(res.body.message));
  return { id, awb: String(res.body.awbNumber) };
}
const courierExpenses = () => expenses.listExpenses({ limit: 2000 }).filter((e) => e.categoryId === 'courier');
const auditActions = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).action as string));

test("a charge in Jeebly's reply: found under its names (never the COD amount); none when Jeebly sends none", () => {
  assert.equal(charges.chargeInReply({ success: 'true', 'AWB No': 'JB1', shipping_charges: '18.50' }), 1850);
  assert.equal(charges.chargeInReply({ Tracking: { reference_no: 'JB1', 'Delivery Charge': 'AED 22' } }), 2200);
  assert.equal(charges.chargeInReply({ data: { freight_cost: 15 } }), 1500);
  assert.equal(charges.chargeInReply({ cod_amount: '250', amount: '250' }), null);
  assert.equal(charges.chargeInReply(REPLIES.tracking('JB1', 'Delivered').body), null, "Jeebly's demo reply carries no charge");
  assert.equal(charges.chargeInReply({ shipping_charges: 'free' }), null);
  assert.equal(charges.chargeInReply({ shipping_charges: '0' }), null);
});

test("Jeebly's replies: a charge in the booking or tracking reply becomes one courier expense, never two; a test booking never", async () => {
  mock.restore();
  mock = jeebly({ track: (call: { body: Record<string, unknown> }) => ({ status: 200, body: { ...REPLIES.tracking(String(call.body.reference_number), 'Delivered').body, shipping_charges: '19.00' } }) });
  const before = courierExpenses().length;
  const { id, awb } = await booked();
  const ops = await import('@/lib/server/jeeblyOps');
  await ops.jeeblyTrackingFor(orders.getOrder(id)!, { fresh: true });
  await ops.jeeblyTrackingFor(orders.getOrder(id)!, { fresh: true });
  const made = courierExpenses().filter((e) => e.note.includes(awb));
  assert.equal(made.length, 1);
  assert.equal(made[0].amountFils, 1900);
  assert.equal(made[0].payee, 'Jeebly');
  assert.match(made[0].note, new RegExp(`order ${id}`));
  assert.equal(courierExpenses().length, before + 1);
  assert.ok(auditActions().includes('expense.created'));
  // A sandbox booking's reply is not a real charge.
  const sandbox = { ...orders.getOrder(id)!, courier: { ...orders.getOrder(id)!.courier, awbNumber: 'JB999001', carrierEnv: 'sandbox' as const, testKind: 'sandbox' as const, simulated: true } };
  charges.noteJeeblyReply(sandbox, { shipping_charges: '19' });
  assert.equal(courierExpenses().length, before + 1);
});

test("past shipments are asked about (each once a day unless forced), and the ones Jeebly gives a charge for land in Money", async () => {
  const past = [await booked(), await booked()];
  assert.ok(charges.shipmentsWithoutCharge().some((s) => s.awb === past[0].awb));
  mock.restore();
  mock = jeebly({ track: (call: { body: Record<string, unknown> }) => (call.body.reference_number === past[0].awb ? { status: 200, body: { ...REPLIES.tracking(past[0].awb, 'Delivered').body, delivery_charges: '21.00' } } : undefined) });
  // The mock forgets the earlier AWBs; past[1] gets Jeebly's "unknown" reply: no charge, no expense.
  const r = await charges.syncJeeblyCharges({ max: 50 });
  assert.ok(r.checked >= 2);
  assert.ok(r.found >= 1);
  assert.equal(courierExpenses().find((e) => e.note.includes(past[0].awb))?.amountFils, 2100);
  assert.equal(courierExpenses().some((e) => e.note.includes(past[1].awb)), false);
  const asked = mock.calls.filter((c) => c.path === 'track_shipment').length;
  await charges.syncJeeblyCharges({ max: 50 });
  assert.equal(mock.calls.filter((c) => c.path === 'track_shipment').length, asked, 'not asked again within a day');
  await charges.syncJeeblyCharges({ max: 50, force: true });
  assert.ok(mock.calls.filter((c) => c.path === 'track_shipment').length > asked, '"Check Jeebly now" asks again');
  assert.ok(charges.syncState()!.at);
});

test("Jeebly's statement: AWB and charge columns found (never COD), previewed without saving, saved once per AWB; a changed figure corrects the expense (earlier version kept); not a shop order still counts", async () => {
  const a = await booked();
  const b = await booked();
  const csv = [
    '﻿Date,AWB No,Reference,COD Amount,Shipping Charges,Status',
    `05/11/2026,${a.awb},${a.id},250.00,18.00,Delivered`,
    `"04/11/2026","${b.awb}","${b.id}","0","AED 21.50","Delivered"`,
    'x,,,,,',
    '03/11/2026,JBOUTSIDE1,,0,15,Delivered',
    `05/11/2026,${a.awb},${a.id},250.00,18.00,Delivered`,
  ].join('\r\n');
  const before = courierExpenses().length;
  const p = charges.readStatement(csv, '2026-11-05');
  assert.deepEqual(p.columns, { awb: 'AWB No', charge: 'Shipping Charges', date: 'Date' });
  assert.equal(p.rows.length, 3);
  assert.equal(p.skipped, 2, 'an empty row and a repeated AWB');
  assert.deepEqual(p.rows.map((r) => [r.awb, r.amountFils, r.chargedOn, r.status]), [
    [a.awb, 1800, '2026-11-05', 'new'],
    [b.awb, 2150, '2026-11-04', 'new'],
    ['JBOUTSIDE1', 1500, '2026-11-03', 'unmatched'],
  ]);
  assert.equal(courierExpenses().length, before, 'a preview saves nothing');
  const saved = charges.applyStatement(csv, 'owner@shop.test');
  assert.deepEqual([saved.added, saved.updated, saved.same], [3, 0, 0]);
  assert.equal(courierExpenses().length, before + 3);
  assert.deepEqual(charges.applyStatement(csv, 'owner@shop.test'), { ...saved, added: 0, same: 3 }, 'the same file again changes nothing');
  assert.equal(courierExpenses().length, before + 3);
  // Jeebly corrects a figure: the expense is updated, its earlier version kept.
  const fixed = csv.replace('AED 21.50', 'AED 23.00');
  assert.equal(charges.readStatement(fixed, '2026-11-05').rows.find((r) => r.awb === b.awb)!.status, 'changed');
  assert.equal(charges.applyStatement(fixed, 'owner@shop.test').updated, 1);
  const eb = courierExpenses().find((e) => e.note.includes(b.awb))!;
  assert.equal(eb.amountFils, 2300);
  assert.ok(expenses.expenseVersions(eb.id).length >= 2);
  // A reply never overrides the statement.
  charges.noteJeeblyReply(orders.getOrder(b.id)!, { shipping_charges: '5' });
  assert.equal(courierExpenses().find((e) => e.note.includes(b.awb))!.amountFils, 2300);
  assert.ok(auditActions().includes('courier.statement_imported'));
  // Not Jeebly's statement: refused with a reason.
  assert.throws(() => charges.readStatement('Name,Phone\nA,1'), /AWB column and a shipping charge column/);
  assert.throws(() => charges.readStatement('AWB,COD Amount\nJB1,10'), /shipping charge column/);
  // Semicolons and tabs, dates as written by Excel.
  const semi = charges.readStatement('AWB;Delivery Fee\nJBSEMI001;12,5', '2026-11-05');
  assert.equal(semi.rows[0].amountFils, 1250, 'a decimal comma is a decimal, never AED 125');
  assert.equal(charges.readStatement('AWB\tFreight Charges\tBooked On\nJBTAB0001\t12.50\t2026-10-01', '2026-11-05').rows[0].chargedOn, '2026-10-01');
});

test('the courier charges are in the backup and come back with the restore', async () => {
  const c = await booked();
  charges.recordCourierCharge({ awb: c.awb, amountFils: 1700, source: 'statement', chargedOn: '2026-11-01' }, 'owner@shop.test');
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-courier-'));
  fs.rmSync(target, { recursive: true });
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /Integrity check: ok/);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  const row = db.prepare('SELECT amount_fils, order_id, expense_id FROM courier_charges WHERE awb = ?').get(c.awb) as { amount_fils: number; order_id: string; expense_id: string };
  assert.equal(row.amount_fils, 1700);
  assert.equal(row.order_id, c.id);
  assert.ok(db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(row.expense_id));
  db.close();
  fs.rmSync(target, { recursive: true, force: true });
});
