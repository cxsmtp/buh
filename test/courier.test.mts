import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createJeeblyShipment } from '@/lib/jeebly';
import { createEchoShipment } from '@/lib/echo';
import type { CourierSettings, Order } from '@/types';

// A mock carrier with scenario switches: down, rejecting, accepting without an AWB, or healthy.
type Scenario = 'down' | 'reject' | 'no-awb' | 'ok';
const realFetch = globalThis.fetch;
function mockCarrier(scenario: Scenario) {
  globalThis.fetch = (async () => {
    if (scenario === 'down') throw new TypeError('fetch failed');
    if (scenario === 'reject') return new Response(JSON.stringify({ success: false, message: 'Invalid API Token' }), { status: 401 });
    if (scenario === 'no-awb') return new Response(JSON.stringify({ success: true, data: [{}] }), { status: 200 });
    return new Response(JSON.stringify({ success: true, awbNumber: 'JB123', data: [{ awbNo: 'EC123' }] }), { status: 200 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

const order = {
  id: 'BUH-1',
  customer: { fullName: 'T', phone: '+971501234567', emirate: 'Dubai', area: 'Marina', streetAddress: 'x', buildingVilla: 'y', flatVillaNo: '1' },
  items: [{ title: 'Sheet', profileName: 'King', unitPrice: 100, quantity: 1 }],
  total: 100,
  paymentMethod: 'cod',
  courier: {},
} as unknown as Order;
const jeebly = (isLive: boolean) => ({ isLive }) as CourierSettings['jeebly'];
const echo = (isLive: boolean) => ({ isLive }) as CourierSettings['echo'];

test('regression: live bookings never invent an AWB when the carrier fails', async () => {
  for (const scenario of ['down', 'reject', 'no-awb'] as const) {
    mockCarrier(scenario);
    const j = await createJeeblyShipment(order, jeebly(true));
    assert.equal(j.success, false, `jeebly ${scenario}`);
    assert.equal(j.awbNumber, '', `jeebly ${scenario}`);
    const e = await createEchoShipment(order, echo(true));
    assert.equal(e.success, false, `echo ${scenario}`);
    assert.equal(e.awbNumber, '', `echo ${scenario}`);
  }
});

test('live bookings use the carrier AWB; sandbox ones are labelled simulated', async () => {
  mockCarrier('ok');
  assert.equal((await createJeeblyShipment(order, jeebly(true))).awbNumber, 'JB123');
  assert.equal((await createEchoShipment(order, echo(true))).awbNumber, 'EC123');

  mockCarrier('down');
  const sandbox = await createJeeblyShipment(order, jeebly(false));
  assert.equal(sandbox.isSimulated, true);
  assert.match(sandbox.message, /simulated/i);
});
