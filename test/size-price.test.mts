/**
 * Reported by the owner: "The price was set to 105 but it jumped to 215". The product had one
 * size (Super King) whose surcharge (+AED 110, copied from the shop's size presets) was added on
 * the product page and at checkout, while the card showed AED 105. With one size, the price typed
 * is what the customer pays; with several, cards show "From" the cheapest size that can be bought.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
for (const k of ['SMTP_HOST', 'BACKUP_EMAIL', 'TRUST_PROXY', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getDb } = await import('@/lib/server/db');
const money = await import('@/lib/money');

/** A product saved before this fix: one size that still carries the preset's +110. */
function legacyOneSize() {
  const p = products.listProducts()[0];
  const superKing = { ...p.profiles[0], id: 'super-king', name: 'Super King / Emperor Bed', priceDelta: 110 };
  const data = { ...p, price: 105, compareAtPrice: undefined, profiles: [superKing], defaultProfileId: 'super-king' };
  getDb().prepare('UPDATE products SET data = ? WHERE id = ?').run(JSON.stringify(data), p.id);
  getDb().prepare('DELETE FROM product_stock WHERE product_id = ?').run(p.id);
  getDb().prepare('INSERT INTO product_stock (product_id, size_id, qty) VALUES (?, ?, 5)').run(p.id, 'super-king');
  products.invalidateProducts();
  return products.listProducts().find((x) => x.id === p.id)!;
}

test('one size: the card, the product page and checkout all charge the price typed (AED 105, not 215)', () => {
  const p = legacyOneSize();
  assert.equal(money.priceLabel(p), 'AED 105');
  assert.equal(money.sizePriceFils(p, p.profiles[0]), 10500);
  const phone = '+971506000001';
  const { order } = orders.placeOrder({
    idempotencyKey: `size-price-${Date.now()}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Noura Test', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: 'super-king', quantity: 1 }],
    paymentMethod: 'cod',
  });
  assert.equal(order.items[0].unitPrice, 105, 'checkout charges what the owner set');
});

test('saving a one-size product stores no surcharge; with two sizes the surcharge counts and the card says "From"', () => {
  const p = products.listProducts()[1];
  const base = { title: 'Size Price Set', category: p.category, price: 105, featuredImage: p.featuredImage, galleryImages: [] };
  const one = products.createProduct({ ...base, profiles: [{ ...p.profiles[0], priceDelta: 110 }], defaultProfileId: p.profiles[0].id, stockBySize: { [p.profiles[0].id]: 2 } });
  assert.equal(one.profiles[0].priceDelta, 0);
  assert.equal(money.priceLabel(one), 'AED 105');
  const sizes = [{ ...p.profiles[0], priceDelta: 0 }, { ...(p.profiles[1] ?? p.profiles[0]), id: 'sz-b', priceDelta: 50 }];
  const two = products.createProduct({ ...base, title: 'Size Price Set 2', profiles: sizes, defaultProfileId: sizes[0].id, stockBySize: { [sizes[0].id]: 0, 'sz-b': 3 } });
  // The cheaper size is sold out: the card shows the cheapest one a customer can buy.
  assert.equal(money.priceLabel(two), 'From AED 155');
  assert.equal(money.sizePriceFils(two, two.profiles[1]), 15500);
});
