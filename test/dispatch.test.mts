import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const { dispatchOrder } = await import('@/lib/server/dispatch');
const { getOrder, placeOrder, updateOrderByAdmin } = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings, getSettings } = await import('@/lib/server/settings');

// Mock carrier: count bookings and switch between answering and hanging up.
let carrierCalls = 0;
let mode: 'ok' | 'down' = 'ok';
let lastKey = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
  carrierCalls++;
  lastKey = String((init?.headers as Record<string, string>)?.XApiKey ?? '');
  if (mode === 'down') throw new TypeError('fetch failed');
  return new Response(JSON.stringify({ success: true, awbNumber: `JB${carrierCalls}` }), { status: 200 });
}) as typeof fetch;
afterEach(() => {
  mode = 'ok';
});
process.on('exit', () => {
  globalThis.fetch = realFetch;
});

function newOrder() {
  const p = listProducts()[0];
  return placeOrder({
    idempotencyKey: `dispatch-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    verificationToken: issuePhoneToken('+971501234567'),
    customer: { fullName: 'T', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order.id;
}

const live = async (on: boolean) => updateSettings('courier', { jeebly: { isLive: on, apiKey: 'jb-live-key' }, echo: { isLive: on } });
const book = (orderId: string, rebook = false) => dispatchOrder({ orderId, provider: 'jeebly', rebook, actor: 'test' });

test('dispatch uses the courier keys saved on the server and records the AWB on the order', async () => {
  await live(true);
  carrierCalls = 0;
  const id = newOrder();
  const res = await book(id);
  assert.equal(res.status, 200);
  assert.equal(lastKey, 'jb-live-key');
  const order = getOrder(id)!;
  assert.equal(order.courier.awbNumber, 'JB1');
  assert.equal(order.courier.bookingState, 'booked');
  assert.equal(order.status, 'confirmed');
});

test('regression: a live order is booked once; a repeat returns the same AWB without calling the carrier', async () => {
  await live(true);
  carrierCalls = 0;
  const id = newOrder();
  const first = await book(id);
  const again = await book(id);
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyBooked, true);
  assert.equal(again.body.awbNumber, first.body.awbNumber);
  assert.equal(carrierCalls, 1, 'the carrier was called once');
});

test('regression: after an unanswered attempt, booking again needs the owner to confirm', async () => {
  await live(true);
  carrierCalls = 0;
  const id = newOrder();
  mode = 'down';
  const lost = await book(id);
  assert.equal(lost.status, 502);
  assert.equal(lost.body.uncertain, true);
  assert.equal(getOrder(id)!.courier.bookingState, 'uncertain');

  mode = 'ok';
  const blocked = await book(id);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.needsConfirm, true);
  assert.equal(carrierCalls, 1, 'no second booking without confirmation');

  const confirmed = await book(id, true);
  assert.equal(confirmed.status, 200);
  assert.equal(carrierCalls, 2);
});

test('two clicks at once book once', async () => {
  await live(true);
  carrierCalls = 0;
  const id = newOrder();
  const [a, b] = await Promise.all([book(id), book(id)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(carrierCalls, 1);
});

test('sandbox bookings are labelled simulated and not remembered as live', async () => {
  await live(false);
  mode = 'down';
  const id = newOrder();
  const a = await book(id);
  assert.equal(a.body.isSimulated, true);
  assert.equal(getOrder(id)!.courier.simulated, true);
  assert.equal(getOrder(id)!.courier.bookingState, undefined);
});

test('cancelled orders cannot be booked; unknown orders are refused', async () => {
  const id = newOrder();
  updateOrderByAdmin(id, { status: 'cancelled' }, 'test');
  await assert.rejects(book(id), (e: { status?: number }) => e.status === 409);
  await assert.rejects(book('BUH-000000-NOPE00'), (e: { status?: number }) => e.status === 404);
  assert.ok(getSettings('courier'));
});
