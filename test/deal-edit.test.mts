/**
 * Editing a photo deal link until it is ordered (asked by the owner: "the photo link should be
 * editable till the order is not made"): what it is, for whom, pieces, price, ways to pay, how long
 * it works and its pictures (keep, remove, reorder, add); the link stays the same; a customer who
 * opened the page before a price change is stopped at checkout; refused once ordered or stopped;
 * allow-listed and audited; the new pictures go with the order and are backed up like the old.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const orders = await import('@/lib/server/orders');
const deals = await import('@/lib/server/photoDeals');
const { updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');

const A = fs.readFileSync('test/fixtures/sheet-indigo.png');
const pngA = `data:image/png;base64,${A.toString('base64')}`;
// A second, different picture: the same PNG with a few bytes after its end (still a valid image).
const B = Buffer.concat([A, Buffer.from('second picture')]);
const pngB = `data:image/png;base64,${B.toString('base64')}`;
const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const status = (f: () => unknown) => {
  try {
    f();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
const tokenOf = (d: { link?: string }) => d.link!.split('/').pop()!;
await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place(body: Record<string, unknown>) {
  _clearAllRateLimits();
  return orders.placeOrder(
    {
      idempotencyKey: `deal-edit-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Fatima Test', phone: `+9715071${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [],
      paymentMethod: 'cod',
      ...body,
    },
    { ip: `10.5.${n}.1` }
  );
}
const audits = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> }));
const make = () => deals.createDeal({ photos: [pngA, pngB, pngA], note: 'King set, blue print', forWhom: 'Fatima', pieces: 2, amount: 375, payments: ['cod', 'bank_transfer'] }, OWNER);

test('asked: an open link is edited (price, words, pieces, payments, days); the link stays the same; audited', () => {
  const d = make();
  const token = tokenOf(d);
  const e = deals.updateDeal(d.id, { amount: 350.5, note: 'King set, blue print, 2 pillow covers', forWhom: 'Fatima M', pieces: 3, payments: ['cod'], days: 14 }, OWNER);
  assert.equal(e.amount, 350.5);
  assert.equal(e.note, 'King set, blue print, 2 pillow covers');
  assert.equal(e.forWhom, 'Fatima M');
  assert.equal(e.pieces, 3);
  assert.deepEqual(e.payments, ['cod']);
  assert.ok(Date.parse(e.expiresAt) > Date.now() + 13 * 86_400_000, 'works 14 days from now');
  assert.equal(tokenOf(e), token, 'the same link');
  assert.equal(deals.dealView(token)?.amountFils, 35050, 'the customer’s page shows the new price');
  const a = audits().filter((x) => x.action === 'deal.updated').at(-1);
  assert.equal(a?.details?.amountFilsBefore, 37500);
  assert.equal(a?.details?.amountFils, 35050);
  // The order takes the new price; a page opened before the change is stopped at checkout.
  assert.throws(() => place({ deal: { token }, expectedTotal: 375 }), (err) => code(err) === 'price_changed');
  assert.equal(place({ deal: { token }, expectedTotal: 350.5 }).order.total, 350.5);
});

test('the pictures: keep some (in a new order), remove others, add new; the files follow; the order gets them', () => {
  const d = make();
  const e = deals.updateDeal(d.id, { keep: [2], photos: [pngA] }, OWNER);
  assert.equal(e.photos, 2);
  assert.deepEqual(deals.readDealPhoto(d.id, 1)?.bytes, B, 'picture 2 is now first');
  assert.deepEqual(deals.readDealPhoto(d.id, 2)?.bytes, A, 'the new one after it');
  assert.equal(deals.readDealPhoto(d.id, 3), null, 'the removed one is gone');
  assert.ok(!fs.readdirSync(path.join(dir, 'receipts')).some((f) => f.endsWith('.new')), 'nothing left half-written');
  const { order } = place({ deal: { token: tokenOf(e) } });
  assert.equal(order.photoOrder?.photos, 2);
  assert.deepEqual(orders.readPhotoOrderPhoto(order.id, 1)?.bytes, B);
  // Checked: at least one picture, at most 12, numbers that exist, no repeats.
  const f = make();
  for (const body of [{ keep: [] }, { keep: [4] }, { keep: [1, 1] }, { keep: ['1'] }, { keep: [1], photos: Array(12).fill(pngA) }, { photos: 'x' }]) {
    assert.equal(status(() => deals.updateDeal(f.id, body, OWNER)), 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(deals.getDeal(f.id)?.photos, 3, 'a refused edit changes nothing');
});

test('until it is ordered: an ordered or stopped link is not edited; an expired one can be (and works again); fields allow-listed', () => {
  const d = make();
  place({ deal: { token: tokenOf(d) } });
  assert.throws(() => deals.updateDeal(d.id, { amount: 10 }, OWNER), (e) => code(e) === 'deal_ordered');
  const s = make();
  deals.cancelDeal(s.id, OWNER);
  assert.throws(() => deals.updateDeal(s.id, { amount: 10 }, OWNER), (e) => code(e) === 'deal_cancelled');
  assert.equal(status(() => deals.updateDeal('DEAL-000000-NOPE00', { amount: 10 }, OWNER)), 404);
  const x = make();
  for (const body of [{ amount: 0 }, { amount: '5' }, { payments: [] }, { days: 31 }, { pieces: 0 }, { token: 'x' }, { orderId: 'BUH-1' }]) {
    assert.equal(status(() => deals.updateDeal(x.id, body, OWNER)), 400, JSON.stringify(body));
  }
  // Expired: edited with new days, the same link opens again.
  const old = make();
  const later = Date.now() + 8 * 86_400_000;
  assert.equal(deals.openDealId(tokenOf(old), later), null);
  deals.updateDeal(old.id, { days: 14 }, OWNER);
  assert.equal(deals.openDealId(tokenOf(old), later), old.id);
});
