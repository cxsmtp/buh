/**
 * BUH-02.09 against the real build: card payments through Stripe, with a local stand-in for
 * Stripe's API (the server is pointed at it with BUH_TEST_STRIPE_API) and, in Chromium, a stub of
 * Stripe.js served for js.stripe.com (no real Stripe anywhere). Settings → Payments (door, session,
 * keys write-only, connection check, Apple Pay domain); the webhook is public (the front gate
 * leaves it alone) and signed; the shop's first load has no Stripe code; at 375 and 1280 px the
 * Card option shows Stripe's field without sideways scroll and is reachable with the keyboard;
 * Apple Pay's address fills checkout (an unknown area is asked for before paying), and the
 * confirmation says "Paid by card" only once the server has Stripe's word. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, setPhoneCheck, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { startStripeMock, TEST_KEYS, type StripeMock } from './stripe-mock.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

let server: RunningServer;
let mock: StripeMock;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  mock = await startStripeMock();
  server = await startServer({ BUH_TEST_STRIPE_API: mock.url, CARD_SWEEP_DISABLED: '1', NEXT_PUBLIC_APP_URL: '' });
  // These tests drive the SMS-code checkout (Settings → Phone check "SMS code"; the default is WhatsApp).
  await setPhoneCheck(server, 'sms_code');
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Stripe-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
  await mock?.close();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const hook = (body: string, signature?: string) => rawFetch(`${server.base}/api/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'stripe-signature': signature } : {}) }, body });
async function products() {
  return (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; title: string; profiles: Array<{ id: string }> }>;
}
function auditLines(): string[] {
  return fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean));
}

test('Settings → Payments: off by default; keys saved write-only; check the connection; the webhook address; Apple Pay domain needs a real domain', { skip }, async () => {
  const pub0 = await (await rawFetch(`${server.base}/api/settings/public`)).json();
  assert.deepEqual(pub0.payments, { card: false });
  // Door, session and same site, like every admin route.
  assert.equal((await rawFetch(`${server.base}/api/admin/payments`, { headers: { cookie } })).status, 404, 'no door: unknown');
  assert.equal((await post('/api/admin/payments', { action: 'check' }, { cookie: server.door })).status, 401, 'no session');
  assert.equal((await api('POST', '/api/admin/payments', { action: 'check' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('POST', '/api/admin/payments', { action: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/admin/payments', { action: 'check', extra: 1 })).status, 400, 'allow-listed fields');
  assert.equal((await api('POST', '/api/admin/payments', { action: 'check', secretKey: 'pk_test_123' })).status, 400);

  const on = await api('PUT', '/api/admin/settings/payments', { settings: { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook } });
  assert.equal(on.status, 200, await on.clone().text());
  const all = await (await api('GET', '/api/admin/settings')).json();
  assert.equal(all.payments.value.stripeSecretKey, '');
  assert.equal(all.payments.value.stripeWebhookSecret, '');
  assert.deepEqual(all.payments.secretsSet, { stripeSecretKey: true, stripeWebhookSecret: true });
  assert.equal(all.payments.value.stripePublishableKey, TEST_KEYS.publishable);

  const info = await (await api('GET', '/api/admin/payments')).json();
  assert.equal(info.mode, 'test');
  assert.match(info.webhookUrl, /^https:\/\/127\.0\.0\.1:\d+\/api\/stripe\/webhook$/);
  assert.deepEqual(info.events, ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.refund.updated']);
  const check = await (await api('POST', '/api/admin/payments', { action: 'check' })).json();
  assert.equal(check.account.name, 'Beautiful UAE Home (test)');
  assert.equal(check.account.chargesEnabled, true);
  const wrong = await api('POST', '/api/admin/payments', { action: 'check', secretKey: 'sk_test_51NotTheRightKey000000000' });
  assert.equal(wrong.status, 502);
  assert.match((await wrong.json()).message, /did not accept this secret key/);
  // 127.0.0.1 is no domain for Apple Pay.
  assert.equal((await api('POST', '/api/admin/payments', { action: 'domain' })).status, 400);

  const pub = await (await rawFetch(`${server.base}/api/settings/public`)).json();
  assert.deepEqual(pub.payments, { card: true, publishableKey: TEST_KEYS.publishable });
  for (const text of [JSON.stringify(pub), JSON.stringify(all), JSON.stringify(info), await (await rawFetch(`${server.base}/`)).text()]) {
    assert.ok(!text.includes(TEST_KEYS.secret) && !text.includes(TEST_KEYS.webhook));
  }
  assert.ok(auditLines().some((l) => l.includes('"action":"payments.checked"')));
});

test('the webhook is public (the front gate leaves it alone), signed, and the same short answer for every refusal', { skip }, async () => {
  const unknown = await rawFetch(`${server.base}/api/no-such-${crypto.randomBytes(4).toString('hex')}`, { method: 'POST' });
  const bad = await hook('{}', 't=1,v1=00');
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type') || '', /json/, 'answered by the route, not the unknown-address page');
  assert.notEqual(await bad.clone().text(), await unknown.text());
  const unsigned = await hook('{}');
  assert.deepEqual(await unsigned.json(), await bad.json());
  const big = await hook('x'.repeat(300 * 1024), 't=1,v1=00');
  assert.equal(big.status, 400);
  assert.deepEqual(await big.json(), { received: false, message: 'Invalid request.' });
  const ignored = mock.event('customer.created', { id: 'cus_1' });
  assert.equal((await hook(ignored.body, ignored.signature)).status, 200);
});

test('a card checkout through the real routes: the server’s amount, paid by the signed webhook, shown in the hub; refund once', { skip }, async () => {
  const [p] = await products();
  const body = {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Hessa Card', phone: '0507001234', emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Tower', flatVillaNo: '12' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'online_card',
  };
  const res = await post('/api/orders', body);
  assert.equal(res.status, 201, await res.clone().text());
  const placed = await res.json();
  assert.equal(placed.order.status, 'pending_payment');
  const pi = [...mock.intents.values()].find((x) => x.metadata.orderId === placed.order.id)!;
  assert.equal(pi.amount, Math.round(placed.order.total * 100));
  assert.equal(pi.client_secret, placed.payment.clientSecret);
  assert.deepEqual(placed.order.card, { state: 'pending' }, 'the customer gets the client secret, not Stripe references');

  // Not paid until Stripe says so; the owner can't book it meanwhile.
  const unpaid = await (await api('GET', `/api/admin/orders/${placed.order.id}`)).json();
  assert.equal(unpaid.order.card.state, 'pending');
  const booking = await api('POST', '/api/courier/dispatch', { orderId: placed.order.id, provider: 'jeebly' });
  assert.equal(booking.status, 409);

  const paid = mock.succeed(pi.id, { wallet: null, brand: 'visa', last4: '4242' });
  const ev = mock.event('payment_intent.succeeded', paid);
  assert.equal((await hook(ev.body, ev.signature)).status, 200);
  assert.equal((await hook(ev.body, ev.signature)).status, 200, 'resent: fine, and nothing more happens');
  let o = (await (await api('GET', `/api/admin/orders/${placed.order.id}`)).json()).order;
  for (let i = 0; i < 50 && !o.card.label; i++) {
    await new Promise((r) => setTimeout(r, 100));
    o = (await (await api('GET', `/api/admin/orders/${placed.order.id}`)).json()).order;
  }
  assert.equal(o.card.state, 'paid');
  assert.equal(o.card.ref, pi.id);
  assert.equal(o.card.label, 'Visa •••• 4242');
  assert.equal(o.status, 'pending_confirmation');
  assert.equal(auditLines().filter((l) => l.includes('"action":"payment.paid"') && l.includes(placed.order.id)).length, 1);

  // A plain cancel is refused; Cancel & refund needs the amount the owner saw, and happens once.
  assert.equal((await api('PATCH', `/api/admin/orders/${placed.order.id}`, { status: 'cancelled' })).status, 409);
  assert.equal((await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: 1 })).status, 409);
  assert.equal((await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: o.total, why: 'x' })).status, 400);
  const refund = await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: o.total });
  assert.equal(refund.status, 200, await refund.clone().text());
  const r = await refund.json();
  assert.equal(r.outcome, 'refunded');
  assert.equal(r.order.status, 'cancelled');
  assert.equal(r.order.card.state, 'refunded');
  const again = await (await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: o.total })).json();
  assert.equal(again.outcome, 'already');
  assert.equal(mock.requests.filter((x) => x.path === '/v1/refunds' && x.body.get('payment_intent') === pi.id).length, 1, 'one refund request to Stripe');
  // The server's log never carries a key or a client secret.
  assert.ok(!server.log().includes(TEST_KEYS.secret) && !server.log().includes(TEST_KEYS.webhook) && !server.log().includes(pi.client_secret));
});

test('keys of another mode: the save warns about open card orders; a paid one is cancelled without a Stripe refund only with the explicit confirmation', { skip }, async () => {
  const [p] = await products();
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Reem Switch', phone: '0507002468', emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'online_card',
  });
  assert.equal(res.status, 201);
  const placed = await res.json();
  const pi = mock.succeed([...mock.intents.values()].find((x) => x.metadata.orderId === placed.order.id)!.id);
  const ev = mock.event('payment_intent.succeeded', pi);
  assert.equal((await hook(ev.body, ev.signature)).status, 200);
  const live = { publishable: 'pk_live_51BuhLivePublishable0000000000', secret: 'sk_live_51BuhLiveSecretKey000000000000' };
  try {
    const saved = await api('PUT', '/api/admin/settings/payments', { settings: { cardEnabled: true, stripePublishableKey: live.publishable, stripeSecretKey: live.secret, stripeWebhookSecret: TEST_KEYS.webhook } });
    assert.equal(saved.status, 200, 'saved, not blocked');
    assert.match((await saved.json()).warning, /still open from test mode/);
    const order = (await (await api('GET', `/api/admin/orders/${placed.order.id}`)).json()).order;
    const refund = await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: order.total });
    assert.equal(refund.status, 409);
    const r = await refund.json();
    assert.equal(r.code, 'card_unreachable');
    assert.doesNotMatch(r.message, /Cash on Delivery/);
    assert.equal((await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: order.total, withoutStripeRefund: true })).status, 400, 'the confirmation is required');
    assert.equal((await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: order.total, withoutStripeRefund: true, confirm: 'yes' })).status, 400);
    const done = await api('POST', `/api/admin/orders/${placed.order.id}/refund`, { amount: order.total, withoutStripeRefund: true, confirm: 'refund-in-stripe-dashboard' });
    assert.equal(done.status, 200, await done.clone().text());
    const d = await done.json();
    assert.equal(d.outcome, 'cancelled_without_refund');
    assert.equal(d.order.status, 'cancelled');
    assert.ok(d.order.card.refundOutsideAt);
    assert.equal(d.order.attention.kind, 'refund_outside_stripe');
    assert.ok(auditLines().some((l) => l.includes('"action":"payment.cancelled_without_refund"')));
    // The hub shows the red note (375 and 1280 px, no sideways scroll); "Mark as handled" with the keyboard.
    if (!skipBrowser) {
      for (const width of [375, 1280]) {
        const hub = await browser.newContext({ viewport: { width, height: 860 } });
        const eq = cookie.indexOf('=');
        await hub.addCookies([{ name: cookie.slice(0, eq), value: cookie.slice(eq + 1), url: server.base }]);
        const hp = await hub.newPage();
        const hubErrors: string[] = [];
        hp.on('pageerror', (e) => hubErrors.push(e.message));
        await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
        await openAdminSection(hp, /^Orders/);
        const note = hp.getByTestId('order-attention').filter({ hasText: 'Cancelled without a refund through the shop' });
        await note.waitFor();
        assert.match((await hp.getByTestId('card-badge').filter({ hasText: 'cancelled without a Stripe refund' }).first().textContent()) || '', /refund AED [\d.]+ in the Stripe dashboard/);
        assert.equal(await overflow(hp), false, `no sideways scroll at ${width}px`);
        await hp.screenshot({ path: path.join(server.dataDir, `attention-${width}.png`) });
        if (width === 1280) {
          await note.getByRole('button', { name: 'Mark as handled' }).focus();
          await hp.keyboard.press('Enter');
          await note.waitFor({ state: 'detached' });
        }
        assert.deepEqual(hubErrors, []);
        await hub.close();
      }
    }
    // Mark as handled (again: nothing more to clear).
    const handled = await api('PATCH', `/api/admin/orders/${placed.order.id}`, { clearAttention: true });
    assert.equal(handled.status, 200);
    assert.equal((await handled.json()).order.attention, undefined);
  } finally {
    const back = await api('PUT', '/api/admin/settings/payments', { settings: { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook } });
    assert.equal(back.status, 200);
  }
});

test('the shop’s first load carries no Stripe code (it comes only with checkout)', { skip }, async () => {
  const html = await (await rawFetch(`${server.base}/`)).text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 3, `${scripts.length} scripts`);
  for (const src of scripts) {
    const text = await (await rawFetch(`${server.base}${src}`)).text();
    assert.ok(!text.includes('js.stripe.com') && !text.includes('ExpressCheckoutElement'), `${src} has Stripe code`);
  }
  // The chunk that does is never preloaded by the page.
  const chunks = fs.readdirSync('.next/static/chunks').filter((f) => f.endsWith('.js') && fs.readFileSync(path.join('.next/static/chunks', f), 'utf8').includes('js.stripe.com'));
  assert.ok(chunks.length >= 1);
  for (const c of chunks) assert.ok(!html.includes(c), `${c} is not on the first load`);
});

// ── In Chromium ─────────────────────────────────────────────────────────────

/** A stand-in for Stripe.js: the Payment Element is a plain card field; Express Checkout an "Apple Pay (test)" button. */
const STRIPE_JS_STUB = `
(() => {
  const calls = (window.__stripeCalls = []);
  function element(type) {
    const handlers = {};
    let node = null;
    const el = {
      mount(dom) {
        node = dom;
        if (type === 'payment') {
          dom.innerHTML = '<label style="display:block;font-size:12px">Card number <input data-stub-card aria-label="Card number" inputmode="numeric" style="width:100%;max-width:100%;box-sizing:border-box" /></label>';
        } else if (type === 'expressCheckout') {
          dom.innerHTML = '<button type="button" data-stub-wallet style="width:100%;height:44px">Apple Pay (test)</button>';
          dom.querySelector('button').addEventListener('click', () => {
            const w = window.__wallet || {};
            const event = {
              expressPaymentType: 'apple_pay',
              billingDetails: { name: w.name, email: w.email, phone: w.phone, address: w.address },
              shippingAddress: { name: w.name, address: w.address },
              shippingRate: { id: 'standard', amount: 0, displayName: 'Free delivery' },
              paymentFailed: (p) => { window.__walletFailed = p || {}; },
            };
            (handlers.confirm || []).forEach((h) => h(event));
          });
        }
        setTimeout(() => (handlers.ready || []).forEach((h) => h(type === 'expressCheckout' ? { elementType: type, availablePaymentMethods: { applePay: true, googlePay: false, link: false, paypal: false, amazonPay: false, klarna: false } } : { elementType: type })), 30);
      },
      on(name, h) { (handlers[name] = handlers[name] || []).push(h); return el; },
      off(name, h) { handlers[name] = (handlers[name] || []).filter((x) => x !== h); return el; },
      update() { return el; },
      destroy() { if (node) node.innerHTML = ''; },
      unmount() {},
    };
    return el;
  }
  window.Stripe = function (key) {
    calls.push(['Stripe', key]);
    return {
      _registerWrapper() {},
      registerAppInfo() {},
      createToken() {},
      createPaymentMethod() {},
      confirmCardPayment() {},
      elements(options) {
        calls.push(['elements', options.amount, options.currency]);
        return { create: (type) => element(type), update(o) { calls.push(['update', o.amount]); }, submit: async () => ({}), getElement: () => null };
      },
      // __confirmError: a message (a decline: card_error), or a whole error ({ type, message }).
      confirmPayment: async (p) => {
        calls.push(['confirmPayment', p.clientSecret, p.redirect]);
        const e = window.__confirmError;
        if (!e) return { paymentIntent: { status: 'processing' } };
        return { error: typeof e === 'string' ? { type: 'card_error', code: 'card_declined', message: e } : e };
      },
    };
  };
  window.Stripe.version = 'basil';
})();
`;

async function openCheckout(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 } });
  const stripeRequests: string[] = [];
  await ctx.route('https://js.stripe.com/**', (route) => {
    stripeRequests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/javascript', body: STRIPE_JS_STUB });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.base, { waitUntil: 'load' });
  assert.equal(stripeRequests.length, 0, 'Stripe.js is not loaded by the shop itself');
  const [p] = await products();
  await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  return { ctx, page, errors, stripeRequests };
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll('[role="dialog"] .overflow-y-auto')].some((e) => e.scrollWidth > e.clientWidth + 1));

for (const width of [375, 1280]) {
  test(`at ${width}px: Card shows Stripe’s field (no sideways scroll, keyboard reaches it); the Pay button needs no SMS code`, { skip: skip || skipBrowser }, async () => {
    const { ctx, page, errors, stripeRequests } = await openCheckout(width);
    // Checkout fetches Stripe.js on its own after it opens: give it up to 10 s on a busy machine.
    for (let i = 0; i < 100 && !stripeRequests.some((u) => u.startsWith('https://js.stripe.com/')); i++) await page.waitForTimeout(100);
    assert.ok(stripeRequests.some((u) => u.startsWith('https://js.stripe.com/')), 'checkout loads Stripe.js');
    const cardOption = page.getByRole('radio', { name: /^Card/ });
    await cardOption.waitFor();
    await cardOption.focus();
    await page.keyboard.press('Enter');
    // Chosen with the keyboard (waits for the redraw: on a busy machine React may not have updated yet).
    await page.getByRole('radio', { name: /^Card/, checked: true }).waitFor();
    const field = page.locator('[data-testid="card-element"] input[data-stub-card]');
    await field.waitFor();
    assert.equal(await overflow(page), false, 'no sideways scroll');
    // Tab from the Card option reaches Stripe's field.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await field.evaluate((el) => el === document.activeElement);
    }
    assert.ok(reached, 'Tab reaches the card field');
    const pay = page.getByRole('button', { name: /^Pay AED/ });
    await pay.waitFor();
    assert.equal(await pay.isEnabled(), true, 'no SMS code needed to pay by card');
    assert.equal(await page.getByRole('button', { name: 'Send code' }).count(), 0);
    await page.getByText('Paying by card: no SMS code needed').waitFor();
    await page.screenshot({ path: path.join(server.dataDir, `card-${width}.png`) });
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('at 375px: Apple Pay fills checkout; an area we don’t know is asked for before paying; paid only on the server’s word', { skip: skip || skipBrowser }, async () => {
  const { ctx, page, errors } = await openCheckout(375);
  const wallet = page.locator('[data-stub-wallet]');
  await wallet.waitFor();
  await page.getByText('Express checkout · your address and phone fill in').waitFor();
  const before = mock.intents.size;
  const known = new Set(mock.intents.keys());
  await page.evaluate(() => {
    (window as unknown as { __wallet: unknown }).__wallet = { name: 'Aisha Wallet', email: 'aisha@example.ae', phone: '+971 55 123 4567', address: { line1: 'Villa 12, Street 4', line2: '', city: 'Somewhere New', state: 'Dubai', postal_code: '', country: 'AE' } };
  });
  await wallet.click();
  await page.getByText(/not an area we know/).waitFor();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __walletFailed: unknown }).__walletFailed), { reason: 'invalid_shipping_address', message: 'Please choose your area in checkout, then try again.' });
  assert.equal(mock.intents.size, before, 'nothing created or charged');
  // What the wallet gave is in checkout already; the area is asked for.
  assert.equal(await page.locator('input[placeholder="e.g. Fatima Al Mansoori"]').inputValue(), 'Aisha Wallet');
  assert.equal(await page.locator('#checkout-emirate').inputValue(), 'Dubai');
  const area = page.getByRole('combobox', { name: /Area \/ Neighborhood/ });
  await page.waitForFunction(() => document.activeElement?.id === 'checkout-area', null, { timeout: 3000 }); // the area field has focus
  await area.fill('Dubai Marina');
  await page.keyboard.press('Escape');
  await wallet.click();
  const status = page.getByTestId('card-payment-status');
  await status.waitFor();
  assert.match((await status.textContent()) || '', /Payment is being confirmed/);
  const pi = [...mock.intents.values()].find((x) => !known.has(x.id))!;
  assert.ok(pi, 'one PaymentIntent made by the server');
  const order = (await (await api('GET', `/api/admin/orders/${pi.metadata.orderId}`)).json()).order;
  assert.equal(order.customer.fullName, 'Aisha Wallet');
  assert.equal(order.customer.phone, '+971551234567', 'the wallet’s phone, through the shop’s phone rules');
  assert.equal(order.customer.area, 'Dubai Marina');
  assert.equal(order.customer.flatVillaNo, 'Villa 12');
  assert.equal(order.card.state, 'pending', 'the browser’s “done” is not “paid”');
  const confirmCalls = await page.evaluate(() => (window as unknown as { __stripeCalls: unknown[][] }).__stripeCalls.filter((c) => c[0] === 'confirmPayment'));
  assert.deepEqual(confirmCalls, [['confirmPayment', pi.client_secret, 'if_required']]);
  // Stripe takes the payment: the confirmation screen hears it from the server (which asked Stripe).
  mock.succeed(pi.id);
  await page.getByText('Paid by card · Apple Pay · Visa •••• 4242').waitFor({ timeout: 15_000 });
  assert.equal(await overflow(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

/** Card chosen, and the delivery details typed in. */
async function fillCardCheckout(page: Page, name: string, phone: string) {
  await page.getByRole('radio', { name: /^Card/ }).click();
  await page.locator('[data-testid="card-element"] input[data-stub-card]').waitFor();
  await page.locator('input[placeholder="e.g. Fatima Al Mansoori"]').fill(name);
  await page.locator('#checkout-phone').fill(phone);
  await page.getByRole('combobox', { name: /Area \/ Neighborhood/ }).fill('Dubai Marina');
  await page.keyboard.press('Escape');
  await page.locator('input[placeholder="Street name, road, or community number"]').fill('Marina Walk');
  await page.locator('input[placeholder="e.g. Marina Gate 1 or Villa 24"]').fill('Marina Gate 1');
  await page.locator('input[placeholder="e.g. Apt 1402 or Villa 24"]').fill('Apt 1402');
}

test('at 1280px: a typed card pays; a declined try frees the pieces and the next try is a new order', { skip: skip || skipBrowser }, async () => {
  const { ctx, page, errors } = await openCheckout(1280);
  await fillCardCheckout(page, 'Mona Typed', '0509876543');
  const count = () => [...mock.intents.values()].filter((x) => x.client_secret).length;
  const start = count();

  await page.evaluate(() => ((window as unknown as { __confirmError: string }).__confirmError = 'Your card was declined.'));
  await page.getByRole('button', { name: /^Pay AED/ }).click();
  await page.getByRole('alert').filter({ hasText: 'Your card was declined. Nothing was charged.' }).waitFor();
  assert.equal(count(), start + 1);
  const declined = [...mock.intents.values()].at(-1)!;
  for (let i = 0; i < 50 && declined.status !== 'canceled'; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(declined.status, 'canceled', 'the declined attempt is stopped at Stripe');
  assert.equal((await (await api('GET', `/api/admin/orders/${declined.metadata.orderId}`)).json()).order.status, 'cancelled', 'and its order cancelled (pieces back)');

  await page.evaluate(() => ((window as unknown as { __confirmError: string }).__confirmError = ''));
  await page.getByRole('button', { name: /^Pay AED/ }).click();
  await page.getByTestId('card-payment-status').waitFor();
  assert.equal(count(), start + 2, 'a new order and intent for the new try');
  const second = [...mock.intents.values()].at(-1)!;
  assert.notEqual(second.metadata.orderId, declined.metadata.orderId);
  // Stripe's signed webhook says paid.
  const ev = mock.event('payment_intent.succeeded', mock.succeed(second.id, { wallet: null, brand: 'mastercard', last4: '5454' }));
  assert.equal((await hook(ev.body, ev.signature)).status, 200);
  await page.getByText(/^Paid by card/).waitFor({ timeout: 15_000 });
  assert.equal(await overflow(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('at 1280px: the connection drops while paying and leaving fails too: nothing is claimed, “Check again” asks the server, and paying again is the same order (one order, one intent)', { skip: skip || skipBrowser }, async () => {
  const { ctx, page, errors } = await openCheckout(1280);
  await fillCardCheckout(page, 'Noor Offline', '0505550123');
  const known = new Set(mock.intents.keys());
  const fresh = () => [...mock.intents.values()].filter((x) => !known.has(x.id));
  // Stripe.js loses the connection (the card may or may not have been charged), and the shop's
  // "leave card checkout" call fails as well (offline).
  await page.evaluate(() => ((window as unknown as { __confirmError: unknown }).__confirmError = { type: 'api_connection_error', message: 'A network error has occurred.' }));
  let abandons = 0;
  await page.route('**/api/orders/payment', (route) => {
    if ((route.request().postData() || '').includes('"abandon"')) {
      abandons++;
      return route.abort('internetdisconnected');
    }
    return route.continue();
  });
  await page.getByRole('button', { name: /^Pay AED/ }).click();
  const alert = page.getByRole('alert').filter({ hasText: /couldn.t confirm the payment/ });
  await alert.waitFor();
  assert.match((await alert.textContent()) || '', /if your card was charged, your order is safe/);
  assert.doesNotMatch((await alert.textContent()) || '', /Nothing was charged/, 'never said when it is not known');
  assert.equal(abandons, 1);
  assert.equal(fresh().length, 1);
  const pi = fresh()[0];
  assert.equal((await (await api('GET', `/api/admin/orders/${pi.metadata.orderId}`)).json()).order.status, 'pending_payment', 'the order is kept');

  // "Check again": the server asks Stripe (not paid yet).
  await page.getByRole('button', { name: 'Check again' }).click();
  await page.getByRole('alert').filter({ hasText: /has not confirmed a payment for this order yet/ }).waitFor();

  // Back online: paying again continues the same order and the same PaymentIntent.
  await page.evaluate(() => ((window as unknown as { __confirmError: unknown }).__confirmError = ''));
  await page.getByRole('button', { name: /^Pay AED/ }).click();
  await page.getByTestId('card-payment-status').waitFor();
  assert.equal(fresh().length, 1, 'one PaymentIntent');
  assert.equal([...mock.intents.values()].filter((x) => x.metadata.orderId === pi.metadata.orderId).length, 1);
  const all = (await (await api('GET', '/api/admin/orders')).json()).orders as Array<{ customer: { fullName: string } }>;
  assert.equal(all.filter((o) => o.customer.fullName === 'Noor Offline').length, 1, 'one order');
  const confirms = await page.evaluate(() => (window as unknown as { __stripeCalls: unknown[][] }).__stripeCalls.filter((c) => c[0] === 'confirmPayment'));
  assert.deepEqual(confirms, [
    ['confirmPayment', pi.client_secret, 'if_required'],
    ['confirmPayment', pi.client_secret, 'if_required'],
  ]);
  mock.succeed(pi.id);
  await page.getByText(/^Paid by card/).waitFor({ timeout: 15_000 });
  assert.equal(await overflow(page), false);
  assert.deepEqual(errors, []);
  await ctx.close();
});
