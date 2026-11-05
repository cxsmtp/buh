/**
 * Edit an order before its label, and recreate a cancelled cash order, against the real build
 * (BUH-02.35.00). The routes are the owner's (door, session, same origin, size-capped, allow-listed).
 * In Chromium at 375 and 1280 px: "Edit order" opens a form with the customer and the lines;
 * saving changes the address and a price on the order; "Recreate order" on a cancelled cash order
 * makes a new confirmed one. No sideways scroll, no page errors.
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
  assert.equal((await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877' } })).status, 200);
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
const adminOrders = async () => (await (await api('GET', '/api/admin/orders')).json()).orders as Array<{ id: string; status: string; total: number; recreatedFrom?: string; customer: { area: string }; items: Array<{ unitPrice: number }> }>;

let phoneN = 0;
async function order(): Promise<{ id: string; total: number }> {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Rohini R Nair', phone: `+97150887${String(++phoneN).padStart(4, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}

test('the routes: the owner’s, checked', { skip }, async () => {
  const o = await order();
  const details = `/api/admin/orders/${o.id}/details`;
  assert.equal((await rawFetch(`${server.base}${details}`, { method: 'POST' })).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}${details}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' })).status, 401);
  assert.equal((await api('POST', details, { customer: { area: 'JLT' } }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('POST', details, { total: 1 })).status, 400);
  assert.equal((await api('POST', details, JSON.stringify({ customer: { area: 'x'.repeat(20_000) } }))).status, 413);
  assert.equal((await api('POST', details, { customer: { area: 'JLT' } })).status, 200);
  const recreate = `/api/admin/orders/${o.id}/recreate`;
  assert.equal((await api('POST', recreate, { x: 1 })).status, 400);
  assert.equal((await api('POST', recreate, {})).status, 409, 'not cancelled');
});

test('at 375 and 1280 px: "Edit order" changes the address and a price; "Recreate order" makes a new one', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const o = await order();
    const c = await order();
    assert.equal((await api('PATCH', `/api/admin/orders/${c.id}`, { status: 'cancelled' })).status, 200);
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    hp.on('dialog', (d) => void d.accept());
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);

    const card = hp.locator('[data-testid="order-edit-actions"]').filter({ has: hp.getByRole('button', { name: 'Edit order' }) });
    await card.first().waitFor();
    // The newest order (this round's) is first.
    const editBtn = hp.getByRole('button', { name: 'Edit order' }).first();
    await editBtn.click();
    const form = hp.getByTestId('order-edit');
    await form.waitFor();
    const heading = await form.getByRole('heading').innerText();
    const id = heading.match(/BUH-[A-Z0-9-]+/)![0];
    await form.getByLabel('Area').fill(`Area ${width}`);
    await form.getByLabel('Unit AED').first().fill('199.5');
    assert.equal(await overflow(hp), false, `edit form at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await form.screenshot({ path: `${process.env.SHOTS}/edit-${width}.png` });
    await form.getByRole('button', { name: 'Save changes' }).click();
    await form.waitFor({ state: 'detached' });
    const edited = (await adminOrders()).find((x) => x.id === id)!;
    assert.equal(edited.customer.area, `Area ${width}`);
    assert.equal(edited.items[0].unitPrice, 199.5);
    void o;

    // Recreate the cancelled one.
    await hp.getByRole('button', { name: 'Recreate order' }).first().click();
    let made: { id: string } | undefined;
    for (let i = 0; i < 50 && !(made = (await adminOrders()).find((x) => x.recreatedFrom === c.id)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(made, 'a new order from the cancelled one');
    assert.equal((await adminOrders()).find((x) => x.id === made!.id)!.status, 'confirmed');
    assert.equal(await overflow(hp), false);
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
