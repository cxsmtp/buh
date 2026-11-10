/**
 * The Orders page, asked by the owner (BUH-02.40.00), in a real browser at 375 and 1280 px:
 * "Handed over in person" also on an order booked with the courier (the booking is cancelled first;
 * here Jeebly can't be reached, so the owner confirms they cancelled it in the portal); every action
 * of an order in one compact wrapping line; only the latest 3 photo deal links on top, all of them
 * (and the orders from a photo) under the Photo orders tab; a link edited until it is ordered.
 * No sideways scroll, no page errors.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
    customer: { fullName: 'Rohini R Nair', phone: `+97150885${String(++phoneN).padStart(4, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}


const PNG = `data:image/png;base64,${fs.readFileSync('test/fixtures/sheet-indigo.png').toString('base64')}`;
let dealN = 0;
async function deal(): Promise<{ id: string }> {
  const res = await api('POST', '/api/admin/deals', { photos: [PNG], note: `Deal ${++dealN}`, forWhom: `Customer ${dealN}`, pieces: 1, amount: 300 + dealN, payments: ['cod'] });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).deal;
}

test('the deal edit route: the owner’s, checked', { skip }, async () => {
  const d = await deal();
  const url = `/api/admin/deals/${d.id}`;
  assert.equal((await fetch(`${server.base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' })).status, 401);
  assert.equal((await api('PATCH', url, { amount: 10 }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('PATCH', url, { amount: 10, orderId: 'x' })).status, 400);
  const ok = await api('PATCH', url, { amount: 299 });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).deal.amount, 299);
});

test('at 375 and 1280 px: handed over though booked; one line of actions; latest 3 deals, the rest under Photo orders; Edit a link', { skip: skip || skipBrowser }, async () => {
  for (let i = 0; i < 4; i++) await deal();
  for (const width of [375, 1280]) {
    const o = await order();
    assert.equal((await api('PATCH', `/api/admin/orders/${o.id}`, { status: 'confirmed', shipUnconfirmed: true })).status, 200);
    const t = await api('POST', `/api/admin/orders/${o.id}/tracking`, { carrier: 'jeebly', awb: `JB-66${width}` });
    assert.equal(t.status, 200, await t.clone().text());
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

    // Latest 3 deal links on top, the rest under Photo orders.
    const list = hp.getByTestId('deal-list');
    await list.waitFor();
    assert.equal(await list.locator('li').count(), 3, 'only the latest 3');
    // The booked order: one line of actions (at 1280), "Handed over in person" there too.
    const card = hp.locator('div.bg-surface.rounded-2xl').filter({ hasText: o.id }).first();
    const actions = card.getByTestId('order-actions');
    await actions.waitFor();
    if (width >= 1280) {
      const tops = await actions.locator(':scope > button, :scope > a, :scope > span').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().top)))]);
      assert.ok(tops.length <= 2, `actions in one line (two at most), got ${tops.length} rows`);
    }
    for (const label of ['Receipt / invoice', 'WhatsApp Customer', 'Cancel order', 'Handed over in person']) {
      assert.equal(await actions.getByRole('button', { name: label }).or(actions.getByRole('link', { name: label })).count(), 1, label);
    }
    assert.equal(await overflow(hp), false, `orders at ${width}: no sideways scroll`);
    await actions.getByRole('button', { name: 'Handed over in person' }).click();
    await card.getByTestId('handed-over-badge').waitFor();
    assert.match(asked[0] ?? '', /Jeebly booking \(AWB JB-66\d+\) is cancelled with Jeebly first/);
    assert.match(asked.at(-1) ?? '', /Did you cancel it in the courier's portal yourself\?/, 'Jeebly not reachable here: the owner confirms');
    const saved = (await (await api('GET', '/api/admin/orders')).json()).orders.find((x: { id: string }) => x.id === o.id);
    assert.equal(saved.status, 'delivered');

    // Photo orders tab: every link; Edit one.
    await hp.getByTestId('deal-see-all').click();
    await hp.getByRole('button', { name: /^Photo orders/ }).waitFor();
    await hp.waitForFunction(() => document.querySelectorAll('[data-testid="deal-list"] li').length >= 4);
    const first = hp.getByTestId('deal-list').locator('li').first();
    await first.getByTestId('deal-edit').click();
    await hp.getByTestId('deal-editing').waitFor();
    const price = hp.getByLabel('Price with delivery (AED)');
    await price.fill(String(400 + width));
    await hp.getByRole('button', { name: 'Save changes' }).click();
    await hp.getByTestId('deal-made').waitFor();
    assert.match((await hp.getByTestId('deal-made').textContent()) ?? '', new RegExp(`AED ${400 + width}`));
    assert.match((await hp.getByTestId('deal-list').locator('li').first().textContent()) ?? '', new RegExp(`AED ${400 + width}`));
    assert.equal(await overflow(hp), false, `photo orders at ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
