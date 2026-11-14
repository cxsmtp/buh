/**
 * The PDF invoice against the real build (BUH-02.32.00). The routes: the hub's (hidden without the
 * door, a session, the same origin, an allow-listed body; the PDF only once issued, never cached,
 * the browser's PDF viewer only); the customer's private PDF link (/invoice/<order>.<mac>/pdf: an
 * unissued invoice or a changed link is a 404). In Chromium at 375 and 1280 px: Settings → Store &
 * contact has the optional legal name and trade licence fields; a confirmed order's "Make invoice
 * (PDF)" gives its number, "Open PDF" and "Send on WhatsApp" with the private link. No sideways
 * scroll, no page errors. Skipped without a build.
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
async function order(confirm = true): Promise<{ id: string; documentPath: string }> {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Mariam Test', phone: `+97150882${String(++phoneN).padStart(4, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  const o = JSON.parse(text).order;
  if (confirm) assert.equal((await api('POST', `/api/admin/orders/${o.id}/whatsapp`, { result: 'confirmed' })).status, 200);
  return o;
}

test('the routes: the owner’s checked; the PDF only once issued; the customer’s private link', { skip }, async () => {
  const o = await order();
  const route = `/api/admin/orders/${o.id}/invoice-pdf`;
  assert.equal((await rawFetch(`${server.base}${route}`)).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}${route}`)).status, 401);
  assert.equal((await api('POST', route, { action: 'issue' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('POST', route, { action: 'issue', extra: 1 })).status, 400);
  assert.equal((await api('POST', route, { action: 'print' })).status, 400);
  assert.equal((await api('POST', route, JSON.stringify({ action: 'issue', pad: 'x'.repeat(400) }))).status, 413);
  assert.equal((await api('GET', route)).status, 404, 'not issued yet');
  const customerPdf = `${o.documentPath}/pdf`;
  assert.equal((await rawFetch(`${server.base}${customerPdf}`)).status, 404, 'not issued yet');
  const unconfirmed = await order(false);
  const early = await api('POST', `/api/admin/orders/${unconfirmed.id}/invoice-pdf`, { action: 'issue' });
  assert.equal(early.status, 409);
  const issued = await api('POST', route, { action: 'issue' });
  assert.equal(issued.status, 200);
  const { invoice } = await issued.json();
  assert.match(invoice.number, /^INV-\d{4}-\d{6}$/);
  const pdf = await api('GET', route);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition') ?? '', new RegExp(`Invoice-${invoice.number}\\.pdf`));
  assert.match(pdf.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(pdf.headers.get('content-security-policy'), "default-src 'none'; object-src 'self'; frame-ancestors 'none'");
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  const mine = await rawFetch(`${server.base}${customerPdf}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get('content-type'), 'application/pdf');
  assert.equal(mine.headers.get('referrer-policy'), 'no-referrer');
  assert.match(mine.headers.get('x-robots-tag') ?? '', /noindex/);
  assert.equal((await rawFetch(`${server.base}${customerPdf.replace(/\.[^./]+\/pdf$/, '.' + 'A'.repeat(43) + '/pdf')}`)).status, 404);
  // No email on the order: said so (409), the invoice stays.
  const mail = await api('POST', route, { action: 'email' });
  assert.equal(mail.status, 409);
  assert.equal((await mail.json()).invoice.number, invoice.number);
});

test('at 375 and 1280 px: the optional invoice fields; "Make invoice (PDF)", "Open PDF", "Send on WhatsApp" with the private link', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const o = await order();
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    // Settings → Store & contact: the optional fields.
    await openAdminSection(hp, /^Settings/);
    await hp.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Store & contact', exact: true }).click();
    const fields = hp.getByTestId('invoice-details');
    await fields.scrollIntoViewIfNeeded();
    await fields.getByLabel('Trade licence number').fill(`TL-${width}`);
    await fields.getByLabel('Issuing authority').fill('Dubai DET');
    assert.equal(await overflow(hp), false, `settings at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await fields.screenshot({ path: `${process.env.SHOTS}/invoice-fields-${width}.png` });
    // Orders: the confirmed order's invoice.
    await openAdminSection(hp, /^Orders/);
    // The fields save by themselves a moment after typing (and on leaving Settings): the invoice is
    // made once they are saved, or "Regenerate" below would rightly find something changed.
    await hp.waitForFunction(
      async (licence) => JSON.stringify(await fetch('/api/admin/settings', { credentials: 'same-origin' }).then((r) => r.json())).includes(licence),
      `TL-${width}`,
      { polling: 300, timeout: 20_000 }
    );
    const box = hp.locator('[data-testid="order-invoice"]').filter({ hasText: 'not made yet' }).first();
    await box.waitFor();
    const make = box.getByRole('button', { name: 'Make invoice (PDF)' });
    await make.focus();
    await hp.keyboard.press('Enter');
    const done = hp.locator('[data-testid="order-invoice"]').filter({ hasText: /Invoice INV-\d{4}-\d{6}/ }).first();
    await done.waitFor();
    const open = done.getByRole('link', { name: 'Open PDF' });
    assert.match((await open.getAttribute('href')) ?? '', /\/api\/admin\/orders\/BUH-[^/]+\/invoice-pdf$/);
    const wa = decodeURIComponent((await done.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href')) ?? '');
    assert.match(wa, /here is your invoice INV-\d{4}-\d{6} for order BUH-/);
    assert.match(wa, /\/invoice\/BUH-[A-Z0-9-]+\.[A-Za-z0-9_-]{43}\/pdf/);
    // "Regenerate": asks first; nothing changed since it was made, so it says so and keeps the number.
    const number = (await done.textContent())?.match(/INV-\d{4}-\d{6}/)?.[0];
    hp.once('dialog', (d) => void d.accept().catch(() => undefined));
    await done.getByTestId('invoice-regenerate').click();
    await done.getByText('Nothing changed: the invoice is already up to date.').waitFor();
    assert.ok(number && ((await done.textContent()) ?? '').includes(number));
    assert.equal(await overflow(hp), false, `orders at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await done.screenshot({ path: `${process.env.SHOTS}/invoice-hub-${width}.png` });
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
