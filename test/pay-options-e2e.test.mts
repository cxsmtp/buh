/**
 * Against the real build, in Chromium at 375 and 1280 px: the card payment fee and bank transfer
 * "on request". Checkout's Card option says the fee applies, the summary shows "Card payment fee
 * (3.5%) AED x" before the total and the Pay button the full amount; switching to bank transfer
 * removes the line. With no bank account saved but the shop's WhatsApp number, bank transfer is
 * offered as "message us on WhatsApp"; while the order waits for its WhatsApp confirmation the
 * confirmation has one button, "Confirm & ask for bank details on WhatsApp" (the code and the ask),
 * also on /pay, which never shows the account for these orders; the hub's order card says the
 * customer will ask, with a reply that has "[your bank details]" to fill in. A card order is charged
 * total + fee (Stripe stand-in) and the confirmation shows the fee. The fee setting goes live when
 * the field is left. No sideways scroll. Skipped without a build.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, setPhoneCheck, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { startStripeMock, STRIPE_JS_STUB, TEST_KEYS, type StripeMock } from './stripe-mock.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

const SHOP_WA = '+971 50 123 9876';
const SHOTS = process.env.PAY_SHOTS_DIR || '';

let server: RunningServer;
let mock: StripeMock;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  mock = await startStripeMock();
  server = await startServer({ BUH_TEST_STRIPE_API: mock.url, CARD_SWEEP_DISABLED: '1', NEXT_PUBLIC_APP_URL: '' });
  await setPhoneCheck(server, 'sms_code');
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Pay-Options-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  for (const [key, settings] of [
    ['store', { whatsappNumber: SHOP_WA }],
    ['payments', { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook }],
  ] as const) {
    const res = await api('PUT', `/api/admin/settings/${key}`, { settings });
    assert.equal(res.status, 200, await res.text());
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
  await mock?.close();
});

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
};
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || [...document.querySelectorAll('[role="dialog"] .overflow-y-auto')].some((e) => e.scrollWidth > e.clientWidth + 1));
const feeOf = (fils: number) => Math.floor((fils * 350 + 5000) / 10000);
const aed = (fils: number) => (fils % 100 === 0 ? String(fils / 100) : (fils / 100).toFixed(2));

test('the public settings: bank transfer on request (no account, a WhatsApp number) and the card fee percent; no account anywhere', { skip }, async () => {
  const pub = await (await rawFetch(`${server.base}/api/settings/public`)).json();
  assert.equal(pub.bankTransfer, true);
  assert.equal(pub.bankTransferMode, 'ask_whatsapp');
  assert.equal(pub.payments.cardFeePercent, 3.5);
  // An audited change of the fee, from and to.
  const res = await api('PUT', '/api/admin/settings/payments', { settings: { cardFeePercent: 3 } });
  assert.equal(res.status, 200, await res.text());
  const back = await api('PUT', '/api/admin/settings/payments', { settings: { cardFeePercent: 3.5 } });
  assert.equal(back.status, 200);
  const lines = fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((e) => e.action === 'settings.payment_options_changed');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].details.from.cardFeePercent, 3.5);
  assert.equal(lines[0].details.to.cardFeePercent, 3);
  // Refused on the server: out of range.
  assert.equal((await api('PUT', '/api/admin/settings/payments', { settings: { cardFeePercent: 12 } })).status, 400);
});

async function openCheckout(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, hasTouch: width < 800 });
  await ctx.route('https://js.stripe.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: STRIPE_JS_STUB }));
  await ctx.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.base, { waitUntil: 'load' });
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ title: string; price: number; profiles: Array<{ priceDelta?: number }> }>;
  const p = products[0];
  await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  return { ctx, page, errors };
}

async function fillDetails(page: Page, name: string, phone: string) {
  await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill(name);
  await page.locator('#checkout-phone').fill(phone);
  await page.getByRole('combobox', { name: /Area \/ Neighborhood/ }).fill('Dubai Marina');
  await page.keyboard.press('Escape');
  await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
  await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
  await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
}

/** The bag's total before any fee, in fils, from what checkout shows with cash on delivery. */
async function baseFils(page: Page): Promise<number> {
  const text = (await page.locator('#checkout-total').innerText()).replace(/[^\d.]/g, '');
  return Math.round(Number(text) * 100);
}

for (const [width, phone] of [[375, '050 662 3001'], [1280, '055 662 3002']] as const) {
  test(`at ${width}px: the card fee line and Pay amount; bank transfer on request; the confirmation's one WhatsApp button; the hub's note`, { skip: skip || skipBrowser }, async () => {
    const { ctx, page, errors } = await openCheckout(width);
    await fillDetails(page, 'Salma Fee', phone);
    await page.getByRole('button', { name: /Send code/ }).click();
    await page.getByRole('button', { name: /Test mode/ }).click();
    await page.getByText('Mobile number verified').waitFor();
    const base = await baseFils(page);
    const fee = feeOf(base);
    assert.equal(await page.getByTestId('card-fee-line').count(), 0, 'cash on delivery: no fee line');

    // Card: the option says it, the summary shows the fee before the total, the button the full amount.
    const cardOption = page.getByRole('radio', { name: /^Card/ });
    await cardOption.getByText('A 3.5% card fee applies.').waitFor();
    await cardOption.click();
    const line = page.getByTestId('card-fee-line');
    await line.waitFor();
    assert.equal((await line.innerText()).trim(), `Card payment fee (3.5%) AED ${aed(fee)}`);
    assert.equal((await page.locator('#checkout-total').innerText()).trim(), `AED ${aed(base + fee)}`);
    await page.getByRole('button', { name: `Pay AED ${aed(base + fee)}` }).waitFor();
    // The fee line comes before the total.
    const order = await page.evaluate(() => {
      const l = document.querySelector('[data-testid="card-fee-line"]')!;
      const t = document.getElementById('checkout-total')!;
      return Boolean(l.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(order, 'the fee line is shown before the total');
    assert.equal(await overflow(page), false, 'card: no sideways scroll');
    await page.locator('#checkout-total').scrollIntoViewIfNeeded();
    await shot(page, `checkout-card-fee-${width}.png`);

    // Bank transfer on request: the fee line goes, the option says to message on WhatsApp.
    const bank = page.getByRole('radio', { name: /Bank transfer/ });
    await bank.getByText('Message us on WhatsApp for our bank details; we dispatch as soon as it arrives.').waitFor();
    await bank.click();
    await page.getByTestId('bank-transfer-note').getByText(/Ask for bank details on WhatsApp/).waitFor();
    assert.equal(await page.getByTestId('card-fee-line').count(), 0, 'bank transfer: no fee line');
    assert.equal((await page.locator('#checkout-total').innerText()).trim(), `AED ${aed(base)}`);
    assert.equal(await overflow(page), false, 'bank: no sideways scroll');
    await bank.scrollIntoViewIfNeeded();
    await shot(page, `checkout-bank-on-request-${width}.png`);

    // Keyboard: the bank option is reachable and chosen with Enter.
    await cardOption.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('card-fee-line').waitFor();
    await bank.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('radio', { name: /Bank transfer/, checked: true }).waitFor();

    await page.locator('button[type=submit]').click();
    await page.getByText('Thank you for your order').waitFor({ timeout: 10_000 });
    // The order still waits for its WhatsApp confirmation (Store & contact's "Confirm orders on
    // WhatsApp"): one button, the confirmation with its code, which also asks for the details.
    const dialog = page.getByRole('dialog');
    const ask = dialog.getByRole('link', { name: 'Confirm & ask for bank details on WhatsApp' });
    await ask.waitFor();
    assert.equal(await dialog.locator('a[href^="https://wa.me/"]').count(), 1, 'one WhatsApp button, not two');
    assert.equal(await page.getByTestId('bank-ask-whatsapp').count(), 0);
    const href = (await ask.getAttribute('href'))!;
    const url = new URL(href);
    assert.equal(url.origin + url.pathname, 'https://wa.me/971501239876', 'the shop’s number');
    const text = url.searchParams.get('text')!;
    const id = text.match(/BUH-[A-Z0-9-]+/)?.[0];
    assert.ok(id, text);
    assert.match(text, new RegExp(`^Confirm my order ${id} · code \\d{4}, and please send me the bank details$`));
    const box = (await ask.boundingBox())!;
    assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width, JSON.stringify(box));
    await page.getByRole('link', { name: 'Then upload your transfer screenshot' }).waitFor();
    assert.equal(await overflow(page), false, 'confirmation: no sideways scroll');
    await shot(page, `confirmation-ask-bank-${width}.png`);
    assert.deepEqual(errors, []);
    await ctx.close();

    // The hub: the order says the customer will ask; the reply has "[your bank details]" to fill in.
    const placed = (await (await api('GET', `/api/admin/orders/${id}`)).json()).order;
    assert.equal(placed.bankDetailsBy, 'whatsapp');
    assert.equal(placed.paymentStatus, 'pending');
    assert.equal(placed.bankTransfer.state, 'awaiting');
    const hub = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const hubErrors: string[] = [];
    hp.on('pageerror', (e) => hubErrors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const panel = hp.getByTestId('bank-transfer').filter({ hasText: id! });
    await panel.getByTestId('bank-on-request').filter({ hasText: 'Bank transfer: customer will ask for details on WhatsApp' }).waitFor();
    const reply = panel.getByRole('link', { name: 'Reply with bank details on WhatsApp' });
    const replyUrl = new URL((await reply.getAttribute('href'))!);
    assert.equal(replyUrl.pathname, `/${placed.customer.phone.replace(/\D/g, '')}`, 'to the customer');
    const replyText = replyUrl.searchParams.get('text')!;
    for (const s of ['[your bank details]', `Reference: ${id}`, `AED ${aed(base)}`]) assert.ok(replyText.includes(s), s);
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await overflow(hp), false, 'hub: no sideways scroll');
    await shot(hp, `hub-bank-on-request-${width}.png`);
    assert.deepEqual(hubErrors, []);
    await hub.close();
  });
}

test('at 1280px: a card order is charged total + fee, and the confirmation shows the fee', { skip: skip || skipBrowser }, async () => {
  const { ctx, page, errors } = await openCheckout(1280);
  await fillDetails(page, 'Huda Card', '0506624003');
  const base = await baseFils(page);
  const fee = feeOf(base);
  await page.getByRole('radio', { name: /^Card/ }).click();
  await page.locator('[data-testid="card-element"] input[data-stub-card]').waitFor();
  const elementsAmounts = await page.evaluate(() => (window as unknown as { __stripeCalls: unknown[][] }).__stripeCalls.filter((c) => c[0] === 'elements').map((c) => c[1]));
  assert.ok(elementsAmounts.includes(base + fee), `Stripe's form shows total + fee: ${JSON.stringify(elementsAmounts)}`);
  const known = new Set(mock.intents.keys());
  await page.getByRole('button', { name: `Pay AED ${aed(base + fee)}` }).click();
  await page.getByTestId('card-payment-status').waitFor();
  const pi = [...mock.intents.values()].find((x) => !known.has(x.id))!;
  assert.equal(pi.amount, base + fee, 'the PaymentIntent is total + fee');
  mock.succeed(pi.id);
  await page.getByText(/^Paid by card/).waitFor({ timeout: 15_000 });
  const feeRow = page.getByTestId('confirmed-card-fee');
  assert.match(await feeRow.innerText(), new RegExp(`Card payment fee \\(3\\.5%\\)\\s+AED ${aed(fee).replace('.', '\\.')}`));
  await page.getByText(`AED ${aed(base + fee)}`, { exact: true }).first().waitFor();
  assert.equal(await overflow(page), false);
  await shot(page, 'confirmation-card-fee-1280.png');
  assert.deepEqual(errors, []);
  await ctx.close();
  const order = (await (await api('GET', `/api/admin/orders/${pi.metadata.orderId}`)).json()).order;
  assert.equal(order.cardFee, fee / 100);
  assert.equal(order.total, (base + fee) / 100);
});

// ── Review fixes ─────────────────────────────────────────────────────────────────────────────────

const BANK = { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' };

test('at 375px, phone check WhatsApp, "on request" with an account saved: one WhatsApp button (confirm + ask, with the code); /pay shows no account; the hub reply asks for YES', { skip: skip || skipBrowser }, async () => {
  await setPhoneCheck(server, 'whatsapp');
  for (const [key, settings] of [['bank', BANK], ['payments', { bankTransferMode: 'ask_whatsapp' }]] as const) {
    const res = await api('PUT', `/api/admin/settings/${key}`, { settings });
    assert.equal(res.status, 200, await res.text());
  }
  try {
    const { ctx, page, errors } = await openCheckout(375);
    await fillDetails(page, 'Noura Ask', '050 662 3011');
    await page.getByRole('radio', { name: /Bank transfer/ }).click();
    await page.locator('button[type=submit]').click();
    await page.getByText('Thank you for your order').waitFor({ timeout: 10_000 });
    const dialog = page.getByRole('dialog');
    const button = dialog.getByRole('link', { name: 'Confirm & ask for bank details on WhatsApp' });
    await button.waitFor();
    assert.equal(await dialog.locator('a[href^="https://wa.me/"]').count(), 1, 'one WhatsApp button, not two');
    assert.equal(await page.getByTestId('bank-ask-whatsapp').count(), 0, 'no separate ask without the code');
    const text = new URL((await button.getAttribute('href'))!).searchParams.get('text')!;
    const id = text.match(/BUH-[A-Z0-9-]+/)?.[0];
    const placed = (await (await api('GET', `/api/admin/orders/${id}`)).json()).order;
    assert.equal(placed.bankDetailsBy, 'whatsapp');
    assert.equal(placed.whatsappCheck.status, 'awaiting');
    assert.equal(text, `Confirm my order ${id} · code ${placed.whatsappCheck.code}, and please send me the bank details`);
    assert.equal(await overflow(page), false, 'confirmation: no sideways scroll');
    await shot(page, 'confirmation-confirm-and-ask-375.png');
    assert.deepEqual(errors, []);

    // The order's private page: no account detail at all, the same one button.
    const html = await (await rawFetch(`${server.base}${placed.bankTransfer.payPath}`)).text();
    assert.match(html, /Pay by bank transfer/);
    const flat = html.replace(/\s+/g, '');
    for (const s of [BANK.iban, BANK.accountName, BANK.accountNumber, BANK.swiftCode, BANK.bankName]) assert.ok(!flat.includes(s.replace(/\s+/g, '')), `not on /pay: ${s}`);
    await page.goto(`${server.base}${placed.bankTransfer.payPath}`, { waitUntil: 'load' });
    const pay = page.getByTestId('pay-ask-bank');
    assert.equal((await pay.innerText()).trim(), 'Confirm & ask for bank details on WhatsApp');
    assert.equal(new URL((await pay.getAttribute('href'))!).searchParams.get('text'), text);
    assert.equal(await overflow(page), false, '/pay: no sideways scroll');
    await ctx.close();

    // The hub's reply (the saved account) also asks for the confirmation while it is awaited.
    const hub = await browser.newContext({ viewport: { width: 375, height: 860 }, hasTouch: true });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const panel = hp.getByTestId('bank-transfer').filter({ hasText: id! });
    const reply = new URL((await panel.getByRole('link', { name: 'Reply with bank details on WhatsApp' }).getAttribute('href'))!).searchParams.get('text')!;
    assert.ok(reply.includes(BANK.bankName) && reply.includes('Please also reply YES to confirm your order.'), reply);
    await hub.close();
  } finally {
    await setPhoneCheck(server, 'sms_code');
    await api('PUT', '/api/admin/settings/payments', { settings: { bankTransferMode: 'default' } });
    await api('PUT', '/api/admin/settings/bank', { settings: { bankName: '', accountName: '', iban: '', accountNumber: '', swiftCode: '' } });
  }
});

test('Settings → Payments: the card fee goes live when the field is left, not while typing ("3" on the way to "3.7" is never saved or audited)', { skip: skip || skipBrowser }, async () => {
  const feeChanges = () =>
    fs
      .readdirSync(server.dataDir)
      .filter((f) => /^audit-.*\.jsonl$/.test(f))
      .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean))
      .map((l) => JSON.parse(l))
      .filter((e) => e.action === 'settings.payment_options_changed');
  const saved = async () => (await (await api('GET', '/api/admin/settings')).json()).payments.value.cardFeePercent;
  assert.equal(await saved(), 3.5);
  const before = feeChanges().length;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Payments' }).click();
  const input = page.getByTestId('card-fee-input');
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.pressSequentially('3');
  await page.waitForTimeout(3000); // longer than the autosave's pause
  assert.equal(await saved(), 3.5, 'a half-typed fee is not saved');
  await input.pressSequentially('.7');
  await page.getByText('On AED 100: AED 3.70').waitFor();
  await input.press('Tab');
  for (let i = 0; i < 100 && (await saved()) !== 3.7; i++) await page.waitForTimeout(100);
  assert.equal(await saved(), 3.7, 'saved once the field is left');
  const changes = feeChanges().slice(before);
  assert.equal(changes.length, 1, JSON.stringify(changes));
  assert.equal(changes[0].details.from.cardFeePercent, 3.5);
  assert.equal(changes[0].details.to.cardFeePercent, 3.7);
  await ctx.close();
  assert.equal((await api('PUT', '/api/admin/settings/payments', { settings: { cardFeePercent: 3.5 } })).status, 200);
});
