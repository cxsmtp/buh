/**
 * Asked by the owner: "recreate a cancelled COD order and before label creation edit all the data".
 *  - Edit: name, phone (old number kept in the history: Track Order still finds it), email,
 *    address; for a cash order also each line's quantity and unit price (0 removes) and the
 *    delivery charge; the stock follows; the total, what the courier collects and the weight are
 *    worked out on the server; checked like checkout; audited; refused once booked, cancelled or
 *    delivered; amounts refused when paid by card or invoiced (the details still change).
 *  - Recreate: a cancelled cash order becomes a new confirmed order (same customer, lines, prices),
 *    the stock taken again; asked twice, the same new order; refused for a non-cash or live order,
 *    or when a piece sold out meanwhile.
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

const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place(over: Record<string, unknown> = {}) {
  _clearAllRateLimits();
  const p = listProducts()[0];
  return orders.placeOrder(
    {
      idempotencyKey: `edit-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Rohini R Nair', phone: `+9715077${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...over,
    },
    { ip: `10.9.${n}.1` }
  ).order;
}
const stockOf = (o: { items: Array<{ productId: string; profileId: string }> }) => getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').pluck().get(o.items[0].productId, o.items[0].profileId) as number;
const cancel = (id: string) => orders.updateOrderByAdmin(id, { status: 'cancelled' }, OWNER);
const audits = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).action as string));

test('edit the customer: name, phone (old number kept), email, address; checked; audited', () => {
  const o = place();
  const r = orders.editOrderDetails(o.id, { customer: { fullName: 'Rohini Nair', phone: '050 123 9876', email: 'rohini@example.com', emirate: 'Sharjah', area: 'Al Majaz', streetAddress: 'Corniche St', buildingVilla: 'Pearl Tower', flatVillaNo: '1204', landmark: 'near the park' } }, OWNER);
  assert.equal(r.changed, true);
  assert.equal(r.order.customer.fullName, 'Rohini Nair');
  assert.equal(r.order.customer.phone, '+971501239876');
  assert.equal(r.order.customer.emirate, 'Sharjah');
  assert.equal(r.order.customer.landmark, 'near the park');
  assert.ok(orders.lookupOrder(o.id, o.customer.phone), 'Track Order still finds it with the old number');
  assert.ok(orders.lookupOrder(o.id, '+971501239876'));
  assert.ok(audits().includes('order.details_edited'));
  assert.equal(orders.editOrderDetails(o.id, { customer: { fullName: 'Rohini Nair' } }, OWNER).changed, false, 'nothing new: nothing written');
  for (const bad of [{ customer: { phone: '123' } }, { customer: { emirate: 'Paris' } }, { customer: { email: 'x@' } }, { customer: { fullName: '' } }, { customer: { iban: 'x' } }, { price: 1 }]) {
    assert.throws(() => orders.editOrderDetails(o.id, bad, OWNER), (e: { status?: number }) => e.status === 400, JSON.stringify(bad));
  }
});

test('edit the amounts of a cash order: quantities move the stock, prices and delivery change the total and what is collected', () => {
  const o = place();
  const before = stockOf(o);
  const r = orders.editOrderDetails(o.id, { lines: [{ quantity: 2, unitPrice: 300 }], deliveryFee: 15 }, OWNER).order;
  assert.equal(stockOf(o), before - 1, 'one more piece taken');
  assert.equal(r.items[0].quantity, 2);
  assert.equal(r.subtotal, 600);
  assert.equal(r.deliveryFee, 15);
  assert.equal(r.total, 615);
  assert.equal(r.courier.codAmountCollected, 615);
  assert.equal(getDb().prepare('SELECT total_fils FROM orders WHERE id = ?').pluck().get(o.id), 61500);
  assert.equal(r.courier.pieces, 2);
  orders.editOrderDetails(o.id, { lines: [{ quantity: 1 }] }, OWNER);
  assert.equal(stockOf(o), before, 'and put back');
  assert.throws(() => orders.editOrderDetails(o.id, { lines: [{ quantity: 0 }] }, OWNER), (e: { status?: number }) => e.status === 400, 'at least one line');
  assert.throws(() => orders.editOrderDetails(o.id, { lines: [{ quantity: 1 }, { quantity: 1 }] }, OWNER), (e: { status?: number }) => e.status === 400);
  assert.throws(() => orders.editOrderDetails(o.id, { lines: [{ quantity: 1, unitPrice: 1.234 }] }, OWNER), (e: { status?: number }) => e.status === 400);
  assert.throws(() => orders.editOrderDetails(o.id, { lines: [{ quantity: 999 }] }, OWNER), (e: { status?: number }) => e.status === 400);
  assert.throws(() => orders.editOrderDetails(o.id, { deliveryFee: -1 }, OWNER), (e: { status?: number }) => e.status === 400);
});

test('locked once booked, cancelled or delivered; a card order’s amounts stay (its details can change)', () => {
  const booked = place();
  getDb().prepare("UPDATE orders SET data = json_set(data, '$.courier.bookingState', 'booked') WHERE id = ?").run(booked.id);
  assert.throws(() => orders.editOrderDetails(booked.id, { customer: { fullName: 'X Y' } }, OWNER), (e) => code(e) === 'edit_locked');
  const c = place();
  cancel(c.id);
  assert.throws(() => orders.editOrderDetails(c.id, { customer: { fullName: 'X Y' } }, OWNER), (e) => code(e) === 'edit_locked');
  const card = place();
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'paid', payment_ref = ?, data = json_set(data, '$.paymentMethod', 'online_card') WHERE id = ?").run(`pi_edit_${card.id}`, card.id);
  assert.throws(() => orders.editOrderDetails(card.id, { deliveryFee: 10 }, OWNER), (e) => code(e) === 'money_locked');
  assert.equal(orders.editOrderDetails(card.id, { customer: { area: 'JLT' } }, OWNER).order.customer.area, 'JLT');
});

test('reported: recreate a cancelled cash order: a new confirmed order, same customer and lines, stock taken again; once', () => {
  const o = place();
  const edited = orders.editOrderDetails(o.id, { lines: [{ quantity: 1, unitPrice: 250 }] }, OWNER).order;
  cancel(o.id);
  const stock = stockOf(o);
  const r = orders.recreateOrder(o.id, OWNER);
  assert.equal(r.created, true);
  assert.notEqual(r.order.id, o.id);
  assert.equal(r.order.status, 'confirmed');
  assert.equal(r.order.paymentMethod, 'cod');
  assert.equal(r.order.recreatedFrom, o.id);
  assert.equal(r.order.total, edited.total);
  assert.equal(r.order.items[0].unitPrice, 250);
  assert.equal(r.order.courier.codAmountCollected, edited.total);
  assert.equal(r.order.courier.awbNumber, '');
  assert.deepEqual(r.order.customer, edited.customer);
  assert.equal(stockOf(o), stock - 1);
  assert.equal(orders.getOrder(o.id)!.recreatedAs, r.order.id);
  assert.ok(audits().includes('order.recreated'));
  // Asked again: the same one.
  const again = orders.recreateOrder(o.id, OWNER);
  assert.equal(again.created, false);
  assert.equal(again.order.id, r.order.id);
  assert.equal(stockOf(o), stock - 1);
  // The new one can be edited before its label.
  assert.equal(orders.editOrderDetails(r.order.id, { customer: { flatVillaNo: '9' } }, OWNER).changed, true);
});

test('recreate only a cancelled cash order; a sold-out piece is said', () => {
  const live = place();
  assert.throws(() => orders.recreateOrder(live.id, OWNER), (e) => code(e) === 'not_cancelled');
  const card = place();
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', status = 'cancelled', payment_ref = ?, data = json_set(json_set(data, '$.paymentMethod', 'online_card'), '$.status', 'cancelled') WHERE id = ?").run(`pi_rc_${card.id}`, card.id);
  assert.throws(() => orders.recreateOrder(card.id, OWNER), (e) => code(e) === 'not_cod');
  const gone = place();
  cancel(gone.id);
  getDb().prepare('UPDATE product_stock SET qty = 0 WHERE product_id = ? AND size_id = ?').run(gone.items[0].productId, gone.items[0].profileId);
  assert.throws(() => orders.recreateOrder(gone.id, OWNER), (e) => code(e) === 'stock');
  assert.equal(orders.getOrder(gone.id)!.recreatedAs, undefined, 'nothing made');
});
