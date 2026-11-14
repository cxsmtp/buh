/**
 * The Admin Hub gaps the last review round left open, on the server side:
 *  4. an order cancelled (or made smaller) for a size the product no longer has does not make or
 *     grow a stock row nobody can see: its pieces are not put back on sale, and the order's history
 *     and the audit log say how many, of what, so the owner can count them; sizes the product still
 *     has go back as before;
 *  5. the bank, payments, SMS and email settings and inviting an accountant need the owner again:
 *     a sign-in in the last 10 minutes, or the password with the change (a typed password is a new
 *     sign-in, so it is remembered the same 10 minutes); the routes ask before they change anything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
process.env.MONITOR_DISABLED = 'true';
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.SESSION_SECRET;

const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const auth = await import('@/lib/server/adminAuth');
const { updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');

const OWNER = 'owner@shop.test';
await updateSettings('store', { whatsappNumber: '+971501234567' });

const stock = (productId: string, sizeId: string) => getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').pluck().get(productId, sizeId) as number | undefined;
function auditEntries(action: string): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((e) => e.action === action);
}

let n = 0;
function place(items: Array<{ productId: string; profileId: string; quantity: number }>) {
  _clearAllRateLimits();
  n++;
  return orders.placeOrder(
    {
      idempotencyKey: `gaps-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'Rohini R Nair', phone: `+9715066${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items,
      paymentMethod: 'cod',
    },
    { ip: `10.8.${n}.1` }
  ).order;
}
/** A product with two sizes (the first two of the catalogue's first product), 5 pieces of each. */
function twoSizes() {
  const p = products.listProducts()[n % products.listProducts().length];
  const [a, b] = p.profiles;
  assert.ok(a && b, 'the sample product has at least two sizes');
  products.updateProduct(p.id, { stockBySize: { [a.id]: 5, [b.id]: 5 } });
  return { p, a, b };
}

test('gap 4: cancelling an order for a size the product no longer has makes no hidden stock row, and says so in the history and the audit log', () => {
  const { p, a, b } = twoSizes();
  const o = place([
    { productId: p.id, profileId: a.id, quantity: 2 },
    { productId: p.id, profileId: b.id, quantity: 1 },
  ]);
  assert.equal(stock(p.id, a.id), 3);
  assert.equal(stock(p.id, b.id), 4);

  // The owner removes the first size in the editor while the order is still open.
  const kept = products.getProduct(p.id)!;
  products.updateProduct(p.id, { profiles: kept.profiles.filter((s) => s.id !== a.id), defaultProfileId: b.id }, OWNER);
  assert.equal(stock(p.id, a.id), undefined, 'a size no longer offered keeps no stock row');
  const totalBefore = products.getProduct(p.id)!.stockCount;

  const cancelled = orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, OWNER);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(stock(p.id, a.id), undefined, 'no stock row is made for the removed size');
  assert.equal(stock(p.id, b.id), 5, 'the size the product still has goes back on sale');
  products.invalidateProducts();
  const after = products.getProduct(p.id)!;
  assert.equal(after.stockCount, totalBefore + 1, 'the product counts only what it shows');
  assert.equal(Object.keys(after.stockBySize ?? {}).includes(a.id), false);

  // The order's history says it, with how many and of what.
  const event = orders.orderEvents(o.id).find((e) => e.event === 'stock_not_returned');
  assert.ok(event, 'in the order history');
  assert.equal(event!.actor, OWNER);
  const detail = event!.detail as { pieces: number; items: Array<{ productId: string; sizeId: string; size: string; quantity: number; title: string }> };
  assert.equal(detail.pieces, 2);
  assert.deepEqual(
    detail.items.map((i) => [i.productId, i.sizeId, i.quantity]),
    [[p.id, a.id, 2]]
  );
  assert.equal(detail.items[0].size, a.name);
  assert.ok(detail.items[0].title);
  // And the audit log.
  const entry = auditEntries('order.stock_not_returned').find((e) => e.details.orderId === o.id);
  assert.ok(entry, 'in the audit log');
  assert.equal(entry!.details.pieces, 2);
  assert.equal(entry!.details.by, OWNER);
  assert.equal(entry!.details.why, 'size_removed');
});

test('gap 4: an order whose sizes are all still offered is cancelled as before (every piece back, nothing extra recorded)', () => {
  const { p, a, b } = twoSizes();
  const o = place([
    { productId: p.id, profileId: a.id, quantity: 1 },
    { productId: p.id, profileId: b.id, quantity: 2 },
  ]);
  orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, OWNER);
  assert.equal(stock(p.id, a.id), 5);
  assert.equal(stock(p.id, b.id), 5);
  assert.equal(orders.orderEvents(o.id).some((e) => e.event === 'stock_not_returned'), false);
  assert.equal(auditEntries('order.stock_not_returned').some((e) => e.details.orderId === o.id), false);
});

test('gap 4: lowering a line of a removed size in "Edit order" makes no hidden stock row either', () => {
  const { p, a, b } = twoSizes();
  const o = place([
    { productId: p.id, profileId: a.id, quantity: 2 },
    { productId: p.id, profileId: b.id, quantity: 1 },
  ]);
  const kept = products.getProduct(p.id)!;
  products.updateProduct(p.id, { profiles: kept.profiles.filter((s) => s.id !== a.id), defaultProfileId: b.id }, OWNER);
  orders.editOrderDetails(o.id, { lines: [{ quantity: 1 }, {}] }, OWNER);
  assert.equal(stock(p.id, a.id), undefined);
  const event = orders.orderEvents(o.id).find((e) => e.event === 'stock_not_returned');
  assert.equal((event?.detail as { pieces: number }).pieces, 1);
  assert.equal(auditEntries('order.stock_not_returned').find((e) => e.details.orderId === o.id)?.details.pieces, 1);
});

// ── Gap 5: the owner again ────────────────────────────────────────────────────

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e) => (typeof e?.status === 'number' ? e.status : -1));
const codeOf = (p: Promise<unknown>) => p.then(() => '', (e) => String(e?.details?.code ?? ''));
const EMAIL = 'admin@beautifuluaehome.com';
const PW = 'Owner-Own-Passphrase-1';

async function setUp() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    await auth.signIn('nobody@example.com', 'x', { ip: '192.0.2.250' }).catch(() => {});
  } finally {
    console.log = original;
  }
  await auth.changePassword(lines.join('\n').match(/Password: (\S+)/)![1], PW);
  auth._resetAdminAuthState();
}
/** The same session, as if it had been issued `minutes` ago. */
function aged(token: string, minutes: number): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  return auth.signSessionPayload({ ...payload, iat: payload.iat - minutes * 60_000 });
}

test('gap 5: a high-impact change needs a sign-in in the last 10 minutes, or the password (remembered as a new sign-in)', async () => {
  await setUp();
  const ip = '198.51.100.40';
  const token = (await auth.signIn(EMAIL, PW, { ip })).token;
  const fresh = (await auth.verifySessionToken(token))!;
  assert.equal(auth.isFreshSignIn(fresh), true);
  assert.deepEqual(await auth.confirmOwnerForChange(fresh, undefined, { ip }), {}, 'just signed in: not asked');

  // The same session 11 minutes later: only a live session, so the change is refused until the password is typed.
  const old = (await auth.verifySessionToken(aged(token, 11)))!;
  assert.ok(old, 'still a valid session');
  assert.equal(auth.isFreshSignIn(old), false);
  assert.equal(await statusOf(auth.confirmOwnerForChange(old, undefined, { ip })), 400);
  assert.equal(await codeOf(auth.confirmOwnerForChange(old, undefined, { ip })), 'owner_confirm');
  assert.equal(await codeOf(auth.confirmOwnerForChange(old, '', { ip })), 'owner_confirm');
  // A wrong password: a 400 (the owner stays signed in), with its own code; it counts as a failed sign-in.
  assert.equal(await statusOf(auth.confirmOwnerForChange(old, 'not-the-password', { ip })), 400);
  assert.equal(await codeOf(auth.confirmOwnerForChange(old, 'not-the-password', { ip })), 'owner_confirm_wrong');
  assert.equal(await statusOf(auth.confirmOwnerForChange(old, 12345, { ip })), 400, 'a password is text');
  // The right one: a new sign-in comes back, and with it the next change is not asked.
  const confirmed = await auth.confirmOwnerForChange(old, PW, { ip });
  assert.ok(confirmed.token);
  const renewed = (await auth.verifySessionToken(confirmed.token))!;
  assert.equal(renewed.role, 'owner');
  assert.equal(auth.isFreshSignIn(renewed), true);
  assert.deepEqual(await auth.confirmOwnerForChange(renewed, undefined, { ip }), {});
  // …for 10 minutes, not longer.
  assert.equal(auth.isFreshSignIn(renewed, renewed.issuedAt + 10 * 60_000 + 1), false);

  // A passkey sign-in counts the same way; a recovery-code session never does.
  const viaPasskey = (await auth.verifySessionToken((await auth.passkeySession()).token))!;
  assert.deepEqual(await auth.confirmOwnerForChange(viaPasskey, undefined), {});
  assert.equal(auth.isFreshSignIn({ ...fresh, method: 'recovery' }), false);
  auth._resetAdminAuthState();
});

test('gap 5: wrong passwords typed to confirm pause sign-in like wrong sign-ins do', async () => {
  const ip = '198.51.100.41';
  const old = (await auth.verifySessionToken(aged((await auth.signIn(EMAIL, PW, { ip })).token, 30)))!;
  let last = 0;
  for (let i = 0; i < 12 && last !== 429; i++) last = await statusOf(auth.confirmOwnerForChange(old, `guess-${i}`, { ip }));
  assert.equal(last, 429, 'paused after repeated wrong passwords');
  assert.equal(await statusOf(auth.confirmOwnerForChange(old, PW, { ip })), 429, 'the right one waits too');
  auth._resetAdminAuthState();
});

test('gap 5: the routes ask before they change anything (bank, payments, SMS, email; history restore; invite an accountant)', () => {
  assert.deepEqual([...auth.CONFIRMED_SETTINGS].sort(), ['bank', 'email', 'payments', 'sms']);
  const put = fs.readFileSync('src/app/api/admin/settings/[key]/route.ts', 'utf8');
  assert.ok(put.indexOf('confirmOwnerForChange(') > 0 && put.indexOf('confirmOwnerForChange(') < put.indexOf('saveGuarded('), 'the settings save: confirmed before it is saved');
  assert.match(put, /CONFIRMED_SETTINGS\.includes\(key\)/);
  assert.match(put, /res\.cookies\.set\(sessionCookie\(confirmed\.token\)\)/, 'the typed password’s sign-in is remembered');
  const restore = fs.readFileSync('src/app/api/admin/settings/history/route.ts', 'utf8');
  assert.ok(restore.indexOf('confirmOwnerForChange(') > 0 && restore.indexOf('confirmOwnerForChange(') < restore.indexOf('restoreSettingsVersion('), 'a restore: confirmed before it is put back');
  const staff = fs.readFileSync('src/app/api/admin/staff/route.ts', 'utf8');
  assert.ok(staff.indexOf('confirmOwnerForChange(') > 0 && staff.indexOf('confirmOwnerForChange(') < staff.indexOf('inviteAccountant('), 'an invitation: confirmed before the account is made');
  assert.match(staff, /allowFields\(body, \['email', 'name', 'currentPassword'\]\)/);
  // The password never reaches the audit log or the settings themselves.
  assert.doesNotMatch(put, /audit\([^)]*currentPassword/);
  assert.doesNotMatch(put, /saveGuarded\([^)]*currentPassword/);
});
