/**
 * "Protect backups with a password" and the easy Google Drive setup, against the production build
 * with Google replaced by a stand-in on 127.0.0.1 (BUH_TEST_GOOGLE_API), and no BACKUP_PASSPHRASE:
 * - the route: hidden from strangers, sign-in and same-origin required, allow-listed; generate (the
 *   only reply with the password, no-store), confirm, set, change (the hub password again, a wrong
 *   one refused); audited without the value; never in a reply, the log or the audit log;
 * - in Chromium at 375 px and 1280 px: the card (make one, copy, download, tick, use it; then change
 *   it), the Drive card's "Make a password first", the setup wizard (links into the project, ticks
 *   kept after a reload), Google's client file read into the fields, the connect code view (large,
 *   Copy, Open google.com/device), "Connected to …" and the first copy. No sideways scroll, keyboard
 *   works, no page errors.
 * Screenshots go to BUH_SHOTS_DIR when it is set. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { makeServiceAccount, OAUTH_CLIENT, startGoogleMock, type GoogleMock } from './google-drive-mock.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const SHOTS = process.env.BUH_SHOTS_DIR || '';
const PASSWORD = 'Backup-Password-Owner-Pass-1';

let google: GoogleMock;
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
/** Every backup password this test saw (none may reach the log, the audit log or another reply). */
const seen: string[] = [];

before(async () => {
  if (skip) return;
  google = await startGoogleMock(makeServiceAccount());
  google.deviceInterval = 1;
  server = await startServer({ BUH_TEST_GOOGLE_API: google.url });
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: PASSWORD }) });
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
const auditText = () =>
  fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .map((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8'))
    .join('\n');

async function hub(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.base });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.getByRole('status').filter({ hasText: /Backup/ }).first().waitFor();
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'System & backups', exact: true }).click();
  await page.getByRole('heading', { name: 'System & backups', exact: true, level: 2 }).waitFor();
  return { ctx, page, errors };
}
async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}
const shot = async (loc: import('playwright').Locator, name: string) => {
  if (!SHOTS) return;
  await loc.scrollIntoViewIfNeeded();
  await loc.screenshot({ path: path.join(SHOTS, name) });
};

test('the password route: hidden, sign-in and same origin required, allow-listed; nothing to change on a fresh shop', { skip }, async () => {
  assert.equal((await rawFetch(`${server.base}/api/admin/backup/passphrase`)).status, 404, 'hidden without the door');
  assert.equal((await api('GET', '/api/admin/backup/passphrase', undefined, { cookie: '' })).status, 401);
  const st = await api('GET', '/api/admin/backup/passphrase');
  assert.equal(st.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await st.json(), { source: 'none', encrypted: false, short: false, earlier: [], minLength: 12 });
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'generate' }, { origin: 'https://evil.example' })).status, 403, 'cross-site refused');
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'generate', passphrase: 'x' })).status, 400, 'allow-listed per action');
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'set', passphrase: 'short', repeat: 'short' })).status, 400);
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'confirm', fingerprint: 'abcdef012345' })).status, 409, 'nothing made yet');
  const big = await api('POST', '/api/admin/backup/passphrase', { action: 'set', passphrase: 'x'.repeat(4000), repeat: 'x' });
  assert.equal(big.status, 413, 'size-capped');
  // The backup health alert points to the card, no server setting named.
  const health = await (await api('GET', '/api/admin/backup')).json();
  assert.equal(health.encrypted, false);
});

for (const width of [375, 1280]) {
  test(`the password card at ${width}px: ${width === 375 ? 'make one, copy, download, tick, use it' : 'change it (the hub password again), older backups still need the old one'}`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    const card = page.getByTestId('backup-password-card');
    await card.waitFor();
    if (width === 375) {
      assert.match(await card.getByTestId('backup-password-status').innerText(), /Not protected: anyone with a backup email can read customers’ details\./);
      // The Drive card offers it too.
      const driveCard = page.getByTestId('drive-backup-card');
      await driveCard.getByTestId('drive-needs-password').getByRole('button', { name: 'Make a password first' }).waitFor();
      await shot(card, `password-card-none-${width}.png`);
      await shot(driveCard.getByTestId('drive-needs-password'), `drive-needs-password-${width}.png`);
    } else {
      assert.match(await card.getByTestId('backup-password-status').innerText(), /Backups are encrypted ✓ Password set on/);
      await card.getByRole('button', { name: 'Change the password' }).click();
      await card.getByRole('note').filter({ hasText: 'Backups made before today still need the old password.' }).waitFor();
    }
    // Make one for me, by keyboard.
    await card.getByRole('button', { name: 'Make one for me' }).focus();
    await page.keyboard.press('Enter');
    const made = card.getByTestId('password-made');
    await made.waitFor();
    const pass = (await made.getByTestId('password-made-text').innerText()).trim();
    assert.match(pass, /^([a-z]+-){6}\d{2}$/);
    seen.push(pass);
    await made.getByRole('button', { name: 'Copy' }).click();
    await made.getByRole('button', { name: 'Copied' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), pass);
    const [download] = await Promise.all([page.waitForEvent('download'), made.getByRole('button', { name: 'Download as a text file' }).click()]);
    assert.equal(download.suggestedFilename(), 'beautiful-uae-home-backup-password.txt');
    const saved = path.join(os.tmpdir(), `buh-pw-dl-${Date.now()}.txt`);
    await download.saveAs(saved);
    assert.ok(fs.readFileSync(saved, 'utf8').includes(pass));
    fs.rmSync(saved);
    const use = made.getByRole('button', { name: 'Use this password' });
    assert.equal(await use.isDisabled(), true, 'not before the tick');
    assert.deepEqual(await overflow(page), []);
    await shot(made, `password-made-${width}.png`);
    // The tick by keyboard.
    await made.getByRole('checkbox', { name: /I saved it in my password manager/ }).focus();
    await page.keyboard.press('Space');
    if (width === 1280) {
      assert.equal(await use.isDisabled(), true, 'the hub password first');
      await made.getByLabel('Your hub password (to change it)').fill('not my password');
      await use.click();
      await card.getByTestId('password-error').filter({ hasText: /not your current password/ }).waitFor();
      await made.getByLabel('Your hub password (to change it)').fill(PASSWORD);
    }
    await use.click();
    await card.getByTestId('backup-password-message').filter({ hasText: width === 375 ? /^Saved\. From now on every backup is encrypted/ : /^Changed\. New backups use the new password; older ones still need the old one\./ }).waitFor();
    assert.match(await card.getByTestId('backup-password-status').innerText(), /Backups are encrypted ✓ Password set on .*\(made for you\)/);
    // Never shown again.
    assert.ok(!(await page.content()).includes(pass));
    if (width === 1280) {
      await card.getByTestId('backup-password-earlier').getByText('Earlier passwords (1)').click();
      assert.match(await card.getByTestId('backup-password-earlier').innerText(), /backups from then still need it/);
    }
    // The Drive card no longer asks for one; the status line drops the "unencrypted" alert.
    await page.getByTestId('drive-backup-card').getByTestId('drive-needs-password').waitFor({ state: 'detached' });
    assert.deepEqual(await overflow(page), []);
    await shot(card, `password-card-set-${width}.png`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('the routes by hand: set refused once one exists, change needs the hub password, typed twice; all audited, the password nowhere else', { skip }, async () => {
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'set', passphrase: 'mango-harbour-velvet', repeat: 'mango-harbour-velvet' })).status, 409);
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'change', passphrase: 'mango-harbour-velvet', repeat: 'mango-harbour-velvet' })).status, 400, 'no hub password');
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'change', passphrase: 'mango-harbour-velvet', repeat: 'mango-harbour-velvet', currentPassword: 'wrong' })).status, 400);
  assert.equal((await api('POST', '/api/admin/backup/passphrase', { action: 'change', passphrase: 'mango-harbour-velvet', repeat: 'mango-harbour-velvez', currentPassword: PASSWORD })).status, 400, 'not the same twice');
  const ok = await api('POST', '/api/admin/backup/passphrase', { action: 'change', passphrase: 'mango-harbour-velvet', repeat: 'mango-harbour-velvet', currentPassword: PASSWORD });
  const okText = await ok.text();
  assert.equal(ok.status, 200, okText);
  seen.push('mango-harbour-velvet');
  const body = JSON.parse(okText);
  assert.equal(body.changed, true);
  assert.equal(body.status.how, 'typed');
  assert.equal(body.status.earlier.length, 2);
  for (const p of seen) assert.ok(!okText.includes(p), 'not in the reply');
  // A backup now is encrypted with it.
  const run = await (await api('POST', '/api/admin/backup', {})).json();
  assert.equal(run.encrypted, true);
  assert.match(run.lastFile, /\.tar\.gz\.enc$/);
  // The file: owner-only, never in the backup.
  const file = path.join(server.dataDir, 'backup-secret.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(path.join(server.dataDir, 'backups', run.lastFile));
  for (const p of seen) assert.ok(!raw.includes(Buffer.from(p)));
  // Audited (set once, changed twice), never the value; never in the log.
  const audit = auditText();
  assert.equal((audit.match(/backup\.passphrase_set/g) ?? []).length, 1);
  assert.equal((audit.match(/backup\.passphrase_changed/g) ?? []).length, 2);
  const log = server.log();
  for (const p of seen) {
    assert.ok(!audit.includes(p), 'audit');
    assert.ok(!log.includes(p), 'log');
  }
  const status = await (await api('GET', '/api/admin/backup/passphrase')).text();
  for (const p of seen) assert.ok(!status.includes(p));
});

for (const width of [375, 1280]) {
  test(`Google Drive at ${width}px: the setup wizard (ticks kept), the client file, the code to enter, connected and the first copy`, { skip }, async () => {
    const first = width === 375;
    let { ctx, page, errors } = await hub(width);
    let card = page.getByTestId('drive-backup-card');
    if (first) {
      const wizard = card.getByTestId('drive-wizard');
      await wizard.waitFor();
      assert.equal(await wizard.getByTestId('drive-wizard-progress').innerText(), '0 of 4 done');
      assert.equal(await wizard.getByRole('link', { name: 'Open this page' }).first().getAttribute('href'), 'https://console.cloud.google.com/projectcreate');
      // The project id makes the next links open in the project.
      await wizard.getByLabel(/Project ID/).fill('beautiful-uae-home-4711');
      await wizard.getByLabel('Step 1 done').focus();
      await page.keyboard.press('Space');
      await wizard.getByTestId('drive-wizard-progress').filter({ hasText: '1 of 4 done' }).waitFor();
      await wizard.getByLabel('Step 2 done').check();
      await wizard.getByTestId('drive-wizard-progress').filter({ hasText: '2 of 4 done' }).waitFor();
      assert.equal(await wizard.getByTestId('drive-wizard-api').getByRole('link', { name: 'Open this page' }).getAttribute('href'), 'https://console.cloud.google.com/apis/library/drive.googleapis.com?project=beautiful-uae-home-4711');
      assert.equal(await wizard.getByRole('link', { name: 'Open Branding' }).getAttribute('href'), 'https://console.cloud.google.com/auth/branding?project=beautiful-uae-home-4711');
      assert.equal(await wizard.getByRole('link', { name: 'Open Audience' }).getAttribute('href'), 'https://console.cloud.google.com/auth/audience?project=beautiful-uae-home-4711');
      assert.equal(await wizard.getByTestId('drive-wizard-client').getByRole('link', { name: 'Open this page' }).getAttribute('href'), 'https://console.cloud.google.com/auth/clients?project=beautiful-uae-home-4711');
      // Copy buttons for what to type.
      await wizard.getByRole('button', { name: 'Copy the Drive scope' }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://www.googleapis.com/auth/drive.file');
      await wizard.getByRole('button', { name: 'Copy the application type' }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'TVs and Limited Input devices');
      assert.deepEqual(await overflow(page), []);
      await shot(wizard, `drive-wizard-${width}.png`);
      // Ticks are kept: a reload shows them.
      await ctx.close();
      ({ ctx, page, errors } = await hub(width));
      card = page.getByTestId('drive-backup-card');
      assert.equal(await card.getByTestId('drive-wizard-progress').innerText(), '2 of 4 done');
      assert.ok(await card.getByLabel('Step 1 done').isChecked());
      assert.equal(await card.getByLabel(/Project ID/).inputValue(), 'beautiful-uae-home-4711');
      // The client file: a service account key refused with what to do, Google's client file read in.
      const sa = path.join(os.tmpdir(), `buh-sa-${Date.now()}.json`);
      fs.writeFileSync(sa, makeServiceAccount().json);
      await card.getByTestId('drive-client-file').setInputFiles(sa);
      await card.getByTestId('drive-client-file-note').filter({ hasText: /service account key, not an OAuth client/ }).waitFor();
      fs.rmSync(sa);
      const clientFile = path.join(os.tmpdir(), `client_secret_${Date.now()}.json`);
      fs.writeFileSync(clientFile, JSON.stringify({ installed: { client_id: OAUTH_CLIENT.id, project_id: 'beautiful-uae-home-4711', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', client_secret: OAUTH_CLIENT.secret, redirect_uris: ['http://localhost'] } }));
      await card.getByTestId('drive-client-file').setInputFiles(clientFile);
      fs.rmSync(clientFile);
      await card.getByTestId('drive-client-file-note').filter({ hasText: /Read the client ID and secret from the file/ }).waitFor();
      assert.equal(await card.getByLabel('OAuth client ID').inputValue(), OAUTH_CLIENT.id);
      assert.equal(await card.getByTestId('drive-client-id-check').innerText(), '✓ Looks right');
      // The live check of the client ID.
      await card.getByLabel('OAuth client ID').fill('123-oops');
      assert.match(await card.getByTestId('drive-client-id-check').innerText(), /Not a client ID yet/);
      assert.equal(await card.getByRole('button', { name: 'Connect Google Drive' }).isDisabled(), true);
      await card.getByLabel('OAuth client ID').fill(OAUTH_CLIENT.id);
      // Service accounts are tucked away under Advanced.
      assert.equal(await card.getByTestId('drive-advanced').getAttribute('open'), null);
    }
    // Connect: the code, large, with Copy and Open google.com/device; the hub notices by itself.
    google.deviceScript = ['pending', 'pending', 'ok'];
    await card.getByRole('button', { name: first ? 'Connect Google Drive' : 'Reconnect Google Drive' }).focus();
    await page.keyboard.press('Enter');
    const code = card.getByTestId('drive-connect-code');
    await code.waitFor();
    assert.equal(await card.getByTestId('drive-user-code').innerText(), 'GQVQ-JKEC');
    const size = await card.getByTestId('drive-user-code').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    assert.ok(size >= 36, `the code is large (${size}px)`);
    await code.getByRole('button', { name: 'Copy the code' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'GQVQ-JKEC');
    assert.equal(await code.getByRole('link', { name: 'Open google.com/device' }).getAttribute('href'), 'https://www.google.com/device');
    assert.deepEqual(await overflow(page), []);
    await shot(code, `drive-code-${width}.png`);
    await card.getByTestId('drive-connected').filter({ hasText: 'Connected to shop.owner@gmail.com' }).waitFor({ timeout: 20_000 });
    // The first copy, made at once.
    await card.getByTestId('drive-last-copy').filter({ hasText: /Last copy .*\(\d+ in Drive\)/ }).waitFor({ timeout: 20_000 });
    assert.deepEqual(await overflow(page), []);
    await shot(card, `drive-connected-${width}.png`);
    if (SHOTS && width === 1280) await page.screenshot({ path: path.join(SHOTS, `system-backups-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('after connecting: copies are encrypted with the hub password and in the shop’s folder; no secret in the log', { skip }, async () => {
  const st = await (await api('GET', '/api/admin/backup/drive')).json();
  assert.equal(st.enabled, true);
  assert.equal(st.accountEmail, 'shop.owner@gmail.com');
  const copies = [...google.files.values()].filter((f) => f.parents.includes(st.oauthFolderId) && f.name.endsWith('.tar.gz.enc'));
  assert.ok(copies.length >= 1);
  for (const c of copies) assert.equal(c.data.subarray(0, 7).toString(), 'BUHBK1\n');
  const log = server.log();
  for (const s of [...seen, OAUTH_CLIENT.secret, google.refreshToken, google.userToken]) assert.ok(!log.includes(s));
});
