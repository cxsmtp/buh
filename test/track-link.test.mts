/**
 * The order's private tracking link (asked by the owner: after confirming on WhatsApp the customer
 * gets a short message with the order number and a link to track the package, "so that they don't
 * need to ask"). /track/<order>.<mac>: made from the server's key, never stored; opens Track Order
 * for that order without the phone number; a changed or made-up link opens nothing; it shows what
 * Track Order shows (never the address or phone). The hub's confirmation message and courier
 * update carry it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const orders = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');
const wa = await import('@/lib/whatsappConfirm');
const { whatsAppUpdateText } = await import('@/components/admin/AdminOrdersTab');

await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place() {
  _clearAllRateLimits();
  const p = listProducts()[0];
  return orders.placeOrder(
    {
      idempotencyKey: `track-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Noura Test', phone: `+9715088${String(++n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
    },
    { ip: `10.9.${n}.1` }
  ).order;
}

test('every order has its private tracking link; it opens that order only, without the phone; never stored', () => {
  const order = place();
  const link = orders.trackPath(order.id);
  assert.match(link, /^\/track\/BUH-\d{6}-[A-Z2-9]{6}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(orders.getOrder(order.id)!.trackPath, link);
  const stored = (getDb().prepare('SELECT data FROM orders WHERE id = ?').get(order.id) as { data: string }).data;
  assert.ok(!stored.includes('trackPath') && !stored.includes(link), 'worked out from the key, never stored');
  const token = link.split('/').pop()!;
  const seen = orders.lookupTracked(token)!;
  assert.equal(seen.id, order.id);
  assert.equal(seen.firstName, 'Noura');
  const text = JSON.stringify(seen);
  assert.ok(!text.includes(order.customer.phone) && !text.includes('Walk 1') && !text.includes('Tower'), 'never the phone or address');
  // Changed, made up, another order's, or junk: nothing.
  const other = place();
  assert.equal(orders.lookupTracked(`${other.id}.${token.split('.')[1]}`), null);
  assert.equal(orders.lookupTracked(`${order.id}.${'A'.repeat(43)}`), null);
  assert.equal(orders.lookupTracked(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), null);
  assert.equal(orders.lookupTracked('BUH-1'), null);
  assert.equal(orders.lookupTracked(42), null);
  // The customer's own view carries it too (the confirmation screen).
  assert.equal(orders.customerView(order).trackPath, link);
});

test('reported: after confirming on WhatsApp the hub sends the order number and the tracking link; the courier update carries it too', () => {
  const order = place();
  orders.checkWhatsApp(order.id, 'confirmed', 'owner@shop.test');
  const confirmed = orders.getOrder(order.id)!;
  const url = `https://beautifuluaehome.com${confirmed.trackPath}`;
  const msg = wa.confirmedReply(confirmed.id, url, 'Noura');
  assert.equal(msg, `Thank you, Noura, your order ${order.id} is confirmed ✓\nTrack it any time: ${url}`);
  assert.equal(wa.confirmedReply('BUH-1'), 'Thank you, your order BUH-1 is confirmed ✓', 'without a link: as before');
  assert.equal(wa.trackLinkOf({ trackUrl: url, trackPath: confirmed.trackPath }), url);
  assert.match(whatsAppUpdateText({ ...confirmed, trackUrl: url }), new RegExp(`Track your order any time: ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});
