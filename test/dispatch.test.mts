import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const { dispatchOrder } = await import('@/lib/server/dispatch');
const { parseCourierSettings, parseOrderForDispatch } = await import('@/lib/server/courierInput');

// Mock carrier: count bookings and switch between answering and hanging up.
let carrierCalls = 0;
let mode: 'ok' | 'down' = 'ok';
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  carrierCalls++;
  if (mode === 'down') throw new TypeError('fetch failed');
  return new Response(JSON.stringify({ success: true, awbNumber: `JB${carrierCalls}` }), { status: 200 });
}) as typeof fetch;
afterEach(() => {
  mode = 'ok';
});
process.on('exit', () => {
  globalThis.fetch = realFetch;
});

const order = (id: string) =>
  parseOrderForDispatch({
    id,
    customer: { fullName: 'T', phone: '+971501234567', emirate: 'Dubai', area: 'Marina' },
    items: [{ title: 'Sheet', unitPrice: 100, quantity: 1 }],
    total: 100,
    paymentMethod: 'cod',
  });
const live = parseCourierSettings({ jeebly: { isLive: true }, echo: { isLive: true } });
const sandbox = parseCourierSettings({ jeebly: { isLive: false }, echo: {} });

test('regression: a live order is booked once; a repeat returns the same AWB without calling the carrier', async () => {
  carrierCalls = 0;
  const first = await dispatchOrder({ provider: 'jeebly', order: order('BUH-A'), settings: live, rebook: false });
  assert.equal(first.status, 200);
  assert.equal(first.body.awbNumber, 'JB1');
  const again = await dispatchOrder({ provider: 'jeebly', order: order('BUH-A'), settings: live, rebook: false });
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyBooked, true);
  assert.equal(again.body.awbNumber, 'JB1');
  assert.equal(carrierCalls, 1, 'the carrier was called once');
});

test('regression: after an unanswered attempt, booking again needs the owner to confirm', async () => {
  carrierCalls = 0;
  mode = 'down';
  const lost = await dispatchOrder({ provider: 'jeebly', order: order('BUH-B'), settings: live, rebook: false });
  assert.equal(lost.status, 502);
  assert.equal(lost.body.uncertain, true);
  assert.match(String(lost.body.message), /may or may not have been created/);

  mode = 'ok';
  const blocked = await dispatchOrder({ provider: 'jeebly', order: order('BUH-B'), settings: live, rebook: false });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.needsConfirm, true);
  assert.equal(carrierCalls, 1, 'no second booking without confirmation');

  const confirmed = await dispatchOrder({ provider: 'jeebly', order: order('BUH-B'), settings: live, rebook: true });
  assert.equal(confirmed.status, 200);
  assert.equal(carrierCalls, 2);
});

test('two clicks at once book once', async () => {
  carrierCalls = 0;
  const [a, b] = await Promise.all([
    dispatchOrder({ provider: 'jeebly', order: order('BUH-C'), settings: live, rebook: false }),
    dispatchOrder({ provider: 'jeebly', order: order('BUH-C'), settings: live, rebook: false }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(carrierCalls, 1);
});

test('sandbox bookings are not remembered (they are simulated)', async () => {
  mode = 'down';
  const a = await dispatchOrder({ provider: 'jeebly', order: order('BUH-D'), settings: sandbox, rebook: false });
  const b = await dispatchOrder({ provider: 'jeebly', order: order('BUH-D'), settings: sandbox, rebook: false });
  assert.equal(a.body.isSimulated, true);
  assert.equal(b.body.alreadyBooked, undefined);
});

test('an unknown emirate is refused before reaching the carrier', () => {
  assert.throws(() => parseOrderForDispatch({ id: 'X', customer: { fullName: 'T', phone: '1', emirate: 'Narnia', area: 'a' }, items: [{ title: 't', unitPrice: 1, quantity: 1 }], total: 1, paymentMethod: 'cod' }), /seven Emirates/);
});
