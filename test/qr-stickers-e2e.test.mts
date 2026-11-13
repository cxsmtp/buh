/**
 * QR stickers and the scanner in the real build (BUH-02.43.00, asked by the owner): the routes are
 * the owner's and checked; the sticker PDF; a scan (a sticker's link or a typed stock code) shows the
 * item with its stock and the orders waiting for it; at 375 and 1280 px Inventory prints and scans,
 * and an order's "Scan to check" ticks matching pieces and flags others. The test browser has no
 * camera, so codes are typed in the scanner's box, as an owner can.
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
    customer: { fullName: 'Rohini R Nair', phone: `+97150884${String(++phoneN).padStart(4, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}



type Prod = { id: string; title: string; sku?: string; profiles: Array<{ id: string; name: string }> };
const products = async () => (await (await rawFetch(`${server.base}/api/products`)).json()).products as Prod[];
const codeOf = async (productId: string, sizeId: string) => {
  const r = await api('GET', `/api/admin/scan?code=${encodeURIComponent(`https://shop.test/p/${productId}?s=${sizeId}`)}`);
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.json()).item.code as string;
};

test('the routes: the owner’s, checked; the stickers PDF; a scan finds the item and the orders waiting for it', { skip }, async () => {
  for (const route of ['/api/admin/qr-stickers', '/api/admin/scan?code=x']) {
    assert.equal((await rawFetch(`${server.base}${route}`)).status, 404, `${route}: hidden without the door`);
    assert.equal((await fetch(`${server.base}${route}`)).status, 401, `${route}: no session`);
  }
  for (const q of ['copies=all', 'start=0', 'start=41', 'start=x', 'category=../x', 'ids=a/b', 'other=1']) assert.equal((await api('GET', `/api/admin/qr-stickers?${q}`)).status, 400, q);
  const pdf = await api('GET', '/api/admin/qr-stickers?copies=one&start=3');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await api('GET', '/api/admin/qr-stickers?ids=nope')).status, 409, 'nothing to print');

  const [p] = await products();
  const o = await order(); // the first product, its first size
  const byLink = await (await api('GET', `/api/admin/scan?code=${encodeURIComponent(`https://beautifuluaehome.com/p/${p.id}?s=${p.profiles[0].id}`)}`)).json();
  assert.equal(byLink.item.productId, p.id);
  assert.equal(byLink.item.sizeId, p.profiles[0].id);
  assert.equal(typeof byLink.item.stock, 'number');
  assert.ok(byLink.waiting.some((w: { orderId: string }) => w.orderId === o.id), 'the open order waiting for it');
  const byCode = await (await api('GET', `/api/admin/scan?code=${encodeURIComponent(byLink.item.code.toLowerCase())}`)).json();
  assert.deepEqual([byCode.item.productId, byCode.item.sizeId], [p.id, p.profiles[0].id], 'a typed code, any case');
  assert.equal((await api('GET', '/api/admin/scan?code=javascript:alert(1)')).status, 400);
  assert.equal((await api('GET', '/api/admin/scan?code=NO-SUCH-CODE-1')).status, 404);
  assert.equal((await api('GET', `/api/admin/scan?code=${encodeURIComponent(`/p/${p.id}?s=no-size`)}`)).status, 404);
});

test('at 375 and 1280 px: Inventory prints stickers and scans an item; an order’s "Scan to check" ticks its pieces and flags others', { skip: skip || skipBrowser }, async () => {
  const [p, other] = await products();
  const good = await codeOf(p.id, p.profiles[0].id);
  const wrong = await codeOf(other.id, other.profiles[0].id);
  for (const width of [375, 1280]) {
    const o = await order();
    assert.equal((await api('PATCH', `/api/admin/orders/${o.id}`, { status: 'confirmed', shipUnconfirmed: true })).status, 200);
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });

    // Inventory: the stickers and a scan.
    await openAdminSection(hp, /^Inventory/);
    const panel = hp.getByTestId('qr-panel');
    await panel.getByRole('button', { name: 'QR stickers' }).click();
    await hp.getByTestId('qr-copies').selectOption('one');
    await hp.getByTestId('qr-start').fill('5');
    assert.equal(await hp.getByTestId('qr-pdf').getAttribute('href'), '/api/admin/qr-stickers?copies=one&start=5');
    assert.equal(await overflow(hp), false, `inventory at ${width}: no sideways scroll`);
    await panel.getByRole('button', { name: 'Scan an item' }).click();
    const scanner = hp.getByTestId('qr-scanner');
    await scanner.waitFor();
    await scanner.getByLabel('Stock code').fill(good);
    await scanner.getByRole('button', { name: 'Find' }).click();
    const result = hp.getByTestId('scan-result');
    await result.waitFor();
    assert.match((await result.textContent()) ?? '', new RegExp(`${p.profiles[0].name.replace(/[()]/g, '.')}.*in stock`));
    assert.match((await result.textContent()) ?? '', new RegExp(o.id), 'the order waiting for it');
    assert.equal(await overflow(hp), false, `scan at ${width}: no sideways scroll`);

    // Orders: "Scan to check".
    await openAdminSection(hp, /^Orders/);
    const card = hp.locator('div.bg-surface.rounded-2xl').filter({ hasText: o.id }).first();
    await card.getByTestId('order-pack-check').click();
    const check = card.getByTestId('pack-check');
    await check.waitFor();
    await check.getByLabel('Stock code').fill(wrong);
    await check.getByRole('button', { name: 'Find' }).click();
    await check.getByTestId('pack-note').filter({ hasText: 'Not in this order' }).waitFor();
    await check.getByLabel('Stock code').fill(good);
    await check.getByRole('button', { name: 'Find' }).click();
    await check.getByTestId('pack-total').filter({ hasText: 'All 1 piece checked: ready to pack.' }).waitFor();
    await check.getByLabel('Stock code').fill(good);
    await check.getByRole('button', { name: 'Find' }).click();
    await check.getByTestId('pack-note').filter({ hasText: 'already checked' }).waitFor();
    assert.equal(await overflow(hp), false, `order check at ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
