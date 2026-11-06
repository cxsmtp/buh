/**
 * "Handed over in person" in a real browser (BUH-02.38.00): the route is the owner's and checked;
 * at 375 and 1280 px the button asks first, then the order shows delivered with its badge and the
 * cash taken; no courier is booked; no sideways scroll, no page errors.
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

test('the route: the owner’s, checked', { skip }, async () => {
  const o = await order();
  const route = `/api/admin/orders/${o.id}/handover`;
  assert.equal((await rawFetch(`${server.base}${route}`, { method: 'POST' })).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' })).status, 401);
  assert.equal((await api('POST', route, {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('POST', route, { status: 'delivered' })).status, 400);
  assert.equal((await api('POST', route, JSON.stringify({ note: 'x'.repeat(5000) }))).status, 413);
  const ok = await api('POST', route, { cashReceived: true });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).order.status, 'delivered');
});

test('at 375 and 1280 px: "Handed over in person" asks, then the order is delivered with the cash taken', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const o = await order();
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    const asked: string[] = [];
    hp.on('dialog', (d) => {
      asked.push(d.message());
      void d.accept().catch(() => undefined);
    });
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    // The newest order (this round's) is first.
    await hp.getByTestId('order-handover').first().click();
    await hp.getByTestId('handed-over-badge').first().waitFor();
    assert.match(asked[0] ?? '', new RegExp(`${o.id}: handed over to the customer in person and AED ${o.total.toFixed(2)} cash received`));
    assert.match((await hp.getByTestId('handed-over-badge').first().textContent()) ?? '', new RegExp(`AED ${o.total.toFixed(2)} cash`));
    const saved = (await (await api('GET', '/api/admin/orders')).json()).orders.find((x: { id: string }) => x.id === o.id);
    assert.deepEqual([saved.status, saved.paymentStatus, saved.courier.awbNumber], ['delivered', 'paid', '']);
    assert.equal(await overflow(hp), false, `orders at ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
