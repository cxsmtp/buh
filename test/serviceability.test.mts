/**
 * Delivery: decided by the address, not a GPS reading; same-day delivery with the
 * owner's charge, computed by the server. A customer in Dubai whose laptop
 * reported a location in Virginia (a network/VPN location) could not order:
 * that must never happen again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const { deliveryCheck, inUAE, uaeMinutes } = await import('@/lib/delivery');
const { nearestUAELocation } = await import('@/lib/uaeLocations');
const { DEFAULT_DELIVERY } = await import('@/data/catalogDefaults');
const settings = await import('@/lib/server/settings');
const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');

const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
/** 10:00 and 15:00 in the UAE (UTC+4). */
const MORNING = Date.parse('2026-10-15T06:00:00Z');
const AFTERNOON = Date.parse('2026-10-15T11:00:00Z');

test('every emirate is delivered to, in 1–2 days, without naming the courier', () => {
  for (const emirate of ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain']) {
    const r = deliveryCheck({ emirate, area: 'Al Barsha' }, DEFAULT_DELIVERY);
    assert.equal(r.serviceable, true, emirate);
    assert.equal(r.days, '1–2 days');
    assert.doesNotMatch(JSON.stringify(r), /jeebly|hub/i, 'no courier details for customers');
  }
  assert.equal(deliveryCheck({ emirate: 'Muscat', area: '' }, DEFAULT_DELIVERY).serviceable, false);
  const excluded = { ...DEFAULT_DELIVERY, notServed: ['Sir Bani Yas Island'] };
  assert.equal(deliveryCheck({ emirate: 'Abu Dhabi', area: 'sir bani yas island' }, excluded).serviceable, false);
  assert.equal(deliveryCheck({ emirate: 'Abu Dhabi', area: 'Yas Island' }, excluded).serviceable, true);
});

test('same day: only when switched on, in the chosen emirates, before the cut-off (UAE time)', () => {
  const on = { ...DEFAULT_DELIVERY, sameDayEnabled: true, sameDayFee: 30, sameDayCutoff: '13:00', sameDayEmirates: ['Dubai' as const] };
  assert.equal(uaeMinutes(MORNING), 10 * 60);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'JLT' }, DEFAULT_DELIVERY, MORNING).sameDay.available, false, 'off by default');
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'JLT' }, on, MORNING).sameDay.available, true);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'JLT' }, on, AFTERNOON).sameDay.available, false);
  assert.match(deliveryCheck({ emirate: 'Dubai', area: 'JLT' }, on, AFTERNOON).sameDay.reason!, /before 13:00/);
  assert.equal(deliveryCheck({ emirate: 'Sharjah', area: 'Al Nahda' }, on, MORNING).sameDay.available, false);
});

test('a GPS reading only suggests an area inside the UAE, and never a far-away guess', () => {
  assert.equal(inUAE(39.0487, -77.4404), false, 'Virginia (a network/VPN location)');
  assert.equal(nearestUAELocation(39.0487, -77.4404), null, 'no made-up "Corniche, Abu Dhabi"');
  assert.equal(nearestUAELocation(25.0775, 55.1395)?.location.name, 'Dubai Marina');
  assert.equal(nearestUAELocation(24.4965, 54.606)?.location.name, 'Yas Island');
  assert.equal(nearestUAELocation(23.0, 53.0), null, 'in the desert, far from any known area: no guess');
});

let n = 0;
function place(over: Record<string, unknown> = {}, customer: Record<string, unknown> = {}) {
  const p = products.listProducts()[0];
  return orders.placeOrder({
    idempotencyKey: `svc-${++n}-${Date.now()}`,
    verificationToken: issuePhoneToken(`+9715070${String(n).padStart(5, '0')}`),
    customer: { fullName: 'Delivery Test', emirate: 'Dubai', area: 'Al Barsha', streetAddress: 'Street 1', buildingVilla: 'Villa', flatVillaNo: '1', ...customer },
    items: [{ productId: p.id, profileId: p.defaultProfileId, quantity: 1 }],
    paymentMethod: 'cod',
    ...over,
  }).order;
}

test('regression (reported): a Dubai customer whose device reports Virginia can still order', () => {
  const o = place({}, { gpsCoordinates: { lat: 39.0487, lng: -77.4404 } });
  assert.equal(o.customer.emirate, 'Dubai');
  assert.equal(o.courier.serviceability?.verified, true);
  assert.equal(o.courier.serviceability?.hub, '', 'no courier hub recorded as if verified');
});

test('same-day delivery is charged by the server, in fils; refused when not available; never trusted from the browser', async () => {
  const standard = place();
  assert.equal(standard.deliveryFee, 0);
  assert.equal(standard.deliveryOption, 'standard');
  assert.equal(statusOf(() => place({ deliveryOption: 'same_day' })), 409, 'off by default');

  await settings.updateSettings('delivery', { sameDayEnabled: true, sameDayFee: 24.5, sameDayCutoff: '23:59', sameDayEmirates: ['Dubai'] });
  const fast = place({ deliveryOption: 'same_day' });
  assert.equal(fast.deliveryOption, 'same_day');
  assert.equal(fast.deliveryFee, 24.5);
  assert.equal(Math.round(fast.total * 100), Math.round(fast.subtotal * 100) + 2450);
  // The total the customer saw must include the charge.
  assert.equal(statusOf(() => place({ deliveryOption: 'same_day', expectedTotal: fast.subtotal })), 409);
  assert.equal(statusOf(() => place({ deliveryOption: 'same_day' }, { emirate: 'Sharjah' })), 409, 'not offered there');
  // The cut-off is now (UAE time): too late for same day. (At exactly 00:00 a cut-off can't be set: skip.)
  const m = uaeMinutes(Date.now());
  if (m > 0) {
    await settings.updateSettings('delivery', { sameDayCutoff: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
    assert.equal(statusOf(() => place({ deliveryOption: 'same_day' })), 409, 'after the cut-off');
  }
});

test('settings → Delivery: checked', async () => {
  const bad = async (s: Record<string, unknown>) => {
    try {
      await settings.updateSettings('delivery', s);
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };
  assert.equal(await bad({ sameDayFee: -1 }), 400);
  assert.equal(await bad({ sameDayFee: 10.555 }), 400);
  assert.equal(await bad({ sameDayCutoff: '25:00' }), 400);
  assert.equal(await bad({ emirates: [] }), 400);
  assert.equal(await bad({ emirates: ['Muscat'] }), 400);
  await settings.updateSettings('delivery', { notServed: 'Sir Bani Yas Island, Delma Island' });
  assert.deepEqual(settings.getSettings('delivery').notServed, ['Sir Bani Yas Island', 'Delma Island']);
  assert.equal(statusOf(() => place({}, { emirate: 'Abu Dhabi', area: 'Delma Island' })), 400);
});

// ── Review of BUH-02.02.00 ─────────────────────────────────────────────────

test('regression: a paid same-day order is booked for today as Express, never with the next-day-only courier', async () => {
  await settings.updateSettings('delivery', { sameDayEnabled: true, sameDayFee: 25, sameDayCutoff: '23:59', sameDayEmirates: ['Dubai'] });
  const o = place({ deliveryOption: 'same_day' });
  const { uaeDate } = await import('@/lib/delivery');
  assert.equal(o.courier.serviceType, 'Express');
  assert.equal(o.courier.pickupDate, uaeDate(Date.now()), 'collected today (UAE date)');
  assert.equal(place().courier.pickupDate, uaeDate(Date.now(), 1), 'standard: tomorrow');
  const { dispatchOrder } = await import('@/lib/server/dispatch');
  await assert.rejects(dispatchOrder({ orderId: o.id, provider: 'echo', rebook: false, actor: 'test' }), (e: { status?: number }) => e.status === 400);
  await settings.updateSettings('delivery', { sameDayEnabled: false });
});

test('regression: "areas not served" never blocks more than the area named', async () => {
  const s = (notServed: string[]) => ({ ...DEFAULT_DELIVERY, notServed });
  for (const area of ['Al Barsha', 'Palm Jumeirah', 'Dubai Marina']) assert.equal(deliveryCheck({ emirate: 'Dubai', area }, s(['Al'])).serviceable, true, area);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'Business Bay' }, s(['Bay'])).serviceable, true);
  assert.equal(deliveryCheck({ emirate: 'Abu Dhabi', area: 'Sir Bani Yas Island, west jetty' }, s(['Sir Bani Yas Island'])).serviceable, false);
  assert.equal(deliveryCheck({ emirate: 'Abu Dhabi', area: 'Delma' }, s(['Delma'])).serviceable, false);
  await assert.rejects(settings.updateSettings('delivery', { notServed: ['Al'] }), (e: { status?: number }) => e.status === 400);
});

test('regression: same-day charges like AED 19.99 can be saved; a 00:00 cut-off is refused', async () => {
  await settings.updateSettings('delivery', { sameDayFee: 19.99 });
  assert.equal(settings.getSettings('delivery').sameDayFee, 19.99);
  await settings.updateSettings('delivery', { sameDayFee: 1.15 });
  assert.equal(settings.getSettings('delivery').sameDayFee, 1.15);
  await assert.rejects(settings.updateSettings('delivery', { sameDayEnabled: true, sameDayCutoff: '00:00' }), (e: { status?: number }) => e.status === 400);
});

test('regression: the courier is not named to customers (Track Order), and Doha is not taken for the UAE', () => {
  const o = place();
  const seen = orders.lookupOrder(o.id, o.customer.phone);
  assert.doesNotMatch(JSON.stringify(seen), /jeebly|"provider"/i);
  assert.equal(inUAE(25.2854, 51.531), false, 'Doha');
  assert.equal(inUAE(24.4539, 54.3773), true, 'Abu Dhabi');
  assert.equal(inUAE(24.1302, 52.5785), true, 'Ruwais (west of Abu Dhabi)');
});
