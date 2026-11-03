/**
 * Settings → Delivery: the delivery options the customer sees are the owner's (asked by the owner:
 * "at delivery page I should be able to edit these delivery option"). Standard delivery's name and
 * charge, same day's name; the server charges what the settings say (in fils, never the
 * browser's), checkout's shown total must match, and the product data for search engines says the
 * same charge. Defaults keep today's shop: "Standard delivery", AED 0, "Same day".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const orders = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { getSettings, updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { deliveryCheck } = await import('@/lib/delivery');
const seo = await import('@/lib/server/seo');

await updateSettings('store', { whatsappNumber: '+971501234567', photoOrders: true });

let n = 0;
function place(over: Record<string, unknown> = {}) {
  _clearAllRateLimits();
  const p = listProducts()[0];
  return orders.placeOrder(
    {
      idempotencyKey: `delivery-options-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Test Customer', phone: `+9715080${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...over,
    },
    { ip: `10.3.${n}.1` }
  ).order;
}

test('defaults keep today’s shop: "Standard delivery" at AED 0, "Same day"', () => {
  const d = getSettings('delivery');
  assert.equal(d.standardName, 'Standard delivery');
  assert.equal(d.standardFee, 0);
  assert.equal(d.sameDayName, 'Same day');
  const check = deliveryCheck({ emirate: 'Dubai', area: 'Marina' }, d);
  assert.deepEqual(check.standard, { name: 'Standard delivery', fee: 0 });
  assert.equal(check.sameDay.name, 'Same day');
  const order = place();
  assert.equal(order.deliveryFee, 0);
  assert.equal(order.total, order.subtotal);
});

test('the owner’s names and standard charge: charged by the server (COD collects it), shown totals must match, search engines told the same', async () => {
  await updateSettings('delivery', { standardName: 'Courier delivery', standardFee: 15, sameDayName: 'Express today' });
  const d = getSettings('delivery');
  assert.equal(d.standardName, 'Courier delivery');
  assert.equal(d.sameDayName, 'Express today');
  const check = deliveryCheck({ emirate: 'Dubai', area: 'Marina' }, d);
  assert.deepEqual(check.standard, { name: 'Courier delivery', fee: 15 });
  assert.equal(check.sameDay.name, 'Express today');

  const order = place();
  assert.equal(order.deliveryFee, 15);
  assert.equal(order.total, Math.round((order.subtotal + 15) * 100) / 100);
  assert.equal(order.courier.codAmountCollected, order.total);
  // Checkout showed a total without the charge (an old page): refused, nothing taken.
  const subtotal = listProducts()[0].price;
  assert.throws(() => place({ expectedTotal: subtotal }), (e: { details?: { code?: string } }) => e.details?.code === 'price_changed');

  // An order from a photo: the agreed total already includes standard delivery (asked by the owner), so nothing is added.
  const photo = orders.placeOrder(
    {
      idempotencyKey: `delivery-options-photo-${Date.now()}`,
      customer: { fullName: 'Photo Customer', phone: '+971508099999', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [],
      photo: { photos: [`data:image/png;base64,${(await import('node:fs')).readFileSync('test/fixtures/sheet-indigo.png').toString('base64')}`], amount: 300 },
      paymentMethod: 'cod',
    },
    { ip: '10.3.200.1' }
  ).order;
  assert.equal(photo.total, 300);
  assert.equal(photo.deliveryFee, 0);
  assert.equal(orders.confirmPhotoAmount(photo.id, 350, 'owner@shop.test').order.total, 350);

  // Product data for search engines: the same charge.
  const ld = JSON.stringify(seo.productJsonLd(listProducts()[0], 'https://shop.test'));
  assert.match(ld, /"shippingRate":\{"@type":"MonetaryAmount","value":"15\.00","currency":"AED"\}/);
  await updateSettings('delivery', { standardFee: 0 });
  assert.match(JSON.stringify(seo.productJsonLd(listProducts()[0], 'https://shop.test')), /"value":"0\.00"/);
});

test('the charge and the names are checked: AED 0–500 with fils, names cut to 40 characters (empty: the default)', async () => {
  for (const bad of [-1, 500.01, 1.234, 'abc', null, '']) {
    await assert.rejects(updateSettings('delivery', { standardFee: bad }), (e: { status?: number; message?: string }) => e.status === 400 && /Standard delivery charge/.test(e.message ?? ''), String(bad));
  }
  // Too long: cut to 40, like every settings text.
  await updateSettings('delivery', { standardName: 'x'.repeat(41) });
  assert.equal(getSettings('delivery').standardName, 'x'.repeat(40));
  await assert.rejects(updateSettings('delivery', { standardName: 5 }), (e: { status?: number }) => e.status === 400);
  await updateSettings('delivery', { standardName: '', sameDayName: '' });
  assert.equal(getSettings('delivery').standardName, 'Standard delivery');
  assert.equal(getSettings('delivery').sameDayName, 'Same day');
  await updateSettings('delivery', { standardFee: 12.5 });
  assert.equal(getSettings('delivery').standardFee, 12.5);
});
