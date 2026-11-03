/**
 * "Order from your photo" (asked by the owner: a piece agreed on WhatsApp, not in the catalogue;
 * the customer uploads its photos, the agreed amount, payment and address, confirms on WhatsApp;
 * the owner confirms, and only then is it booked and the label made). Off by default; the photos
 * checked and kept beside the transfer screenshots (backed up and restored with them); no stock
 * touched; the amount is the customer's word until "Confirm amount" (audited), which every booking
 * and status change waits for; no card payment for it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const orders = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const { getSettings, updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');
const backup = await import('@/lib/server/backup');

const PHOTO = fs.readFileSync('test/fixtures/sheet-indigo.png');
const png = `data:image/png;base64,${PHOTO.toString('base64')}`;

await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place(photo: unknown, over: Record<string, unknown> = {}) {
  _clearAllRateLimits();
  const phone = `+9715060${String(++n).padStart(5, '0')}`;
  return orders.placeOrder(
    {
      idempotencyKey: `photo-order-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Layla Test', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [],
      photo,
      paymentMethod: 'cod',
      ...over,
    },
    { ip: `10.2.${n}.1` }
  );
}
const stock = () => getDb().prepare('SELECT product_id, size_id, qty FROM product_stock ORDER BY product_id, size_id').all();
const auditLines = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;

test('off by default: the shop takes no order from a photo until the owner switches it on', () => {
  assert.equal(getSettings('store').photoOrders, false);
  assert.equal(getSettings('store').photoOrdersOnHome, false);
  assert.throws(() => place({ photos: [png], amount: 350 }), (e: { status?: number }) => e.status === 404 && code(e) === 'photo_orders_off');
});

test('an order from a photo: the agreed amount, its photos kept for the owner, no stock touched, and the customer sees it is being checked', async () => {
  await updateSettings('store', { photoOrders: true });
  listProducts();
  const before = stock();
  const { order, created } = place({ photos: [png, png], note: 'King set, blue block print', pieces: 2, amount: 350 });
  assert.equal(created, true);
  assert.equal(order.total, 350);
  assert.equal(order.subtotal, 350);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].productType, 'photo');
  assert.equal(order.items[0].productId, orders.PHOTO_PRODUCT_ID);
  assert.match(order.items[0].title, /From your photo: King set, blue block print/);
  assert.equal(order.courier.pieces, 2);
  assert.equal(order.courier.codAmountCollected, 350);
  assert.deepEqual(order.photoOrder, { photos: 2, note: 'King set, blue block print', pieces: 2, agreedTotal: 350 });
  assert.equal(order.status, 'pending_confirmation');
  assert.ok(order.whatsappCheck, 'confirmed on WhatsApp like any order');
  assert.deepEqual(stock(), before, 'nothing reserved');
  // The photos: beside the transfer screenshots, for the owner only.
  assert.deepEqual(orders.readPhotoOrderPhoto(order.id, 1)?.bytes, PHOTO);
  assert.ok(orders.readPhotoOrderPhoto(order.id, 2));
  assert.equal(orders.readPhotoOrderPhoto(order.id, 3), null);
  assert.equal(orders.readPhotoOrderPhoto('../etc', 1), null);
  // The customer: the amount typed, not yet confirmed (and not who confirms).
  const view = orders.customerView(order) as { photoOrder?: Record<string, unknown> };
  assert.deepEqual(view.photoOrder, { photos: 2, pieces: 2, agreedTotal: 350, note: 'King set, blue block print', amountConfirmed: false });
  const tracked = orders.lookupOrder(order.id, order.customer.phone) as { photoOrder?: { amountConfirmed: boolean } };
  assert.equal(tracked.photoOrder?.amountConfirmed, false);
});

test('nothing is confirmed or booked before the owner confirms the amount; correcting it changes the total everywhere, audited; the same amount again changes nothing', () => {
  const { order } = place({ photos: [png], amount: 350 });
  assert.throws(() => orders.assertNotHeld(orders.getOrder(order.id)!), (e) => code(e) === 'photo_amount');
  assert.throws(() => orders.updateOrderByAdmin(order.id, { status: 'confirmed', shipUnconfirmed: true }, 'owner@shop.test'), (e) => code(e) === 'photo_amount');
  // The amount is checked like the customer's.
  for (const bad of [0, -5, 20_001, 1.234, '350', null]) assert.throws(() => orders.confirmPhotoAmount(order.id, bad, 'owner@shop.test'), (e: { status?: number }) => e.status === 400, String(bad));
  const r = orders.confirmPhotoAmount(order.id, 420, 'owner@shop.test');
  assert.equal(r.changed, true);
  assert.equal(r.order.total, 420);
  assert.equal(r.order.items[0].totalPrice, 420);
  assert.equal(r.order.courier.codAmountCollected, 420);
  assert.equal(r.order.photoOrder?.agreedTotal, 350, 'what the customer typed stays on record');
  assert.equal(r.order.photoOrder?.confirmedBy, 'owner@shop.test');
  assert.equal((getDb().prepare('SELECT total_fils FROM orders WHERE id = ?').get(order.id) as { total_fils: number }).total_fils, 42000);
  const entry = auditLines().find((l) => l.action === 'order.photo_amount_confirmed' && l.details.orderId === order.id);
  assert.equal(entry?.details.fromFils, 35000);
  assert.equal(entry?.details.toFils, 42000);
  assert.equal(orders.confirmPhotoAmount(order.id, 420, 'owner@shop.test').changed, false);
  // Now it can go ahead like any order.
  orders.assertNotHeld(orders.getOrder(order.id)!);
  const confirmed = orders.updateOrderByAdmin(order.id, { status: 'confirmed', shipUnconfirmed: true }, 'owner@shop.test');
  assert.equal(confirmed.status, 'confirmed');
  assert.equal((orders.customerView(confirmed) as { photoOrder?: { amountConfirmed: boolean } }).photoOrder?.amountConfirmed, true);
  // Cancelled: no stock goes back (it never came from the catalogue), and its amount is closed.
  const before = stock();
  orders.updateOrderByAdmin(order.id, { status: 'cancelled' }, 'owner@shop.test');
  assert.deepEqual(stock(), before);
  assert.throws(() => orders.confirmPhotoAmount(order.id, 500, 'owner@shop.test'), (e: { status?: number }) => e.status === 409);
  // Not an order from a photo: not found.
  assert.throws(() => orders.confirmPhotoAmount('BUH-000000-NOPE', 100, 'owner@shop.test'), (e: { status?: number }) => e.status === 404);
});

test('what the photo order takes: 1–4 real images, an amount in AED with fils, whole pieces, its own fields only; no card, no bag items', () => {
  const refused = (photo: unknown, over: Record<string, unknown> = {}) => assert.throws(() => place(photo, over), (e: { status?: number }) => e.status === 400 || e.status === 413, JSON.stringify(photo)?.slice(0, 80));
  refused({ photos: [], amount: 100 });
  refused({ amount: 100 });
  refused({ photos: [png, png, png, png, png], amount: 100 });
  refused({ photos: ['data:image/png;base64,AAAA'], amount: 100 });
  refused({ photos: [`data:application/pdf;base64,${Buffer.from('%PDF-1.4 x').toString('base64')}`], amount: 100 });
  refused({ photos: [`data:image/jpeg;base64,${Buffer.alloc(1_300_000, 0xff).toString('base64')}`], amount: 100 });
  refused({ photos: [png] });
  refused({ photos: [png], amount: 0 });
  refused({ photos: [png], amount: 20_000.01 });
  refused({ photos: [png], amount: 10.005 });
  refused({ photos: [png], amount: 100, pieces: 0 });
  refused({ photos: [png], amount: 100, pieces: 1.5 });
  refused({ photos: [png], amount: 100, note: 'x'.repeat(301) });
  refused({ photos: [png], amount: 100, price: 1 });
  refused({ photos: [png], amount: 100 }, { items: [{ productId: listProducts()[0].id, profileId: listProducts()[0].profiles[0].id, quantity: 1 }] });
  assert.throws(() => place({ photos: [png], amount: 100 }, { paymentMethod: 'online_card' }), (e) => code(e) === 'photo_no_card');
  // A shown total that differs from the agreed amount: refused like any checkout.
  assert.throws(() => place({ photos: [png], amount: 100 }, { expectedTotal: 90 }), (e) => code(e) === 'price_changed');
  const ok = place({ photos: [png], amount: 99.5 }, { expectedTotal: 99.5 });
  assert.equal(ok.order.total, 99.5);
});

test('the photos are in the backup and come back with the restore', async () => {
  const { order } = place({ photos: [png], amount: 120 });
  const result = await backup.createBackup();
  const names = backup.openBackup(fs.readFileSync(result.file)).map((e) => e.name);
  assert.ok(names.includes(`receipts/${order.id}.photo1.png`), names.filter((x) => x.startsWith('receipts/')).join(', '));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-photo-'));
  fs.rmSync(target, { recursive: true });
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /Integrity check: ok/);
  assert.deepEqual(fs.readFileSync(path.join(target, 'receipts', `${order.id}.photo1.png`)), PHOTO);
});
