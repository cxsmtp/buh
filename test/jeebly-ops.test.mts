/**
 * A booking's life at Jeebly, against Jeebly's exact replies (demo system, 2026-10-19): the label
 * PDF fetched on the server (a real PDF only), tracking mapped and cached (no phones, rider, proof
 * or signature), and cancelling with the order: audited before it is reported, a refusal said and
 * flagged, never claimed as done.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { installJeeblyMock } from './fixtures/jeebly-mock.mjs';

const dir = tempDataDir();
const orders = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings } = await import('@/lib/server/settings');
const { dispatchOrder } = await import('@/lib/server/dispatch');
const ops = await import('@/lib/server/jeeblyOps');

type Call = { host: string; path: string; body: Record<string, unknown> };
type Mock = { calls: Call[]; restore: () => void; setStatus: (awb: string, s: string) => void };
let mock: Mock = installJeeblyMock();
afterEach(() => {
  mock.restore();
  mock = installJeeblyMock();
});

const PICKUP = { pickupPhone: '+971501112222', pickupUnit: 'Shop 4', pickupBuilding: 'Barsha Tower', pickupArea: 'Al Barsha 1', pickupLandmark: 'Near the mall', pickupEmirate: 'Dubai' };
await updateSettings(
  'courier',
  { jeebly: { ...PICKUP, isLive: true, liveBaseUrl: 'https://live.jeebly.com', apiKey: 'LIVE-KEY-1', clientKey: 'LIVE-CLIENT-1', sandboxApiKey: 'SB-KEY-1', sandboxClientKey: 'SB-CLIENT-1' } },
  { liveOverride: true }
);

let n = 3000;
async function booked(): Promise<{ id: string; phone: string; awb: string }> {
  const p = listProducts()[0];
  const phone = `+97150${String(++n).padStart(7, '0')}`;
  const id = orders.placeOrder({
    idempotencyKey: `ops-${n}-${Date.now()}-abcdefgh`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Aisha Test', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order.id;
  const res = await dispatchOrder({ orderId: id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test', weightKg: 1.4 });
  assert.equal(res.status, 200, String(res.body.message));
  return { id, phone, awb: String(res.body.awbNumber) };
}
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('a live booking: Jeebly\'s AWB, on the live system; its label is the PDF Jeebly makes', async () => {
  const { id, awb } = await booked();
  const order = orders.getOrder(id)!;
  assert.equal(order.courier.carrierEnv, 'live');
  assert.equal(order.courier.bookingState, 'booked');
  assert.equal(order.courier.trackingUrl, '');
  const label = await ops.jeeblyLabelFor(order);
  assert.ok('pdf' in label);
  assert.equal(label.pdf.subarray(0, 5).toString(), '%PDF-');
  const last = mock.calls.at(-1)!;
  assert.equal(last.host, 'live.jeebly.com');
  assert.equal(last.path, 'generate_shipment_label');
  assert.deepEqual(last.body, { reference_number: awb });
});

test('only a real PDF is passed on: a JSON refusal or anything else is an error', async () => {
  const { id } = await booked();
  mock.restore();
  mock = installJeeblyMock({ label: () => ({ status: 400, body: { success: 'false', message: 'Invalid Customer Key Or Shipment Number' } }) });
  const refused = await ops.jeeblyLabelFor(orders.getOrder(id)!);
  assert.ok('error' in refused && /HTTP 400.*Invalid Customer Key Or Shipment Number/.test(refused.error));
  mock.restore();
  mock = installJeeblyMock({ label: () => new Response('<html>not a pdf</html>', { status: 200, headers: { 'content-type': 'application/pdf' } }) });
  assert.ok('error' in (await ops.jeeblyLabelFor(orders.getOrder(id)!)), 'says PDF but is not one');
  const practice = { ...orders.getOrder(id)!, courier: { ...orders.getOrder(id)!.courier, testKind: 'practice' as const, simulated: true } };
  assert.ok('error' in (await ops.jeeblyLabelFor(practice)), 'a practice booking has no Jeebly label');
});

test('tracking: mapped (no phones, rider, proof or signature), kept 5 minutes, refreshed on request; never moves the order', async () => {
  const { id, awb } = await booked();
  const order = orders.getOrder(id)!;
  const first = await ops.customerTracking(order);
  assert.equal(first!.lastStatus, 'Pickup Scheduled');
  assert.equal(first!.events[0].hub, 'DXB');
  const before = mock.calls.filter((c) => c.path === 'track_shipment').length;
  await ops.customerTracking(order);
  assert.equal(mock.calls.filter((c) => c.path === 'track_shipment').length, before, 'cached');
  mock.setStatus(awb, 'Delivered');
  const fresh = await ops.jeeblyTrackingFor(order, { fresh: true });
  assert.ok(!('error' in fresh));
  assert.equal(fresh.lastStatus, 'Delivered');
  assert.doesNotMatch(JSON.stringify(fresh), /9715|Rider Name|R42|pod\.example|sig\.example|phone/);
  assert.equal(orders.getOrder(id)!.status, 'confirmed', 'shown only: the owner marks delivered');
  const unknown = { ...order, courier: { ...order.courier, awbNumber: 'JB000000' } };
  assert.ok('error' in (await ops.jeeblyTrackingFor(unknown, { fresh: true })));
  assert.equal(await ops.customerTracking({ ...order, courier: { ...order.courier, simulated: true, testKind: 'sandbox' } }), undefined, 'a test booking is not shown to customers');
});

test('cancelling the order cancels the Jeebly booking: audited before it is reported; a refusal is said and flagged', async () => {
  const { id, awb } = await booked();
  orders.updateOrderByAdmin(id, { status: 'cancelled' }, 'owner@shop.test');
  const before = auditEntries().length;
  const ok = await ops.cancelJeeblyBooking(orders.getOrder(id)!, 'owner@shop.test');
  assert.deepEqual([ok.attempted, ok.cancelled], [true, true]);
  assert.match(ok.message, /Jeebly cancelled the shipment .*Shipment cancelled successfully/);
  const entry = auditEntries().slice(before).find((e) => e.action === 'courier.cancel')!;
  assert.equal(entry.details.cancelled, true);
  assert.equal(entry.details.awb, awb);
  assert.equal(orders.getOrder(id)!.courier.status, 'Cancelled with the carrier');

  // Jeebly refuses (already cancelled, picked up…): never claimed, the owner is told and the order flagged.
  const second = await booked();
  orders.updateOrderByAdmin(second.id, { status: 'cancelled' }, 'owner@shop.test');
  mock.restore();
  mock = installJeeblyMock({ cancel: () => ({ status: 400, body: { success: 'false1', message: 'Shipment can not be Cancel' } }) });
  const refused = await ops.cancelJeeblyBooking(orders.getOrder(second.id)!, 'owner@shop.test');
  assert.equal(refused.cancelled, false);
  assert.match(refused.message, /did not cancel .*HTTP 400: "Shipment can not be Cancel".*Cancel it in the Jeebly portal/);
  assert.ok(auditEntries().some((e) => e.action === 'courier.cancel' && e.details.cancelled === false && e.details.awb === second.awb));
  assert.equal(orders.getOrder(second.id)!.attention?.kind, 'booked_after_cancel');
});

test('the order routes cancel with Jeebly after the order is cancelled, and report what Jeebly said (source)', () => {
  const patch = fs.readFileSync('src/app/api/admin/orders/[id]/route.ts', 'utf8');
  assert.ok(patch.indexOf('updateOrderByAdmin(id, body') < patch.indexOf('cancelJeeblyBooking('));
  assert.match(fs.readFileSync('src/app/api/admin/orders/[id]/refund/route.ts', 'utf8'), /cancelJeeblyBooking\(/);
  const label = fs.readFileSync('src/app/api/admin/orders/[id]/carrier-label/route.ts', 'utf8');
  assert.match(label, /requireAdmin\(req\)/);
  assert.ok(label.indexOf("auditOrThrow('courier.label_printed'") < label.indexOf('new Response('), 'audited before it is sent');
  assert.match(label, /'Content-Type': 'application\/pdf'/);
});
