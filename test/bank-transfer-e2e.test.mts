/**
 * BUH-02.09 against the real build: bank transfer without the bank account on the website. The
 * public pages, APIs and scripts never carry the IBAN or account name; a bank-transfer order gets
 * its details by email (once, with the private link) and on its private page /pay/<token>
 * (no-referrer, noindex, no-store, never in the sitemap; a wrong token is the shop's ordinary 404,
 * byte for byte; page views limited); the token never reaches the server's log. The owner's
 * "Payment received" route: door + session + same site, allow-listed body, unknown order 404,
 * idempotent, audited. In Chromium at 375 and 1280 px: checkout's bank-transfer copy, the
 * confirmation's link, the /pay page's upload, then the hub's badge → screenshot → Payment
 * received; no sideways scroll, keyboard works. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { SMTPServer } from 'smtp-server';
import { freePort, hasBuild, rawFetch, setPhoneCheck, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

const SHOP_WA = '+971 50 999 4411';
const BANK = { bankName: 'Mashreq', accountName: 'BUH TEXTILES TRADING LLC', iban: 'AE07 0331 2345 6789 0123 456', accountNumber: '1012345678901', swiftCode: 'BOMLAEAD', branch: 'Al Wasl', instructions: 'Please put your order number in the transfer remarks.' };
const SECRETS = ['AE07', '0331 2345', '0331234567', BANK.accountName, BANK.accountNumber, 'BOMLAEAD'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let server: RunningServer;
let smtp: SMTPServer;
const mails: string[] = [];
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _s, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        mails.push(raw);
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const port = String((smtp.server.address() as { port: number }).port);
  // The shop's address is configured (links to customers are built from it, never the Host header).
  const shopPort = await freePort();
  server = await startServer(
    { SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@test', BACKUP_EMAIL: 'owner@test', NEXT_PUBLIC_APP_URL: `http://127.0.0.1:${shopPort}` },
    { port: shopPort }
  );
  // These tests drive the SMS-code checkout (Settings → Phone check "SMS code"; the default is WhatsApp).
  await setPhoneCheck(server, 'sms_code');
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Bank-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  for (const [key, settings] of [['bank', BANK], ['store', { whatsappNumber: SHOP_WA, confirmOrdersOnWhatsApp: true, holdUntilWhatsAppConfirmed: false }]] as const) {
    const res = await api('PUT', `/api/admin/settings/${key}`, { settings });
    assert.equal(res.status, 200, await res.text());
  }
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
  smtp?.close();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

interface PlacedOrder {
  id: string;
  total: number;
  customer: { phone: string };
  bankTransfer?: { state: string; uploads: number; payPath?: string };
}
let phoneN = 0;
async function placeOrder(email: string | undefined = 'buyer@example.com'): Promise<PlacedOrder> {
  const phone = `+97150880${String(++phoneN).padStart(4, '0')}`;
  const sent = await (await post('/api/otp/send', { phone })).json();
  const { verificationToken } = await (await post('/api/otp/verify', { phone, code: sent.devOtpCode })).json();
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    verificationToken,
    customer: { fullName: 'Layla Test', email, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'bank_transfer',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  for (const s of SECRETS) assert.ok(!text.includes(s), `the order answer never carries ${s}`);
  return JSON.parse(text).order;
}
const adminOrder = async (id: string) => (await (await api('GET', `/api/admin/orders/${id}`)).json()) as { order: PlacedOrder & { paymentStatus: string; bankTransfer: { state: string; checkedBy?: string; emailedAt?: string; uploads: number } }; events: Array<{ event: string; actor: string }> };
function auditLines(): string[] {
  return fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean));
}
/** Status, body and every header but Date: what a visitor can compare. */
async function answer(res: Response) {
  const body = await res.text();
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'date').map(([k, v]) => `${k}: ${v}`).sort();
  return { status: res.status, body, headers };
}
const rand = () => crypto.randomBytes(6).toString('hex');
async function until<T>(fn: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
}

test('the public site, its APIs and every script never carry the bank account', { skip }, async () => {
  const pub = await (await rawFetch(`${server.base}/api/settings/public`)).json();
  assert.equal(pub.bankTransfer, true, 'checkout offers bank transfer');
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string }>;
  const seen = new Set<string>();
  const problems: string[] = [];
  const scan = async (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    const text = await (await rawFetch(`${server.base}${url}`)).text();
    for (const s of SECRETS) if (text.includes(s)) problems.push(`${url}: ${s}`);
    for (const m of text.matchAll(/(?:\/_next\/)?static\/(?:chunks|css)\/[^"'\s()<>\\]+?\.(?:js|css)/g)) await scan(m[0].startsWith('/_next/') ? m[0] : `/_next/${m[0]}`);
  };
  for (const p of ['/', `/p/${products[0].id}`, '/offline', '/sw.js', '/manifest.webmanifest', '/api/settings/public', '/api/products', '/robots.txt', '/sitemap.xml']) await scan(p);
  assert.ok(seen.size >= 10, `${seen.size} files`);
  assert.deepEqual(problems, []);
});

test('a bank-transfer order: the details emailed once with the private link; the page is private; a wrong token is the ordinary 404', { skip }, async () => {
  const o = await placeOrder();
  assert.equal(o.bankTransfer?.state, 'awaiting');
  const payPath = o.bankTransfer!.payPath!;
  assert.match(payPath, /^\/pay\/[A-Za-z0-9_-]{43}$/);
  const token = payPath.slice(5);

  // The email (sent after the answer): details, amount, reference and the link.
  const { simpleParser } = await import('mailparser');
  const mail = await until(async () => {
    for (const raw of mails) {
      const m = await simpleParser(raw);
      if (m.subject === `Bank details for your order ${o.id}`) return m;
    }
  }, 'the bank details email');
  for (const s of [BANK.iban, BANK.accountName, `AED ${o.total}`, `use ${o.id} as the transfer reference`, payPath, 'or reply to this email with your screenshot']) assert.ok(mail.text!.includes(s), s);
  await until(async () => (await adminOrder(o.id)).order.bankTransfer.emailedAt, 'emailed noted');
  assert.ok((await adminOrder(o.id)).events.some((e) => e.event === 'bank_emailed'));
  assert.equal(mails.filter((m) => m.includes(o.id)).length, 1, 'once');

  // The private page: the details, behind the token only, with private headers.
  const page = await rawFetch(`${server.base}${payPath}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  for (const s of [BANK.iban, BANK.accountName, o.id]) assert.ok(html.includes(s), s);
  assert.match(html, /<meta name="robots" content="noindex, nofollow, nocache"/);
  assert.match(html, /<meta name="referrer" content="no-referrer"/);
  assert.ok(!(await (await rawFetch(`${server.base}/sitemap.xml`)).text()).includes('/pay'), 'never in the sitemap');

  // A wrong (or altered) token: the shop's ordinary 404, byte for byte.
  const unknownPage = await answer(await rawFetch(`${server.base}/no-such-page-${rand()}`));
  assert.equal(unknownPage.status, 404);
  for (const wrong of [crypto.randomBytes(32).toString('base64url'), `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, 'short']) {
    assert.deepEqual(await answer(await rawFetch(`${server.base}/pay/${wrong}`)), unknownPage, wrong);
  }
  const init = () => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' });
  const unknownApi = await answer(await rawFetch(`${server.base}/api/no-such-${rand()}`, init()));
  assert.deepEqual(await answer(await rawFetch(`${server.base}/api/pay/${crypto.randomBytes(32).toString('base64url')}`, init())), unknownApi);

  // The token never reaches the server's log (masked like the admin link).
  assert.ok(!server.log().includes(token), 'never in the log');
});

test('the page and its upload are limited per order', { skip }, async () => {
  const o = await placeOrder(undefined);
  const payPath = o.bankTransfer!.payPath!;
  let last = 0;
  for (let i = 0; i < 70 && last !== 429; i++) {
    const res = await rawFetch(`${server.base}${payPath}`);
    last = res.status;
    await res.arrayBuffer();
  }
  assert.equal(last, 429, 'page views per order');
  const file = `data:image/png;base64,${PNG.toString('base64')}`;
  let up = 0;
  for (let i = 0; i < 15 && up !== 429; i++) up = (await post(`/api/pay/${payPath.slice(5)}`, { file })).status;
  assert.equal(up, 429, 'uploads per order');
  assert.ok((await adminOrder(o.id)).order.bankTransfer.uploads <= 10);
});

test('the owner’s "Payment received" route: door, session and same site; body validated; unknown order 404; idempotent and audited', { skip }, async () => {
  const o = await placeOrder(undefined);
  const url = `/api/admin/orders/${o.id}/bank`;
  const unknown = await rawFetch(`${server.base}/api/no-such-${rand()}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' });
  const noDoor = await rawFetch(`${server.base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: JSON.stringify({ result: 'received' }) });
  assert.equal(noDoor.status, 404, 'without the door: an unknown address');
  assert.equal(await noDoor.text(), await unknown.text());
  assert.equal((await post(url, { result: 'received' }, { cookie: server.door })).status, 401, 'the door but no session');
  assert.equal((await api('POST', url, { result: 'received' }, { origin: 'https://evil.example' })).status, 403, 'cross-site');
  assert.equal((await api('POST', url, {})).status, 400);
  assert.equal((await api('POST', url, { result: 'paid' })).status, 400);
  assert.equal((await api('POST', url, { result: 'received', amount: 1 })).status, 400, 'fields outside the allow-list');
  assert.equal((await api('POST', url, { result: 'received', pad: 'x'.repeat(4000) })).status, 413, 'size-capped');
  const missing = await api('POST', '/api/admin/orders/BUH-000000-NOSUCH/bank', { result: 'received' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { success: false, message: 'Order not found.' });
  assert.equal((await adminOrder(o.id)).order.bankTransfer.state, 'awaiting', 'nothing changed by the refused calls');

  const before = auditLines().length;
  const first = await api('POST', url, { result: 'received' });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.changed, true);
  assert.equal(body.order.bankTransfer.state, 'paid');
  assert.equal(body.order.paymentStatus, 'verified');
  assert.equal(body.order.bankTransfer.checkedBy, 'admin@beautifuluaehome.com');
  const again = await (await api('POST', url, { result: 'received' })).json();
  assert.equal(again.changed, false);
  assert.equal(again.order.bankTransfer.checkedAt, body.order.bankTransfer.checkedAt, 'a second tap changes nothing');
  const added = auditLines().slice(before).map((l) => JSON.parse(l));
  assert.deepEqual(added.map((e) => e.action), ['payment.bank_received']);
  assert.equal((await api('POST', url, { result: 'not_received' })).status, 409, 'never un-paid');
  // Paid: its private page is gone (the ordinary 404).
  assert.equal((await rawFetch(`${server.base}${o.bankTransfer!.payPath}`)).status, 404);
});

async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

/** Tab through the page until the focused element matches (keyboard reachable). */
async function tabTo(page: Page, test: (el: { tag: string; type: string; text: string }) => boolean): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const el = await page.evaluate(() => {
      const a = document.activeElement as HTMLInputElement | null;
      return { tag: a?.tagName ?? '', type: a?.type ?? '', text: a?.innerText || a?.closest('label')?.innerText || '' };
    });
    if (test(el)) return true;
  }
  return false;
}

for (const [width, phone] of [[375, '050 881 3001'], [1280, '055 881 3002']] as const) {
  test(`at ${width}px: checkout’s bank-transfer copy, the confirmation’s link, the private page’s upload, then the hub: badge → screenshot → Payment received`, { skip: skip || skipBrowser }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    await ctx.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.locator('h3, h4').filter({ hasText: 'Mughal' }).first().click();
    await page.getByRole('button', { name: /Add to Bag/ }).click();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
    await page.locator('#checkout-phone').waitFor();
    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Reem Test');
    await page.locator('#checkout-phone').fill(phone);
    await page.getByRole('button', { name: /Send code/ }).click();
    await page.getByRole('button', { name: /Test mode/ }).click();
    await page.getByText('Mobile number verified').waitFor();
    await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Dubai Marina');
    await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
    await page.getByRole('radio', { name: /Bank transfer/ }).click();
    const note = page.getByTestId('bank-transfer-note');
    await note.getByText('After you order, we\'ll send our bank details by email and WhatsApp, with a private link to upload your transfer screenshot.').waitFor();
    assert.ok(await note.isVisible());
    const checkoutText = await page.locator('body').innerText();
    for (const s of SECRETS) assert.ok(!checkoutText.includes(s), `checkout never shows ${s}`);
    assert.deepEqual(await overflow(page), [], 'checkout: no sideways scroll');
    await page.locator('button[type=submit]').click();
    await page.locator('#order-confirmed-title').waitFor({ timeout: 10_000 });

    // The confirmation: the customer's own private link, and "Confirm on WhatsApp" asks for the details.
    const uploadLink = page.getByRole('link', { name: 'Upload your transfer screenshot' });
    await uploadLink.waitFor();
    const payPath = (await uploadLink.getAttribute('href'))!;
    assert.match(payPath, /^\/pay\/[A-Za-z0-9_-]{43}$/);
    const confirm = page.getByRole('link', { name: /Confirm (my order )?on WhatsApp/ });
    const confirmHref = (await confirm.getAttribute('href'))!;
    const id = confirmHref.match(/BUH-\d{6}-[A-Z2-9]{6}/)?.[0];
    assert.ok(id, confirmHref);
    assert.match(new URL(confirmHref).searchParams.get('text')!, new RegExp(`^Confirm my order ${id} · code \\d{4}, and please send me the bank details$`));
    const confirmationText = await page.locator('body').innerText();
    for (const s of SECRETS) assert.ok(!confirmationText.includes(s), `the confirmation never shows ${s}`);
    assert.deepEqual(await overflow(page), [], 'confirmation: no sideways scroll');
    const box = (await uploadLink.boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.height >= 44, JSON.stringify(box));

    // Track Order shows the same link for the verified customer.
    const tracked = await (await post('/api/orders/lookup', { orderId: id, phone })).json();
    assert.equal(tracked.order.bankTransfer.payPath, payPath);

    // The private page: details, amount, reference; the upload, by keyboard too.
    const pay = await ctx.newPage();
    pay.on('pageerror', (e) => errors.push(e.message));
    await pay.goto(`${server.base}${payPath}`, { waitUntil: 'domcontentloaded' });
    await pay.getByRole('heading', { name: 'Pay by bank transfer' }).waitFor();
    await pay.getByText(BANK.iban).waitFor();
    await pay.getByText(BANK.accountName).waitFor();
    const { order } = await adminOrder(id!);
    assert.equal(await pay.getByTestId('pay-amount').innerText(), `AED ${order.total}`);
    assert.ok(await pay.getByText(id!).first().isVisible());
    assert.deepEqual(await overflow(pay), [], '/pay: no sideways scroll');
    assert.ok(await tabTo(pay, (el) => el.tag === 'INPUT' && el.type === 'file'), 'the upload is reachable with Tab');
    await pay.locator('input[type=file]').setInputFiles({ name: 'transfer.png', mimeType: 'image/png', buffer: PNG });
    await pay.getByText('Thank you, we\'ll confirm your order once we see the transfer.').waitFor();
    await pay.getByText('Upload a different screenshot').waitFor();
    assert.deepEqual(await overflow(pay), [], '/pay after upload: no sideways scroll');
    assert.equal((await adminOrder(id!)).order.bankTransfer.state, 'uploaded');
    assert.deepEqual(errors, []);
    await ctx.close();

    // The owner's phone view of the hub: badge → screenshot → Payment received → reply link.
    const hub = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const hubErrors: string[] = [];
    hp.on('pageerror', (e) => hubErrors.push(e.message));
    hp.on('dialog', (d) => void d.accept());
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    await hp.getByRole('button', { name: /Transfer to check/ }).click();
    const panel = hp.getByTestId('bank-transfer').filter({ hasText: id! });
    await panel.getByTestId('bank-badge').filter({ hasText: 'Transfer screenshot received' }).waitFor();
    const shot = panel.getByRole('link', { name: 'View transfer screenshot' });
    const shotRes = await fetch(new URL((await shot.getAttribute('href'))!, server.base).href, { headers: { cookie } });
    assert.equal(shotRes.status, 200);
    assert.equal(shotRes.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await shotRes.arrayBuffer()), PNG);
    assert.equal((await rawFetch(new URL((await shot.getAttribute('href'))!, server.base).href)).status, 404, 'the screenshot is hub-only');
    const details = panel.getByRole('link', { name: 'Send bank details on WhatsApp' });
    const detailsText = new URL((await details.getAttribute('href'))!).searchParams.get('text')!;
    for (const s of [BANK.iban, `Reference: ${id}`, `AED ${order.total}`, `${server.base}${payPath}`]) assert.ok(detailsText.includes(s), s);
    await panel.getByText(`${server.base}${payPath}`).waitFor();
    assert.deepEqual(await overflow(hp), [], 'hub: no sideways scroll');
    await panel.getByRole('button', { name: 'Payment received' }).click();
    await panel.getByTestId('bank-badge').filter({ hasText: 'Payment received' }).waitFor();
    const reply = panel.getByRole('link', { name: 'Tell the customer on WhatsApp' });
    const digits = order.customer.phone.replace(/\D/g, '');
    assert.equal(await reply.getAttribute('href'), `https://wa.me/${digits}?text=${encodeURIComponent(`We've received your payment for order ${id}, thank you ✓`)}`);
    const done = await adminOrder(id!);
    assert.equal(done.order.bankTransfer.state, 'paid');
    assert.deepEqual(done.events.map((e) => e.event).filter((e) => e.startsWith('bank') || e.startsWith('transfer')), ['bank_link_made', 'transfer_uploaded', 'bank_paid']);
    assert.equal((await rawFetch(`${server.base}${payPath}`)).status, 404, 'the private page closes once paid');
    assert.deepEqual(hubErrors, []);
    await hub.close();
  });
}
