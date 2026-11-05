/**
 * BUH-02.34.00 against the real build, in Chromium at 375 and 1280 px (no sideways scroll, no
 * page errors, the keyboard reaches the controls):
 *  - Couriers: a saved key shows its last 4 characters ("••••WXYZ saved"), never the key;
 *  - System & backups: the second backup place (S3, Backblaze B2, Cloudflare R2) card; a wrong
 *    endpoint is refused in plain words; its routes are the owner's (door, session, same origin);
 *  - Orders → Orders from a photo: the customer upload page's switches next to the deal links.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { fake, ownerPassword, wrongLogin } from './fixtures/fake.mjs';
const OWNER_PASSWORD = ownerPassword();

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;
const EMAIL = 'admin@beautifuluaehome.com';
// Built at run time: a key-shaped literal would trip secret scanners.
const JEEBLY_KEY = fake('jb_', 'live_', '9f8e7d6c5b4a3210WXYZ');

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
  assert.equal((await api('PUT', '/api/admin/settings/courier', { settings: { jeebly: { apiKey: JEEBLY_KEY } } })).status, 200);
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

test('the routes: the key hint, never the key; the backup place is the owner’s', { skip }, async () => {
  const all = await (await api('GET', '/api/admin/settings')).json();
  assert.equal(all.courier.secretsHint['jeebly.apiKey'], '••••WXYZ');
  assert.ok(!JSON.stringify(all).includes(JEEBLY_KEY));
  assert.equal((await rawFetch(`${server.base}/api/admin/backup/s3`)).status, 404, 'hidden without the door');
  assert.equal((await fetch(`${server.base}/api/admin/backup/s3`)).status, 401);
  assert.equal((await api('PUT', '/api/admin/backup/s3', { bucket: 'b-1' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await api('PUT', '/api/admin/backup/s3', { bucket: 'b-1', extra: 1 })).status, 400);
  assert.equal((await api('PUT', '/api/admin/backup/s3', JSON.stringify({ bucket: 'x'.repeat(5000) }))).status, 413);
  const t = await (await api('POST', '/api/admin/backup/s3/test', {})).json();
  assert.equal(t.ok, false, 'nothing saved yet: says what to enter');
});

test('at 375 and 1280 px: the key hint in Couriers; the backup place card; the upload page switches in Orders', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });

    await openAdminSection(hp, /^Settings/);
    const nav = hp.getByRole('navigation', { name: 'Settings sections' });
    await nav.getByRole('button', { name: 'Couriers', exact: true }).click();
    await hp.getByPlaceholder('••••WXYZ saved — leave blank to keep').first().waitFor();

    await nav.getByRole('button', { name: 'System & backups', exact: true }).click();
    const card = hp.getByTestId('s3-backup');
    await card.scrollIntoViewIfNeeded();
    await card.getByLabel('Endpoint', { exact: true }).fill('https://127.0.0.1');
    await card.getByLabel('Bucket', { exact: true }).fill('buh-backups');
    await card.getByRole('button', { name: /Save/ }).first().focus();
    await hp.keyboard.press('Enter');
    await card.getByTestId('s3-note').filter({ hasText: /public address|backup password|enter the endpoint/i }).waitFor();
    assert.equal(await overflow(hp), false, `backups at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await card.screenshot({ path: `${process.env.SHOTS}/s3-${width}.png` });

    await openAdminSection(hp, /^Orders/);
    const pageSettings = hp.getByTestId('photo-page-settings');
    await pageSettings.locator('summary').click();
    const on = pageSettings.getByLabel(/Take orders from the customer/);
    if (!(await on.isChecked())) await on.check();
    await pageSettings.getByTestId('photo-page-link').waitFor();
    assert.match(await pageSettings.getByTestId('photo-page-link').innerText(), /\/order-by-photo$/);
    await pageSettings.getByLabel(/Card payment on this page/).uncheck();
    await pageSettings.getByText('Saved.').waitFor();
    const store = (await (await api('GET', '/api/admin/settings')).json()).store.value;
    assert.equal(store.photoOrders, true);
    assert.equal(store.photoOrdersCard, false);
    await pageSettings.getByLabel(/Card payment on this page/).check();
    assert.equal(await overflow(hp), false, `orders at ${width}: no sideways scroll`);
    if (process.env.SHOTS) await hp.getByTestId('photo-deals').screenshot({ path: `${process.env.SHOTS}/photo-orders-${width}.png` });
    assert.deepEqual(errors, []);
    await hub.close();
  }
});
