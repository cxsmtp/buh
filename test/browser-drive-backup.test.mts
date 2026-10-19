/**
 * Settings → System & backups → "Copy each backup to Google Drive" against the production build,
 * with Google replaced by a stand-in on 127.0.0.1 (BUH_TEST_GOOGLE_API, loopback only):
 * - the routes: hidden from strangers, sign-in required, allow-listed fields, the key never in a
 *   reply or the server's log, Test connection, and "Back up now" copying to Drive;
 * - in Chromium at 375 px and 1280 px: the card (the key shown as the service account's email),
 *   Test connection from the keyboard, the last copy in the card and in the status line, a failed
 *   copy shown; no sideways scroll, no page errors.
 * Screenshots go to BUH_SHOTS_DIR when it is set. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { makeServiceAccount, startGoogleMock, type GoogleMock } from './google-drive-mock.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const SHOTS = process.env.BUH_SHOTS_DIR || '';
const FOLDER = '1BuhBackupsFolder_abcdefghijklmn';
const sa = makeServiceAccount('shop-backups@buh-shop-4821.iam.gserviceaccount.com');

let google: GoogleMock;
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  google = await startGoogleMock(sa);
  server = await startServer({ BUH_TEST_GOOGLE_API: google.url, BACKUP_PASSPHRASE: 'correct horse battery staple' });
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Drive-Backup-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.stop();
  await google?.close();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

test('the Drive routes: hidden from strangers, sign-in required, allow-listed; the key never returned or logged; Back up now copies to Drive', { skip }, async () => {
  assert.equal((await rawFetch(`${server.base}/api/admin/backup/drive`)).status, 404);
  assert.equal((await rawFetch(`${server.base}/api/admin/backup/drive/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await api('GET', '/api/admin/backup/drive', undefined, { cookie: '' })).status, 401);
  const off = await (await api('GET', '/api/admin/backup/drive')).json();
  assert.equal(off.enabled, false);
  assert.equal(off.passphraseSet, true);
  assert.equal((await api('PUT', '/api/admin/backup/drive', { enabled: true, sneaky: 1 })).status, 400);
  assert.equal((await api('PUT', '/api/admin/backup/drive', { enabled: true, folderId: FOLDER })).status, 400, 'no key yet');
  assert.equal((await api('PUT', '/api/admin/backup/drive', { folderId: 'https://evil.example/drive/folders/1abcdefghijk' })).status, 400);

  const test = await api('POST', '/api/admin/backup/drive/test', { serviceAccountKey: sa.json, folderId: `https://drive.google.com/drive/folders/${FOLDER}` });
  const testText = await test.text();
  assert.equal(test.status, 200, testText);
  assert.ok(!testText.includes('PRIVATE'));

  const saved = await api('PUT', '/api/admin/backup/drive', { enabled: true, folderId: `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`, keep: 30, serviceAccountKey: sa.json });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText);
  assert.ok(!savedText.includes('PRIVATE') && !savedText.includes('MII'));
  const s = JSON.parse(savedText);
  assert.equal(s.clientEmail, sa.email);
  assert.equal(s.folderId, FOLDER);
  assert.equal(s.keySaved, true);

  const run = await api('POST', '/api/admin/backup', {});
  const runBody = await run.json();
  assert.equal(run.status, 200);
  assert.ok(runBody.lastSuccessAt);
  assert.ok(runBody.drive.lastSuccessAt, JSON.stringify(runBody.drive));
  assert.equal(runBody.drive.level, 'ok');
  assert.equal([...google.files.values()].filter((f) => f.parents.includes(FOLDER) && f.name.endsWith('.tar.gz.enc')).length, 1);
  assert.ok(!/MII|PRIVATE KEY|ya29\.mock/.test(server.log()), 'no key or token in the log');
});

async function hub(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.getByRole('status').filter({ hasText: /Backup/ }).first().waitFor();
  return { ctx, page, errors };
}
async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}
async function openSettings(page: Page, section: string) {
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
  await page.getByRole('heading', { name: section, exact: true, level: 2 }).waitFor();
}

for (const width of [375, 1280]) {
  test(`Settings → System & backups → Google Drive at ${width}px: key as its email, Test connection by keyboard, the last copy`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    // The status line at the top says when the last copy reached Drive.
    await page.getByTestId('backup-drive').first().filter({ hasText: /Copied to Google Drive/ }).waitFor();
    await openSettings(page, 'System & backups');
    const card = page.getByTestId('drive-backup-card');
    await card.waitFor();
    assert.match(await card.getByTestId('drive-key-saved').innerText(), new RegExp(sa.email.replace(/\./g, '\\.')));
    assert.equal(await card.getByLabel('Service account key (JSON)').inputValue(), '', 'the key is never sent back');
    assert.equal(await card.getByLabel('Shared drive folder link or id').inputValue(), FOLDER);
    assert.equal(await card.getByLabel('Copies to keep').inputValue(), '30');
    assert.ok(await card.getByRole('checkbox', { name: 'Copy each backup to Google Drive' }).isChecked());
    assert.match(await card.getByTestId('drive-last-copy').innerText(), /Last copy .*[KM]B \(1 in Drive\)/);
    // Keyboard: Test connection.
    await card.getByRole('button', { name: 'Test connection' }).focus();
    await page.keyboard.press('Enter');
    await card.getByTestId('drive-message').filter({ hasText: /^Connected/ }).waitFor();
    assert.deepEqual(await overflow(page), []);
    await card.scrollIntoViewIfNeeded();
    if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `drive-card-${width}.png`) });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `drive-settings-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('a failed copy shows in the card and the status line, the local backup still green-dated', { skip }, async () => {
  google.failStart = { status: 403, reason: 'storageQuotaExceeded', message: 'Service Accounts do not have storage quota.' };
  const run = await (await api('POST', '/api/admin/backup', {})).json();
  assert.ok(run.lastSuccessAt && !run.lastError, 'the local backup succeeded');
  assert.equal(run.drive.level, 'failing');
  for (const width of [375, 1280]) {
    const { ctx, page, errors } = await hub(width);
    await page.getByTestId('backup-drive').first().filter({ hasText: /Google Drive copy failed: Google does not let a service account/ }).waitFor();
    await openSettings(page, 'System & backups');
    const card = page.getByTestId('drive-backup-card');
    await card.getByTestId('drive-last-copy').filter({ hasText: /Last copy failed: .*shared drive/ }).waitFor();
    assert.deepEqual(await overflow(page), []);
    if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `drive-card-failed-${width}.png`) });
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
