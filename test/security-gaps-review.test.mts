/**
 * Security, payments and operations gaps left open by earlier review rounds:
 *  1. Content Security Policy: per-request pages get a nonce policy with no 'unsafe-inline' for scripts.
 *  2. Password hashes: a higher scrypt cost that every released version can still check; old
 *     hashes are replaced at the next sign-in.
 *  3. Card payments: a refund after part of the payment was moved to another order; an unpaid
 *     order when Stripe refuses the saved key; a payment that succeeds after its order was cancelled.
 *  4. Behind a proxy without TRUST_PROXY=1: the monitor says so.
 *  5. Old Stripe event ids, seen chat emails and hourly chat counters are pruned daily.
 *  6. The updater's "after a restart" reminder reaches the hub's status.
 * (The browser side of 1 is in security-gaps-review-e2e.test.mts; the updater's own part of 6 in updater.test.mts.)
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { jsonRequest, tempDataDir } from './helpers.mjs';
import { startStripeMock, TEST_KEYS, type StripeMock } from './stripe-mock.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.SESSION_SECRET;
delete process.env.TRUST_PROXY;
process.env.CARD_SWEEP_DISABLED = '1';
const mock: StripeMock = await startStripeMock();
process.env.BUH_TEST_STRIPE_API = mock.url;
after(() => mock.close());

// ── The first released verify, copied as it shipped (src/lib/server/password.ts before this change) ──
const OLD_N = 16384;
function oldScrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}
async function oldHashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await oldScrypt(password, salt, OLD_N, 8, 1);
  return ['scrypt', OLD_N, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}
async function oldVerifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await oldScrypt(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// The owner's account as an older version left it: a hash at the first cost.
const OWNER = 'owner@shop.test';
const OWNER_PASSWORD = 'An-old-Owner-Passphrase-1';
const ownerOldHash = await oldHashPassword(OWNER_PASSWORD);
fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({ email: OWNER, passwordHash: ownerOldHash, mustChangePassword: false }), { mode: 0o600 });

const auth = await import('@/lib/server/adminAuth');
const password = await import('@/lib/server/password');
const staff = await import('@/lib/server/staffAuth');
const orders = await import('@/lib/server/orders');
const payments = await import('@/lib/server/payments');
const settings = await import('@/lib/server/settings');
const { listProducts } = await import('@/lib/server/products');
const { getDb } = await import('@/lib/server/db');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const ordersRoute = await import('@/app/api/orders/route');
const webhookRoute = await import('@/app/api/stripe/webhook/route');
const http = await import('@/lib/server/http');
const monitor = await import('@/lib/server/monitor');
const housekeeping = await import('@/lib/server/housekeeping');
const versions = await import('@/lib/server/versions');
const cspNonce = await import('@/lib/server/cspNonce');
const { contentSecurityPolicy } = await import('@/lib/csp');
const { LOCALE_BOOT_SCRIPT } = await import('@/lib/i18n/boot');

const storedOwnerHash = () => JSON.parse(fs.readFileSync(path.join(dir, 'admin.json'), 'utf8')).passwordHash as string;
const auditLinesWith = (action: string) =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .filter((l) => l.includes(`"action":"${action}"`));

// ── 1. Content Security Policy ───────────────────────────────────────────────

const scriptSrc = (policy: string) => policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? '';

test('1. the nonce policy: no unsafe-inline for scripts, a fresh nonce Next.js can read, the checkout’s hosts only where the checkout is', async () => {
  const { getScriptNonceFromHeader } = (await import('next/dist/server/app-render/get-script-nonce-from-header.js')) as { getScriptNonceFromHeader: (v: string) => string | undefined };
  const seen = new Set<string>();
  for (const kind of ['private', 'shop'] as const) {
    const nonce = cspNonce.newNonce();
    assert.match(nonce, /^[A-Za-z0-9+/]{24}$/, '144 random bits');
    assert.ok(!seen.has(nonce));
    seen.add(nonce);
    const policy = cspNonce.nonceContentSecurityPolicy(nonce, kind);
    const scripts = scriptSrc(policy);
    assert.doesNotMatch(scripts, /unsafe-inline|unsafe-eval/, kind);
    assert.ok(scripts.includes(`'nonce-${nonce}'`));
    assert.equal(getScriptNonceFromHeader(policy), nonce, 'Next.js finds the nonce for its own scripts');
    // The shop's one fixed inline script (the language direction) is allowed by its hash.
    assert.ok(scripts.includes(`'sha256-${crypto.createHash('sha256').update(LOCALE_BOOT_SCRIPT).digest('base64')}'`));
    // The rest of the policy is the shop's usual one.
    for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "worker-src 'self' blob:", "manifest-src 'self'"]) assert.ok(policy.includes(d), d);
    assert.equal(policy.replace(scripts, ''), contentSecurityPolicy().replace(scriptSrc(contentSecurityPolicy()), ''), 'only script-src differs');
  }
  const priv = scriptSrc(cspNonce.nonceContentSecurityPolicy('abc', 'private'));
  assert.doesNotMatch(priv, /strict-dynamic/, 'the host list stays in force');
  assert.doesNotMatch(priv, /https:/, 'the hub and the private pages load no other site’s script');
  const shop = scriptSrc(cspNonce.nonceContentSecurityPolicy('abc', 'shop'));
  assert.doesNotMatch(shop, /strict-dynamic/);
  assert.match(shop, /https:\/\/js\.stripe\.com/, 'Stripe.js stays allowed at checkout');
  assert.match(shop, /https:\/\/www\.google\.com\/recaptcha\//);

  // Which pages: the ones rendered for each request. The kept pages (home, category, festival) are not.
  for (const p of ['/hub', '/pay/abc']) assert.equal(cspNonce.nonceKindFor(p), 'private', p);
  for (const p of ['/deal/abc', '/track/abc.def', '/c/eid-picks', '/p/some-product', '/terms', '/order-by-photo']) assert.equal(cspNonce.nonceKindFor(p), 'shop', p);
  for (const p of ['/', '/shop/bedsheets', '/gifts/eid', '/offline', '/api/orders', '/termsx', '/hubx']) assert.equal(cspNonce.nonceKindFor(p), null, p);
});

// ── 2. Password hash cost ────────────────────────────────────────────────────

test('2. new hashes cost more, yet the first released verify (64 MiB limit) still checks them; N=2^16 would not fit', async () => {
  const hash = await password.hashPassword('correct horse battery');
  const [, n, r, p] = hash.split('$').map(Number);
  assert.ok(n * r * p >= 6 * OLD_N * 8, `at least six times the first cost (N=${n} r=${r} p=${p})`);
  assert.ok(128 * r * (n + 2) + 128 * r * p <= 64 * 1024 * 1024, 'fits the old verify’s memory limit');
  // The old code path, as shipped: a rollback (or the old copy during an update) can sign people in.
  assert.equal(await oldVerifyPassword('correct horse battery', hash), true);
  assert.equal(await oldVerifyPassword('wrong horse battery', hash), false);
  assert.equal(await password.verifyPassword('correct horse battery', hash), true);
  assert.equal(password.passwordNeedsRehash(hash), false);
  // Why N stops at 2^15: one step more is refused by the old code's limit.
  await assert.rejects(oldScrypt('x', crypto.randomBytes(16), 65536, 8, 1), /memory limit/i);

  // Old hashes still verify, and are marked for an upgrade.
  const old = await oldHashPassword('correct horse battery');
  assert.equal(await password.verifyPassword('correct horse battery', old), true);
  assert.equal(await password.verifyPassword('wrong', old), false);
  assert.equal(password.passwordNeedsRehash(old), true);
  assert.equal(password.passwordNeedsRehash('not-a-hash'), false);
  assert.equal(await password.verifyPassword('x', 'scrypt$0$8$1$AAAA$AAAA').catch(() => false), false, 'a broken hash never passes');
});

test('2. the owner’s old hash is replaced at the next sign-in (not when the password only confirms an action); the session it gives is valid', async () => {
  assert.equal(storedOwnerHash(), ownerOldHash);
  // A wrong password changes nothing.
  await assert.rejects(auth.signIn(OWNER, 'not the password', { upgradeHash: true }), (e: { status?: number }) => e.status === 401);
  assert.equal(storedOwnerHash(), ownerOldHash);

  // The password typed to confirm an action (new recovery codes, an email change): the session in use stays valid.
  const first = await auth.signIn(OWNER, OWNER_PASSWORD);
  const session = (await auth.verifySessionToken(first.token))!;
  assert.ok(session);
  await auth.confirmOwner(session, OWNER_PASSWORD);
  assert.equal(storedOwnerHash(), ownerOldHash, 'no upgrade there');
  assert.ok(await auth.verifySessionToken(first.token), 'still signed in');

  // A real sign-in (the login route): upgraded, stored with owner-only permissions, and it verifies everywhere.
  const signedIn = await auth.signIn(OWNER, OWNER_PASSWORD, { upgradeHash: true });
  const upgraded = storedOwnerHash();
  assert.notEqual(upgraded, ownerOldHash);
  assert.equal(password.passwordNeedsRehash(upgraded), false);
  assert.equal(fs.statSync(path.join(dir, 'admin.json')).mode & 0o777, 0o600);
  assert.equal(await oldVerifyPassword(OWNER_PASSWORD, upgraded), true, 'the old version can still sign the owner in');
  assert.ok(await auth.verifySessionToken(signedIn.token), 'the new session is for the new hash');
  // Sessions are tied to the stored hash: the earlier one ends (said in the report).
  assert.equal(await auth.verifySessionToken(first.token), null);

  // Again: nothing more to do.
  const again = await auth.signIn(OWNER, OWNER_PASSWORD, { upgradeHash: true });
  assert.equal(storedOwnerHash(), upgraded);
  assert.ok(await auth.verifySessionToken(again.token));
  assert.ok(await auth.verifySessionToken(signedIn.token));
});

test('2. an accountant’s old hash is upgraded the same way, only while it is still the one that was checked', async () => {
  const PASSWORD = 'The-Accountants-Passphrase-9';
  const invite = staff.inviteAccountant('ca@firm.test', 'Our CA', OWNER, OWNER);
  await staff.completeStaffSetup(invite.token, PASSWORD);
  const old = await oldHashPassword(PASSWORD);
  getDb().prepare('UPDATE staff_accounts SET password_hash = ? WHERE id = ?').run(old, invite.account.id);
  const hashNow = () => getDb().prepare('SELECT password_hash FROM staff_accounts WHERE id = ?').pluck().get(invite.account.id) as string;

  const r = await auth.signIn('ca@firm.test', PASSWORD, { upgradeHash: true });
  assert.equal(r.role, 'accountant');
  assert.notEqual(hashNow(), old);
  assert.equal(password.passwordNeedsRehash(hashNow()), false);
  assert.equal(await oldVerifyPassword(PASSWORD, hashNow()), true);
  assert.ok(await auth.verifySessionToken(r.token), 'their session is valid');

  // Never over a hash that changed meanwhile (a new setup, the other copy of the shop).
  assert.equal(staff.upgradeStaffPasswordHash(invite.account.id, old, 'scrypt$1$1$1$x$y'), false);
  assert.equal(password.passwordNeedsRehash(hashNow()), false);
});

// ── 3. Card payments ─────────────────────────────────────────────────────────

const ORIGIN = 'http://shop.test';
await settings.updateSettings('store', { whatsappNumber: '+971501234567' });
const keysOn = () => settings.updateSettings('payments', { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook });
await keysOn();

let n = 0;
const product = () => listProducts()[0];
const stockOf = (productId: string, sizeId: string) => (getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').get(productId, sizeId) as { qty: number }).qty;
const customer = () => ({ fullName: 'Layla Card', phone: `050 78${String(++n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Tower 1', flatVillaNo: 'Apt 4' });

async function placeCard() {
  _clearAllRateLimits();
  const p = product();
  const body = { idempotencyKey: `gaps-card-${n}-${crypto.randomUUID()}`, customer: customer(), items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }], paymentMethod: 'online_card' };
  const res = await ordersRoute.POST(jsonRequest(body, { origin: ORIGIN }) as never);
  const data = (await res.json()) as { order?: { id: string; total: number }; payment?: { clientSecret: string }; message?: string };
  assert.ok(data.order && data.payment, data.message);
  return { id: data.order.id, clientSecret: data.payment.clientSecret };
}
function placeCash(quantity = 1) {
  _clearAllRateLimits();
  const p = product();
  return orders.placeOrder({ idempotencyKey: `gaps-cash-${crypto.randomUUID()}`, customer: { ...customer(), phone: `+9715067${String(n).padStart(5, '0')}` }, items: [{ productId: p.id, profileId: p.profiles[0].id, quantity }], paymentMethod: 'cod' }, { ip: `10.9.${n % 250}.1` }).order;
}
async function webhook(body: string, signature: string) {
  const res = await webhookRoute.POST(new Request('http://shop.test/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body }));
  return res.status;
}
const intentOf = (orderId: string) => [...mock.intents.values()].find((p) => p.metadata.orderId === orderId)!;
async function paidCard() {
  const { id } = await placeCard();
  const pi = mock.succeed(intentOf(id).id);
  const ev = mock.event('payment_intent.succeeded', pi);
  assert.equal(await webhook(ev.body, ev.signature), 200);
  assert.equal(orders.getOrder(id)!.card!.state, 'paid');
  return { id, pi };
}
const refundCalls = (piId: string) => mock.requests.filter((x) => x.method === 'POST' && x.path === '/v1/refunds' && x.body.get('payment_intent') === piId);
const codeOf = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const age = (id: string, minutes: number) => getDb().prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - minutes * 60_000).toISOString(), id);

test('3a. Cancel & refund after part of the payment was moved to another order: Stripe is sent what is left (paid − refunded − moved), once', async () => {
  const { id, pi } = await paidCard();
  const other = placeCash();
  const moved = 1000; // AED 10
  orders.moveCredit(id, other.id, moved / 100, OWNER);
  assert.equal(orders.getOrder(id)!.status, 'cancelled', 'moving the payment cancels the paid order');
  assert.equal(orders.refundableFils(orders.getOrder(id)!), pi.amount - moved);

  // The owner's screen still showed the whole payment: refused, with what is left.
  await assert.rejects(payments.refundCardOrder(id, OWNER, pi.amount), (e) => codeOf(e) === 'refund_amount_changed' && (e as { details: { amount: number } }).details.amount === (pi.amount - moved) / 100);
  assert.equal(refundCalls(pi.id).length, 0, 'nothing sent to Stripe yet');

  const r = await payments.refundCardOrder(id, OWNER, pi.amount - moved);
  assert.equal(r.outcome, 'refunded');
  const calls = refundCalls(pi.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.get('amount'), String(pi.amount - moved), 'the moved part is not refunded too');
  assert.equal(calls[0].idempotencyKey, `refund:${id}:${pi.amount - moved}`);
  assert.match(auditLinesWith('payment.refund_requested').at(-1)!, new RegExp(`"amountFils":${pi.amount - moved}`), 'audited before it went to Stripe');
  // Again: nothing more.
  assert.equal((await payments.refundCardOrder(id, OWNER)).outcome, 'already');
  assert.equal(refundCalls(pi.id).length, 1);
  // The other order still collects that much less.
  assert.equal(Math.round((orders.getOrder(other.id)!.courier.codAmountCollected ?? 0) * 100), Math.round(other.total * 100) - moved);

  // With a partial refund made in Stripe's dashboard as well (its webhook not here yet): all three count.
  const second = await paidCard();
  const other2 = placeCash();
  mock.dashboardRefund(second.pi.id, 500);
  orders.moveCredit(second.id, other2.id, 7.5, OWNER);
  const left = second.pi.amount - 500 - 750;
  const r2 = await payments.refundCardOrder(second.id, OWNER, left);
  assert.equal(r2.outcome, 'refunded');
  const calls2 = refundCalls(second.pi.id);
  assert.equal(calls2.length, 1);
  assert.equal(calls2[0].body.get('amount'), String(left));
});

test('3a. the whole payment moved: 409 refund_moved, nothing sent to Stripe, nothing changed', async () => {
  const { id, pi } = await paidCard();
  const other = placeCash(2); // collects more than the card order paid
  assert.ok(Math.round(other.total * 100) >= pi.amount);
  orders.moveCredit(id, other.id, pi.amount / 100, OWNER);
  const before = mock.requests.filter((x) => x.path === '/v1/refunds').length;
  await assert.rejects(payments.refundCardOrder(id, OWNER), (e: { status?: number; message?: string }) => e.status === 409 && codeOf(e) === 'refund_moved' && new RegExp(`moved onto another order`).test(e.message ?? ''));
  await assert.rejects(payments.refundCardOrder(id, OWNER, pi.amount), (e) => codeOf(e) === 'refund_moved');
  assert.equal(mock.requests.filter((x) => x.path === '/v1/refunds').length, before, 'no refund was asked of Stripe');
  const o = orders.getOrder(id)!;
  assert.equal(o.card!.state, 'paid', 'not marked refunded');
  assert.equal(orders.refundableFils(o), 0);
});

test('3b. Stripe refuses the saved key (401 or 403) on cancel and on retrieve: the unpaid order is closed like an unreachable payment, flagged unless test mode', async () => {
  const p = product();
  const size = p.profiles[0].id;
  try {
    for (const status of [401, 403] as const) {
      // A test-mode order: cancelled by the sweep, its piece back once, no flag.
      const test1 = await placeCard();
      // One whose mode is not known to be test (made before modes were kept): flagged for the owner.
      const unknown = await placeCard();
      getDb().prepare('UPDATE orders SET card_livemode = NULL WHERE id = ?').run(unknown.id);
      const start = stockOf(p.id, size);
      age(test1.id, 11);
      age(unknown.id, 11);
      mock.refuse = { status };
      assert.equal(await payments.sweepCardOrders(), 2, `closed (${status})`);
      assert.equal(await payments.sweepCardOrders(), 0, 'once');
      assert.equal(stockOf(p.id, size), start + 2, 'their pieces back on sale, once');
      const a = orders.getOrder(test1.id)!;
      assert.equal(a.status, 'cancelled');
      assert.equal(a.card!.state, 'canceled');
      assert.equal(a.attention, undefined, 'a test-mode payment needs no owner check');
      const b = orders.getOrder(unknown.id)!;
      assert.equal(b.status, 'cancelled');
      assert.equal(b.attention?.kind, 'card_unreachable');
      assert.match(b.attention!.text, /Stripe refused the secret key now saved/);
      assert.match(b.attention!.text, new RegExp(intentOf(unknown.id).id), 'names the payment to look up');
      assert.match(auditLinesWith('payment.card_cancelled').at(-1)!, /Stripe refused the secret key now saved/, 'audited with why');
      // Both were asked of Stripe, and both refused.
      const asked = mock.requests.filter((x) => x.path.includes(intentOf(unknown.id).id));
      assert.ok(asked.some((x) => x.method === 'POST' && x.path.endsWith('/cancel')) && asked.some((x) => x.method === 'GET'), 'cancel, then retrieve');
      mock.refuse = null;
    }

    // The owner's own Cancel, the key refused: cancelled (not "Stripe is still processing").
    const mine = await placeCard();
    mock.refuse = { status: 401 };
    const cancelled = await payments.cancelUnpaidCardOrder(mine.id, OWNER);
    assert.equal(cancelled.status, 'cancelled');
    mock.refuse = null;

    // A key that may read but no longer stop payments (403 on cancel only): an unpaid one is closed
    // too; one Stripe says is paid is recorded as paid, never cancelled.
    const unpaid = await placeCard();
    const paid = await placeCard();
    mock.succeed(intentOf(paid.id).id);
    age(unpaid.id, 11);
    age(paid.id, 11);
    mock.refuse = { status: 403, only: /^POST .*\/cancel$/ };
    assert.equal(await payments.sweepCardOrders(), 1);
    assert.equal(orders.getOrder(unpaid.id)!.status, 'cancelled');
    const kept = orders.getOrder(paid.id)!;
    assert.equal(kept.card!.state, 'paid');
    assert.notEqual(kept.status, 'cancelled');
  } finally {
    mock.refuse = null;
  }

  // Stripe merely unreachable (a 500) is not a refused key: the order waits for the next sweep.
  const waiting = await placeCard();
  age(waiting.id, 11);
  mock.intents.get(intentOf(waiting.id).id)!.status = 'processing';
  assert.equal(await payments.sweepCardOrders(), 0);
  assert.notEqual(orders.getOrder(waiting.id)!.status, 'cancelled');
});

test('3c. paid after cancel: a payment that succeeds after its order was cancelled is recorded, flagged for the owner and notified, once', async () => {
  const warned: string[] = [];
  const saved = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(' '));
  try {
    const p = product();
    const size = p.profiles[0].id;
    const { id, clientSecret } = await placeCard();
    await payments.abandonCardPayment(id, clientSecret);
    assert.equal(orders.getOrder(id)!.status, 'cancelled');
    assert.equal(orders.getOrder(id)!.card!.state, 'canceled');
    const stock = stockOf(p.id, size);

    // Stripe says it was paid all the same (only possible around a rollback or a refused cancel).
    const pi = mock.succeed(intentOf(id).id);
    const ev = mock.event('payment_intent.succeeded', pi);
    assert.equal(await webhook(ev.body, ev.signature), 200);
    const o = orders.getOrder(id)!;
    assert.equal(o.status, 'cancelled', 'not brought back by itself');
    assert.equal(o.card!.state, 'paid', 'the money is recorded, so it can be refunded from the hub');
    assert.equal(o.attention?.kind, 'paid_after_cancel');
    assert.match(o.attention!.text, /was paid by card after this order was cancelled/);
    assert.match(o.attention!.text, new RegExp(`AED ${pi.amount / 100}\\b`));
    assert.equal(orders.ordersNeedingAttention() >= 1, true);
    assert.equal(stockOf(p.id, size), stock, 'no piece is taken for a cancelled order');
    assert.equal(auditLinesWith('payment.paid_after_cancel').filter((l) => l.includes(id)).length, 1, 'audited');
    assert.equal(auditLinesWith('payment.paid').filter((l) => l.includes(`"orderId":"${id}"`)).length, 0, 'not as an ordinary payment');

    // The owner is told (an email when mail is set up; always in the log).
    for (let i = 0; i < 50 && !warned.some((l) => l.includes('owner_alert') && l.includes(id)); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(warned.some((l) => l.includes('"event":"owner_alert"') && l.includes(`Order ${id} needs your attention`)), warned.join('\n'));

    // The same event again, and a new event for the same payment: nothing more.
    const alerts = () => warned.filter((l) => l.includes('owner_alert') && l.includes(id)).length;
    const told = alerts();
    assert.equal(await webhook(ev.body, ev.signature), 200);
    const ev2 = mock.event('payment_intent.succeeded', pi);
    assert.equal(await webhook(ev2.body, ev2.signature), 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(auditLinesWith('payment.paid_after_cancel').filter((l) => l.includes(id)).length, 1);
    assert.equal(alerts(), told, 'told once');

    // And the owner can give it back: Cancel & refund refunds the whole payment.
    const r = await payments.refundCardOrder(id, OWNER, pi.amount);
    assert.equal(r.outcome, 'refunded');
    assert.equal(refundCalls(pi.id).length, 1);
  } finally {
    console.warn = saved;
  }
});

// ── 4. Behind a proxy without TRUST_PROXY ────────────────────────────────────

test('4. the monitor warns when requests arrive through a proxy and TRUST_PROXY is not set; never for a shop opened directly, a test server, or with it set', () => {
  const env = process.env as Record<string, string | undefined>;
  const before = { NODE_ENV: env.NODE_ENV, TRUST_PROXY: env.TRUST_PROXY, BUH_TEST_SERVER: env.BUH_TEST_SERVER };
  const problem = (now?: number) => monitor.currentProblems(now).find((p) => p.id === 'trust_proxy');
  const arrive = (count: number, headers: Record<string, unknown>, at: number) => {
    for (let i = 0; i < count; i++) http.noteArrival(headers, at + i);
  };
  try {
    env.NODE_ENV = 'production';
    delete env.TRUST_PROXY;
    delete env.BUH_TEST_SERVER;
    const t0 = Date.now();

    // Opened directly on this machine (no proxy): no forwarded headers, no warning.
    http._resetArrivals();
    arrive(200, { host: '127.0.0.1:3000' }, t0);
    assert.equal(problem(), undefined);

    // A few requests that bring the header themselves (anyone can send it) are not a proxy.
    arrive(5, { 'x-forwarded-for': '203.0.113.9' }, t0 + 1000);
    assert.equal(problem(), undefined);

    // Behind a proxy: most requests carry it. The updater's own health checks (not counted) change nothing.
    http._resetArrivals();
    for (let i = 0; i < 500; i++) http.noteArrival({ host: '127.0.0.1:3000' }, t0 + i, false);
    arrive(9, { 'x-forwarded-for': '198.51.100.7' }, t0);
    assert.equal(problem(), undefined, 'too few requests to tell');
    arrive(3, { 'x-real-ip': '198.51.100.7' }, t0 + 100);
    const warning = problem();
    assert.ok(warning, 'warned');
    assert.equal(warning.level, 'warning');
    assert.match(warning.text, /TRUST_PROXY=1/, 'the exact setting');
    assert.match(warning.text, /--env "TRUST_PROXY=1"/, 'and how to add it');
    assert.match(warning.text, /sign-in pauses for everyone/);
    assert.doesNotMatch(warning.text, /X-Forwarded|header|rate.?limit/i, 'plain words');

    // Not on a test server, not outside production, not once it is set.
    env.BUH_TEST_SERVER = '1';
    assert.equal(problem(), undefined);
    delete env.BUH_TEST_SERVER;
    env.NODE_ENV = 'test';
    assert.equal(problem(), undefined);
    env.NODE_ENV = 'production';
    env.TRUST_PROXY = '1';
    assert.equal(problem(), undefined);
    assert.equal(http.proxyWithoutTrust(), false);
    delete env.TRUST_PROXY;
    assert.ok(problem());

    // The proxy taken away: the warning goes a day after the last such request.
    assert.ok(problem(t0 + 23 * 3600_000));
    assert.equal(problem(t0 + 25 * 3600_000), undefined);

    // With TRUST_PROXY=1 nothing is counted at all.
    http._resetArrivals();
    env.TRUST_PROXY = '1';
    arrive(50, { 'x-forwarded-for': '198.51.100.7' }, t0);
    delete env.TRUST_PROXY;
    assert.equal(problem(), undefined);
  } finally {
    http._resetArrivals();
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
});

// ── 5. Slow growth ───────────────────────────────────────────────────────────

test('5. once a day: Stripe event ids and seen chat emails older than 90 days and hourly chat counters older than 7 days are removed, a bounded number a round; an order’s history never', () => {
  const db = getDb();
  const now = Date.parse('2026-11-14T09:30:00Z');
  const daysAgo = (d: number) => new Date(now - d * 24 * 3600_000).toISOString();
  db.prepare('DELETE FROM stripe_events').run();
  db.prepare('DELETE FROM chat_mail_seen').run();
  const ev = db.prepare('INSERT INTO stripe_events (id, type, order_id, at, outcome) VALUES (?, ?, ?, ?, ?)');
  ev.run('evt_old', 'payment_intent.succeeded', 'BUH-1', daysAgo(91), 'paid');
  ev.run('evt_edge', 'payment_intent.succeeded', 'BUH-1', daysAgo(89), 'paid');
  ev.run('evt_new', 'charge.refunded', 'BUH-2', daysAgo(1), 'refunded');
  const mail = db.prepare('INSERT INTO chat_mail_seen (message_id, at) VALUES (?, ?)');
  mail.run('<old@mail>', daysAgo(120));
  mail.run('<recent@mail>', daysAgo(2));
  const kv = db.prepare('INSERT OR REPLACE INTO kv (key, data, updated_at) VALUES (?, ?, ?)');
  const hourKey = (d: number) => `chat:owner-emails:${daysAgo(d).slice(0, 13)}`;
  kv.run(hourKey(30), '3', daysAgo(30));
  kv.run(hourKey(8), '1', daysAgo(8));
  kv.run(hourKey(6), '2', daysAgo(6));
  kv.run(hourKey(0), '4', daysAgo(0));
  kv.run('chat:other-setting', '"keep"', daysAgo(400));
  kv.run('chat:owner-emailsX', '"keep"', daysAgo(400));
  const kvCount = () => db.prepare('SELECT COUNT(*) FROM kv').pluck().get() as number;
  const kvBefore = kvCount();
  const history = db.prepare('SELECT COUNT(*) FROM order_events').pluck().get() as number;
  assert.ok(history > 0, 'the orders above left their history');
  db.prepare("UPDATE order_events SET at = ? WHERE id IN (SELECT id FROM order_events LIMIT 3)").run(daysAgo(900));

  assert.deepEqual(housekeeping.pruneOldRecords(now), { stripeEvents: 1, chatMailSeen: 1, chatHourKeys: 2 });
  assert.deepEqual(db.prepare('SELECT id FROM stripe_events ORDER BY id').pluck().all(), ['evt_edge', 'evt_new']);
  assert.deepEqual(db.prepare('SELECT message_id FROM chat_mail_seen').pluck().all(), ['<recent@mail>']);
  assert.deepEqual(db.prepare("SELECT key FROM kv WHERE key LIKE 'chat:owner-emails:%' ORDER BY key").pluck().all(), [hourKey(6), hourKey(0)]);
  assert.equal(kvCount(), kvBefore - 2, 'no other setting or counter was touched');
  assert.equal(db.prepare('SELECT COUNT(*) FROM order_events').pluck().get(), history, 'order history is kept, however old');
  assert.deepEqual(housekeeping.pruneOldRecords(now), { stripeEvents: 0, chatMailSeen: 0, chatHourKeys: 0 }, 'again: nothing');

  // A recent event sent again is still recognised (its id is kept): applied once.
  assert.equal(db.prepare("INSERT INTO stripe_events (id, type, order_id, at, outcome) VALUES ('evt_new', 'x', NULL, ?, 'applying') ON CONFLICT(id) DO NOTHING").run(daysAgo(0)).changes, 0);

  // Bounded: a long backlog goes a batch a round.
  db.transaction(() => {
    for (let i = 0; i < housekeeping.PRUNE_BATCH + 7; i++) ev.run(`evt_backlog_${i}`, 't', null, daysAgo(200), 'ignored');
  })();
  assert.equal(housekeeping.pruneOldRecords(now).stripeEvents, housekeeping.PRUNE_BATCH);
  assert.equal(housekeeping.pruneOldRecords(now).stripeEvents, 7);

  // Started with the other periodic jobs, once; and it can be switched off.
  const startup = fs.readFileSync(path.resolve('src/lib/server/startup.ts'), 'utf8');
  assert.match(startup, /step\('housekeeping', startHousekeeping\)/);
  housekeeping.startHousekeeping();
  housekeeping.startHousekeeping();
});

// ── 6. The updater's reminder ────────────────────────────────────────────────

test('6. the updater’s "after a restart" reminder reaches the hub’s status (capped), and is empty from an updater that does not send it', () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-status-'));
  const env = process.env as Record<string, string | undefined>;
  const before = env.UPDATER_STATUS_DIR;
  env.UPDATER_STATUS_DIR = statusDir;
  try {
    const base = { updatedAt: new Date().toISOString(), mode: 'single', running: '2.46.0', lastGood: '2.46.0', previous: '', onServer: ['2.46.0'], autoUpdateMinutes: 15 };
    fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify(base));
    assert.equal(versions.updaterStatus()?.restartNote, '');
    const note = 'Not yet seen coming back by itself after a restart of the computer. With Podman that needs its restart service, turned on once. Linux server: sudo systemctl enable --now podman-restart.service';
    fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify({ ...base, restartNote: note }));
    assert.equal(versions.updaterStatus()?.restartNote, note);
    fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify({ ...base, restartNote: 'x'.repeat(5000) }));
    assert.equal(versions.updaterStatus()?.restartNote.length, 500);
    fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify({ ...base, restartNote: { not: 'text' } }));
    assert.equal(versions.updaterStatus()?.restartNote, '');
  } finally {
    if (before === undefined) delete env.UPDATER_STATUS_DIR;
    else env.UPDATER_STATUS_DIR = before;
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});
