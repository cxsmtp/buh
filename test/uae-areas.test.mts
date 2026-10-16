/**
 * Areas and honest GPS (reported at checkout from Discovery Gardens, Dubai): "Use My GPS" said
 * "near Arabian Ranches (about 2 km accuracy)", 12 km away, and the area list had 12 Dubai
 * names and no Discovery Gardens.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();

const uaeAreas = await import('@/data/uaeAreas');
const loc = await import('@/lib/uaeLocations');
const { deliveryCheck } = await import('@/lib/delivery');
const { DEFAULT_DELIVERY } = await import('@/data/catalogDefaults');
const { UAE_AREAS, resolveArea, searchAreas, areasOf } = uaeAreas;
const suggest = (loc as Record<string, unknown>).suggestAreaFromGps as
  | ((lat: number, lng: number, accuracyM: number) => { kind: string; location?: { name: string; emirate: string } })
  | undefined;

test('regression (reported): a ±2 km Wi-Fi reading near Arabian Ranches suggests no area', () => {
  assert.equal(typeof suggest, 'function');
  const r = suggest!(25.0534, 55.2655, 2000);
  assert.equal(r.kind, 'approximate');
  assert.equal(r.location, undefined);
  // Even a reading a little worse than 300 m guesses nothing.
  assert.equal(suggest!(25.0534, 55.2655, 301).kind, 'approximate');
  assert.equal(suggest!(25.0534, 55.2655, NaN).kind, 'approximate', 'unknown accuracy is never taken as precise');
  assert.equal(loc.formatAccuracy(2000), '± 2 km');
  assert.equal(loc.formatAccuracy(1530), '± 1.5 km');
  assert.equal(loc.formatAccuracy(450), '± 450 m');
});

test('regression (reported): a precise reading in Discovery Gardens suggests Discovery Gardens, Dubai', () => {
  const r = suggest!(25.0405, 55.1452, 25);
  assert.equal(r.kind, 'area');
  assert.equal(r.location?.name, 'Discovery Gardens');
  assert.equal(r.location?.emirate, 'Dubai');
  // Precise, but more than 1.5 km from any community we know: no guess.
  assert.equal(suggest!(24.6, 55.0, 10).kind, 'unknown');
  assert.equal(suggest!(39.0487, -77.4404, 10).kind, 'outside');
  // The old 15 km snap is gone.
  assert.equal(loc.nearestUAELocation(25.07, 55.23), null, 'between JVC and Arabian Ranches, 2+ km from each');
});

test('the Dubai list is complete enough: 150+ names including the ones customers reported', () => {
  const dubai = areasOf('Dubai').map((a) => a.name);
  assert.ok(dubai.length >= 150, `${dubai.length} Dubai areas`);
  for (const want of ['Discovery Gardens', 'Al Furjan', 'International City', 'Dubai South', 'The Gardens', 'Ibn Battuta']) assert.ok(dubai.includes(want), want);
  assert.ok(dubai.some((n) => /\(JLT\)/.test(n)), 'JLT');
  for (const emirate of ['Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'] as const) {
    assert.ok(areasOf(emirate).length >= 12, `${emirate}: ${areasOf(emirate).length}`);
  }
  assert.ok(areasOf('Abu Dhabi').some((a) => a.region === 'Al Ain'));
  assert.ok(areasOf('Abu Dhabi').some((a) => a.region === 'Al Dhafra'));
  // No name twice in one emirate.
  const keys = UAE_AREAS.map((a) => `${a.emirate}|${a.name}`);
  assert.equal(new Set(keys).size, keys.length);
  // Every name fits the order's 120-character area field.
  assert.ok(UAE_AREAS.every((a) => a.name.length <= 120));
});

test('aliases resolve, ignoring case and punctuation; a name in two emirates follows the chosen one', () => {
  const cases: Array<[string, string]> = [
    ['JVC', 'Jumeirah Village Circle (JVC)'],
    ['jlt', 'Jumeirah Lake Towers (JLT)'],
    ['DIP', 'Dubai Investments Park (DIP)'],
    ['Tecom', 'Barsha Heights (Tecom)'],
    ['Akoya', 'Damac Hills'],
    ['DWC', 'Dubai South'],
    ['zabeel', 'Za’abeel'],
    ['Discovery Gardens', 'Discovery Gardens'],
    ['discovery  gardens!', 'Discovery Gardens'],
  ];
  for (const [typed, name] of cases) assert.equal(resolveArea(typed, 'Dubai')?.name, name, typed);
  assert.equal(resolveArea('Al Nahda', 'Sharjah')?.emirate, 'Sharjah');
  assert.equal(resolveArea('Al Nahda', 'Dubai')?.emirate, 'Dubai');
  assert.equal(resolveArea('Emirates Living', 'Dubai'), null, 'an alias for three communities names none of them');
  assert.equal(resolveArea('Villa 24, near the park', 'Dubai'), null);
});

test('search matches any part of a name or alias, the chosen emirate first', () => {
  const names = (q: string, e = 'Dubai') => searchAreas(q, e).map((m) => m.area.name);
  assert.equal(names('discov')[0], 'Discovery Gardens');
  assert.equal(names('DISCOV')[0], 'Discovery Gardens');
  assert.ok(names('gardens').includes('Discovery Gardens'), 'middle of a name');
  assert.equal(names('jvc')[0], 'Jumeirah Village Circle (JVC)');
  assert.equal(searchAreas('jvc', 'Dubai')[0].via, undefined, 'JVC is already in the name');
  assert.equal(searchAreas('akoya', 'Dubai')[0].via, 'Akoya');
  assert.ok(names('furjan').includes('Al Furjan'));
  // Al Nahda: Sharjah's first when Sharjah is chosen.
  assert.equal(searchAreas('nahda', 'Sharjah')[0].area.emirate, 'Sharjah');
  assert.equal(searchAreas('nahda', 'Dubai')[0].area.emirate, 'Dubai');
  // Another emirate's area is still offered.
  assert.equal(searchAreas('yas island', 'Dubai')[0].area.emirate, 'Abu Dhabi');
  assert.equal(searchAreas('', 'Ajman')[0].area.emirate, 'Ajman');
});

test('coordinates: every known point is in the UAE, in its emirate’s rough box, and the old tests still hold', () => {
  const box: Record<string, [number, number, number, number]> = {
    Dubai: [24.6, 25.4, 54.85, 56.2],
    'Abu Dhabi': [22.6, 24.9, 51.5, 56.0],
    Sharjah: [24.9, 25.6, 55.3, 56.4],
    Ajman: [25.35, 25.45, 55.4, 55.6],
    'Ras Al Khaimah': [25.5, 26.1, 55.7, 56.2],
    Fujairah: [25.0, 25.7, 56.0, 56.4],
    'Umm Al Quwain': [25.4, 25.7, 55.5, 55.8],
  };
  assert.ok(loc.UAE_KEY_LOCATIONS.length >= 50, `${loc.UAE_KEY_LOCATIONS.length} points`);
  for (const p of loc.UAE_KEY_LOCATIONS) {
    const [a, b, c, d] = box[p.emirate];
    assert.ok(p.lat >= a && p.lat <= b && p.lng >= c && p.lng <= d, `${p.name} (${p.lat}, ${p.lng}) outside ${p.emirate}`);
    // Each point suggests itself.
    assert.equal(loc.nearestUAELocation(p.lat, p.lng)?.location.name, p.name);
  }
  // Every point is an area in the list (so a suggested name is one customers see).
  for (const p of loc.UAE_KEY_LOCATIONS) assert.ok(UAE_AREAS.some((a) => a.name === p.name && a.emirate === p.emirate), p.name);
});

test('"areas not served" works with the new names and their short forms', () => {
  const s = (notServed: string[]) => ({ ...DEFAULT_DELIVERY, notServed });
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'Jumeirah Village Circle (JVC)' }, s(['JVC'])).serviceable, false);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'JVC' }, s(['Jumeirah Village Circle'])).serviceable, false);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'JVC' }, s(['Jumeirah Village Circle (JVC)'])).serviceable, false);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'Jumeirah Village Triangle (JVT)' }, s(['JVC'])).serviceable, true);
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'Discovery Gardens' }, s(['The Gardens'])).serviceable, true, 'a different community');
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'The Meadows' }, s(['Emirates Living'])).serviceable, true, 'an ambiguous alias blocks nothing it does not name');
  // Any typed area is still accepted.
  assert.equal(deliveryCheck({ emirate: 'Dubai', area: 'Building 12, behind the mosque' }, DEFAULT_DELIVERY).serviceable, true);
});

test('the order API takes any typed area (capped at 120 characters) and a GPS pin, and decides delivery itself', async () => {
  const orders = await import('@/lib/server/orders');
  const products = await import('@/lib/server/products');
  const { issuePhoneToken } = await import('@/lib/server/phoneToken');
  const p = products.listProducts()[0];
  let n = 0;
  const place = (customer: Record<string, unknown>) =>
    orders.placeOrder({
      idempotencyKey: `area-${++n}-${Date.now()}`,
      verificationToken: issuePhoneToken(`+9715080${String(n).padStart(5, '0')}`),
      customer: { fullName: 'Area Test', emirate: 'Dubai', streetAddress: 'Street 1', buildingVilla: 'Villa', flatVillaNo: '1', ...customer },
      items: [{ productId: p.id, profileId: p.defaultProfileId, quantity: 1 }],
      paymentMethod: 'cod',
    }).order;
  const status = (fn: () => unknown) => {
    try {
      fn();
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };
  // An approximate reading near Arabian Ranches, with the area the customer typed: both kept as sent.
  const o = place({ area: 'Discovery Gardens, Building 14', gpsCoordinates: { lat: 25.0534, lng: 55.2655 } });
  assert.equal(o.customer.area, 'Discovery Gardens, Building 14');
  assert.deepEqual(o.customer.gpsCoordinates, { lat: 25.0534, lng: 55.2655 });
  assert.equal(place({ area: 'Some new community nobody listed yet' }).customer.area, 'Some new community nobody listed yet');
  assert.equal(place({ area: 'Jumeirah Village Circle (JVC)', emirate: 'Dubai' }).customer.emirate, 'Dubai');
  assert.equal(status(() => place({ area: 'x'.repeat(121) })), 400, 'too long');
  assert.equal(status(() => place({ area: '' })), 400, 'required');
  assert.equal(status(() => place({ area: 'JVC', emirate: 'Muscat' })), 400, 'emirate from the allow-list only');
});
