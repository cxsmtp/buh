/**
 * Settings → System & backups → "Connect my Google Drive" against the production build, with Google
 * replaced by a stand-in on 127.0.0.1 (BUH_TEST_GOOGLE_API, loopback only):
 * - the routes: hidden from strangers, sign-in required, allow-listed; "Copy restore details" only
 *   with the current password (a wrong one refused), audited; nothing secret in a reply or the log;
 * - in Chromium at 375 px and 1280 px: the recommended way chosen by default, the client id and
 *   secret, the code to enter at google.com/device while the hub waits, then Connected (the hub
 *   polls the server, the server polls Google); restore details after the password. No sideways
 *   scroll, no page errors.
 * Screenshots go to BUH_SHOTS_DIR when it is set. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const PASSWORD = 'Drive-Connect-Owner-Pass-1';

let google: GoogleMock;
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  google = await startGoogleMock(makeServiceAccount());
  google.deviceInterval = 1; // quick for the test; the server keeps to whatever Google says
  server = await startServer({ BUH_TEST_GOOGLE_API: google.url, BACKUP_PASSPHRASE: 'correct horse battery staple' });
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

/** "Back up now": the backup (it does not wait for Google), then the copy to Drive, followed until done. */
async function backUpNow() {
  const res = await api('POST', '/api/admin/backup', {});
  const body = await res.json();
  let drive = body.drive;
  for (let i = 0; i < 150 && drive?.copying; i++) {
    await new Promise((r) => setTimeout(r, 100));
    drive = (await (await api('GET', '/api/admin/backup')).json()).drive;
  }
  return { status: res.status, body: { ...body, drive } };
}

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
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'System & backups', exact: true }).click();
  await page.getByRole('heading', { name: 'System & backups', exact: true, level: 2 }).waitFor();
  return { ctx, page, errors };
}
async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

test('the connect and restore-details routes: hidden, sign-in required, allow-listed', { skip }, async () => {
  assert.equal((await rawFetch(`${server.base}/api/admin/backup/drive/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"poll"}' })).status, 404);
  assert.equal((await rawFetch(`${server.base}/api/admin/backup/drive/restore-details`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await api('POST', '/api/admin/backup/drive/connect', { action: 'poll' }, { cookie: '' })).status, 401);
  assert.equal((await api('POST', '/api/admin/backup/drive/connect', { action: 'poll', extra: 1 })).status, 400);
  assert.equal((await api('POST', '/api/admin/backup/drive/connect', { action: 'nope' })).status, 400);
  assert.equal((await api('POST', '/api/admin/backup/drive/connect', { action: 'start', clientId: 'x' })).status, 400);
  const off = await (await api('GET', '/api/admin/backup/drive')).json();
  assert.equal(off.mode, 'oauth', 'the recommended way by default');
  assert.equal(off.connected, false);
  assert.equal((await api('POST', '/api/admin/backup/drive/restore-details', { currentPassword: PASSWORD })).status, 409, 'nothing to show before connecting');
});

for (const width of [375, 1280]) {
  test(`Connect my Google Drive at ${width}px: the code to enter, then connected; restore details after the password`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    const card = page.getByTestId('drive-backup-card');
    // The recommended way, chosen by default; the service account tucked away under Advanced.
    assert.ok(await card.getByRole('radio', { name: /Connect my Google Drive/, includeHidden: true }).isChecked());
    assert.equal(await card.getByTestId('drive-advanced').getAttribute('open'), null);
    // Google: pending a few times, then the owner approves.
    google.deviceScript = ['pending', 'pending', 'pending', 'ok'];
    const first = width === 375;
    if (first) {
      await card.getByLabel('OAuth client ID').fill(OAUTH_CLIENT.id);
      await card.getByLabel('Client secret').fill(OAUTH_CLIENT.secret);
    }
    await card.getByRole('button', { name: first ? 'Connect Google Drive' : 'Reconnect Google Drive' }).click();
    const code = card.getByTestId('drive-connect-code');
    await code.waitFor();
    assert.equal(await card.getByTestId('drive-user-code').innerText(), 'GQVQ-JKEC');
    assert.equal(await code.getByRole('link', { name: 'Open google.com/device' }).getAttribute('href'), 'https://www.google.com/device');
    assert.deepEqual(await overflow(page), []);
    await card.scrollIntoViewIfNeeded();
    if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `drive-connect-code-${width}.png`) });
    await card.getByTestId('drive-connected').waitFor({ timeout: 20_000 });
    await card.getByTestId('drive-message').filter({ hasText: /^Connected to shop\.owner@gmail\.com\. Making the first copy now/ }).waitFor();
    assert.match(await card.getByTestId('drive-connected').innerText(), /Connected to shop\.owner@gmail\.com/);
    // The first copy is made at once (Back up now, then the copy to Drive).
    await card.getByTestId('drive-last-copy').filter({ hasText: /Last copy .*\(\d+ in Drive\)/ }).waitFor({ timeout: 20_000 });
    assert.ok(await card.getByRole('checkbox', { name: 'Copy each backup to Google Drive' }).isChecked());
    assert.equal(await card.getByLabel('Client secret').getAttribute('placeholder'), 'Saved (hidden)');
    assert.equal(await card.getByLabel('Client secret').inputValue(), '');

    // Restore details: a wrong password refused, then shown.
    await card.getByRole('button', { name: 'Copy restore details' }).click();
    const box = card.getByTestId('drive-restore-details');
    await box.getByLabel('Current password').fill('not my password');
    await box.getByRole('button', { name: 'Show' }).click();
    await card.getByTestId('drive-message').filter({ hasText: /not your current password/ }).waitFor();
    await box.getByLabel('Current password').fill(PASSWORD);
    await box.getByRole('button', { name: 'Show' }).click();
    const text = await box.getByTestId('drive-details-text').innerText();
    assert.match(text, /BUH_DRIVE_CLIENT_ID=123456789012-/);
    assert.match(text, /BUH_DRIVE_REFRESH_TOKEN=1\/\/0gMockRefresh/);
    assert.deepEqual(await overflow(page), []);
    if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `drive-connected-${width}.png`) });
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('after connecting: Back up now copies to the shop’s folder; nothing secret in the status, the log or the audit; the reveal is audited', { skip }, async () => {
  const run = (await backUpNow()).body;
  assert.equal(run.drive.level, 'ok', JSON.stringify(run.drive));
  const folder = google.files.get(run.drive.oauthFolderId)!;
  assert.equal(folder.name, 'Beautiful UAE Home backups');
  // The first copy made on connecting, and this one (one per minute: a copy with the same name replaces the earlier).
  const inFolder = [...google.files.values()].filter((f) => f.parents.includes(folder.id) && f.name.endsWith('.tar.gz.enc'));
  assert.ok(inFolder.length >= 1 && inFolder.length === run.drive.copies, `${inFolder.length} copies, ${run.drive.copies} recorded`);
  const status = await (await api('GET', '/api/admin/backup/drive')).text();
  for (const s of [OAUTH_CLIENT.secret, google.refreshToken, google.userToken]) assert.ok(!status.includes(s));
  const log = server.log();
  for (const s of [OAUTH_CLIENT.secret, google.refreshToken, google.userToken, 'mock-device']) assert.ok(!log.includes(s), `log: ${s.slice(0, 8)}`);
  const audit = fs.readdirSync(server.dataDir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8')).join('\n');
  assert.equal((audit.match(/backup\.drive_details_revealed/g) ?? []).length, 2, 'each reveal audited');
  for (const s of [OAUTH_CLIENT.secret, google.refreshToken]) assert.ok(!audit.includes(s));
});
