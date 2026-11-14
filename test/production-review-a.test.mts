/**
 * BUH-02.44.00: the money, checkout and shipping faults found by the production-readiness review.
 * Each test failed before its fix:
 *  - an order from a photo: correcting the amount keeps the extra to collect, and is refused once
 *    the courier has the parcel's amount;
 *  - a payment moved onto an order comes back to the paid order when that order is cancelled;
 *  - a credit move sent twice (double tap) moves once; an extra can't be added to an unpaid card order;
 *  - a bulk order already paid in cash is not collected again by the courier;
 *  - the same checkout sent again for something else (another way of paying, other items) is
 *    refused, never answered with "Thank you" for the first order;
 *  - a booking the courier never answered counts as booked for a handover; nothing is cancelled
 *    with the courier for a handover request that is refused anyway;
 *  - a booking that comes back after a handover is flagged; a hand-entered booking is flagged
 *    when its order is cancelled; a cancelled order shows no tracking number;
 *  - no same-day delivery on Sundays; an unpaid bank transfer is sent out only on the owner's word;
 *  - the courier gets whole pieces, kilograms rounded up, the street before the landmark;
 *  - a real shop starts without the sample products; the hub may use the camera (QR scanner).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { installJeeblyMock, REPLIES } from './fixtures/jeebly-mock.mjs';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const orders = await import('@/lib/server/orders');
const { handOverInPerson, cancelJeeblyBooking } = await import('@/lib/server/jeeblyOps');
const { listProducts } = await import('@/lib/server/products');
const { getSettings, updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');
const { buildJeeblyPayload } = await import('@/lib/jeebly');
const { deliveryCheck } = await import('@/lib/delivery');
const { dueOnDeliveryFils } = await import('@/lib/orderMoney');

type Mock = { calls: Array<{ path: string; body: Record<string, unknown> }>; restore: () => void };
let mock: Mock = installJeeblyMock({ create: () => REPLIES.created('JB770001') });
afterEach(() => {
  mock.restore();
  mock = installJeeblyMock({ create: () => REPLIES.created('JB770001') });
  _clearAllRateLimits();
});

const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const PNG = `data:image/png;base64,${fs.readFileSync('test/fixtures/sheet-indigo.png').toString('base64')}`;
const BANK = { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' };
await updateSettings('store', { whatsappNumber: '+971501234567', photoOrders: true });
await updateSettings('bank', BANK);
const PICKUP = { pickupPhone: '+971501112222', pickupUnit: 'Shop 4', pickupBuilding: 'Barsha Tower', pickupArea: 'Al Barsha 1', pickupLandmark: 'Near the mall', pickupEmirate: 'Dubai' };
await updateSettings('courier', { jeebly: { ...PICKUP, isLive: true, liveBaseUrl: 'https://live.jeebly.com', apiKey: 'LIVE-KEY-1', clientKey: 'LIVE-CLIENT-1', sandboxApiKey: 'SB-KEY-1', sandboxClientKey: 'SB-CLIENT-1' } }, { liveOverride: true });

let n = 0;
function body(over: Record<string, unknown> = {}, phone?: string) {
  const p = listProducts()[0];
  n++;
  return {
    idempotencyKey: `review-a-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    customer: { fullName: 'Rohini R Nair', phone: phone ?? `+9715055${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
    ...over,
  };
}
function place(over: Record<string, unknown> = {}, phone?: string) {
  _clearAllRateLimits();
  return orders.placeOrder(body(over, phone), { ip: `10.9.${n}.1` }).order;
}
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
const attention = (id: string) => orders.getOrder(id)!.attention;

test('an order from a photo: correcting the amount keeps the extra to collect; refused once the courier has the amount', () => {
  const o = place({ items: [], photo: { photos: [PNG], amount: 350 } });
  orders.confirmPhotoAmount(o.id, 350, OWNER);
  const withExtra = orders.setExtraCharge(o.id, 40, 'gift wrap', OWNER).order;
  assert.equal(withExtra.total, 390);
  const corrected = orders.confirmPhotoAmount(o.id, 420, OWNER).order;
  assert.equal(corrected.total, 460, 'the agreed amount and the extra');
  assert.equal(corrected.courier.codAmountCollected, 460);
  assert.equal(getDb().prepare('SELECT total_fils FROM orders WHERE id = ?').pluck().get(o.id), 46000);
  orders.recordBooking(o.id, OWNER, { provider: 'jeebly', awbNumber: 'JB990011', bookingState: 'booked' });
  assert.throws(() => orders.confirmPhotoAmount(o.id, 300, OWNER), (e) => code(e) === 'collect_locked');
  assert.equal(orders.getOrder(o.id)!.total, 460, 'the courier collects what the booking said');
});

test('a payment moved onto an order comes back to the paid order when that order is cancelled', () => {
  const phone = '+971505599001';
  const paid = paidByCard(place({}, phone).id);
  const other = place({}, phone);
  const move = Math.min(paid.total, other.total);
  orders.moveCredit(paid.id, other.id, move, OWNER, 'key-move-0001');
  assert.equal(orders.refundableFils(orders.getOrder(paid.id)!), Math.round((paid.total - move) * 100));
  orders.updateOrderByAdmin(other.id, { status: 'cancelled' }, OWNER);
  const from = orders.getOrder(paid.id)!;
  const to = orders.getOrder(other.id)!;
  assert.equal(to.creditsIn, undefined, 'the cancelled order holds no payment');
  assert.deepEqual(from.creditsOut ?? [], [], 'it is back on the order that was paid');
  assert.equal(orders.refundableFils(from), Math.round(paid.total * 100), 'and can be refunded or moved again');
  assert.ok(audits().some((a) => a.action === 'order.credit_returned' && a.details?.fromOrderId === other.id && a.details?.toOrderId === paid.id));
});

test('a credit move sent twice with the same key moves once; a different amount is checked as usual', () => {
  const phone = '+971505599002';
  const paid = paidByCard(place({}, phone).id);
  const other = place({ items: [{ productId: listProducts()[0].id, profileId: listProducts()[0].profiles[0].id, quantity: 2 }] }, phone);
  const half = Math.round(paid.total * 50) / 100;
  const first = orders.moveCredit(paid.id, other.id, half, OWNER, 'double-tap-key-1');
  const again = orders.moveCredit(paid.id, other.id, half, OWNER, 'double-tap-key-1');
  assert.equal(again.to.creditsIn?.length, 1, 'once');
  assert.deepEqual(again.from.creditsOut?.map((c) => c.amount), first.from.creditsOut?.map((c) => c.amount));
  assert.equal(dueOnDeliveryFils(again.to), Math.round((other.total - half) * 100));
  assert.throws(() => orders.moveCredit(paid.id, other.id, half, OWNER, 'bad key!'), (e: { status?: number }) => e.status === 400);
});

test('an extra to collect is refused on a card order that is not paid yet', () => {
  const o = place();
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'pending', status = 'pending_payment', data = json_set(json_set(data, '$.paymentMethod', 'online_card'), '$.status', 'pending_payment') WHERE id = ?").run(o.id);
  assert.throws(() => orders.setExtraCharge(o.id, 25, 'extra', OWNER), (e) => code(e) === 'card_unpaid');
});

test('a bulk order already paid in cash: the courier collects nothing but an extra', () => {
  const o = place();
  assert.equal(dueOnDeliveryFils(o), Math.round(o.total * 100));
  const bulkPaid = { ...o, bulk: { paidWith: 'cash' } as never, paymentStatus: 'paid' as const };
  assert.equal(dueOnDeliveryFils(bulkPaid), 0);
  assert.equal(buildJeeblyPayload(bulkPaid, getSettings('courier').jeebly, { shopName: 'Shop', email: '' }).payment_type, 'PREPAID');
  assert.equal(dueOnDeliveryFils({ ...bulkPaid, extraCharge: { amount: 15, note: '', by: OWNER, at: '' } as never }), 1500);
});

test('the same checkout sent again: the same order back; for something else it is refused, never "Thank you" for the first', () => {
  _clearAllRateLimits();
  const first = body();
  const made = orders.placeOrder(first, { ip: '10.9.200.1' });
  assert.equal(made.created, true);
  const again = orders.placeOrder(first, { ip: '10.9.200.1' });
  assert.deepEqual([again.created, again.order.id], [false, made.order.id]);
  assert.throws(() => orders.placeOrder({ ...first, paymentMethod: 'bank_transfer' }, { ip: '10.9.200.1' }), (e) => code(e) === 'checkout_changed');
  assert.throws(() => orders.placeOrder({ ...first, items: [{ ...first.items[0], quantity: 2 }] }, { ip: '10.9.200.1' }), (e) => code(e) === 'checkout_changed');
  assert.equal(orders.getOrder(made.order.id)!.paymentMethod, 'cod');
});

test('a booking the courier never answered counts as booked: handed over only on the owner’s word that the portal shows none', async () => {
  const o = place();
  orders.recordBooking(o.id, OWNER, { provider: 'jeebly', bookingState: 'uncertain' });
  assert.equal(orders.courierStillBooked(orders.getOrder(o.id)!), true);
  assert.throws(() => orders.handOverOrder(o.id, {}, OWNER), (e) => code(e) === 'courier_booked');
  await assert.rejects(() => handOverInPerson(o.id, { cancelCourier: true }, OWNER), (e) => code(e) === 'courier_not_cancelled');
  assert.equal(orders.getOrder(o.id)!.status !== 'delivered', true);
  const done = await handOverInPerson(o.id, { cancelCourier: true, courierCancelled: true }, OWNER);
  assert.equal(done.order.status, 'delivered');
});

test('a handover that is refused anyway cancels nothing with the courier', async () => {
  const o = place({ items: [], photo: { photos: [PNG], amount: 200 } });
  orders.recordBooking(o.id, OWNER, { provider: 'jeebly', awbNumber: 'JB990022', bookingState: 'booked' });
  mock.restore();
  mock = installJeeblyMock({ cancel: () => REPLIES.cancelled });
  await assert.rejects(() => handOverInPerson(o.id, { cancelCourier: true, cashReceived: 'yes' }, OWNER), (e: { status?: number }) => e.status === 400);
  await assert.rejects(() => handOverInPerson(o.id, { cancelCourier: true }, OWNER), (e) => code(e) === 'photo_amount');
  assert.equal(mock.calls.length, 0, 'Jeebly was not asked to cancel');
  assert.equal(orders.getOrder(o.id)!.courier.bookingState, 'booked');
});

test('a booking that comes back after the order was handed over in person is flagged for the owner', () => {
  const o = place();
  orders.handOverOrder(o.id, {}, OWNER);
  orders.recordBooking(o.id, OWNER, { provider: 'jeebly', awbNumber: 'JB990033', bookingState: 'booked' });
  assert.equal(attention(o.id)?.kind, 'booked_after_cancel');
  assert.match(attention(o.id)!.text, /handed over in person/);
});

test('cancelling an order whose tracking number was typed in for another courier: flagged, to cancel in their portal', async () => {
  const o = place();
  orders.updateOrderByAdmin(o.id, { status: 'confirmed', shipUnconfirmed: true }, OWNER);
  orders.enterTracking(o.id, OWNER, { carrier: 'other', carrierName: 'Aramex', awb: 'ARX-1234567' });
  const cancelled = orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, OWNER);
  const said = await cancelJeeblyBooking(cancelled, OWNER);
  assert.match(said.message, /Aramex.*ARX-1234567.*portal/);
  assert.equal(attention(o.id)?.kind, 'booked_after_cancel');
  assert.equal(mock.calls.length, 0, 'nothing sent to Jeebly for another courier’s booking');
  // Asked again: said once.
  assert.equal((await cancelJeeblyBooking(orders.getOrder(o.id)!, OWNER)).message, '');
});

test('a cancelled order shows the customer no tracking number', () => {
  const o = place();
  orders.recordBooking(o.id, OWNER, { provider: 'jeebly', awbNumber: 'JB990044', bookingState: 'booked', trackingUrl: 'https://track.example/JB990044' });
  const token = orders.trackPath(o.id).split('/').pop()!;
  assert.equal(orders.lookupTracked(token)!.courier.awbNumber, 'JB990044');
  orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, OWNER);
  const seen = orders.lookupTracked(token)!;
  assert.deepEqual([seen.courier.awbNumber, seen.courier.trackingUrl, seen.courier.status], ['', '', 'Cancelled']);
});

test('no same-day delivery on Sundays (the courier collects nothing then)', () => {
  const s = { ...getSettings('delivery'), sameDayEnabled: true, sameDayEmirates: ['Dubai'], sameDayCutoff: '14:00', emirates: ['Dubai'] } as never;
  const saturday = Date.UTC(2026, 10, 14, 6, 0); // 10:00 in the UAE
  const sunday = Date.UTC(2026, 10, 15, 6, 0);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'Marina' }, s, saturday).sameDay.available, true);
  const closed = deliveryCheck({ emirate: 'Dubai', area: 'Marina' }, s, sunday).sameDay;
  assert.equal(closed.available, false);
  assert.match(closed.reason ?? '', /Sunday/);
  // 23:00 UTC on Saturday is already Sunday in the UAE.
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'Marina' }, { ...(s as object), sameDayCutoff: '23:59' } as never, Date.UTC(2026, 10, 14, 21, 0)).sameDay.available, false);
});

test('an unpaid bank transfer is sent out only on the owner’s explicit word, recorded; a paid one goes as usual', () => {
  const o = place({ paymentMethod: 'bank_transfer' });
  orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, OWNER);
  assert.throws(() => orders.updateOrderByAdmin(o.id, { status: 'dispatched' }, OWNER), (e) => code(e) === 'bank_unpaid');
  assert.throws(() => orders.assertShipAllowed(o.id, OWNER, false), (e) => code(e) === 'bank_unpaid');
  assert.equal(orders.getOrder(o.id)!.status, 'confirmed');
  const sent = orders.updateOrderByAdmin(o.id, { status: 'dispatched', shipUnconfirmed: true }, OWNER);
  assert.equal(sent.status, 'dispatched');
  assert.ok(audits().some((a) => a.action === 'order.ship_unpaid_bank' && a.details?.orderId === o.id));

  const paid = place({ paymentMethod: 'bank_transfer' });
  orders.checkBankTransfer(paid.id, 'received', OWNER);
  orders.assertShipAllowed(paid.id, OWNER, false);
  if (orders.getOrder(paid.id)!.status !== 'confirmed') orders.updateOrderByAdmin(paid.id, { status: 'confirmed' }, OWNER);
  assert.equal(orders.updateOrderByAdmin(paid.id, { status: 'dispatched' }, OWNER).status, 'dispatched');
});

test('the courier gets whole pieces, kilograms rounded up, and the street before the landmark', () => {
  const o = place();
  const jeebly = getSettings('courier').jeebly;
  const sender = { shopName: 'Shop', email: '' };
  const pay = (courier: Record<string, unknown>, customer: Record<string, unknown> = {}) =>
    buildJeeblyPayload({ ...o, courier: { ...o.courier, ...courier }, customer: { ...o.customer, ...customer } } as never, jeebly, sender);
  assert.equal(pay({ pieces: 1.5 }).num_pieces, 2);
  assert.equal(pay({ pieces: 0 }).num_pieces, 1);
  assert.equal(pay({ weightKg: 2.01 }).weight, 3);
  assert.equal(pay({ weightKg: 0.1 + 0.2 + 1.7 }).weight, 2, '2.0000000000000004 is 2 kg');
  assert.equal(pay({ weightKg: 0.3 }).weight, 1);
  const long = 'Opposite the very large shopping centre with the fountain, next to the petrol station and the school, behind the park';
  const lm = pay({}, { streetAddress: 'Street 12B', landmark: long }).destination_address_landmark;
  assert.ok(lm.startsWith('Street 12B, '), lm);
});

test('a real shop (the published image) starts without the sample products; demos and tests still get them', () => {
  const run = (env: Record<string, string>) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-seed-'));
    const clean = { ...process.env, DATA_DIR: data, ...env } as Record<string, string | undefined>;
    if (!('SEED_STOCK' in env)) delete clean.SEED_STOCK;
    const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('@/lib/server/products').then((m) => console.log('COUNT=' + m.listProducts().length))"], { env: clean as NodeJS.ProcessEnv, encoding: 'utf8', cwd: process.cwd() });
    return Number(/COUNT=(\d+)/.exec(out)?.[1]);
  };
  assert.equal(run({ NODE_ENV: 'production' }), 0);
  assert.ok(run({ NODE_ENV: 'production', SEED_STOCK: '5' }) > 0);
});

test('the hub may use the camera on its own pages (the QR scanner); nobody else’s page may', () => {
  const config = fs.readFileSync('next.config.ts', 'utf8');
  assert.match(config, /camera=\(self\)/);
  assert.doesNotMatch(config, /camera=\(\)/);
});
