/**
 * "Handed over in person" (BUH-02.38.00, asked by the owner: an order "handpicked and never needed
 * to send it to anyone"): delivered without a courier, from any open status; cash on delivery is
 * recorded as received (or left unpaid when the owner says so); refused when a courier is booked,
 * a card payment is not confirmed, or a photo order's amount is not confirmed; audited; once.
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
const { classifyOrder } = await import('@/lib/orderMoney');

const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place(over: Record<string, unknown> = {}) {
  _clearAllRateLimits();
  const p = listProducts()[0];
  return orders.placeOrder(
    {
      idempotencyKey: `handover-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Rohini R Nair', phone: `+9715077${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...over,
    },
    { ip: `10.9.${n}.1` }
  ).order;
}
const set = (id: string, jsonPath: string, value: unknown) => getDb().prepare(`UPDATE orders SET data = json_set(data, ?, json(?)) WHERE id = ?`).run(jsonPath, JSON.stringify(value), id);
const audits = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> }));

test('asked: a cash order handed over in person is delivered without a courier and paid with the cash due; once; audited', () => {
  const o = place();
  orders.checkWhatsApp(o.id, 'confirmed', OWNER);
  const r = orders.handOverOrder(o.id, {}, OWNER);
  assert.equal(r.changed, true);
  assert.deepEqual([r.order.status, r.order.paymentStatus], ['delivered', 'paid']);
  assert.equal(r.order.handedOver?.by, OWNER);
  assert.equal(r.order.handedOver?.cash, o.total);
  assert.equal(r.order.courier.codAmountCollected, o.total);
  assert.equal(r.order.courier.status, 'Handed over in person (no courier)');
  assert.ok(r.order.courier.deliveredAt);
  assert.equal(r.order.courier.awbNumber, '', 'no courier booked');
  assert.equal(classifyOrder(r.order).paid, true, 'counted as paid in Reports');
  const a = audits().filter((x) => x.action === 'order.handed_over').at(-1);
  assert.equal(a?.details?.orderId, o.id);
  assert.equal(a?.details?.cashFils, Math.round(o.total * 100));
  // Again: nothing changes.
  assert.equal(orders.handOverOrder(o.id, {}, OWNER).changed, false);
});

test('from any open status (even before the WhatsApp confirmation: the customer was there); cash not received yet stays unpaid', () => {
  const o = place();
  assert.equal(o.status, 'pending_confirmation');
  const r = orders.handOverOrder(o.id, { cashReceived: false, note: 'Collected at the shop' }, OWNER);
  assert.deepEqual([r.order.status, r.order.paymentStatus], ['delivered', 'cod_pending']);
  assert.equal(r.order.handedOver?.cash, undefined);
  assert.equal(r.order.handedOver?.note, 'Collected at the shop');
});

test('refused: booked with a courier, a card not yet paid, a photo order whose amount is not confirmed, cancelled; unknown fields', () => {
  const booked = place();
  set(booked.id, '$.courier.awbNumber', 'JB123456');
  set(booked.id, '$.courier.bookingState', 'booked');
  assert.throws(() => orders.handOverOrder(booked.id, {}, OWNER), (e) => code(e) === 'courier_booked');

  const card = place();
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'pending', data = json_set(data, '$.paymentMethod', 'online_card') WHERE id = ?").run(card.id);
  assert.throws(() => orders.handOverOrder(card.id, {}, OWNER), (e) => code(e) === 'card_unpaid');

  const photo = place();
  set(photo.id, '$.photoOrder', { photos: 1, note: 'King bedsheet', pieces: 1, agreedTotal: 100 });
  assert.throws(() => orders.handOverOrder(photo.id, {}, OWNER), (e) => code(e) === 'photo_amount');

  const gone = place();
  orders.updateOrderByAdmin(gone.id, { status: 'cancelled' }, OWNER);
  assert.throws(() => orders.handOverOrder(gone.id, {}, OWNER), (e) => code(e) === 'order_closed');

  const o = place();
  assert.throws(() => orders.handOverOrder(o.id, { status: 'delivered' }, OWNER), (e: { status?: number }) => e.status === 400);
  assert.throws(() => orders.handOverOrder(o.id, { cashReceived: 'yes' }, OWNER), (e: { status?: number }) => e.status === 400);
  assert.equal(orders.getOrder(o.id)!.status, 'pending_confirmation', 'nothing changed');
});

test('a card order already paid is handed over: delivered, its payment untouched', () => {
  const o = place();
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'paid', paid_fils = ?, payment_ref = ?, data = json_set(data, '$.paymentMethod', 'online_card') WHERE id = ?").run(Math.round(o.total * 100), `pi_handover_${o.id}`, o.id);
  const r = orders.handOverOrder(o.id, { cashReceived: true }, OWNER);
  assert.equal(r.order.status, 'delivered');
  assert.equal(r.order.handedOver?.cash, undefined, 'no cash on a card order');
  assert.equal(r.order.card?.state, 'paid');
});
