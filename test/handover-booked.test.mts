/**
 * "Handed over in person" for an order already booked with Jeebly (asked by the owner: "sometimes
 * I hand deliver or people pick it… just mark it as delivered"): the booking is cancelled with
 * Jeebly first (its answer audited), so the courier does not come; only when Jeebly confirms is the
 * order delivered. When Jeebly refuses, nothing changes until the owner says they cancelled it in
 * the portal ({ courierCancelled: true }), recorded as their word. Without the flag, still refused.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { installJeeblyMock, REPLIES } from './fixtures/jeebly-mock.mjs';

const dir = tempDataDir();
const orders = await import('@/lib/server/orders');
const { handOverInPerson } = await import('@/lib/server/jeeblyOps');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings } = await import('@/lib/server/settings');
const { dispatchOrder } = await import('@/lib/server/dispatch');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');

type Mock = { calls: Array<{ path: string; body: Record<string, unknown> }>; restore: () => void };
let awbN = 880000;
const jeebly = (script: Record<string, unknown> = {}): Mock => installJeeblyMock({ create: () => REPLIES.created(`JB${++awbN}`), ...script });
let mock: Mock = jeebly();
afterEach(() => {
  mock.restore();
  mock = jeebly();
  _clearAllRateLimits();
});
const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const PICKUP = { pickupPhone: '+971501112222', pickupUnit: 'Shop 4', pickupBuilding: 'Barsha Tower', pickupArea: 'Al Barsha 1', pickupLandmark: 'Near the mall', pickupEmirate: 'Dubai' };
await updateSettings('store', { whatsappNumber: '+971501234567' });
await updateSettings('courier', { jeebly: { ...PICKUP, isLive: true, liveBaseUrl: 'https://live.jeebly.com', apiKey: 'LIVE-KEY-1', clientKey: 'LIVE-CLIENT-1', sandboxApiKey: 'SB-KEY-1', sandboxClientKey: 'SB-CLIENT-1' } }, { liveOverride: true });

let n = 6000;
async function booked(): Promise<{ id: string; awb: string; total: number }> {
  const p = listProducts()[0];
  const phone = `+97150${String(++n).padStart(7, '0')}`;
  const order = orders.placeOrder({
    idempotencyKey: `hb-${n}-${Date.now()}-abcdefgh`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Mounika Test', emirate: 'Abu Dhabi', area: 'Khalifa City', streetAddress: 's', buildingVilla: 'C1', flatVillaNo: '605' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
  const res = await dispatchOrder({ orderId: order.id, provider: 'jeebly', rebook: false, actor: OWNER, weightKg: 1.4 });
  assert.equal(res.status, 200, String(res.body.message));
  return { id: order.id, awb: String(res.body.awbNumber), total: order.total };
}
const audits = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> }));

test('asked: a booked order handed over in person: Jeebly cancels the booking first, then it is delivered with the cash; once', async () => {
  const { id, awb, total } = await booked();
  mock.restore();
  mock = jeebly({ cancel: () => REPLIES.cancelled });
  // Without asking to cancel the courier: refused as before (nothing changes).
  await assert.rejects(handOverInPerson(id, { cashReceived: true }, OWNER), (e) => code(e) === 'courier_booked');
  assert.equal(orders.getOrder(id)!.status, 'confirmed');
  const r = await handOverInPerson(id, { cashReceived: true, cancelCourier: true }, OWNER);
  assert.equal(r.changed, true);
  assert.deepEqual([r.order.status, r.order.paymentStatus], ['delivered', 'paid']);
  assert.equal(r.order.handedOver?.cash, total);
  assert.equal(r.order.courier.awbNumber, awb, 'the AWB stays on the record');
  assert.equal(r.order.courier.bookingState, undefined);
  const cancels = mock.calls.filter((c) => c.path === 'cancel_shipment');
  assert.equal(cancels.length, 1, 'cancelled with Jeebly once');
  assert.equal(cancels[0].body.reference_number, awb);
  const a = audits();
  assert.ok(a.some((x) => x.action === 'courier.cancel' && x.details?.cancelled === true && x.details?.awb === awb), 'Jeebly’s answer audited');
  assert.equal(a.filter((x) => x.action === 'order.handed_over').at(-1)?.details?.courierCancelled, 'carrier_confirmed');
  // Again: nothing more (no second cancel).
  const again = await handOverInPerson(id, { cashReceived: true, cancelCourier: true }, OWNER);
  assert.equal(again.changed, false);
  assert.equal(mock.calls.filter((c) => c.path === 'cancel_shipment').length, 1);
});

test('Jeebly refuses the cancel: nothing is delivered; the owner’s "I cancelled it in the portal" hands it over, recorded as theirs', async () => {
  const { id, awb } = await booked();
  mock.restore();
  mock = jeebly({ cancel: () => REPLIES.cancelAgain });
  await assert.rejects(handOverInPerson(id, { cashReceived: true, cancelCourier: true }, OWNER), (e) => code(e) === 'courier_not_cancelled');
  const still = orders.getOrder(id)!;
  assert.equal(still.status, 'confirmed', 'not delivered on a refusal');
  assert.equal(still.attention?.kind, 'booked_after_cancel', 'flagged: cancel it in the portal');
  const r = await handOverInPerson(id, { cashReceived: true, cancelCourier: true, courierCancelled: true }, OWNER);
  assert.equal(r.order.status, 'delivered');
  assert.equal(orders.getOrder(id)!.attention, undefined, 'the portal flag is done');
  const last = audits().filter((x) => x.action === 'order.handed_over').at(-1);
  assert.deepEqual([last?.details?.courierCancelled, last?.details?.awb], ['owner_confirmed', awb]);
});

test('checked: the flags are true or false, nothing else; unknown fields refused', async () => {
  const { id } = await booked();
  for (const body of [{ cancelCourier: 'yes' }, { courierCancelled: 1 }, { cancel: true }]) {
    await assert.rejects(handOverInPerson(id, body, OWNER), (e: { status?: number }) => e.status === 400, JSON.stringify(body));
  }
  assert.equal(mock.calls.filter((c) => c.path === 'cancel_shipment').length, 0, 'a bad request cancels nothing');
});
