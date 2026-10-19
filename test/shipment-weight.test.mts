/**
 * Owner's request: "In the bedsheet specs put the weight too with the size, so the final weight can
 * be calculated automatically." Each size may carry its packed weight (grams; presets too); an order
 * copies it onto each line when placed (a snapshot); the parcel's weight is their sum plus the
 * packaging allowance, booked with Jeebly as whole kilograms rounded up; a size with no weight makes
 * it unknown (never a silent default).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { shipmentWeight } from '@/lib/shipmentWeight';
import { sizeFromPreset } from '@/lib/measurements';
import type { Order } from '@/types';

tempDataDir();
const products = await import('@/lib/server/products');
const orders = await import('@/lib/server/orders');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings, getSettings } = await import('@/lib/server/settings');

const status = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};
const item = (profileName: string, quantity: number, weightGrams?: number) => ({ title: 'Mughal Garden', profileName, quantity, ...(weightGrams === undefined ? {} : { weightGrams }) }) as Order['items'][number];

test('the parcel weight: the sum of quantity × weight plus packaging, rounded up to whole kg for Jeebly (at least 1)', () => {
  const w = shipmentWeight({ items: [item('King', 2, 1200)] }, 200);
  assert.equal(w.grams, 2600);
  assert.equal(w.kg, 2.6);
  assert.equal(w.jeeblyKg, 3);
  assert.equal(w.breakdown, '2 × King 1.2 kg + packaging 0.2 kg = 2.6 kg → 3 kg for Jeebly');
  assert.equal(shipmentWeight({ items: [item('Single', 1, 600), item('King', 1, 1200)] }, 200).grams, 2000);
  assert.equal(shipmentWeight({ items: [item('Single', 1, 600), item('King', 1, 1200)] }, 200).jeeblyKg, 2, 'exactly 2 kg stays 2');
  assert.equal(shipmentWeight({ items: [item('Pillow', 1, 150)] }, 0).jeeblyKg, 1, 'at least 1 kg');
});

test('a size with no weight makes the parcel weight unknown, listed by name (never a 2.5 kg default)', () => {
  const w = shipmentWeight({ items: [item('King', 1, 1200), item('Single', 2)] }, 200);
  assert.equal(w.grams, null);
  assert.equal(w.kg, null);
  assert.equal(w.jeeblyKg, null);
  assert.deepEqual(w.missing, ['Mughal Garden (Single)']);
  assert.equal(w.breakdown, 'Add weights to these sizes: Mughal Garden (Single)');
});

test('a size weight is whole grams from 1 to 50 000 (product and preset); empty means none', async () => {
  const template = products.listProducts()[0];
  const make = (weightGrams: unknown) => () => products.validateProduct({ ...template, profiles: template.profiles.map((p, i) => (i === 0 ? { ...p, weightGrams } : p)) });
  for (const bad of [0, -5, 50_001, 1.5, 'heavy']) assert.equal(status(make(bad)), 400, String(bad));
  assert.equal(products.validateProduct({ ...template, defaultProfileId: template.profiles[0].id, profiles: [{ ...template.profiles[0], weightGrams: 1200 }] }).profiles[0].weightGrams, 1200);
  assert.equal(products.validateProduct({ ...template, defaultProfileId: template.profiles[0].id, profiles: [{ ...template.profiles[0], weightGrams: '' }] }).profiles[0].weightGrams, undefined);
  const sizes = getSettings('catalog').sizes;
  await assert.rejects(updateSettings('catalog', { sizes: sizes.map((s, i) => (i === 0 ? { ...s, weightGrams: 60_000 } : s)) }), (e: { status?: number }) => e.status === 400);
  await updateSettings('catalog', { sizes: sizes.map((s, i) => (i === 0 ? { ...s, weightGrams: 1300 } : s)) });
  assert.equal(getSettings('catalog').sizes[0].weightGrams, 1300);
});

test('a preset carries its weight to a new product size', () => {
  const preset = { ...getSettings('catalog').sizes[0], weightGrams: 1300 };
  assert.equal(sizeFromPreset(preset).weightGrams, 1300);
  assert.equal(sizeFromPreset({ ...preset, weightGrams: undefined }).weightGrams, undefined);
});

test('an order copies each size weight when placed (a snapshot) and starts with the calculated weight; shoppers never get it', async () => {
  await updateSettings('courier', { packagingGrams: 300 });
  const template = products.listProducts()[0];
  const p = products.createProduct({ ...template, title: 'Weighed Set', galleryImages: [], defaultProfileId: template.profiles[0].id, profiles: [{ ...template.profiles[0], weightGrams: 1250 }], stockBySize: { [template.profiles[0].id]: 5 } });
  const placed = orders.placeOrder({
    idempotencyKey: `weight-${Date.now()}-abcdefghij`,
    verificationToken: issuePhoneToken('+971501230001'),
    customer: { fullName: 'T', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 2 }],
    paymentMethod: 'cod',
  }).order;
  assert.equal(placed.items[0].weightGrams, 1250);
  assert.equal(placed.courier.weightKg, 2.8, '2 × 1.25 kg + 0.3 kg packaging');
  products.updateProduct(p.id, { profiles: [{ ...p.profiles[0], weightGrams: 2000 }] });
  assert.equal(orders.getOrder(placed.id)!.items[0].weightGrams, 1250, 'later edits do not change the order');

  const route = await import('@/app/api/products/route');
  const shop = await (route.GET() as Response).json();
  assert.ok(!JSON.stringify(shop).includes('weightGrams'), 'not sent to shoppers');
});

test('packaging allowance: whole grams 0 to 5000, 200 by default', async () => {
  await assert.rejects(updateSettings('courier', { packagingGrams: -1 }), (e: { status?: number }) => e.status === 400);
  await assert.rejects(updateSettings('courier', { packagingGrams: 5001 }), (e: { status?: number }) => e.status === 400);
  await updateSettings('courier', { packagingGrams: 0 });
  assert.equal(getSettings('courier').packagingGrams, 0);
});
