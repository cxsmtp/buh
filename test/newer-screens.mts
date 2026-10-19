/**
 * The screens added since looks were first built (BUH-02.09 to 02.11), for the contrast and looks
 * browser tests: checkout's Card option (with a stand-in for Stripe.js), the order confirmation,
 * the private /pay page, order cards with the WhatsApp check and bank-transfer panels, the hub's
 * Money (Expenses, the expense form, Reports, Audit log) and Settings → Phone check, Payments and
 * Look. `prepareNewerScreens` puts in the shop what they show (once per server); `walkNewerScreens`
 * opens each and hands the page to `visit` (a contrast audit, a stark-surface check…).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { rawFetch, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { TEST_KEYS } from './stripe-mock.mjs';

type Page = import('playwright').Page;
type Browser = import('playwright').Browser;
export type Visit = (page: Page, where: string) => Promise<void>;

const BANK = { bankName: 'Mashreq', accountName: 'BUH TEST TRADING LLC', iban: 'AE07 0331 2345 6789 0123 456', accountNumber: '1012345678901', swiftCode: 'BOMLAEAD', branch: 'Al Wasl', instructions: 'Please put your order number in the transfer remarks.' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/**
 * Stripe.js stand-in: a plain card field and an "Apple Pay (test)" button. It keeps the appearance
 * the shop asked for (window.__stripeAppearance), so a test can check Stripe's fields follow the look.
 */
const STRIPE_JS_STUB = `
(() => {
  function element(type) {
    const handlers = {};
    const el = {
      mount(dom) {
        if (type === 'payment') dom.innerHTML = '<label style="display:block;font-size:12px">Card number <input data-stub-card aria-label="Card number" inputmode="numeric" style="width:100%;max-width:100%;box-sizing:border-box;background:transparent;color:inherit" /></label>';
        else dom.innerHTML = '<button type="button" data-stub-wallet style="width:100%;height:44px;background:transparent;color:inherit">Apple Pay (test)</button>';
        setTimeout(() => (handlers.ready || []).forEach((h) => h(type === 'expressCheckout' ? { elementType: type, availablePaymentMethods: { applePay: true, googlePay: false, link: false, paypal: false, amazonPay: false, klarna: false } } : { elementType: type })), 30);
      },
      on(name, h) { (handlers[name] = handlers[name] || []).push(h); return el; },
      off(name, h) { handlers[name] = (handlers[name] || []).filter((x) => x !== h); return el; },
      update() { return el; },
      destroy() {},
      unmount() {},
    };
    return el;
  }
  window.Stripe = function () {
    return {
      _registerWrapper() {},
      registerAppInfo() {},
      createToken() {},
      createPaymentMethod() {},
      confirmCardPayment() {},
      elements(options) {
        window.__stripeAppearance = options.appearance;
        return { create: (type) => element(type), update(o) { if (o.appearance) window.__stripeAppearance = o.appearance; }, submit: async () => ({}), getElement: () => null };
      },
      confirmPayment: async () => ({ paymentIntent: { status: 'processing' } }),
    };
  };
  window.Stripe.version = 'basil';
})();
`;

export interface NewerScreens {
  /** The private page of a bank-transfer order with a screenshot uploaded. */
  payPath: string;
}

function api(server: RunningServer, cookie: string, method: string, p: string, body?: unknown) {
  return fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
}

let phoneN = 0;
/** A different number each time (orders waiting for WhatsApp are capped per phone). */
function nextPhone(): string {
  return `05088${String(process.pid % 100).padStart(2, '0')}${String(++phoneN).padStart(3, '0')}`;
}

async function placeOrder(server: RunningServer, paymentMethod: 'cod' | 'bank_transfer'): Promise<{ id: string; bankTransfer?: { payPath?: string } }> {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await rawFetch(`${server.base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      customer: { fullName: 'Noor Looks', phone: nextPhone(), email: 'noor@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
      items: [{ productId: products[1].id, profileId: products[1].profiles[0].id, quantity: 1 }],
      paymentMethod,
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}

/**
 * What the newer screens show: the shop's WhatsApp number and bank details, an order waiting for
 * WhatsApp, a bank transfer with its screenshot, an order confirmed by phone call, and an expense.
 */
export async function prepareNewerScreens(server: RunningServer, cookie: string): Promise<NewerScreens> {
  for (const [key, settings] of [['bank', BANK], ['store', { whatsappNumber: '+971 50 999 7744' }]] as const) {
    const res = await api(server, cookie, 'PUT', `/api/admin/settings/${key}`, { settings });
    assert.equal(res.status, 200, await res.text());
  }
  await placeOrder(server, 'cod');
  const bank = await placeOrder(server, 'bank_transfer');
  const payPath = bank.bankTransfer!.payPath!;
  const up = await rawFetch(`${server.base}/api/pay/${payPath.slice(5)}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify({ file: `data:image/png;base64,${PNG.toString('base64')}` }) });
  assert.equal(up.status, 200, await up.text());
  const confirmed = await placeOrder(server, 'cod');
  assert.equal((await api(server, cookie, 'POST', `/api/admin/orders/${confirmed.id}/whatsapp`, { result: 'call' })).status, 200);
  const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
  const ex = await api(server, cookie, 'POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: today, amount: '45.75', categoryId: 'courier', method: 'card', payee: 'Jeebly' });
  assert.equal(ex.status, 201, await ex.text());
  return { payPath };
}

async function cardPayments(server: RunningServer, cookie: string, on: boolean) {
  const settings = on ? { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook } : { cardEnabled: false };
  const res = await api(server, cookie, 'PUT', '/api/admin/settings/payments', { settings });
  assert.equal(res.status, 200, await res.text());
}

/** Wait until nothing is sliding or fading in (a sheet rising, a colour changing). */
async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((an) => an.playState !== 'running' || an.effect?.getComputedTiming().iterations === Infinity));
}

/**
 * Open every newer screen at this width and colour scheme and call `visit` on each. Card payments
 * are on (Stripe.js stood in for) only while the shop is walked.
 */
export async function walkNewerScreens(browser: Browser, server: RunningServer, cookie: string, setup: NewerScreens, colorScheme: 'light' | 'dark', width: number, visit: Visit): Promise<void> {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
  await ctx.route('https://js.stripe.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: STRIPE_JS_STUB }));
  await ctx.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
  const page = await ctx.newPage();
  await cardPayments(server, cookie, true);
  try {
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.locator('main h3').first().waitFor();
    const p = (await (await rawFetch(`${server.base}/api/products`)).json()).products[0];
    await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
    await page.getByRole('button', { name: /Add to Bag/ }).click();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
    await page.locator('#checkout-phone').waitFor();
    await page.locator('[data-stub-wallet]').waitFor({ timeout: 15_000 });
    await page.getByRole('radio', { name: /^Card/ }).click();
    await page.locator('[data-testid="card-element"] input[data-stub-card]').waitFor();
    await settled(page);
    await visit(page, 'checkout, Card chosen');
    // Stripe's own fields are asked to wear the page's look.
    const look = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement);
      return { surface: css.getPropertyValue('--color-surface').trim(), dark: css.colorScheme.includes('dark') };
    });
    const appearance = (await page.evaluate(() => (window as unknown as { __stripeAppearance?: { theme: string; variables: { colorBackground: string } } }).__stripeAppearance))!;
    assert.equal(appearance.variables.colorBackground.toLowerCase(), look.surface.toLowerCase(), 'Stripe fields on the look’s surface');
    assert.equal(appearance.theme, look.dark ? 'night' : 'stripe');

    // Cash on delivery, placed: the confirmation screen.
    await page.getByRole('radio', { name: /^Cash on delivery/ }).click();
    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Hind Looks');
    await page.locator('#checkout-phone').fill(nextPhone());
    await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Dubai Marina');
    await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
    await page.locator('button[type=submit]').click();
    await page.getByText('Thank you for your order').waitFor({ timeout: 15_000 });
    await settled(page);
    await visit(page, 'order confirmation');
    // Confirmed by the owner, so it doesn't count against the shop's cap on unconfirmed orders.
    const href = (await page.getByRole('link', { name: 'Confirm on WhatsApp' }).getAttribute('href'))!;
    const id = href.match(/BUH-\d{6}-[A-Z2-9]{6}/)![0];
    assert.equal((await api(server, cookie, 'POST', `/api/admin/orders/${id}/whatsapp`, { result: 'call' })).status, 200);
  } finally {
    await cardPayments(server, cookie, false);
  }
  await page.goto(`${server.base}${setup.payPath}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Pay by bank transfer' }).waitFor();
  await visit(page, '/pay page');
  await ctx.close();

  const admin = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
  const [n, v] = cookie.split('=');
  await admin.addCookies([{ name: n, value: v, url: server.base }]);
  const a = await admin.newPage();
  a.on('dialog', (d) => void d.dismiss());
  await a.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await openAdminSection(a, /^Orders/);
  await a.getByRole('button', { name: /^Awaiting WhatsApp/ }).click();
  await a.getByTestId('whatsapp-check').first().getByRole('link', { name: 'Ask to confirm' }).waitFor();
  await settled(a);
  await visit(a, 'hub orders, awaiting WhatsApp');
  await a.getByRole('button', { name: /^Transfer to check/ }).click();
  await a.getByTestId('bank-badge').filter({ hasText: 'Transfer screenshot received' }).first().waitFor();
  await settled(a);
  await visit(a, 'hub orders, transfer to check');
  await a.getByRole('button', { name: /^All Orders/ }).click();
  await a.getByText(/Confirmed by phone call/).first().waitFor();
  await settled(a);
  await visit(a, 'hub orders, all');

  await openAdminSection(a, /^Money/);
  await a.getByTestId('expense-item').first().waitFor();
  await settled(a);
  await visit(a, 'hub Money: expenses');
  await a.getByRole('button', { name: 'Add expense' }).click();
  await a.getByTestId('expense-form').waitFor();
  await settled(a);
  await visit(a, 'hub Money: expense form');
  await a.getByRole('button', { name: 'Reports' }).click();
  await a.getByTestId('report-expenses').waitFor();
  await a.getByTestId('vat-notice').waitFor();
  await settled(a);
  await visit(a, 'hub Money: reports');
  await a.getByRole('button', { name: 'Audit log' }).click();
  await a.getByTestId('audit-entry').first().waitFor();
  await settled(a);
  await visit(a, 'hub Money: audit log');

  await openAdminSection(a, /^Settings/);
  const sections = a.getByRole('navigation', { name: 'Settings sections' });
  for (const name of ['Phone check', 'Payments', 'Look']) {
    await sections.getByRole('button', { name, exact: true }).click();
    await a.waitForTimeout(400);
    await settled(a);
    await visit(a, `hub Settings → ${name}`);
  }
  await admin.close();
}
