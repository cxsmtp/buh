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
let mode: 'ok' | 'down' | 'reject' = 'ok';
let lastKey = '';
let lastUrl = '';
// The shop's Jeebly calls go to the function at this symbol when one is set (src/lib/jeeblyApi.ts).
const JEEBLY_FETCH = Symbol.for('buh.jeebly.fetch');
(globalThis as Record<symbol, unknown>)[JEEBLY_FETCH] = (async (url: unknown, init?: RequestInit) => {
  carrierCalls++;
  lastUrl = String(url);
  lastKey = String((init?.headers as Record<string, string>)?.['X-API-KEY'] ?? '');
  if (mode === 'down') throw new TypeError('fetch failed');
  // Jeebly's own replies (demo system, 2026-10-19): a string success and "AWB No".
  if (mode === 'reject') return new Response(JSON.stringify({ success: 'false', message: 'Invalid API Token' }), { status: 400 });
  return new Response(JSON.stringify({ success: 'true', message: 'Created Successfully. ', 'AWB No': `JB${1000 + carrierCalls}` }), { status: 200 });
}) as typeof fetch;
afterEach(() => {
  mode = 'ok';
});

let phoneN = 1000;
function newOrder() {
  const p = listProducts()[0];
  return placeOrder({
    idempotencyKey: `dispatch-${Math.random().toString(36).slice(2)}-${Date.now()}`,
    verificationToken: issuePhoneToken(`+97150${String(++phoneN).padStart(7, '0')}`),
    customer: { fullName: 'T', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order.id;
}

// Live mode is switched on here with the override (the Sandbox check gate is tested in courier-live-gate.test.mts).
const live = async (on: boolean) =>
  updateSettings(
    'courier',
    {
      jeebly: {
        isLive: on,
        liveBaseUrl: 'https://live.jeebly.com',
        apiKey: 'jb-live-key',
        clientKey: 'jb-live-client',
        sandboxApiKey: 'jb-sandbox-key',
        sandboxClientKey: 'jb-sandbox-client',
        pickupPhone: '+971501112222',
        pickupUnit: 'Shop 1',
        pickupBuilding: 'Barsha Tower',
        pickupArea: 'Al Barsha 1',
        pickupLandmark: 'Near the mall',
      },
      echo: { isLive: false },
    },
    { liveOverride: true }
  );
const book = (orderId: string, rebook = false, testBooking = false) => dispatchOrder({ orderId, provider: 'jeebly', rebook, actor: 'test', testBooking, weightKg: 2 });

test('regression: a size with no weight is never booked with a guessed weight', async () => {
  await live(true);
  carrierCalls = 0;
  const id = newOrder();
  assert.equal(getOrder(id)!.courier.weightKg, 0, 'the sample sizes have no weight: unknown, not 2.5 kg');
  await assert.rejects(dispatchOrder({ orderId: id, provider: 'jeebly', rebook: false, actor: 'test' }), (e: { details?: { code?: string } }) => e.details?.code === 'weight_required');
  assert.equal(carrierCalls, 0);
  const ok = await book(id);
  assert.equal(ok.status, 200);
  assert.equal(getOrder(id)!.courier.weightKg, 2);
});

test('dispatch uses the courier keys saved on the server and records the AWB on the order', async () => {
  await live(true);
  carrierCalls = 0;
  const id = newOrder();
  const res = await book(id);
  assert.equal(res.status, 200);
  assert.equal(lastKey, 'jb-live-key');
  const order = getOrder(id)!;
  assert.equal(order.courier.awbNumber, 'JB1001');
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

test('Test mode asks first: no test booking without the owner\'s explicit yes', async () => {
  await live(false);
  carrierCalls = 0;
  const id = newOrder();
  await assert.rejects(book(id), (e: { status?: number; details?: { code?: string; needsTestConfirm?: boolean } }) => e.status === 409 && e.details?.code === 'test_booking' && e.details.needsTestConfirm === true);
  assert.equal(carrierCalls, 0);
  assert.equal(getOrder(id)!.courier.awbNumber, '');
});

test('sandbox bookings go to Jeebly\'s sandbox with the sandbox keys, are labelled tests and not remembered as live', async () => {
  await live(false);
  const id = newOrder();
  const a = await book(id, false, true);
  assert.equal(a.status, 200);
  assert.equal(a.body.isSimulated, true);
  assert.equal(lastKey, 'jb-sandbox-key');
  assert.match(lastUrl, /^https:\/\/demo\.jeebly\.com\/customer\/create_shipment$/);
  const c = getOrder(id)!.courier;
  assert.equal(c.simulated, true);
  assert.equal(c.testKind, 'sandbox');
  assert.equal(c.bookingState, undefined);
  assert.match(c.status, /Test booking/);
});

test('regression: when the sandbox refuses or is down, nothing is invented or recorded', async () => {
  await live(false);
  for (const m of ['down', 'reject'] as const) {
    mode = m;
    const id = newOrder();
    const res = await book(id, false, true);
    assert.equal(res.status, 502, m);
    assert.equal(res.body.success, false);
    assert.equal(res.body.awbNumber, '');
    const c = getOrder(id)!.courier;
    assert.equal(c.awbNumber, '', `${m}: no AWB on the order`);
    assert.equal(c.simulated, undefined);
    assert.equal(c.bookingState, undefined, `${m}: no uncertain state for a sandbox attempt`);
  }
});

test('regression: a test booking does not block a real one; a real one is never booked twice or replaced by a test', async () => {
  await live(false);
  const id = newOrder();
  const t = await book(id, false, true);
  assert.equal(t.body.isSimulated, true);
  await live(true);
  carrierCalls = 0;
  const real = await book(id);
  assert.equal(real.status, 200);
  assert.equal(real.body.isSimulated, false);
  assert.equal(lastKey, 'jb-live-key');
  let c = getOrder(id)!.courier;
  assert.equal(c.simulated, false);
  assert.equal(c.testKind, undefined);
  assert.equal(c.bookingState, 'booked');
  assert.equal(c.awbNumber, real.body.awbNumber);

  // rebook does not book a real booking again; neither does a test booking after Live is off.
  const again = await book(id, true);
  assert.equal(again.body.alreadyBooked, true);
  await live(false);
  const test2 = await book(id, false, true);
  assert.equal(test2.body.alreadyBooked, true);
  assert.equal(carrierCalls, 1, 'the carrier was called once');
  c = getOrder(id)!.courier;
  assert.equal(c.awbNumber, real.body.awbNumber);
  assert.equal(c.simulated, false);
});

test('Eco Express live refuses clearly and nothing is sent', async () => {
  await updateSettings('courier', { echo: { isLive: true } });
  carrierCalls = 0;
  const id = newOrder();
  await assert.rejects(dispatchOrder({ orderId: id, provider: 'echo', rebook: false, actor: 'test', testBooking: true }), (e: { status?: number; message?: string }) => e.status === 409 && /isn't connected yet.*Enter tracking number/.test(e.message ?? ''));
  assert.equal(carrierCalls, 0);
  assert.equal(getOrder(id)!.courier.awbNumber, '');
  await updateSettings('courier', { echo: { isLive: false } });
});

test('cancelled orders cannot be booked; unknown orders are refused', async () => {
  const id = newOrder();
  updateOrderByAdmin(id, { status: 'cancelled' }, 'test');
  await assert.rejects(book(id), (e: { status?: number }) => e.status === 409);
  await assert.rejects(book('BUH-000000-NOPE00'), (e: { status?: number }) => e.status === 404);
  assert.ok(getSettings('courier'));
});

test('review M1: a test booking never wipes an unanswered live attempt, so a second live booking still needs the confirm', async () => {
  await live(true);
  carrierCalls = 0;
  const id = newOrder();
  mode = 'down';
  assert.equal((await book(id)).body.uncertain, true);
  assert.equal(getOrder(id)!.courier.bookingState, 'uncertain');
  mode = 'ok';

  // Switched to Test mode: still asked first, in any mode.
  await live(false);
  const asked = await book(id, false, true);
  assert.equal(asked.status, 409);
  assert.equal(asked.body.needsConfirm, true);
  assert.equal(carrierCalls, 1, 'nothing sent');
  // Confirmed: the test booking is made, but the unanswered live attempt is still remembered.
  const test = await book(id, true, true);
  assert.equal(test.status, 200);
  assert.equal(test.body.isSimulated, true);
  assert.equal(getOrder(id)!.courier.bookingState, 'uncertain', 'not overwritten by the test result');

  // Back to Live: no second real booking without the owner's confirm.
  await live(true);
  const again = await book(id);
  assert.equal(again.status, 409);
  assert.equal(again.body.needsConfirm, true);
  assert.equal(carrierCalls, 2, 'only the sandbox test was sent since');
});
