/**
 * BUH-02.09: card payments (with Apple Pay and Google Pay) through the owner's Stripe account,
 * against a local stand-in for Stripe's API (never the real one). The amount comes from the
 * server's prices; one PaymentIntent per order (idempotency key); paid only on a validly signed
 * webhook whose amount, currency and order match (or the server asking Stripe); resent and
 * out-of-order events change nothing; unpaid orders are stopped at Stripe and cancelled with
 * their stock released exactly once; refunds once, recorded from Stripe; keys never in answers,
 * logs or backups; the migration only adds; wallet addresses map onto the shop's areas.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { jsonRequest, tempDataDir } from './helpers.mjs';
import { startStripeMock, TEST_KEYS, type StripeMock } from './stripe-mock.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
process.env.CARD_SWEEP_DISABLED = '1';
const mock: StripeMock = await startStripeMock();
process.env.BUH_TEST_STRIPE_API = mock.url;

const orders = await import('@/lib/server/orders');
const payments = await import('@/lib/server/payments');
const settings = await import('@/lib/server/settings');
const { listProducts } = await import('@/lib/server/products');
const { getDb } = await import('@/lib/server/db');
const { dispatchOrder } = await import('@/lib/server/dispatch');
const ordersRoute = await import('@/app/api/orders/route');
const paymentRoute = await import('@/app/api/orders/payment/route');
const webhookRoute = await import('@/app/api/stripe/webhook/route');
const publicRoute = await import('@/app/api/settings/public/route');
const { walletAddress, emirateFrom } = await import('@/lib/walletAddress');
const { redact } = await import('@/lib/server/log');

after(() => mock.close());

const ORIGIN = 'http://shop.test';
const keysOn = () => settings.updateSettings('payments', { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook });

/** Everything printed while fn runs (console), to check keys never reach the logs. */
const printed: string[] = [];
const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
before(() => {
  for (const k of Object.keys(saved) as Array<keyof typeof saved>) console[k] = (...a: unknown[]) => void printed.push(a.map(String).join(' '));
});
after(() => Object.assign(console, saved));

let n = 0;
const product = () => listProducts()[0];
const stockOf = (productId: string, sizeId: string) => (getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').get(productId, sizeId) as { qty: number }).qty;
const priceFils = () => Math.round(product().price * 100) + Math.round((product().profiles[0].priceDelta || 0) * 100);

function cardBody(over: Record<string, unknown> = {}) {
  const p = product();
  return {
    idempotencyKey: `card-test-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    customer: { fullName: 'Layla Card', phone: `050 77${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Tower 1', flatVillaNo: 'Apt 4' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'online_card',
    ...over,
  };
}

async function placeCard(over: Record<string, unknown> = {}) {
  const res = await ordersRoute.POST(jsonRequest(cardBody(over), { origin: ORIGIN }) as never);
  return { res, data: (await res.json()) as { order?: { id: string; total: number; status: string; card?: { state: string } }; payment?: { clientSecret: string }; message?: string; code?: string } };
}

async function webhook(body: string, signature: string | null, headers: Record<string, string> = {}) {
  const res = await webhookRoute.POST(new Request('http://shop.test/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}), ...headers }, body }));
  return { status: res.status, text: await res.text() };
}

const intentOf = (orderId: string) => [...mock.intents.values()].find((p) => p.metadata.orderId === orderId)!;
function auditActions(): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).action as string));
}

test('Settings → Payments: off by default; keys validated; on needs all three from one mode; secrets never come back', async () => {
  assert.equal(settings.getSettings('payments').cardEnabled, false);
  assert.equal(settings.cardPaymentsReady(), false);
  const pub = await (await publicRoute.GET()).json();
  assert.deepEqual(pub.payments, { card: false }, 'off: checkout offers no card');
  const refused = async (input: Record<string, unknown>) => {
    try {
      await settings.updateSettings('payments', input);
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };
  assert.equal(await refused({ stripePublishableKey: 'sk_test_51abcdefghijklmnop' }), 400, 'a secret key in the publishable field');
  assert.equal(await refused({ stripeSecretKey: 'pk_test_51abcdefghijklmnop' }), 400, 'the publishable key in the secret field');
  assert.equal(await refused({ stripeWebhookSecret: 'not-a-secret' }), 400);
  assert.equal(await refused({ cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable }), 400, 'on without the secret keys');
  assert.equal(await refused({ stripePublishableKey: 'pk_live_51abcdefghijklmnopqrst', stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook }), 400, 'live publishable with a test secret');
  assert.equal(settings.getSettings('payments').stripeSecretKey, '', 'nothing refused was stored');

  await keysOn();
  assert.equal(settings.cardPaymentsReady(), true);
  const view = settings.adminView('payments');
  assert.equal(view.value.stripeSecretKey, '');
  assert.equal(view.value.stripeWebhookSecret, '');
  assert.deepEqual(view.secretsSet, { stripeSecretKey: true, stripeWebhookSecret: true });
  assert.equal(settings.stripeMode(TEST_KEYS.publishable), 'test');
  assert.equal(settings.stripeMode('sk_live_x'), 'live');
  const after = await (await publicRoute.GET()).json();
  assert.deepEqual(after.payments, { card: true, publishableKey: TEST_KEYS.publishable });
  const text = JSON.stringify(after);
  assert.ok(!text.includes(TEST_KEYS.secret) && !text.includes(TEST_KEYS.webhook), 'only the publishable key reaches the shop');
  // A save without the keys keeps them (write-only); history never keeps them.
  await settings.updateSettings('payments', { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable });
  assert.equal(settings.getSettings('payments').stripeSecretKey, TEST_KEYS.secret);
  const history = getDb().prepare("SELECT data FROM settings_history WHERE key = 'payments'").all() as Array<{ data: string }>;
  assert.ok(history.length >= 1);
  for (const h of history) assert.ok(!h.data.includes(TEST_KEYS.secret) && !h.data.includes(TEST_KEYS.webhook));
});

test('a card order: no SMS code, the server’s prices (a tampered total is refused), one PaymentIntent with order:<id>', async () => {
  const p = product();
  const before = stockOf(p.id, p.profiles[0].id);
  const tampered = await placeCard({ expectedTotal: 1 });
  assert.equal(tampered.res.status, 409, 'a total the server didn’t compute is refused');
  assert.equal(tampered.data.code, 'price_changed');
  assert.equal(stockOf(p.id, p.profiles[0].id), before, 'nothing reserved');
  // Extra fields from the browser (a price, a total) are simply not read.
  const body = cardBody({ total: 1, subtotal: 1, amount: 100, expectedTotal: priceFils() / 100 });
  (body.items as Array<Record<string, unknown>>)[0].unitPrice = 1;
  const res = await ordersRoute.POST(jsonRequest(body, { origin: ORIGIN }) as never);
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.order.status, 'pending_payment');
  assert.equal(data.order.paymentMethod, 'online_card');
  assert.deepEqual(data.order.card, { state: 'pending' });
  assert.equal(data.order.customer.phone, '+971507700002');
  assert.equal(data.order.customer.phoneVerified, false, 'no SMS code: the card payment is the proof');
  assert.match(data.payment.clientSecret, /^pi_\w+_secret_\w+$/);
  assert.equal(stockOf(p.id, p.profiles[0].id), before - 1, 'the piece is held while the customer pays');
  const pi = intentOf(data.order.id);
  assert.equal(pi.amount, priceFils(), 'Stripe is asked for the server’s total, in fils');
  assert.equal(pi.currency, 'aed');
  const creates = mock.requests.filter((r) => r.method === 'POST' && r.path === '/v1/payment_intents' && r.body.get('metadata[orderId]') === data.order.id);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].idempotencyKey, `order:${data.order.id}`);
  assert.equal(creates[0].auth, `Bearer ${TEST_KEYS.secret}`);
  assert.deepEqual(creates[0].body.getAll('payment_method_types[0]').concat(creates[0].body.getAll('payment_method_types[1]')), ['card', 'link']);

  // The same checkout sent again (a retry): the same order and the same intent, no second one.
  const again = await ordersRoute.POST(jsonRequest(body, { origin: ORIGIN }) as never);
  assert.equal(again.status, 200);
  const d2 = await again.json();
  assert.equal(d2.order.id, data.order.id);
  assert.equal(d2.payment.clientSecret, data.payment.clientSecret);
  assert.equal([...mock.intents.values()].filter((x) => x.metadata.orderId === data.order.id).length, 1);
  assert.equal(stockOf(p.id, p.profiles[0].id), before - 1, 'held once');
});

test('a card order needs a UAE mobile, card switched on, and can’t pile up unpaid per phone', async () => {
  assert.equal((await placeCard({ customer: { ...cardBody().customer, phone: '04 123 4567' } })).res.status, 400, 'a landline');
  assert.equal((await placeCard({ customer: { ...cardBody().customer, phone: '+44 7700 900123' } })).res.status, 400, 'not a UAE number');
  const phone = '+971559990001';
  const a = await placeCard({ customer: { ...cardBody().customer, phone } });
  const b = await placeCard({ customer: { ...cardBody().customer, phone } });
  assert.equal(a.res.status, 201);
  assert.equal(b.res.status, 201);
  const c = await placeCard({ customer: { ...cardBody().customer, phone } });
  assert.equal(c.res.status, 429, 'a third unpaid card order for one phone');
  await settings.updateSettings('payments', { cardEnabled: false });
  const off = await placeCard();
  assert.equal(off.res.status, 400);
  assert.equal(off.data.code, 'card_unavailable');
  await keysOn();
  for (const o of [a, b]) await payments.abandonCardPayment(o.data.order!.id, o.data.payment!.clientSecret);
});

test('paid only by a validly signed webhook matching amount, currency and order; resent and late events change nothing', async () => {
  const { data } = await placeCard();
  const id = data.order!.id;
  const pi = intentOf(id);
  // Not paid yet: the browser can't say otherwise (the check asks Stripe).
  const check = await paymentRoute.POST(jsonRequest({ orderId: id, clientSecret: data.payment!.clientSecret }, { origin: ORIGIN }) as never);
  assert.equal((await check.json()).card.state, 'pending');

  // Wrong amount / currency / order: recorded, audited, never paid.
  for (const [what, object] of [
    ['amount', { ...pi, status: 'succeeded', amount: pi.amount - 100, amount_received: pi.amount - 100 }],
    ['currency', { ...pi, status: 'succeeded', currency: 'usd' }],
    ['intent', { ...pi, id: 'pi_someoneelse', status: 'succeeded' }],
  ] as const) {
    const e = mock.event('payment_intent.succeeded', object);
    const r = await webhook(e.body, e.signature);
    assert.equal(r.status, 200, what);
    assert.equal(orders.getOrder(id)!.card!.state, 'pending', `${what}: not paid`);
  }
  assert.ok(auditActions().filter((a) => a === 'payment.mismatch').length >= 3);

  const paidPi = mock.succeed(pi.id, { wallet: 'google_pay', brand: 'mastercard', last4: '4444' });
  const ev = mock.event('payment_intent.succeeded', { ...paidPi, latest_charge: paidPi.latest_charge });
  const auditBefore = auditActions().filter((a) => a === 'payment.paid').length;
  assert.equal((await webhook(ev.body, ev.signature)).status, 200);
  let o = orders.getOrder(id)!;
  assert.equal(o.card!.state, 'paid');
  assert.equal(o.status, 'pending_confirmation', 'now the owner confirms it like any order');
  assert.equal(o.paymentStatus, 'paid');
  assert.equal(o.card!.paidAmount, o.total);
  assert.equal(o.card!.ref, pi.id, 'the reference is Stripe’s PaymentIntent id');
  assert.equal(auditActions().filter((a) => a === 'payment.paid').length, auditBefore + 1);
  // The label comes from Stripe (fetched after answering the webhook).
  for (let i = 0; i < 50 && !orders.getOrder(id)!.card!.label; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(orders.getOrder(id)!.card!.label, 'Google Pay · Mastercard •••• 4444');

  // The same event again, and another succeeded event: nothing changes, nothing more is audited.
  assert.equal(payments.handleStripeWebhook(Buffer.from(ev.body), ev.signature).outcome, 'duplicate');
  const ev2 = mock.event('payment_intent.succeeded', paidPi);
  assert.equal(payments.handleStripeWebhook(Buffer.from(ev2.body), ev2.signature).outcome, 'already');
  // Late, out-of-order events can't un-pay it.
  for (const type of ['payment_intent.payment_failed', 'payment_intent.canceled']) {
    const late = mock.event(type, { ...paidPi, status: type.endsWith('canceled') ? 'canceled' : 'requires_payment_method', last_payment_error: { decline_code: 'insufficient_funds' } });
    assert.equal((await webhook(late.body, late.signature)).status, 200);
  }
  o = orders.getOrder(id)!;
  assert.equal(o.card!.state, 'paid');
  assert.equal(o.status, 'pending_confirmation');
  assert.equal(auditActions().filter((a) => a === 'payment.paid').length, auditBefore + 1);
  const events = getDb().prepare('SELECT COUNT(*) AS n FROM stripe_events WHERE id = ?').get(ev.id) as { n: number };
  assert.equal(events.n, 1);
});

test('the webhook refuses a wrong signature, no saved secret, no signature, an oversized or broken body: one answer for all', async () => {
  const { data } = await placeCard();
  const pi = mock.succeed(intentOf(data.order!.id).id);
  const good = mock.event('payment_intent.succeeded', pi);
  const answers = [
    await webhook(good.body, mock.event('payment_intent.succeeded', pi, { secret: 'whsec_someoneElsesSecret00000000' }).signature),
    await webhook(good.body, null),
    await webhook(good.body, 't=1,v1=deadbeef'),
    await webhook(good.body.replace('"aed"', '"usd"'), good.signature),
    await webhook('not json', good.signature),
    await webhook('x'.repeat(payments.WEBHOOK_MAX_BYTES + 10), good.signature),
  ];
  for (const a of answers) assert.deepEqual(a, answers[0]);
  assert.equal(answers[0].status, 400);
  assert.deepEqual(JSON.parse(answers[0].text), { received: false, message: 'Invalid request.' });
  assert.equal(orders.getOrder(data.order!.id)!.card!.state, 'pending', 'none of them paid it');
  // No signing secret saved: refused the same way, even with a valid-looking signature.
  const s = settings.getSettings('payments');
  await settings.updateSettings('payments', { cardEnabled: false, stripeWebhookSecret: null });
  assert.deepEqual(await webhook(good.body, good.signature), answers[0]);
  await settings.updateSettings('payments', { cardEnabled: s.cardEnabled, stripeWebhookSecret: TEST_KEYS.webhook });
  assert.equal((await webhook(good.body, good.signature)).status, 200);
  assert.equal(orders.getOrder(data.order!.id)!.card!.state, 'paid');
});

test('the confirmation screen’s check asks Stripe (never the browser): paid with how; a wrong secret is unknown', async () => {
  const { data } = await placeCard();
  const id = data.order!.id;
  const ask = async (clientSecret: unknown, action?: string) => {
    const res = await paymentRoute.POST(jsonRequest({ orderId: id, clientSecret, ...(action ? { action } : {}) }, { origin: ORIGIN }) as never);
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await ask('pi_x_secret_y')).status, 404);
  assert.equal((await ask(undefined)).status, 404);
  assert.equal((await ask(data.payment!.clientSecret, 'refund')).status, 400);
  assert.equal((await ask(data.payment!.clientSecret)).body.card.state, 'pending');
  mock.succeed(intentOf(id).id);
  const paid = await ask(data.payment!.clientSecret);
  assert.deepEqual(paid.body.card, { state: 'paid', label: 'Apple Pay · Visa •••• 4242' });
  assert.equal(paid.body.status, 'pending_confirmation');
  assert.ok(auditActions().includes('payment.paid'));
  // Paid now: leaving checkout can't cancel it.
  assert.equal((await ask(data.payment!.clientSecret, 'abandon')).body.card.state, 'paid');
});

test('left checkout, or not paid in time (10 minutes): stopped at Stripe, cancelled, stock released exactly once', async () => {
  const p = product();
  const size = p.profiles[0].id;
  const start = stockOf(p.id, size);
  const left = await placeCard();
  const late = await placeCard();
  assert.equal(stockOf(p.id, size), start - 2);

  const r = await payments.abandonCardPayment(left.data.order!.id, left.data.payment!.clientSecret);
  assert.equal(r.status, 'cancelled');
  assert.equal(intentOf(left.data.order!.id).status, 'canceled', 'stopped at Stripe first');
  assert.equal(stockOf(p.id, size), start - 1);

  // Backdate the other one past the time limit; the sweep cancels it once.
  getDb().prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 60_000).toISOString(), late.data.order!.id);
  assert.equal(await payments.sweepCardOrders(), 1);
  assert.equal(await payments.sweepCardOrders(), 0, 'nothing left to sweep');
  assert.equal(stockOf(p.id, size), start, 'both pieces back on sale, once each');
  assert.equal(orders.getOrder(late.data.order!.id)!.card!.state, 'canceled');
  assert.equal(orders.getOrder(late.data.order!.id)!.status, 'cancelled');
  // Stripe's canceled event afterwards (and again) changes nothing more.
  const ev = mock.event('payment_intent.canceled', intentOf(late.data.order!.id));
  assert.equal((await webhook(ev.body, ev.signature)).status, 200);
  assert.equal((await webhook(ev.body, ev.signature)).status, 200);
  assert.equal(stockOf(p.id, size), start);
  assert.equal(auditActions().filter((a) => a === 'payment.card_cancelled').length >= 2, true);

  // An order paid just before the sweep: Stripe refuses the cancel, so it is recorded as paid instead.
  const raced = await placeCard();
  mock.succeed(intentOf(raced.data.order!.id).id);
  getDb().prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 60_000).toISOString(), raced.data.order!.id);
  await payments.sweepCardOrders();
  assert.equal(orders.getOrder(raced.data.order!.id)!.card!.state, 'paid');
  assert.equal(orders.getOrder(raced.data.order!.id)!.status, 'pending_confirmation');

  // A canceled webhook for an open order releases it (once), like the sweep.
  const third = await placeCard();
  const before = stockOf(p.id, size);
  const cancelled = mock.event('payment_intent.canceled', { ...intentOf(third.data.order!.id), status: 'canceled' });
  await webhook(cancelled.body, cancelled.signature);
  assert.equal(orders.getOrder(third.data.order!.id)!.status, 'cancelled');
  assert.equal(stockOf(p.id, size), before + 1);
});

test('a declined try is noted and the customer may pay again; the owner can’t mark card orders paid or book them unpaid', async () => {
  const { data } = await placeCard();
  const id = data.order!.id;
  const pi = intentOf(id);
  const failed = mock.event('payment_intent.payment_failed', { ...pi, last_payment_error: { decline_code: 'card_declined', code: 'card_declined' } });
  await webhook(failed.body, failed.signature);
  assert.equal(orders.getOrder(id)!.card!.state, 'failed');
  assert.equal(orders.getOrder(id)!.status, 'pending_payment', 'still open for another try');
  assert.throws(() => orders.updateOrderByAdmin(id, { paymentStatus: 'paid' }, 'owner@shop.test'), /recorded by Stripe/);
  assert.throws(() => orders.updateOrderByAdmin(id, { status: 'confirmed' }, 'owner@shop.test'), /waiting for the customer's card payment/);
  await assert.rejects(dispatchOrder({ orderId: id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test' }), /not paid by card/);
  const paid = mock.succeed(pi.id);
  const ok = mock.event('payment_intent.succeeded', paid);
  await webhook(ok.body, ok.signature);
  assert.equal(orders.getOrder(id)!.card!.state, 'paid', 'a later success after a decline counts');
  // Paid: a plain cancel is refused (the money must go back too).
  assert.throws(() => orders.updateOrderByAdmin(id, { status: 'cancelled' }, 'owner@shop.test'), /Cancel & refund/);
});

test('the owner cancels an unpaid card order: stopped at Stripe first, then cancelled once', async () => {
  const { data } = await placeCard();
  const order = await payments.cancelUnpaidCardOrder(data.order!.id, 'owner@shop.test');
  assert.equal(order.status, 'cancelled');
  assert.equal(order.card!.state, 'canceled');
  assert.equal(intentOf(order.id).status, 'canceled');
});

test('Cancel & refund: once (refund:<id>), recorded from Stripe’s answer or its charge.refunded webhook, stock back', async () => {
  const p = product();
  const size = p.profiles[0].id;
  const { data } = await placeCard();
  const id = data.order!.id;
  const paid = mock.succeed(intentOf(id).id);
  const ev = mock.event('payment_intent.succeeded', paid);
  await webhook(ev.body, ev.signature);
  const before = stockOf(p.id, size);

  mock.refundStatus = 'pending';
  const first = await payments.refundCardOrder(id, 'owner@shop.test');
  assert.equal(first.outcome, 'refund_pending');
  assert.equal(first.order.status, 'cancelled');
  assert.equal(stockOf(p.id, size), before + 1, 'its piece back on sale');
  const refundCalls = () => mock.requests.filter((r) => r.path === '/v1/refunds' && r.body.get('payment_intent') === paid.id);
  assert.equal(refundCalls()[0].idempotencyKey, `refund:${id}`);
  // Pressed again while pending: the same refund (same key), nothing new.
  assert.equal((await payments.refundCardOrder(id, 'owner@shop.test')).outcome, 'already');
  assert.equal(new Set(refundCalls().map((r) => r.idempotencyKey)).size, 1);
  assert.equal(stockOf(p.id, size), before + 1, 'released once');

  // Stripe's charge.refunded webhook completes it (and again changes nothing).
  const charge = { id: 'ch_x', object: 'charge', amount: paid.amount, amount_refunded: paid.amount, payment_intent: paid.id, refunds: { data: [{ id: 're_x' }] } };
  const refunded = mock.event('charge.refunded', charge);
  await webhook(refunded.body, refunded.signature);
  const o = orders.getOrder(id)!;
  assert.equal(o.card!.state, 'refunded');
  assert.ok(o.card!.refundedAt);
  await webhook(refunded.body, refunded.signature);
  assert.equal((await payments.refundCardOrder(id, 'owner@shop.test')).outcome, 'already');
  assert.ok(auditActions().includes('payment.refund_requested'));
  assert.ok(auditActions().includes('payment.refunded'));

  // A partial refund made in Stripe's dashboard is only noted.
  mock.refundStatus = 'succeeded';
  const other = await placeCard();
  const paid2 = mock.succeed(intentOf(other.data.order!.id).id);
  const ev2 = mock.event('payment_intent.succeeded', paid2);
  await webhook(ev2.body, ev2.signature);
  const partial = mock.event('charge.refunded', { ...charge, amount_refunded: 100, payment_intent: paid2.id });
  await webhook(partial.body, partial.signature);
  assert.equal(orders.getOrder(other.data.order!.id)!.card!.state, 'paid');
  const done = await payments.refundCardOrder(other.data.order!.id, 'owner@shop.test');
  assert.equal(done.outcome, 'refunded');
});

// ── Review fixes (BUH-02.09 review) ──────────────────────────────────────────

/** A paid card order (through the signed webhook), and its intent. */
async function paidCard(over: Record<string, unknown> = {}) {
  const { data } = await placeCard(over);
  const id = data.order!.id;
  const pi = mock.succeed(intentOf(id).id);
  const ev = mock.event('payment_intent.succeeded', pi);
  await webhook(ev.body, ev.signature);
  assert.equal(orders.getOrder(id)!.card!.state, 'paid');
  return { id, pi, data };
}
/** Audit entries of this action (as raw lines). */
const auditLinesWith = (action: string) =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .filter((l) => l.includes(`"action":"${action}"`));

test('an unpaid card order the saved keys can’t reach (another mode, no key, Stripe has no such payment) is cancelled once, not stuck', async () => {
  const p = product();
  const size = p.profiles[0].id;
  // Its intent is made in test mode (the stand-in says livemode: false), and that is kept.
  const gone = await placeCard();
  assert.equal(getDb().prepare('SELECT card_livemode FROM orders WHERE id = ?').pluck().get(gone.data.order!.id), 0);
  assert.equal(orders.getOrder(gone.data.order!.id)!.card!.mode, 'test');

  // 1. Stripe says no such payment (another account's keys): the sweep cancels it, stock back once.
  const start = stockOf(p.id, size);
  mock.intents.delete(intentOf(gone.data.order!.id)?.id ?? '');
  getDb().prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 11 * 60_000).toISOString(), gone.data.order!.id);
  assert.equal(await payments.sweepCardOrders(), 1);
  assert.equal(await payments.sweepCardOrders(), 0, 'once');
  const o1 = orders.getOrder(gone.data.order!.id)!;
  assert.equal(o1.status, 'cancelled');
  assert.equal(o1.card!.state, 'canceled');
  assert.equal(stockOf(p.id, size), start + 1, 'its piece back on sale, once');
  assert.equal(o1.attention, undefined, 'a test-mode payment needs no owner check');
  assert.match(auditLinesWith('payment.card_cancelled').at(-1)!, /can't be charged with this Stripe account: Stripe has no such payment/, 'audited with why');

  // 2. Made in live mode, the keys now test: the owner's Cancel works without asking Stripe, and
  //    the order is flagged (check the live dashboard in case it was paid there).
  const live = await placeCard();
  getDb().prepare('UPDATE orders SET card_livemode = 1 WHERE id = ?').run(live.data.order!.id);
  const cancels = () => mock.requests.filter((r) => r.path.endsWith('/cancel')).length;
  const before = cancels();
  const cancelled = await payments.cancelUnpaidCardOrder(live.data.order!.id, 'owner@shop.test');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancels(), before, 'no call to the wrong account');
  assert.equal(cancelled.attention?.kind, 'card_unreachable');
  assert.match(cancelled.attention!.text, /Stripe live mode/);
  assert.equal(stockOf(p.id, size), start + 1);

  // 3. No secret key saved: leaving checkout still cancels it (stock back), and says nothing of cash.
  const nokey = await placeCard();
  await settings.updateSettings('payments', { cardEnabled: false, stripeSecretKey: null });
  try {
    const r = await payments.abandonCardPayment(nokey.data.order!.id, nokey.data.payment!.clientSecret);
    assert.equal(r.status, 'cancelled');
    assert.equal(stockOf(p.id, size), start + 1);
  } finally {
    await keysOn();
  }
});

test('a paid card order the saved keys can’t reach: Cancel & refund says why (to the owner), and “Cancel without Stripe refund” is audited, once', async () => {
  const p = product();
  const size = p.profiles[0].id;
  const { id } = await paidCard();
  const before = stockOf(p.id, size);
  // Reachable: the owner must refund through Stripe.
  await assert.rejects(payments.cancelPaidCardWithoutStripe(id, 'owner@shop.test'), (e: { details?: { code?: string } }) => e.details?.code === 'card_reachable');

  getDb().prepare('UPDATE orders SET card_livemode = 1 WHERE id = ?').run(id);
  const refunds = () => mock.requests.filter((r) => r.path === '/v1/refunds').length;
  const r0 = refunds();
  await assert.rejects(payments.refundCardOrder(id, 'owner@shop.test'), (e: { status: number; message: string; details?: { code?: string } }) => {
    assert.equal(e.status, 409);
    assert.equal(e.details?.code, 'card_unreachable');
    assert.match(e.message, /Cancel without Stripe refund/);
    assert.doesNotMatch(e.message, /Cash on Delivery/, 'owner copy, not customer copy');
    return true;
  });
  assert.equal(refunds(), r0, 'nothing sent to the wrong account');
  assert.throws(() => orders.updateOrderByAdmin(id, { status: 'cancelled' }, 'owner@shop.test'), /Cancel & refund/, 'a plain cancel still refuses');

  const done = await payments.cancelPaidCardWithoutStripe(id, 'owner@shop.test');
  assert.equal(done.status, 'cancelled');
  assert.equal(done.card!.state, 'paid', 'not marked refunded: the owner refunds it in Stripe');
  assert.ok(done.card!.refundOutsideAt);
  assert.equal(done.attention?.kind, 'refund_outside_stripe');
  assert.match(done.attention!.text, /Stripe dashboard/);
  assert.equal(stockOf(p.id, size), before + 1);
  const again = await payments.cancelPaidCardWithoutStripe(id, 'owner@shop.test');
  assert.equal(again.status, 'cancelled');
  assert.equal(stockOf(p.id, size), before + 1, 'released once');
  assert.equal(auditLinesWith('payment.cancelled_without_refund').length, 1);
  assert.equal(JSON.parse(auditLinesWith('payment.cancelled_without_refund')[0]).details.orderId, id, 'the exact order number');
  // Mark as handled clears the note (and the problem in Settings → System).
  const { currentProblems } = await import('@/lib/server/monitor');
  assert.ok(currentProblems().some((x) => x.id === 'orders'));
  for (const o of orders.listOrders()) if (o.attention) orders.updateOrderByAdmin(o.id, { clearAttention: true }, 'owner@shop.test');
  assert.equal(orders.getOrder(id)!.attention, undefined);
  assert.ok(!currentProblems().some((x) => x.id === 'orders'));
});

test('saving keys of another mode while card orders are open warns (never blocks); same mode says nothing', async () => {
  const open = await placeCard();
  assert.equal(payments.paymentsModeWarning(TEST_KEYS.secret, TEST_KEYS.secret), null);
  const w = payments.paymentsModeWarning(TEST_KEYS.secret, 'sk_live_51BuhLiveKey00000000000000');
  assert.ok(w && /still open from test mode/.test(w) && /Cancel without Stripe refund/.test(w), w ?? '');
  assert.match(payments.paymentsModeWarning(TEST_KEYS.secret, '') ?? '', /Without a secret key/);
  await payments.abandonCardPayment(open.data.order!.id, open.data.payment!.clientSecret);
});

test('unpaid card orders hold stock for 10 minutes; unverified ones: 2 of each item, 5 lines; a per-connection cap; a polite shop-wide cap', async () => {
  assert.equal(orders.CARD_PAYMENT_TTL_MS, 10 * 60_000);
  const recent = await placeCard();
  getDb().prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 9 * 60_000).toISOString(), recent.data.order!.id);
  await payments.sweepCardOrders();
  assert.equal(orders.getOrder(recent.data.order!.id)!.status, 'pending_payment', '9 minutes: still held');
  getDb().prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 11 * 60_000).toISOString(), recent.data.order!.id);
  assert.equal(await payments.sweepCardOrders(), 1, '11 minutes: stopped and cancelled');

  const p = listProducts()[0];
  const item = (profile = 0, quantity = 1) => ({ productId: p.id, profileId: p.profiles[profile].id, quantity });
  const three = await placeCard({ items: [item(0, 3)] });
  assert.equal(three.res.status, 400);
  assert.equal(three.data.code, 'card_bag_limit');
  assert.match(three.data.message!, /at most 2 of each item/);
  const split = await placeCard({ items: [item(0, 2), item(0, 1)] });
  assert.equal(split.res.status, 400, 'split over lines counts together');
  const many = await placeCard({ items: [item(0), item(1), item(2), item(3), item(0), item(1)] });
  assert.equal(many.res.status, 400);
  assert.match(many.data.message!, /at most 5 different items/);
  // A phone proved with a code: the usual limits.
  const { issuePhoneToken } = await import('@/lib/server/phoneToken');
  const verified = await placeCard({ items: [item(0, 3)], verificationToken: issuePhoneToken('+971551112233') });
  assert.equal(verified.res.status, 201, verified.data.message);
  assert.equal((verified.data.order as unknown as { customer: { phoneVerified: boolean } }).customer.phoneVerified, true);
  await payments.abandonCardPayment(verified.data.order!.id, verified.data.payment!.clientSecret);

  // Per connection (when the address is known): 3 unpaid card orders, whatever the phones.
  process.env.TRUST_PROXY = '1';
  try {
    const fromIp = (ip: string, k: number) =>
      ordersRoute.POST(jsonRequest(cardBody({ customer: { ...cardBody().customer, phone: `+97156${ip.slice(-1)}00000${k}` } }), { origin: ORIGIN, 'x-real-ip': ip }) as never);
    const placed: Array<{ order: { id: string }; payment: { clientSecret: string } }> = [];
    for (let k = 0; k < orders.MAX_UNPAID_CARD_PER_IP; k++) {
      const res = await fromIp('203.0.113.7', k);
      assert.equal(res.status, 201);
      placed.push(await res.json());
    }
    const fourth = await fromIp('203.0.113.7', 9);
    assert.equal(fourth.status, 429);
    assert.equal((await fourth.json()).code, 'card_unpaid_limit');
    assert.equal((await fromIp('203.0.113.8', 1)).status, 201, 'another connection is not affected');
    const stored = getDb().prepare('SELECT card_ip FROM orders WHERE id = ?').pluck().get(placed[0].order.id) as string;
    assert.match(stored, /^[0-9a-f]{64}$/, 'kept as a hash, not the address');
    for (const o of placed) await payments.abandonCardPayment(o.order.id, o.payment.clientSecret);
  } finally {
    delete process.env.TRUST_PROXY;
  }

  // The shop-wide cap: a polite word to the customer.
  const fake = Array.from({ length: orders.MAX_UNPAID_CARD_TOTAL }, (_, k) => `BUH-FAKE-CAP${k}`);
  const ins = getDb().prepare("INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, data, card_state) VALUES (?, ?, ?, '+971500000000', 'pending_payment', 'online_card', 'pending', 100, '{}', 'pending')");
  const now = new Date().toISOString();
  for (const f of fake) ins.run(f, now, now);
  try {
    const busy = await placeCard();
    assert.equal(busy.res.status, 429);
    assert.equal(busy.data.code, 'card_busy');
    assert.match(busy.data.message!, /very busy right now, sorry/);
  } finally {
    getDb().prepare(`DELETE FROM orders WHERE id IN (${fake.map(() => '?').join(',')})`).run(...fake);
  }
});

test('with an SMS gateway on, a card order proves its phone with a code like any order (checkout is told)', async () => {
  process.env.SMS_WEBHOOK_URL = 'https://sms.example.com/send';
  try {
    // Settings → Phone check "WhatsApp (free)" (the default): as if there were no gateway.
    assert.equal(settings.phoneCodesOn(), false, 'WhatsApp mode sends no codes');
    const free = await placeCard();
    assert.equal(free.res.status, 201, 'WhatsApp mode: a card order needs no code');
    await payments.abandonCardPayment(free.data.order!.id, free.data.payment!.clientSecret);
    await settings.updateSettings('phoneCheck', { mode: 'sms_code' });
    assert.equal(settings.phoneCodesOn(), true);
    const pub = await (await publicRoute.GET()).json();
    assert.deepEqual(pub.payments, { card: true, publishableKey: TEST_KEYS.publishable, phoneCheck: true });
    const none = await placeCard();
    assert.equal(none.res.status, 401, 'no code: refused');
    const { issuePhoneToken } = await import('@/lib/server/phoneToken');
    const ok = await placeCard({ verificationToken: issuePhoneToken('+971552223344') });
    assert.equal(ok.res.status, 201);
    assert.equal((ok.data.order as unknown as { customer: { phone: string; phoneVerified: boolean } }).customer.phone, '+971552223344', 'the proved number');
    await payments.abandonCardPayment(ok.data.order!.id, ok.data.payment!.clientSecret);
  } finally {
    delete process.env.SMS_WEBHOOK_URL;
  }
  assert.equal(settings.phoneCodesOn(), false);
  assert.equal((await placeCard()).res.status, 201, 'no gateway: as before, no code needed');
  await settings.updateSettings('phoneCheck', { mode: 'whatsapp' });
});

test('a partial refund in Stripe’s dashboard, then Cancel & refund: only what is left, once; a full dashboard refund cancels the order once', async () => {
  const p = product();
  const size = p.profiles[0].id;
  const { id, pi } = await paidCard();
  // Refunded AED 10 in the dashboard; its webhook says so.
  const { charge } = mock.dashboardRefund(pi.id, 1000);
  const partial = mock.event('charge.refunded', charge);
  await webhook(partial.body, partial.signature);
  let o = orders.getOrder(id)!;
  assert.equal(o.card!.state, 'paid');
  assert.equal(o.card!.refundedAmount, 10);
  assert.equal(orders.refundableFils(o), pi.amount - 1000);
  const before = stockOf(p.id, size);
  // The owner was shown the full amount (an old screen): refused, with what is left.
  await assert.rejects(payments.refundCardOrder(id, 'owner@shop.test', pi.amount), (e: { details?: { code?: string } }) => e.details?.code === 'refund_amount_changed');
  const r = await payments.refundCardOrder(id, 'owner@shop.test', pi.amount - 1000);
  assert.equal(r.outcome, 'refunded');
  assert.equal(r.order.status, 'cancelled');
  assert.equal(stockOf(p.id, size), before + 1);
  const calls = mock.requests.filter((x) => x.path === '/v1/refunds' && x.body.get('payment_intent') === pi.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.get('amount'), String(pi.amount - 1000), 'the amount is said explicitly');
  assert.equal(calls[0].idempotencyKey, `refund:${id}:${pi.amount - 1000}`);
  o = orders.getOrder(id)!;
  assert.equal(o.card!.state, 'refunded');

  // Partial refund made in the dashboard but its webhook not here yet: Stripe's word is used.
  const second = await paidCard();
  mock.dashboardRefund(second.pi.id, 500);
  await assert.rejects(payments.refundCardOrder(second.id, 'owner@shop.test', second.pi.amount), /is left to refund/);
  assert.equal(orders.getOrder(second.id)!.card!.refundedAmount, 5, 'noted from Stripe');
  assert.equal((await payments.refundCardOrder(second.id, 'owner@shop.test', second.pi.amount - 500)).outcome, 'refunded');

  // A full refund in the dashboard: the order is cancelled and its piece back, exactly once.
  const third = await paidCard();
  const before3 = stockOf(p.id, size);
  const full = mock.dashboardRefund(third.pi.id, third.pi.amount);
  const ev = mock.event('charge.refunded', full.charge);
  await webhook(ev.body, ev.signature);
  await webhook(ev.body, ev.signature);
  const again = mock.event('charge.refunded', full.charge);
  await webhook(again.body, again.signature);
  const o3 = orders.getOrder(third.id)!;
  assert.equal(o3.card!.state, 'refunded');
  assert.equal(o3.status, 'cancelled');
  assert.equal(stockOf(p.id, size), before3 + 1, 'released once');
});

test('a refund that fails later goes back to paid, audited, flagged for the owner; trying again is a new refund', async () => {
  const { id, pi } = await paidCard();
  mock.refundStatus = 'pending';
  try {
    const first = await payments.refundCardOrder(id, 'owner@shop.test');
    assert.equal(first.outcome, 'refund_pending');
    const refundId = first.order.card!.refundRef!;
    const failed = mock.failRefund(refundId);
    const ev = mock.event('charge.refund.updated', failed);
    assert.equal(payments.handleStripeWebhook(Buffer.from(ev.body), ev.signature).outcome, 'refund_failed');
    assert.equal(payments.handleStripeWebhook(Buffer.from(ev.body), ev.signature).outcome, 'duplicate');
    // refund.failed for the same refund (if ticked too) changes nothing more.
    const ev2 = mock.event('refund.failed', failed);
    assert.equal(payments.handleStripeWebhook(Buffer.from(ev2.body), ev2.signature).outcome, 'ignored');
    const o = orders.getOrder(id)!;
    assert.equal(o.card!.state, 'paid', 'the money is still with the shop');
    assert.equal(o.card!.refundRef, undefined);
    assert.equal(o.attention?.kind, 'refund_failed');
    assert.match(o.attention!.text, /expired or canceled card/);
    assert.equal(auditLinesWith('payment.refund_failed').length, 1);
    assert.equal(JSON.parse(auditLinesWith('payment.refund_failed')[0]).details.orderId, id, 'the exact order number');
    for (let i = 0; i < 50 && !printed.some((l) => l.includes('"owner_alert"')); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(printed.some((l) => l.includes('"owner_alert"')), 'the owner is alerted');
    // An update that is not a failure is ignored.
    const ok = mock.event('charge.refund.updated', { ...failed, status: 'succeeded' });
    assert.equal(payments.handleStripeWebhook(Buffer.from(ok.body), ok.signature).outcome, 'ignored');
  } finally {
    mock.refundStatus = 'succeeded';
  }
  const retry = await payments.refundCardOrder(id, 'owner@shop.test');
  assert.equal(retry.outcome, 'refunded');
  const keys = mock.requests.filter((x) => x.path === '/v1/refunds' && x.body.get('payment_intent') === pi.id).map((x) => x.idempotencyKey);
  assert.deepEqual(keys, [`refund:${id}`, `refund:${id}:try2`]);
  orders.updateOrderByAdmin(id, { clearAttention: true }, 'owner@shop.test');
});

test('a courier booking that comes back after the order was cancelled or refunded is kept, flagged, audited and alerted, never quietly saved', async () => {
  const { id } = await paidCard();
  await payments.refundCardOrder(id, 'owner@shop.test');
  assert.equal(orders.getOrder(id)!.status, 'cancelled');
  const booked = orders.recordBooking(id, 'owner@shop.test', { provider: 'jeebly', awbNumber: 'JB123456', bookingState: 'booked', status: 'Booked with the carrier' });
  assert.equal(booked.status, 'cancelled', 'not moved to confirmed');
  assert.equal(booked.courier.awbNumber, 'JB123456', 'the AWB is kept (needed to cancel the pickup)');
  assert.equal(booked.attention?.kind, 'booked_after_cancel');
  assert.match(booked.attention!.text, /AWB JB123456.*Cancel that pickup/);
  assert.equal(auditLinesWith('order.booking_exception').length, 1);
  // A booking for an order still fine is saved as before, with no note.
  const { id: fine } = await paidCard();
  const ok = orders.recordBooking(fine, 'owner@shop.test', { provider: 'jeebly', awbNumber: 'JB999', bookingState: 'booked' });
  assert.equal(ok.status, 'confirmed');
  assert.equal(ok.attention, undefined);
  orders.updateOrderByAdmin(id, { clearAttention: true }, 'owner@shop.test');
});

test('a Stripe error code reaches the log (not redacted as if it were an SMS code)', async () => {
  const { logEvent } = await import('@/lib/server/log');
  const mark = printed.length;
  logEvent('warn', 'stripe_test_error', { orderId: 'BUH-X', ...payments.stripeError({ type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404, message: 'No such payment_intent' }) });
  const line = printed.slice(mark).join('\n');
  assert.match(line, /"stripeCode":"resource_missing"/);
  assert.doesNotMatch(line, /\[redacted\]/);
  assert.equal((redact({ code: '123456', otpCode: '1' }) as Record<string, string>).code, '[redacted]', 'SMS codes are still redacted');
});

test('keys and client secrets never reach the logs', () => {
  const all = printed.join('\n');
  assert.ok(!all.includes(TEST_KEYS.secret), 'secret key');
  assert.ok(!all.includes(TEST_KEYS.webhook), 'webhook secret');
  assert.ok(!/pi_\w+_secret_\w+/.test(all), 'client secrets');
  // And the redaction itself, should a library ever print one.
  const line = JSON.stringify(redact({ error: `Invalid API Key provided: ${TEST_KEYS.secret}, whsec ${TEST_KEYS.webhook}, pi_123_secret_abc` }));
  assert.ok(!line.includes(TEST_KEYS.secret) && !line.includes(TEST_KEYS.webhook) && !line.includes('pi_123_secret_abc'), line);
});

test('the daily summary counts card takings', async () => {
  const { dailySummary } = await import('@/lib/server/monitor');
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const { text } = dailySummary(tomorrow);
  assert.match(text, /Paid by card \(Stripe\): \d+, AED [\d.]+; refunded to cards: \d+, AED [\d.]+\./);
});

test('migration 9 only adds (columns, indexes, a table); backups carry card payments, never the keys; restore keeps them', async () => {
  const src = fs.readFileSync('src/lib/server/db.ts', 'utf8');
  const m9 = src.slice(src.indexOf('// 9: card payments'), src.indexOf('];', src.indexOf('// 9: card payments')));
  const statements = m9.slice(m9.indexOf('db.exec(`') + 9, m9.indexOf('`);')).split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  assert.ok(statements.length >= 10);
  for (const s of statements) assert.match(s, /^(ALTER TABLE orders ADD COLUMN|CREATE (UNIQUE )?INDEX|CREATE TABLE stripe_events)/, s);

  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const csv = result.csv.find((c) => c.name === 'orders.csv')!.data.toString('utf8');
  assert.match(csv.split(/\r?\n/)[0], /card_payment,payment_ref,card,paid_at,paid_aed,refund_ref,refunded_at,refunded_aed,stripe_mode,refund_outside_stripe_at,needs_attention/);
  assert.match(csv, /Paid|paid/);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-card-'));
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const restored = new Database(path.join(target, 'shop.db'), { readonly: true });
  const paidRow = restored.prepare("SELECT card_state, payment_ref, paid_fils, paid_at FROM orders WHERE card_state = 'paid' LIMIT 1").get() as Record<string, unknown>;
  assert.ok(paidRow && String(paidRow.payment_ref).startsWith('pi_') && Number(paidRow.paid_fils) > 0 && paidRow.paid_at);
  assert.ok((restored.prepare("SELECT COUNT(*) AS n FROM orders WHERE card_state = 'refunded' AND refund_ref IS NOT NULL").get() as { n: number }).n >= 1);
  assert.ok((restored.prepare('SELECT COUNT(*) AS n FROM stripe_events').get() as { n: number }).n >= 1, 'the applied events come back (so a resent one is still ignored)');
  // The review fixes' columns come back too: the mode, the dashboard refunds, the refunds outside Stripe.
  assert.ok((restored.prepare('SELECT COUNT(*) AS n FROM orders WHERE card_livemode = 0').get() as { n: number }).n >= 1);
  assert.ok((restored.prepare('SELECT COUNT(*) AS n FROM orders WHERE refunded_fils > 0').get() as { n: number }).n >= 1);
  assert.ok((restored.prepare('SELECT COUNT(*) AS n FROM orders WHERE refund_outside_at IS NOT NULL').get() as { n: number }).n >= 1);
  const pay = JSON.parse((restored.prepare("SELECT data FROM settings WHERE key = 'payments'").get() as { data: string }).data);
  assert.equal(pay.stripeSecretKey, '');
  assert.equal(pay.stripeWebhookSecret, '');
  assert.equal(pay.stripePublishableKey, TEST_KEYS.publishable);
  restored.close();
  const raw = fs.readFileSync(path.join(target, 'shop.db'));
  assert.ok(!raw.includes(Buffer.from(TEST_KEYS.secret)) && !raw.includes(Buffer.from(TEST_KEYS.webhook)), 'no key bytes left in the file');

  // An older shop's database (version 8, with an order) upgrades: the order is intact and 'none'.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-v8-'));
  const run = (code: string) => spawnSync(process.execPath, ['--import', 'tsx', '-e', `process.env.DATA_DIR=${JSON.stringify(old)}; ${code}`], { encoding: 'utf8' });
  assert.equal(run(`const m = await import('@/lib/server/db'); (m.getDb ?? m.default.getDb)();`).status, 0);
  const db = new Database(path.join(old, 'shop.db'));
  // Migration 10's columns go too (it runs again after 9).
  // Migrations 11 and 12 go too (they run again after 10): newest first.
  db.exec("DELETE FROM settings_history WHERE key = 'look'; DELETE FROM settings WHERE key = 'look'"); // migration 13
  db.exec('DROP TABLE card_refunds; DROP TABLE expense_bills; DROP TABLE expense_versions; DROP TABLE expenses; DROP TABLE expense_categories;'); // migration 12
  db.exec('DROP INDEX orders_unconfirmed_due; DROP INDEX orders_unopened_due; ALTER TABLE orders DROP COLUMN phone_check_method; ALTER TABLE orders DROP COLUMN wa_cancel_at; ALTER TABLE orders DROP COLUMN wa_unopened_cancel_at;'); // migration 11
  db.exec(`DROP INDEX orders_by_pay_token; DROP INDEX orders_transfer_to_check; ${['pay_nonce', 'pay_token_hash', 'pay_expires_at', 'bank_state', 'transfer_uploads', 'transfer_uploaded_at', 'bank_emailed_at', 'bank_checked_at', 'bank_checked_by'].map((c) => `ALTER TABLE orders DROP COLUMN ${c};`).join(' ')}`);
  db.exec(`DROP INDEX orders_by_payment_ref; DROP INDEX orders_card_open; DROP TABLE stripe_events; ${['card_state', 'payment_ref', 'card_secret_hash', 'paid_fils', 'paid_at', 'card_label', 'refund_ref', 'refunded_at', 'card_livemode', 'card_ip', 'refunded_fils', 'refund_outside_at', 'needs_attention'].map((c) => `ALTER TABLE orders DROP COLUMN ${c};`).join(' ')}`);
  db.exec("INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, data) VALUES ('BUH-OLD-9', '2026-01-01', '2026-01-01', '+971501234567', 'pending_confirmation', 'cod', 'cod_pending', 100, '{\"id\":\"BUH-OLD-9\"}')");
  db.pragma('user_version = 8');
  db.close();
  const up = run(`const m = await import('@/lib/server/db'); const db = (m.getDb ?? m.default.getDb)(); console.log(JSON.stringify({ v: db.pragma('user_version', { simple: true }), row: db.prepare("SELECT status, data, card_state, payment_ref FROM orders WHERE id = 'BUH-OLD-9'").get() }));`);
  assert.equal(up.status, 0, up.stderr);
  assert.deepEqual(JSON.parse(up.stdout.trim().split('\n').pop()!), { v: 13, row: { status: 'pending_confirmation', data: '{"id":"BUH-OLD-9"}', card_state: 'none', payment_ref: null } });
});

test('wallet addresses: emirates by any name, areas from the shop’s list, nothing guessed', () => {
  assert.equal(emirateFrom('Dubai'), 'Dubai');
  assert.equal(emirateFrom('Abu Dhabi Emirate'), 'Abu Dhabi');
  assert.equal(emirateFrom('Ras al-Khaimah'), 'Ras Al Khaimah');
  assert.equal(emirateFrom('دبي'), 'Dubai');
  assert.equal(emirateFrom('Umm Al Qaiwain'), 'Umm Al Quwain');
  assert.equal(emirateFrom('London'), null);
  const a = walletAddress({ name: 'Sara Ali', phone: '+971 50 123 4567', email: 's@x.ae', address: { line1: 'Marina Gate 1, Apt 1402', line2: 'Dubai Marina', city: 'Dubai', state: 'Dubai', country: 'AE' } });
  assert.equal(a.emirate, 'Dubai');
  assert.equal(a.area, 'Dubai Marina');
  assert.equal(a.flatVillaNo, 'Apt 1402');
  assert.equal(a.fullName, 'Sara Ali');
  const b = walletAddress({ address: { line1: 'Villa 24, Street 5', line2: '', city: 'Somewhere Unknown', state: 'Abu Dhabi', country: 'AE' } });
  assert.equal(b.emirate, 'Abu Dhabi');
  assert.equal(b.area, null, 'an area we don’t know is asked for, not guessed');
  assert.equal(b.flatVillaNo, 'Villa 24');
  const c = walletAddress({ address: { line1: 'Building 3', city: 'JVC', state: '', country: 'AE' } });
  assert.equal(c.area !== null && c.emirate === 'Dubai', true, 'an alias names the area and its emirate');
  const d = walletAddress({ address: { line1: 'Tower 2', city: 'Dubai Marina', state: 'Sharjah', country: 'AE' } });
  assert.equal(d.area, null, 'an area in another emirate than the wallet says is not taken');
});

test('the test-only Stripe address is honoured only on this machine', async () => {
  const saved = process.env.BUH_TEST_STRIPE_API;
  try {
    process.env.BUH_TEST_STRIPE_API = 'https://evil.example:443/';
    const client = payments.stripeClient('sk_test_51OtherKeyForThisCheck000000');
    const host = (client as unknown as { _api: { host: string } })._api.host;
    assert.equal(host, 'api.stripe.com', 'anything but a loopback address is ignored');
  } finally {
    process.env.BUH_TEST_STRIPE_API = saved;
  }
});

test('review M3: a full refund in Stripe’s dashboard cancels the order and its Jeebly booking (audited); flagged if Jeebly does not confirm', async () => {
  await keysOn();
  const { installJeeblyMock } = await import('./fixtures/jeebly-mock.mjs');
  const pickup = { pickupPhone: '+971501112222', pickupUnit: 'Shop 4', pickupBuilding: 'Barsha Tower', pickupArea: 'Al Barsha 1', pickupLandmark: 'Near the mall', pickupEmirate: 'Dubai' };
  await settings.updateSettings('courier', { jeebly: { ...pickup, isLive: true, liveBaseUrl: 'https://live.jeebly.com', apiKey: 'LIVE-KEY-1', clientKey: 'LIVE-CLIENT-1' } }, { liveOverride: true });
  try {
    for (const refuse of [false, true]) {
      const jeebly = installJeeblyMock(refuse ? { cancel: () => ({ status: 400, body: { success: 'false1', message: 'Shipment can not be Cancel' } }) } : undefined);
      try {
        const { id, pi } = await paidCard();
        const booked = await dispatchOrder({ orderId: id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test', weightKg: 1 });
        assert.equal(booked.status, 200, String(booked.body.message));
        const awb = String(booked.body.awbNumber);
        const full = mock.dashboardRefund(pi.id, pi.amount);
        const ev = mock.event('charge.refunded', full.charge);
        assert.equal((await webhook(ev.body, ev.signature)).status, 200);
        for (let i = 0; i < 100 && !jeebly.calls.some((c: { path: string }) => c.path === 'cancel_shipment'); i++) await new Promise((r) => setTimeout(r, 10));
        for (let i = 0; i < 100 && !auditLinesWith('courier.cancel').some((l) => l.includes(id)); i++) await new Promise((r) => setTimeout(r, 10));
        const o = orders.getOrder(id)!;
        assert.equal(o.status, 'cancelled');
        const sent = jeebly.calls.filter((c: { path: string; body: Record<string, unknown> }) => c.path === 'cancel_shipment');
        assert.equal(sent.length, 1, `${refuse}: the Jeebly booking is cancelled too`);
        assert.equal(sent[0].body.reference_number, awb);
        const entry = JSON.parse(auditLinesWith('courier.cancel').find((l) => l.includes(id))!);
        assert.deepEqual([entry.details.by, entry.details.cancelled], ['stripe', !refuse]);
        if (refuse) {
          assert.equal(o.attention?.kind, 'booked_after_cancel');
          assert.match(o.attention!.text, /Cancel it in the Jeebly portal/);
          orders.updateOrderByAdmin(id, { clearAttention: true }, 'owner@shop.test');
        } else {
          assert.equal(o.courier.status, 'Cancelled with the carrier');
          assert.equal(o.attention, undefined);
        }
        // Stripe sends it again: nothing more goes to Jeebly.
        await webhook(ev.body, ev.signature);
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(jeebly.calls.filter((c: { path: string }) => c.path === 'cancel_shipment').length, 1);
      } finally {
        jeebly.restore();
      }
    }
  } finally {
    await settings.updateSettings('courier', { jeebly: { isLive: false } });
  }
});
