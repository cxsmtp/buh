/**
 * Photo deals (asked by the owner: "customers change the rate", so the amount must be fixed): the
 * owner uploads the pictures (up to 12), sets the price with delivery and the ways to pay, and
 * sends a private link. The customer sees the pictures and the fixed price, adds the address and
 * pays (card, cash on delivery or bank transfer, as allowed). The price comes from the deal on the
 * server, never the browser; one order per link (an unpaid card try that is cancelled opens it
 * again); the owner can stop it; it expires. The token is never stored; the pictures are backed up
 * and restored. Also: card payment can be switched off on the /order-by-photo page, which now
 * takes up to 8 photos.
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
const deals = await import('@/lib/server/photoDeals');
const { updateSettings, getSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');
const backup = await import('@/lib/server/backup');
const { decide } = await import('@/lib/server/frontGate');

const PHOTO = fs.readFileSync('test/fixtures/sheet-indigo.png');
const png = `data:image/png;base64,${PHOTO.toString('base64')}`;
const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const tokenOf = (d: { link?: string }) => d.link!.split('/').pop()!;

await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place(body: Record<string, unknown>) {
  _clearAllRateLimits();
  const phone = `+9715070${String(++n).padStart(5, '0')}`;
  return orders.placeOrder(
    {
      idempotencyKey: `photo-deal-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Mariam Test', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [],
      paymentMethod: 'cod',
      ...body,
    },
    { ip: `10.4.${n}.1` }
  );
}
const auditActions = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).action as string));

const make = (over: Record<string, unknown> = {}) => deals.createDeal({ photos: [png, png, png], note: 'King set, blue block print', forWhom: 'Fatima', pieces: 2, amount: 375, payments: ['cod', 'bank_transfer', 'online_card'], ...over }, OWNER);

test('the owner makes a deal: up to 12 pictures, a fixed price with fils, the ways to pay, how many days; checked field by field', () => {
  const refused = (body: Record<string, unknown>) => assert.throws(() => deals.createDeal(body, OWNER), (e: { status?: number }) => e.status === 400, JSON.stringify(body).slice(0, 90));
  const base = { photos: [png], amount: 100, payments: ['cod'] };
  refused({ ...base, photos: [] });
  refused({ ...base, photos: Array(13).fill(png) });
  refused({ ...base, photos: ['data:image/png;base64,AAAA'] });
  refused({ ...base, amount: 0 });
  refused({ ...base, amount: 20_000.01 });
  refused({ ...base, amount: 10.005 });
  refused({ ...base, amount: '100' });
  refused({ ...base, payments: [] });
  refused({ ...base, payments: ['crypto'] });
  refused({ ...base, days: 0 });
  refused({ ...base, days: 31 });
  refused({ ...base, pieces: 0 });
  refused({ ...base, note: 'x'.repeat(301) });
  refused({ ...base, price: 5 });
  const twelve = deals.createDeal({ ...base, photos: Array(12).fill(png) }, OWNER);
  assert.equal(twelve.photos, 12);
  assert.equal(twelve.state, 'open');
  assert.ok(deals.readDealPhoto(twelve.id, 12));
  assert.ok(auditActions().includes('deal.created'));
});

test('the link: only its hash is stored; it opens the deal with the pictures and the fixed price; the front gate passes only an open deal', () => {
  const d = make({ days: 7 });
  assert.equal(d.amount, 375);
  assert.deepEqual(d.payments, ['cod', 'bank_transfer', 'online_card']);
  const token = tokenOf(d);
  assert.match(token, deals.DEAL_TOKEN_PATTERN);
  const row = getDb().prepare('SELECT * FROM photo_deals WHERE id = ?').get(d.id) as Record<string, unknown>;
  assert.ok(!JSON.stringify(row).includes(token), 'the token itself is never stored');
  assert.equal(deals.openDealId(token), d.id);
  const view = deals.dealView(token)!;
  assert.equal(view.amountFils, 37500);
  assert.equal(view.pieces, 2);
  assert.equal(view.photos.length, 3);
  assert.equal(view.photos[0], `/api/deal/${token}/photos/1`);
  assert.ok(!JSON.stringify(view).includes(OWNER) && !JSON.stringify(view).includes('Fatima'), 'the customer never sees who made it or the owner’s label');
  // Expires after the days chosen.
  assert.equal(deals.openDealId(token, Date.now() + 8 * 24 * 3600_000), null);
  // The front gate: the page and its pictures pass (no-referrer, noindex); anything else is the shop's 404.
  assert.deepEqual(decide(`/deal/${token}`, ''), { kind: 'deal', dealId: d.id, api: false });
  assert.deepEqual(decide(`/api/deal/${token}/photos/2`, ''), { kind: 'deal', dealId: d.id, api: true });
  assert.equal(decide(`/api/deal/${token}/other`, '').kind, 'unknown');
  assert.equal(decide(`/deal/${token}/x`, '').kind, 'unknown');
  assert.equal(decide(`/deal/${'A'.repeat(43)}`, '').kind, 'unknown');
  assert.equal(decide('/deal/short', '').kind, 'unknown');
});

test('reported: customers changed the rate. An order from a deal is the deal’s price, whatever the browser sends; confirmed already; the pictures go with it; one order per link', () => {
  const d = make();
  const token = tokenOf(d);
  // Only the token: a price or photos sent with it are refused.
  assert.throws(() => place({ deal: { token, amount: 1 } }), (e: { status?: number }) => e.status === 400);
  assert.throws(() => place({ deal: { token }, photo: { photos: [png], amount: 1 } }), (e: { status?: number }) => e.status === 400);
  // A total the customer "changed" in the page: refused, nothing taken.
  assert.throws(() => place({ deal: { token }, expectedTotal: 100 }), (e) => code(e) === 'price_changed');
  assert.equal(deals.openDealId(token), d.id, 'still open after a refused try');
  // Same day is extra on other orders: not on a fixed price.
  assert.throws(() => place({ deal: { token }, deliveryOption: 'same_day' }), (e) => code(e) === 'same_day_unavailable');

  const { order, created } = place({ deal: { token }, expectedTotal: 375 });
  assert.equal(created, true);
  assert.equal(order.total, 375);
  assert.equal(order.subtotal, 375);
  assert.equal(order.deliveryFee, 0, 'delivery is in the price');
  assert.equal(order.courier.codAmountCollected, 375);
  assert.equal(order.courier.pieces, 2);
  assert.equal(order.photoOrder?.dealId, d.id);
  assert.equal(order.photoOrder?.photos, 3);
  assert.equal(order.photoOrder?.confirmedBy, OWNER, 'the owner’s price: nothing to confirm');
  assert.ok(order.photoOrder?.confirmedAt);
  assert.equal(orders.customerView(order).photoOrder?.fixedPrice, true);
  assert.deepEqual(orders.readPhotoOrderPhoto(order.id, 3)?.bytes, PHOTO, 'the deal’s pictures are the order’s');
  // Used: the link closes; the hub shows it ordered.
  assert.equal(deals.openDealId(token), null);
  assert.equal(deals.getDeal(d.id)?.state, 'ordered');
  assert.equal(deals.getDeal(d.id)?.orderId, order.id);
  assert.equal(deals.getDeal(d.id)?.link, undefined);
  assert.throws(() => place({ deal: { token } }), (e) => code(e) === 'deal_closed');
  assert.equal(decide(`/deal/${token}`, '').kind, 'unknown');
});

test('only the ways to pay the owner allowed', () => {
  const d = make({ payments: ['bank_transfer'] });
  assert.throws(() => place({ deal: { token: tokenOf(d) }, paymentMethod: 'cod' }), (e) => code(e) === 'deal_payment');
  assert.equal(deals.openDealId(tokenOf(d)), d.id);
});

test('a cancelled order opens the link again (an unpaid card try); the owner can stop a link; an ordered one stays', () => {
  const d = make();
  const token = tokenOf(d);
  const { order } = place({ deal: { token } });
  assert.equal(deals.openDealId(token), null);
  getDb().prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  assert.equal(deals.openDealId(token), d.id, 'open again');
  assert.equal(deals.getDeal(d.id)?.state, 'open');
  assert.throws(() => deals.cancelDeal(d.id + 'X', OWNER), (e: { status?: number }) => e.status === 404);
  assert.equal(deals.cancelDeal(d.id, OWNER).state, 'cancelled');
  assert.equal(deals.cancelDeal(d.id, OWNER).state, 'cancelled', 'again: nothing changes');
  assert.equal(deals.openDealId(token), null);
  assert.throws(() => place({ deal: { token } }), (e) => code(e) === 'deal_closed');
  assert.ok(auditActions().includes('deal.cancelled'));
  const other = make();
  place({ deal: { token: tokenOf(other) } });
  assert.throws(() => deals.cancelDeal(other.id, OWNER), (e) => code(e) === 'deal_ordered');
});

test('the deal and its pictures are in the backup and come back with the restore', async () => {
  const d = make({ photos: [png] });
  const result = await backup.createBackup();
  const names = backup.openBackup(fs.readFileSync(result.file)).map((e) => e.name);
  assert.ok(names.includes(`receipts/${d.id}.photo1.png`));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-deal-'));
  fs.rmSync(target, { recursive: true });
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /Integrity check: ok/);
  assert.deepEqual(fs.readFileSync(path.join(target, 'receipts', `${d.id}.photo1.png`)), PHOTO);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  assert.equal((db.prepare('SELECT amount_fils FROM photo_deals WHERE id = ?').get(d.id) as { amount_fils: number }).amount_fils, 37500);
  db.close();
});

test('/order-by-photo: up to 8 photos now; card can be switched off there (deal links keep their own choice)', async () => {
  await updateSettings('store', { photoOrders: true });
  assert.equal(getSettings('store').photoOrdersCard, true, 'on by default, as before');
  const eight = place({ photo: { photos: Array(8).fill(png), amount: 200 } });
  assert.equal(eight.order.photoOrder?.photos, 8);
  assert.ok(orders.readPhotoOrderPhoto(eight.order.id, 8));
  const { TEST_KEYS } = await import('./stripe-mock.mjs');
  await updateSettings('payments', { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook });
  try {
    await updateSettings('store', { photoOrdersCard: false });
    assert.throws(() => place({ photo: { photos: [png], amount: 200 }, paymentMethod: 'online_card' }), (e) => code(e) === 'card_unavailable');
    const byCash = place({ photo: { photos: [png], amount: 200 } });
    assert.equal(byCash.order.paymentMethod, 'cod');
    const d = make({ payments: ['online_card'] });
    const byCard = place({ deal: { token: tokenOf(d) }, paymentMethod: 'online_card' });
    assert.equal(byCard.order.paymentMethod, 'online_card');
    assert.equal(byCard.order.subtotal, 375);
    assert.equal(byCard.order.status, 'pending_payment');
  } finally {
    await updateSettings('payments', { cardEnabled: false });
    await updateSettings('store', { photoOrdersCard: true });
  }
});
