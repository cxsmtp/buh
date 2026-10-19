/**
 * Jeebly's Scheduled API as verified against its docs and demo system (2026-10-19): the exact
 * request (flat snake_case, X-API-KEY / client_key), the exact replies (string success, "AWB No",
 * the error messages), and nothing invented. Eco Express: not connected, nothing sent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, test } from 'node:test';
import { buildJeeblyPayload, createJeeblyShipment, jeeblyPickupDate, missingPickup } from '@/lib/jeebly';
import { createEchoShipment } from '@/lib/echo';
import { JEEBLY_API, jeeblyCity, jeeblyLiveBase, jeeblyMobile, jeeblySaid, mapJeeblyTracking } from '@/lib/jeeblyApi';
import { ECO_LIVE_NOT_CONNECTED } from '@/lib/courierMode';
import type { CourierSettings, Order } from '@/types';
import { installJeeblyMock, REPLIES } from './fixtures/jeebly-mock.mjs';

type Mock = { calls: Array<{ host: string; path: string; headers: Record<string, string>; body: Record<string, unknown> }>; restore: () => void };
let mock: Mock | null = null;
const useMock = (script?: Record<string, unknown>) => (mock = installJeeblyMock(script) as Mock);
const realFetch = globalThis.fetch;
afterEach(() => {
  mock?.restore();
  mock = null;
  globalThis.fetch = realFetch;
});

const order = {
  id: 'BUH-261019-ABC123',
  customer: { fullName: 'Fatima Test', phone: '+971 50 123 4567', emirate: 'Umm Al Quwain', area: 'Al Salamah', streetAddress: 'Street 7', buildingVilla: 'Villa 12', flatVillaNo: '12', landmark: 'Near the mosque' },
  items: [{ title: 'Sheet', profileName: 'King', unitPrice: 100, quantity: 2 }],
  total: 315.5,
  paymentMethod: 'cod',
  deliveryOption: 'standard',
  courier: { weightKg: 2.3, pieces: 2, pickupDate: '2099-01-04' },
} as unknown as Order;
const pickup = { pickupLocationName: '', pickupPhone: '+971 50 111 2222', pickupAddress: 'Street 5', pickupBuilding: 'Owner Tower', pickupUnit: 'Shop 3', pickupArea: 'Al Barsha 1', pickupLandmark: 'Mall of the Emirates', pickupEmirate: 'Dubai' };
const keys = { apiKey: 'live-api-key-1', clientKey: 'live-client-key-1' };
const sandboxKeys = { sandboxApiKey: 'sb-api-key-123', sandboxClientKey: 'sb-client-key-456' };
const LIVE = 'https://live.jeebly.com';
const jeebly = (isLive: boolean, extra: Partial<CourierSettings['jeebly']> = {}) => ({ isLive, serviceType: 'Scheduled', liveBaseUrl: LIVE, ...pickup, ...keys, ...extra }) as CourierSettings['jeebly'];
const echo = (isLive: boolean) => ({ isLive }) as CourierSettings['echo'];
const sender = { shopName: 'My Shop' };

test('the request is Jeebly\'s flat snake_case body: the order and the owner\'s pickup, nothing invented', () => {
  const p = buildJeeblyPayload(order, jeebly(true), sender);
  assert.deepEqual(p, {
    delivery_type: 'Next day',
    load_type: 'Non-document',
    consignment_type: 'Forward',
    description: '2x Sheet (King)',
    weight: 3,
    payment_type: 'COD',
    cod_amount: 315.5,
    num_pieces: 2,
    customer_reference_number: 'BUH-261019-ABC123',
    pickup_date: '2099-01-05',
    origin_address_name: 'My Shop',
    origin_address_house_no: 'Shop 3',
    origin_address_building_name: 'Owner Tower',
    origin_address_area: 'Al Barsha 1',
    origin_address_city: 'Dubai',
    origin_address_type: 'Normal',
    origin_address_mob_no_country_code: '+971',
    origin_address_mobile_number: '501112222',
    origin_address_landmark: 'Mall of the Emirates, Street 5',
    destination_address_name: 'Fatima Test',
    destination_address_house_no: '12',
    destination_address_building_name: 'Villa 12',
    destination_address_area: 'Al Salamah',
    destination_address_city: 'Umm Al-Quwain',
    destination_address_type: 'Normal',
    destination_address_mob_no_country_code: '+971',
    destination_address_mobile_number: '501234567',
    destination_address_landmark: 'Near the mosque, Street 7',
  });
  // Prepaid: no cod_amount; same day: "Same day"; weight at least 1 kg.
  const prepaid = buildJeeblyPayload({ ...order, paymentMethod: 'online_card', deliveryOption: 'same_day', courier: { ...order.courier, weightKg: 0.3 } } as Order, jeebly(true), sender);
  assert.equal(prepaid.payment_type, 'PREPAID');
  assert.equal('cod_amount' in prepaid, false);
  assert.equal(prepaid.delivery_type, 'Same day');
  assert.equal(prepaid.weight, 1);
  assert.equal(buildJeeblyPayload({ ...order, total: 0.1 + 0.2 } as Order, jeebly(true), sender).cod_amount, 0.3, 'AED from fils');
  const src = fs.readFileSync('src/lib/jeebly.ts', 'utf8');
  assert.doesNotMatch(src, /Al Quoz|WH-14|Times Square|logistics@|beautifuluaehome\.com|jeebly\.com\/track/);
});

test('cities as Jeebly spells them; phones as digits without +971; pickup day in Dubai, never Sunday or past', () => {
  assert.equal(jeeblyCity('Umm Al Quwain'), 'Umm Al-Quwain');
  assert.equal(jeeblyCity('Al Ain'), 'Al-Ain');
  assert.equal(jeeblyCity('Ras Al Khaimah'), 'Ras Al Khaimah');
  assert.equal(jeeblyCity('Abu Dhabi'), 'Abu Dhabi');
  assert.equal(jeeblyCity('Atlantis'), '');
  for (const [given, want] of [['+971 50 123 4567', '501234567'], ['0501234567', '501234567'], ['00971501234567', '501234567'], ['971-50-123-4567', '501234567']]) assert.equal(jeeblyMobile(given), want, given);
  // 2026-10-17 21:00 UTC is Sunday 18 Oct 01:00 in Dubai: Sunday → Monday.
  const sat = Date.parse('2026-10-17T21:00:00Z');
  assert.equal(jeeblyPickupDate(undefined, sat), '2026-10-19');
  assert.equal(jeeblyPickupDate('2026-10-01', Date.parse('2026-10-14T08:00:00Z')), '2026-10-14', 'never a past day');
  assert.equal(jeeblyPickupDate('2026-10-24', Date.parse('2026-10-14T08:00:00Z')), '2026-10-24', 'Saturday stays');
  assert.equal(jeeblyPickupDate('2026-10-25', Date.parse('2026-10-14T08:00:00Z')), '2026-10-26', 'Sunday → Monday');
});

test('the pickup details Jeebly requires are listed when missing, and nothing is sent', async () => {
  assert.deepEqual(missingPickup({ pickupEmirate: 'Dubai' } as never), ['pickup phone', 'unit / shop / villa no.', 'building', 'area', 'landmark']);
  useMock();
  const r = await createJeeblyShipment(order, jeebly(true, { pickupArea: '', pickupLandmark: '' }), sender);
  assert.equal(r.success, false);
  assert.match(r.message, /Add your pickup area, landmark in Couriers/);
  assert.equal(mock!.calls.length, 0);
});

test('a live booking: headers exactly X-API-KEY and client_key, the live address, the AWB from "AWB No"', async () => {
  useMock();
  const r = await createJeeblyShipment(order, jeebly(true, sandboxKeys), sender);
  assert.equal(r.success, true);
  assert.equal(r.awbNumber, 'JB115106');
  assert.equal(r.isSimulated, false);
  assert.equal(r.carrierEnv, 'live');
  assert.equal(r.trackingUrl, '', 'no link invented');
  const c = mock!.calls[0];
  assert.equal(c.host, 'live.jeebly.com');
  assert.equal(c.path, 'create_shipment');
  assert.equal(c.headers['x-api-key'], keys.apiKey);
  assert.equal(c.headers['client_key'], keys.clientKey);
  assert.deepEqual(JEEBLY_API.headers, { apiKey: 'X-API-KEY', clientKey: 'client_key' });
});

test("Jeebly's refusals are shown verbatim (with what to do), and never become a booking", async () => {
  useMock({ codNeedsBank: true });
  const cod = await createJeeblyShipment(order, jeebly(true), sender);
  assert.equal(cod.success, false);
  assert.equal(cod.awbNumber, '');
  assert.match(cod.message, /HTTP 400\)\. Jeebly said: "For settlement of COD amount, we will require your bank details"\. Nothing was booked\. Add your bank details in your Jeebly account/);

  mock!.restore();
  useMock();
  const bad = await createJeeblyShipment(order, jeebly(true, { apiKey: 'bad-key' }), sender);
  assert.match(bad.message, /Jeebly said: "Invalid API Token".*Check the Jeebly keys/);

  mock!.restore();
  useMock({ create: () => ({ status: 200, body: { success: 'false1', message: 'Shipment can not be created' } }) });
  assert.equal((await createJeeblyShipment(order, jeebly(true), sender)).success, false, '"false1" is not success');

  mock!.restore();
  useMock({ create: () => ({ status: 200, body: { success: 'true', message: 'ok' } }) });
  const noAwb = await createJeeblyShipment(order, jeebly(true), sender);
  assert.equal(noAwb.success, false);
  assert.equal(noAwb.uncertain, true, 'live success without an AWB: check the portal before booking again');

  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const down = await createJeeblyShipment(order, jeebly(true), sender);
  assert.equal(down.success, false);
  assert.equal(down.uncertain, true);
});

test('Live mode needs Jeebly\'s live address; only https on jeebly.com is accepted', async () => {
  useMock();
  const r = await createJeeblyShipment(order, jeebly(true, { liveBaseUrl: '' }), sender);
  assert.match(r.message, /live address/);
  assert.equal(mock!.calls.length, 0);
  assert.equal(jeeblyLiveBase('https://portal.jeebly.com'), 'https://portal.jeebly.com');
  assert.equal(jeeblyLiveBase('https://jeebly.com/'), 'https://jeebly.com');
  for (const bad of ['http://portal.jeebly.com', 'https://jeebly.com.evil.example', 'https://evil.example/jeebly.com', 'https://x@portal.jeebly.com', 'https://portal.jeebly.com:8443', 'https://portal.jeebly.com/customer', 'https://10.0.0.1', '']) {
    assert.equal(jeeblyLiveBase(bad), '', bad);
  }
});

test('Test mode with sandbox keys books in Jeebly\'s demo system; a refusal there records nothing', async () => {
  useMock();
  const ok = await createJeeblyShipment(order, jeebly(false, sandboxKeys), sender);
  assert.equal(ok.success, true);
  assert.equal(ok.isSimulated, true);
  assert.equal(ok.testKind, 'sandbox');
  assert.equal(ok.carrierEnv, 'sandbox');
  assert.equal(mock!.calls[0].host, 'demo.jeebly.com');
  assert.equal(mock!.calls[0].headers['x-api-key'], sandboxKeys.sandboxApiKey, 'sandbox keys, never the live ones');

  mock!.restore();
  useMock({ codNeedsBank: true });
  const r = await createJeeblyShipment(order, jeebly(false, sandboxKeys), sender);
  assert.equal(r.success, false);
  assert.equal(r.awbNumber, '');
  assert.notEqual(r.uncertain, true, 'a sandbox attempt is never remembered');
  assert.doesNotMatch(r.message, /GPY-|sb-api-key-123/);
});

test('no keys at all: an offline practice booking (PRACTICE-…); only live keys with Live off: refused', async () => {
  useMock();
  const practice = await createJeeblyShipment(order, jeebly(false, { apiKey: '', clientKey: '' }), sender);
  assert.equal(practice.testKind, 'practice');
  assert.match(practice.awbNumber, /^PRACTICE-\d{6}$/);
  const blocked = await createJeeblyShipment(order, jeebly(false), sender);
  assert.equal(blocked.success, false);
  assert.match(blocked.message, /sandbox keys/);
  assert.equal(mock!.calls.length, 0);
});

test('tracking keeps only status, description, hub and time (never phones, rider, proof or signature)', () => {
  const t = mapJeeblyTracking(REPLIES.tracking('JB115105', 'Delivered').body)!;
  assert.equal(t.awb, 'JB115105');
  assert.equal(t.lastStatus, 'Delivered');
  assert.deepEqual(t.events[0], { status: 'Delivered', desc: 'Consignment delivered', hub: 'DXB', at: '2026-10-20T09:12:00.000Z' });
  assert.doesNotMatch(JSON.stringify(t), /9715|Rider Name|R42|pod\.example|sig\.example|phone/);
  assert.equal(mapJeeblyTracking(REPLIES.unknownAwb.body), null);
});

test('Eco Express live refuses (its endpoint is a mock); test mode is practice; nothing is sent', async () => {
  useMock();
  const live = await createEchoShipment(order, echo(true));
  assert.equal(live.success, false);
  assert.equal(live.message, ECO_LIVE_NOT_CONNECTED);
  const t = await createEchoShipment(order, echo(false));
  assert.match(t.awbNumber, /^PRACTICE-/);
  assert.equal(mock!.calls.length, 0);
  assert.doesNotMatch(fs.readFileSync('src/lib/echo.ts', 'utf8'), /apiary-mock\.com|Alserkal|508294110|ECH-DXB-91402/);
  assert.doesNotMatch(fs.readFileSync('src/app/api/courier/test/route.ts', 'utf8'), /apiary-mock\.com|LIVE_ENDPOINT_ACTIVE/);
});

test("Jeebly's message: text only, at most 200 characters, keys, emails and phones masked", () => {
  assert.equal(jeeblySaid({ message: 'bad key live-api-key-1' }, ['live-api-key-1']), 'bad key [redacted]');
  assert.equal(jeeblySaid({ message: 'x'.repeat(500) }).length, 200);
  assert.equal(jeeblySaid({ message: { nested: true } }), '');
  assert.doesNotMatch(jeeblySaid({ message: 'call +971 50 123 4567 or a@b.com' }), /123 4567|a@b\.com/);
});
