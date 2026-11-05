/**
 * Money on delivery against the real build (BUH-02.33.00). The routes: "Extra to collect" goes
 * with the courier booking (checked on the server: 0–10,000 AED, fils); moving a paid order's money
 * to another order needs the door, a session, the same origin and an allow-listed body. In
 * Chromium at 375 and 1280 px: the booking box has "Extra to collect" (0 by default) and says what
 * the courier collects as it is typed; a paid bank-transfer order offers "Use it on another order",
 * which moves its money onto the customer's other order. No sideways scroll, no page errors.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';
const OWNER_PASSWORD = ownerPassword();

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;
const EMAIL = 'admin@beautifuluaehome.com';

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const res = await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877' } });
  assert.equal(res.status, 200, await res.text());
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const post = (p: string, body: unknown) => rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(body) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

let phoneN = 0;
async function order(paymentMethod: 'cod' | 'bank_transfer', phone = `+97150884${String(++phoneN).padStart(4, '0')}`): Promise<{ id: string; total: number }> {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Rohini R Nair', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod,
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const o = JSON.parse(text).order;
  assert.equal((await api('POST', `/api/admin/orders/${o.id}/whatsapp`, { result: 'confirmed' })).status, 200);
  return o;
}
const adminOrder = async (id: string) => ((await (await api('GET', '/api/admin/orders')).json()).orders as Array<{ id: string; total: number; status: string; courier: { codAmountCollected: number } }>).find((o) => o.id === id)!;

test('the routes: the extra goes with the booking (checked); moving money is the owner’s, allow-listed', { skip }, async () => {
  const o = await order('cod');
  const book = (extra: unknown) => api('POST', '/api/courier/dispatch', { orderId: o.id, provider: 'jeebly', testBooking: true, shipUnconfirmed: true, weightKg: 1, extraCharge: extra });
  assert.equal((await book(-5)).status, 400);
  assert.equal((await book(1.234)).status, 400);
  assert.equal((await book('25')).status, 400);
  const ok = await book(25);
  assert.equal(ok.status, 200, await ok.clone().text());
  const after = await adminOrder(o.id);
  assert.equal(after.total, Math.round((o.total + 25) * 100) / 100);
  assert.equal(after.courier.codAmountCollected, after.total);

  const bank = await order('bank_transfer');
  const route = `/api/admin/orders/${bank.id}/credit`;
  assert.equal((await rawFetch(`${server.base}${route}`, { method: 'POST' })).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' })).status, 401);
  assert.equal((await api('POST', route, { toOrderId: o.id, amount: 1 }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('POST', route, { toOrderId: o.id, amount: 1, extra: 1 })).status, 400);
  assert.equal((await api('POST', route, JSON.stringify({ toOrderId: o.id, amount: 1, pad: 'x'.repeat(400) }))).status, 413);
  const unpaid = await api('POST', route, { toOrderId: o.id, amount: 1 });
  assert.equal(unpaid.status, 409, 'not paid yet: nothing to move');
});

test('at 375 and 1280 px: "Extra to collect" in the booking box; a paid order’s money used on the customer’s other order', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const phone = `+97150885${String(width).padStart(4, '0')}`;
    const cod = await order('cod', phone);
    const bank = await order('bank_transfer', phone);
    assert.equal((await api('POST', `/api/admin/orders/${bank.id}/bank`, { result: 'received' })).status, 200);
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    hp.on('dialog', (d) => void d.accept().catch(() => undefined));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);

    // The paid bank order: its money onto the cash order (same customer, listed first).
    const credit = hp.getByTestId('order-credit').filter({ hasText: /can be used on another order/ }).first();
    await credit.waitFor();
    await credit.getByRole('button', { name: 'Use it on another order' }).click();
    const select = credit.getByLabel('Use it on');
    const firstOption = await select.locator('option').nth(1).innerText();
    assert.match(firstOption, new RegExp(`${cod.id} .*same customer`));
    await select.selectOption(cod.id);
    assert.equal(await credit.getByLabel('Amount (AED)').inputValue(), Math.min(bank.total, cod.total).toFixed(2));
    await credit.getByLabel('Amount (AED)').fill('10');
    assert.equal(await overflow(hp), false, `orders at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await credit.screenshot({ path: `${process.env.SHOTS}/credit-${width}.png` });
    await credit.getByRole('button', { name: 'Move' }).click();
    await hp.getByTestId('credit-history').filter({ hasText: `AED 10.00 moved to ${cod.id}` }).first().waitFor();
    const moved = await adminOrder(cod.id);
    assert.equal(moved.courier.codAmountCollected, Math.round((cod.total - 10) * 100) / 100);
    assert.equal((await adminOrder(bank.id)).status, 'cancelled');

    // The cash order's booking box: Extra to collect, 0 by default, and what the courier collects.
    const card = hp.locator('div').filter({ has: hp.getByText(cod.id, { exact: true }) }).filter({ has: hp.getByRole('button', { name: /Confirm & Assign Courier|Book courier/ }) }).last();
    await card.getByRole('button', { name: /Confirm & Assign Courier|Book courier/ }).first().click();
    const extra = hp.getByLabel('Extra to collect (AED)');
    await extra.waitFor();
    assert.equal(await extra.inputValue(), '0');
    const preview = hp.getByTestId('collect-preview');
    assert.match(await preview.innerText(), new RegExp(`collects AED ${(cod.total - 10).toFixed(2)}.*after AED 10\\.00 paid on ${bank.id}`));
    await extra.focus();
    await hp.keyboard.press('Control+A');
    await hp.keyboard.type('25');
    assert.match(await preview.innerText(), new RegExp(`collects AED ${(cod.total - 10 + 25).toFixed(2)}`));
    assert.equal(await overflow(hp), false, `booking box at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await hp.getByTestId('extra-charge').screenshot({ path: `${process.env.SHOTS}/extra-${width}.png` });
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
