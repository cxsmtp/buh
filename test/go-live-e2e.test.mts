/**
 * Go live against the real build (BUH-02.27.00): the route is hidden without the door, needs a
 * session and the same origin, reads an allow-listed body, wants the phrase GO LIVE and the hub
 * password every time (a wrong one removes nothing). In Chromium at 375 and 1280 px: Settings →
 * System & backups shows what would be removed, the button stays off until the phrase and the
 * password are typed, and pressing it removes the test order; no sideways scroll; the keyboard
 * reaches every control. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, setPhoneCheck, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

const EMAIL = 'admin@beautifuluaehome.com';
const PASSWORD = 'GoLive-Owner-Pass-1';

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  // Orders placed with a texted code (the checkout's other check needs WhatsApp).
  await setPhoneCheck(server, 'sms_code');
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const post = (p: string, body: unknown) => rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(body) });

let phoneN = 0;
async function placeOrder(): Promise<string> {
  const phone = `+97150770${String(++phoneN).padStart(4, '0')}`;
  const sent = await (await post('/api/otp/send', { phone })).json();
  const { verificationToken } = await (await post('/api/otp/verify', { phone, code: sent.devOtpCode })).json();
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    verificationToken,
    customer: { fullName: 'Layla Test', email: 'buyer@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order.id;
}
const orderCount = async () => ((await (await api('GET', '/api/admin/go-live')).json()) as { orders: number }).orders;
const auditText = () =>
  fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .map((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8'))
    .join('\n');

test('the Go live route: hidden, signed-in, same origin, allow-listed, the phrase and the password every time', { skip }, async () => {
  await placeOrder();
  // No door: the unknown address. No session: 401. Another site: 403.
  assert.equal((await rawFetch(`${server.base}/api/admin/go-live`)).status, 404);
  assert.equal((await fetch(`${server.base}/api/admin/go-live`)).status, 401);
  assert.equal((await api('POST', '/api/admin/go-live', { confirm: 'GO LIVE', currentPassword: PASSWORD }, { origin: 'https://evil.test' })).status, 403);
  // The body: only its three fields, the phrase exactly, a yes/no for the chats, not too big.
  assert.equal((await api('POST', '/api/admin/go-live', { confirm: 'GO LIVE', currentPassword: PASSWORD, extra: 1 })).status, 400);
  assert.equal((await api('POST', '/api/admin/go-live', { confirm: 'go live', currentPassword: PASSWORD })).status, 400);
  assert.equal((await api('POST', '/api/admin/go-live', { confirm: 'GO LIVE', currentPassword: PASSWORD, chats: 'yes' })).status, 400);
  assert.equal((await api('POST', '/api/admin/go-live', JSON.stringify({ confirm: 'GO LIVE', currentPassword: 'x'.repeat(2000) }))).status, 413);
  // A wrong password (or none): refused, nothing removed.
  const wrong = await api('POST', '/api/admin/go-live', { confirm: 'GO LIVE', currentPassword: 'not-the-password' });
  assert.ok([400, 401, 403].includes(wrong.status), String(wrong.status));
  assert.ok([400, 401, 403].includes((await api('POST', '/api/admin/go-live', { confirm: 'GO LIVE' })).status));
  assert.equal(await orderCount(), 1, 'nothing removed');
  assert.ok(!auditText().includes('shop.went_live'));
});

async function hub(page: Page) {
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'System & backups', exact: true }).click();
  const card = page.getByTestId('go-live');
  await card.waitFor();
  return card;
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test('Go live in the hub at 375 and 1280 px: the preview, the button off until the phrase and the password, the orders gone', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    await placeOrder();
    const before = await orderCount();
    assert.ok(before >= 1);
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, url: server.base }]);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const card = await hub(page);
    await card.scrollIntoViewIfNeeded();
    await assert.doesNotReject(card.getByTestId('go-live-preview').getByText(`${before} ${before === 1 ? 'order' : 'orders'} removed`).waitFor());
    const button = card.getByRole('button', { name: 'Go live: remove the test orders' });
    assert.equal(await button.isDisabled(), true, 'off until the phrase and the password');
    // The keyboard reaches the phrase, the password and the button.
    await card.getByLabel('Type GO LIVE to confirm').focus();
    await page.keyboard.type('GO LIVE');
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    assert.equal(await button.isDisabled(), false);
    assert.equal(await overflow(page), false, `no sideways scroll at ${width} px`);
    if (process.env.SHOTS) await card.screenshot({ path: path.join(process.env.SHOTS, `go-live-${width}.png`) });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await card.getByRole('status').filter({ hasText: /Done: \d+ orders? removed/ }).waitFor({ timeout: 30_000 });
    await card.getByTestId('go-live-last').waitFor();
    assert.equal(await orderCount(), 0);
    assert.equal(await overflow(page), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  assert.match(auditText(), /shop\.went_live/);
});
