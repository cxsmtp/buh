/**
 * Shipping labels as a PDF in the real build (BUH-02.39.00): the route is the owner's and checked
 * (door, session, origin, allow-list, size cap, paper); it returns an A4 PDF with two labels a sheet;
 * at 375 and 1280 px the label window links the PDF and offers "Email to printer" once a printer
 * address is saved; the orders list offers every waiting label at once; no sideways scroll.
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
    customer: { fullName: 'Rohini R Nair', phone: `+97150886${String(++phoneN).padStart(4, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}


async function bookedOrder(awb: string): Promise<{ id: string }> {
  const o = await order();
  assert.equal((await api('PATCH', `/api/admin/orders/${o.id}`, { status: 'confirmed', shipUnconfirmed: true })).status, 200);
  const t = await api('POST', `/api/admin/orders/${o.id}/tracking`, { carrier: 'jeebly', awb });
  assert.equal(t.status, 200, await t.clone().text());
  return o;
}

test('the route: the owner’s, checked; an A4 PDF with two labels a sheet', { skip }, async () => {
  const a = await bookedOrder('JB-55001001');
  const b = await bookedOrder('JB-55001002');
  const url = `/api/admin/labels?ids=${a.id},${b.id}&paper=a4`;
  assert.equal((await rawFetch(`${server.base}${url}`)).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}${url}`)).status, 401);
  assert.equal((await api('POST', '/api/admin/labels', { ids: [a.id] }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('GET', `/api/admin/labels?ids=${a.id}&paper=letter`)).status, 400);
  assert.equal((await api('GET', '/api/admin/labels?ids=../x')).status, 400);
  assert.equal((await api('POST', '/api/admin/labels', { ids: [a.id], to: 'someone@evil.test' })).status, 400, 'allow-list: no address from the browser');
  assert.equal((await api('POST', '/api/admin/labels', JSON.stringify({ ids: ['x'.repeat(6000)] }))).status, 413);
  assert.equal((await api('POST', '/api/admin/labels', { ids: [a.id] })).status, 409, 'no printer address yet');
  const res = await api('GET', url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const pdf = Buffer.from(await res.arrayBuffer()).toString('latin1');
  assert.deepEqual([...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [m[1], m[2]]), [['841.89', '595.28']], 'one A4 landscape sheet');
  const all = await api('GET', '/api/admin/labels?paper=a5');
  assert.equal(all.status, 200, 'every waiting label');
});

test('asked: A5 stays for home, A4 offered as well for away; at 375 and 1280 px: both PDFs, Email A4 to printer, all labels at once', { skip: skip || skipBrowser }, async () => {
  assert.equal((await api('PUT', '/api/admin/settings/courier', { settings: { printerEmail: 'printer@print.example.com' } })).status, 200);
  for (const width of [375, 1280]) {
    const o = await bookedOrder(`JB-5500${width}`);
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    const said: string[] = [];
    hp.on('dialog', (d) => {
      said.push(d.message());
      void d.accept().catch(() => undefined);
    });
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const batch = hp.getByTestId('batch-labels-pdf');
    await batch.waitFor();
    assert.equal(await batch.getAttribute('href'), '/api/admin/labels?paper=a4');
    assert.match((await batch.textContent()) ?? '', /A4 PDF \(2 per sheet\)/);
    assert.equal(await hp.getByTestId('batch-labels-home').getAttribute('href'), '/api/admin/labels?paper=a5', 'home: A5 kept');
    await hp.getByTestId('batch-labels-email').waitFor();
    assert.equal(await overflow(hp), false, `orders at ${width}: no sideways scroll`);
    await hp.getByRole('button', { name: /^Print label$/ }).first().click();
    const pdfLink = hp.getByTestId('label-pdf');
    await pdfLink.waitFor();
    assert.equal(await pdfLink.getAttribute('href'), `/api/admin/labels?ids=${encodeURIComponent(o.id)}&paper=a5`, 'home: A5 kept');
    assert.match((await hp.getByRole('dialog').getByRole('button', { name: /Print .*\(A5\)/ }).textContent()) ?? '', /A5/, 'the A5 print button stays');
    const href = (await hp.getByTestId('label-pdf-a4').getAttribute('href')) ?? '';
    assert.equal(href, `/api/admin/labels?ids=${encodeURIComponent(o.id)}&paper=a4`, 'away: A4 as well');
    const got = await hp.evaluate(async (u) => {
      const r = await fetch(u);
      return [r.status, r.headers.get('content-type')];
    }, href);
    assert.deepEqual(got, [200, 'application/pdf']);
    await hp.getByTestId('label-to-printer').click();
    const note = hp.getByRole('status').filter({ hasText: /Sent to|Email is not set up/ });
    await note.waitFor();
    assert.match((await note.textContent()) ?? '', /Email is not set up/, 'no mail server here: told so, nothing claimed');
    assert.equal(await overflow(hp), false, `label at ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
