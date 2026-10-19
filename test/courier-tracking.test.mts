/**
 * Reported: "I put it dispatched. Why are the courier tracking details not shown?" The booking
 * was a test one, which customers never see, and there was no way to type in a number from the
 * carrier's own portal. Now "Enter tracking number" records a real AWB (checked, audited first),
 * Track Order shows it, a real booking is replaced only with the owner's confirm, and a test
 * booking never reaches the customer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const orders = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { dispatchOrder } = await import('@/lib/server/dispatch');

let n = 2000;
function confirmedOrder(status: 'confirmed' | 'dispatched' = 'confirmed') {
  const p = listProducts()[0];
  const phone = `+97150${String(++n).padStart(7, '0')}`;
  const id = orders.placeOrder({
    idempotencyKey: `tracking-${n}-${Date.now()}-abcdef`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Mariam Test', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order.id;
  orders.updateOrderByAdmin(id, { status: 'confirmed' }, 'owner@shop.test');
  if (status === 'dispatched') orders.updateOrderByAdmin(id, { status: 'dispatched' }, 'owner@shop.test');
  return { id, phone };
}
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

test('regression: dispatched with no real AWB, Track Order says so (no test AWB, no courier name)', async () => {
  const { id, phone } = confirmedOrder();
  await dispatchOrder({ orderId: id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test', testBooking: true });
  assert.equal(orders.getOrder(id)!.courier.simulated, true, 'a practice booking (no keys)');
  orders.updateOrderByAdmin(id, { status: 'dispatched' }, 'owner@shop.test');
  const seen = orders.lookupOrder(id, phone)!;
  assert.equal(seen.courier.awbNumber, '');
  assert.equal(seen.courier.trackingUrl, '');
  assert.equal(seen.courier.status, 'With our delivery team');
  assert.doesNotMatch(JSON.stringify(seen), /PRACTICE-|Practice|Sandbox|Jeebly/);
  assert.doesNotMatch(JSON.stringify(orders.customerView(orders.getOrder(id)!)), /PRACTICE-|Practice booking/);
});

test('Enter tracking number: validated, audited before it counts, then shown in Track Order', async () => {
  const { id, phone } = confirmedOrder('dispatched');
  for (const [label, input] of [
    ['too short', { carrier: 'jeebly', awb: 'AB1' }],
    ['spaces', { carrier: 'jeebly', awb: 'AB 12345' }],
    ['symbols', { carrier: 'jeebly', awb: 'AB<12345>' }],
    ['too long', { carrier: 'jeebly', awb: 'A'.repeat(41) }],
    ['unknown courier', { carrier: 'fedex', awb: 'AB12345' }],
    ['other without a name', { carrier: 'other', awb: 'AB12345' }],
    ['http link', { carrier: 'jeebly', awb: 'AB12345', trackingUrl: 'http://track.example.com/AB12345' }],
  ] as const) {
    assert.equal(await status(() => orders.enterTracking(id, 'owner@shop.test', input as never)), 400, label);
  }
  const before = auditEntries().length;
  const saved = orders.enterTracking(id, 'owner@shop.test', { carrier: 'jeebly', awb: 'JB-77889900' });
  const added = auditEntries().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].action, 'order.tracking_entered');
  assert.equal(added[0].details.awb, 'JB-77889900');
  assert.equal(added[0].details.by, 'owner@shop.test');
  assert.equal(saved.courier.bookingState, 'booked');
  assert.equal(saved.courier.simulated, false);
  assert.equal(saved.courier.enteredByHand, true);
  assert.equal(saved.courier.status, 'Booked with the carrier (entered by hand)');
  assert.ok(orders.orderEvents(id).some((e) => e.event === 'tracking_entered'));

  const seen = orders.lookupOrder(id, phone)!;
  assert.equal(seen.courier.awbNumber, 'JB-77889900');
  assert.equal(seen.courier.trackingUrl, '');
  assert.equal((seen.courier as { carrier?: string }).carrier, undefined, 'no link: the courier stays unnamed');
});

test('a real booking is replaced only with the owner\'s confirm (also audited); another courier with a link is named to the customer', async () => {
  const { id, phone } = confirmedOrder('dispatched');
  orders.enterTracking(id, 'owner@shop.test', { carrier: 'echo', awb: 'ECO-1234567' });
  await assert.rejects(
    async () => orders.enterTracking(id, 'owner@shop.test', { carrier: 'other', carrierName: 'Aramex', awb: 'ARX998877', trackingUrl: 'https://www.aramex.com/track/ARX998877' }),
    (e: { status?: number; details?: { code?: string } }) => e.status === 409 && e.details?.code === 'tracking_replace'
  );
  assert.equal(orders.getOrder(id)!.courier.awbNumber, 'ECO-1234567', 'unchanged until confirmed');
  const before = auditEntries().length;
  const replaced = orders.enterTracking(id, 'owner@shop.test', { carrier: 'other', carrierName: 'Aramex', awb: 'ARX998877', trackingUrl: 'https://www.aramex.com/track/ARX998877', replace: true });
  const added = auditEntries().slice(before);
  assert.equal(added[0].action, 'order.tracking_replaced');
  assert.equal(added[0].details.replaced, 'ECO-1234567');
  assert.equal(replaced.courier.provider, 'manual');
  assert.equal(replaced.courier.carrierName, 'Aramex');
  const seen = orders.lookupOrder(id, phone)!;
  assert.equal(seen.courier.awbNumber, 'ARX998877');
  assert.equal(seen.courier.trackingUrl, 'https://www.aramex.com/track/ARX998877');
  assert.equal((seen.courier as { carrier?: string }).carrier, 'Aramex');
});

test('a hand-entered real booking is not booked again by the API, and a test booking replaces nothing', async () => {
  const { id } = confirmedOrder();
  orders.enterTracking(id, 'owner@shop.test', { carrier: 'jeebly', awb: 'JB-55554444' });
  const again = await dispatchOrder({ orderId: id, provider: 'jeebly', rebook: true, actor: 'owner@shop.test', testBooking: true });
  assert.equal(again.body.alreadyBooked, true);
  assert.equal(orders.getOrder(id)!.courier.awbNumber, 'JB-55554444');
});

test('only confirmed, dispatched or out-for-delivery orders take a tracking number', async () => {
  const p = listProducts()[0];
  const pending = orders.placeOrder({
    idempotencyKey: `tracking-pending-${Date.now()}-abcdef`,
    verificationToken: issuePhoneToken('+971509990001'),
    customer: { fullName: 'T', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order.id;
  assert.equal(await status(() => orders.enterTracking(pending, 'owner@shop.test', { carrier: 'jeebly', awb: 'JB-12345678' })), 409);
  orders.updateOrderByAdmin(pending, { status: 'cancelled' }, 'owner@shop.test');
  assert.equal(await status(() => orders.enterTracking(pending, 'owner@shop.test', { carrier: 'jeebly', awb: 'JB-12345678' })), 409);
  assert.equal(await status(() => orders.enterTracking('BUH-000000-NOPE00', 'owner@shop.test', { carrier: 'jeebly', awb: 'JB-12345678' })), 404);
});

test('the tracking route: admin only, size-capped body, allow-listed fields, https link checked for a public host', () => {
  const src = fs.readFileSync('src/app/api/admin/orders/[id]/tracking/route.ts', 'utf8');
  assert.match(src, /requireAdmin\(req\)/);
  assert.match(src, /readJsonBody\(req, 2 \* 1024\)/);
  assert.match(src, /allowFields\(body, \['carrier', 'carrierName', 'awb', 'trackingUrl', 'replace'\]\)/);
  assert.match(src, /assertPublicHttpsUrl\(link/);
  assert.match(src, /handleRouteError/);
});
