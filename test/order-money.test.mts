/**
 * Money on delivery (asked by the owner):
 *  - "Extra to collect" when booking the courier: 0 by default; money still to take from the
 *    customer, even after payment. Added to the total and to what the courier collects; the
 *    Jeebly booking and the label carry it (a paid order with an extra is booked COD for the
 *    extra only). Checked (AED, fils), audited, refused once it is with the courier.
 *  - A paid order's money moved onto another order instead of a refund ("an order is cancelled
 *    but payment is made and I have to adjust the money against another order"): the paid order is
 *    cancelled (pieces back), the other collects that much less; never more than was paid, never
 *    more than is due, never twice; the refund left shrinks to match. Audited.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const orders = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');
const { buildJeeblyPayload } = await import('@/lib/jeebly');
const { dueOnDeliveryFils, heldFils } = await import('@/lib/orderMoney');

const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place(over: Record<string, unknown> = {}, phone?: string) {
  _clearAllRateLimits();
  const p = listProducts()[0];
  return orders.placeOrder(
    {
      idempotencyKey: `money-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Rohini R Nair', phone: phone ?? `+9715066${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...over,
    },
    { ip: `10.8.${n}.1` }
  ).order;
}
/** As if paid by card (Stripe's part is covered by the Stripe tests). */
function paidByCard(id: string) {
  const o = orders.getOrder(id)!;
  getDb()
    .prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'paid', paid_fils = ?, payment_ref = ?, data = json_set(json_set(data, '$.paymentMethod', 'online_card'), '$.courier.codAmountCollected', 0) WHERE id = ?")
    .run(Math.round(o.total * 100), `pi_test_${id}`, id);
  return orders.getOrder(id)!;
}
const audits = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> }));
const stockOf = () => getDb().prepare('SELECT SUM(qty) FROM product_stock').pluck().get() as number;
const jeebly = { pickupLocationName: 'Shop', pickupPhone: '+971501112222', pickupAddress: 'Street 5', pickupArea: 'Al Barsha 1', pickupEmirate: 'Dubai' } as never;

test('extra to collect on a cash order: added to the total and to what the courier collects; the same again changes nothing; 0 removes it', () => {
  const o = place();
  const base = o.total;
  const r = orders.setExtraCharge(o.id, 50, '1 extra pillow cover', OWNER);
  assert.equal(r.changed, true);
  assert.equal(r.order.total, base + 50);
  assert.equal(r.order.courier.codAmountCollected, base + 50);
  assert.deepEqual({ amount: r.order.extraCharge?.amount, note: r.order.extraCharge?.note, by: r.order.extraCharge?.by }, { amount: 50, note: '1 extra pillow cover', by: OWNER });
  assert.equal(getDb().prepare('SELECT total_fils FROM orders WHERE id = ?').pluck().get(o.id), Math.round((base + 50) * 100));
  assert.equal(orders.setExtraCharge(o.id, 50, '1 extra pillow cover', OWNER).changed, false);
  const p = buildJeeblyPayload(orders.getOrder(o.id)!, jeebly, { shopName: 'Shop', email: '' });
  assert.equal(p.payment_type, 'COD');
  assert.equal(p.cod_amount, base + 50);
  const back = orders.setExtraCharge(o.id, 0, '', OWNER).order;
  assert.equal(back.total, base);
  assert.equal(back.extraCharge, undefined);
  assert.ok(audits().filter((a) => a.action === 'order.extra_charge_set').length >= 2);
});

test('reported: a paid (card) order with less paid can still collect the rest: booked COD for the extra only', () => {
  const o = paidByCard(place().id);
  assert.equal(dueOnDeliveryFils(o), 0, 'prepaid: nothing to collect by default');
  assert.equal(buildJeeblyPayload(o, jeebly, { shopName: 'Shop', email: '' }).payment_type, 'PREPAID');
  const r = orders.setExtraCharge(o.id, 20.5, 'balance', OWNER).order;
  assert.equal(r.courier.codAmountCollected, 20.5);
  const p = buildJeeblyPayload(r, jeebly, { shopName: 'Shop', email: '' });
  assert.equal(p.payment_type, 'COD');
  assert.equal(p.cod_amount, 20.5);
  assert.equal(orders.refundableFils(r), Math.round((r.total - 20.5) * 100), 'only what was paid by card can go back to it');
});

test('the extra is checked: AED 0–10,000 with fils; not once it is with the courier or cancelled', () => {
  const o = place();
  for (const bad of [-1, 10_000.01, 1.234, '5', Number.NaN]) assert.throws(() => orders.setExtraCharge(o.id, bad, '', OWNER), (e: { status?: number }) => e.status === 400, String(bad));
  assert.throws(() => orders.setExtraCharge(o.id, 5, 'x'.repeat(121), OWNER), (e: { status?: number }) => e.status === 400);
  getDb().prepare("UPDATE orders SET data = json_set(data, '$.courier.bookingState', 'booked') WHERE id = ?").run(o.id);
  assert.throws(() => orders.setExtraCharge(o.id, 5, '', OWNER), (e) => code(e) === 'collect_locked');
  const c = place();
  getDb().prepare("UPDATE orders SET status = 'cancelled', data = json_set(data, '$.status', 'cancelled') WHERE id = ?").run(c.id);
  assert.throws(() => orders.setExtraCharge(c.id, 5, '', OWNER), (e) => code(e) === 'collect_locked');
  assert.throws(() => orders.setExtraCharge('BUH-000000-NONE00', 5, '', OWNER), (e: { status?: number }) => e.status === 404);
});

test('reported: a paid order’s money moves to another order instead of a refund: cancelled, pieces back, the other collects less; audited', () => {
  const phone = '+971506699001';
  const paid = paidByCard(place({}, phone).id);
  const other = place({}, phone);
  const stock = stockOf();
  const move = Math.min(paid.total, other.total);
  const r = orders.moveCredit(paid.id, other.id, move, OWNER);
  assert.equal(r.from.status, 'cancelled');
  assert.equal(stockOf(), stock + 1, 'its piece is back on sale');
  assert.deepEqual(r.from.creditsOut?.map((c) => [c.toOrderId, c.amount]), [[other.id, move]]);
  assert.deepEqual(r.to.creditsIn?.map((c) => [c.fromOrderId, c.amount]), [[paid.id, move]]);
  assert.equal(r.to.total, other.total, 'the other order’s total (its sale) stays');
  assert.equal(r.to.courier.codAmountCollected, Math.round((other.total - move) * 100) / 100);
  assert.equal(buildJeeblyPayload(r.to, jeebly, { shopName: 'Shop', email: '' }).cod_amount ?? 0, Math.round((other.total - move) * 100) / 100 || 0);
  assert.equal(orders.refundableFils(r.from), Math.round((paid.total - move) * 100), 'what moved is not refunded too');
  assert.equal(heldFils(r.from), Math.round((paid.total - move) * 100));
  const a = audits().find((x) => x.action === 'order.credit_moved');
  assert.equal(a?.details?.fromOrderId, paid.id);
  assert.equal(a?.details?.amountFils, Math.round(move * 100));
});

test('never more than was paid, never more than is due, never twice; only from a paid order to an open one with something to collect', () => {
  const paid = paidByCard(place().id);
  const due = place();
  const extra = orders.setExtraCharge(due.id, 500, 'bigger set', OWNER).order;
  assert.throws(() => orders.moveCredit(paid.id, extra.id, paid.total + 1, OWNER), (e) => code(e) === 'too_much');
  const small = place();
  assert.throws(() => orders.moveCredit(paid.id, small.id, small.total + 1, OWNER), (e) => code(e) === 'too_much');
  // A prepaid target has nothing to collect.
  const prepaid = paidByCard(place().id);
  assert.throws(() => orders.moveCredit(paid.id, prepaid.id, 1, OWNER), (e) => code(e) === 'nothing_due');
  // Not from an unpaid cash order, not to itself, not to an unknown or booked one.
  const cash = place();
  assert.throws(() => orders.moveCredit(cash.id, small.id, 1, OWNER), (e) => code(e) === 'nothing_held');
  assert.throws(() => orders.moveCredit(paid.id, paid.id, 1, OWNER), (e: { status?: number }) => e.status === 400);
  assert.throws(() => orders.moveCredit(paid.id, 'BUH-000000-NONE00', 1, OWNER), (e: { status?: number }) => e.status === 404);
  assert.throws(() => orders.moveCredit(paid.id, 'not-an-order', 1, OWNER), (e: { status?: number }) => e.status === 400);
  const booked = place();
  getDb().prepare("UPDATE orders SET data = json_set(data, '$.courier.bookingState', 'booked') WHERE id = ?").run(booked.id);
  assert.throws(() => orders.moveCredit(paid.id, booked.id, 1, OWNER), (e) => code(e) === 'collect_locked');
  // All of it moved: nothing left to move again (or refund).
  orders.moveCredit(paid.id, extra.id, paid.total, OWNER);
  assert.throws(() => orders.moveCredit(paid.id, small.id, 1, OWNER), (e) => code(e) === 'nothing_held');
  assert.equal(orders.refundableFils(orders.getOrder(paid.id)!), 0);
  // A bank transfer that arrived can move too.
  const bank = place();
  getDb().prepare("UPDATE orders SET payment_method = 'bank_transfer', bank_state = 'paid', payment_status = 'verified', data = json_set(json_set(data, '$.paymentMethod', 'bank_transfer'), '$.paymentStatus', 'verified') WHERE id = ?").run(bank.id);
  const r = orders.moveCredit(bank.id, small.id, 10, OWNER);
  assert.equal(r.to.courier.codAmountCollected, Math.round((small.total - 10) * 100) / 100);
});
