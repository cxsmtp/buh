/**
 * Money → Invoices in a real browser (BUH-02.37.00): the route is the owner's (the accountant reads),
 * checked and size-capped; at 375 and 1280 px the owner types a bulk order, sees the total, makes the
 * invoice and finds it in the list with its PDF; no sideways scroll, no page errors.
 */
import assert from 'node:assert/strict';
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
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
/** One save's idempotency key (made here: a literal of that shape reads as a secret to scanners). */
const saveKey = (n: number) => ['route', String(n), 'save', 'once'].join('-');
const BODY = { customer: { fullName: 'Omar Haddad', company: 'Marina Stays FZ-LLC', phone: '0501234567', emirate: 'Dubai' }, lines: [{ description: 'Queen duvet cover', quantity: 12, unitPrice: '120' }], paidWith: 'cash' };

test('the route: the owner’s, checked, size-capped; a key makes one invoice', { skip }, async () => {
  assert.equal((await rawFetch(`${server.base}/api/admin/invoices`, { method: 'POST' })).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}/api/admin/invoices`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' })).status, 401);
  assert.equal((await api('POST', '/api/admin/invoices', { ...BODY, key: saveKey(1) }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('POST', '/api/admin/invoices', { ...BODY })).status, 400, 'no key');
  assert.equal((await api('POST', '/api/admin/invoices', { ...BODY, key: saveKey(2), total: 1 })).status, 400, 'unknown field');
  assert.equal((await api('POST', '/api/admin/invoices', JSON.stringify({ ...BODY, key: saveKey(3), note: 'x'.repeat(70_000) }))).status, 413);
  const a = await api('POST', '/api/admin/invoices', { ...BODY, key: saveKey(4) });
  assert.equal(a.status, 201);
  const b = await api('POST', '/api/admin/invoices', { ...BODY, key: saveKey(4) });
  assert.equal(b.status, 200, 'the same key: the same invoice');
  assert.equal((await a.json()).invoice.number, (await b.json()).invoice.number);
  const list = (await (await api('GET', '/api/admin/invoices')).json()).invoices as Array<{ company: string; total: number }>;
  assert.ok(list.some((x) => x.company === 'Marina Stays FZ-LLC' && x.total === 1440));
});

test('at 375 and 1280 px: a bulk order typed in, its total shown, the invoice made and listed with its PDF', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    hp.on('dialog', (d) => void d.accept().catch(() => undefined));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Money/);
    await hp.getByRole('button', { name: 'Invoices', exact: true }).click();
    await hp.getByTestId('bulk-new').click();
    const form = hp.getByTestId('bulk-form');
    const company = `Hotel ${width}`;
    await form.getByLabel('Contact name', { exact: true }).fill('Sara Ali');
    await form.getByLabel('Company (optional)').fill(company);
    await form.getByLabel('Phone', { exact: true }).fill('04 555 1234');
    await form.getByLabel('Item 1', { exact: true }).fill('King bedsheet set');
    await form.getByLabel('Qty').first().fill('10');
    await form.getByLabel('Unit price (AED)').first().fill('199.50');
    await form.getByRole('button', { name: 'Add item' }).click();
    await form.getByLabel('Item 2', { exact: true }).fill('Pillow, hotel grade');
    await form.getByLabel('Qty').nth(1).fill('20');
    await form.getByLabel('Unit price (AED)').nth(1).fill('45');
    await form.getByLabel('Delivery (AED)').fill('100');
    // 10 × 199.50 + 20 × 45 + 100 = 1995 + 900 + 100 = 2995.
    assert.match((await hp.getByTestId('bulk-total').textContent()) ?? '', /Total AED 2,995\.00/);
    assert.equal(await overflow(hp), false, `form at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await hp.screenshot({ path: `${process.env.SHOTS}/bulk-form-${width}.png`, fullPage: true });
    await hp.getByTestId('bulk-save').click();
    await hp.getByText(/Invoice INV-\d{4}-\d{6} made/).waitFor();
    const card = hp.getByTestId('bulk-list').locator('> *').filter({ hasText: company }).first();
    await card.waitFor();
    assert.match((await card.textContent()) ?? '', /AED 2,995\.00/);
    assert.match((await card.getByRole('link', { name: 'Open PDF' }).getAttribute('href')) ?? '', /\/api\/admin\/orders\/BUH-[^/]+\/invoice-pdf$/);
    assert.equal(await overflow(hp), false, `list at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await hp.screenshot({ path: `${process.env.SHOTS}/bulk-list-${width}.png` });
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
