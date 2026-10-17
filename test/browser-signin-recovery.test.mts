/**
 * Real-browser checks (Chromium against the production build) for the ways
 * back into the Admin Hub: recovery codes and passkeys, at phone (375 px) and
 * desktop (1280 px) width, by keyboard, and a full passkey round trip with
 * Chromium's virtual authenticator. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
let password = 'Recovery-Owner-Pass-1';
const EMAIL = 'admin@beautifuluaehome.com';

const h = () => ({ 'content-type': 'application/json', origin: server.base });

async function signInByApi() {
  const res = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: EMAIL, password }) });
  assert.equal(res.status, 200);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
}

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await pw!.chromium.launch();
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h(), cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: password }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  await browser?.close();
  server?.stop();
});

async function overflow(page: import('playwright').Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

async function openSignIn(page: import('playwright').Page, url: string) {
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.getByText('Admin Hub Security Access').waitFor();
}

async function openSettingsSection(page: import('playwright').Page) {
  await openAdminSection(page, /Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Passkeys & recovery codes' }).click();
  await page.getByRole('heading', { name: 'Recovery codes', exact: true }).waitFor();
}

for (const width of [375, 1280]) {
  test(`sign-in screen at ${width} px: a passkey button and "Use a recovery code", reachable by keyboard, no sideways scroll`, { skip }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 860 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openSignIn(page, server.adminUrl);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor();
    assert.deepEqual(await overflow(page), []);

    // Keyboard only: focus the link, Enter, type, Tab to the next field.
    await page.getByRole('button', { name: 'Use a recovery code' }).focus();
    await page.keyboard.press('Enter');
    await page.locator('#admin-recovery-email').focus();
    await page.keyboard.type(EMAIL);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'admin-recovery-code');
    await page.keyboard.type('abcd-efgh-jklm-npqr');
    await page.keyboard.press('Enter');
    await page.getByText('Wrong email or recovery code.').waitFor();
    assert.deepEqual(await overflow(page), []);
    await page.getByRole('button', { name: 'Back to sign-in' }).click();
    await page.getByRole('button', { name: 'Unlock Admin Portal' }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`settings at ${width} px: create recovery codes (shown once, Download), see how many are left`, { skip }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, url: server.base }]);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await checked;
    await openSettingsSection(page);

    // At this address (no NEXT_PUBLIC_APP_URL, not localhost) passkeys can't work: say so plainly.
    await page.getByText(/Passkeys need the shop’s address/).waitFor();

    // A wrong password: told so, still signed in.
    await page.locator('#recovery-password').fill('not-my-password');
    await page.locator('#recovery-password').press('Enter');
    await page.getByText('That is not your current password.').waitFor();

    await page.locator('#recovery-password').fill(password);
    await page.locator('#recovery-password').press('Enter');
    const list = page.getByRole('list', { name: 'Your new recovery codes' });
    await list.waitFor();
    const codes = (await list.getByRole('listitem').allTextContents()).map((t) => t.replace(/^\d+\./, '').trim());
    assert.equal(codes.length, 10);
    for (const c of codes) assert.match(c, /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    assert.deepEqual(await overflow(page), [], 'the codes fit');
    // Screen readers hear one short line, not ten codes read aloud.
    const announced = (await page.locator('#codes-announcement').textContent()) || '';
    assert.match(announced, /^10 new recovery codes are shown below\./);
    for (const c of codes) assert.ok(!announced.includes(c));
    assert.equal(await page.locator('[aria-live]').filter({ hasText: codes[0] }).count(), 0, 'the codes are not in a live region');

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    const file = await (await downloading).path();
    const text = fs.readFileSync(file, 'utf8');
    for (const c of codes) assert.ok(text.includes(c));
    await page.getByRole('button', { name: 'Print' }).waitFor();
    await page.getByRole('button', { name: 'Copy', exact: true }).waitFor();

    await page.getByRole('button', { name: 'I’ve saved them' }).or(page.getByRole('button', { name: "I've saved them" })).click();
    await page.getByText(/10 of 10 codes left/).waitFor();
    assert.equal(await list.count(), 0, 'shown once');
    await page.getByRole('button', { name: /Create a new set \(the old codes stop working\)/ }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('forgot the password on a phone: a recovery code signs in, warns when few are left, and a new password is chosen', { skip }, async () => {
  const made = await fetch(`${server.base}/api/admin/recovery-codes`, { method: 'POST', headers: { ...h(), cookie }, body: JSON.stringify({ currentPassword: password }) });
  const { codes } = (await made.json()) as { codes: string[] };
  // Use 8 of the 10 elsewhere (each one ends every other session).
  for (const code of codes.slice(0, 8)) {
    const res = await fetch(`${server.base}/api/admin/login/recovery`, { method: 'POST', headers: h(), body: JSON.stringify({ email: EMAIL, code }) });
    assert.equal(res.status, 200);
  }
  const used = await fetch(`${server.base}/api/admin/login/recovery`, { method: 'POST', headers: h(), body: JSON.stringify({ email: EMAIL, code: codes[0] }) });
  assert.equal(used.status, 401, 'a used code is refused');
  const stale = await fetch(`${server.base}/api/admin/account`, { headers: { cookie } });
  assert.equal(stale.status, 401, 'the earlier session ended');

  const ctx = await browser.newContext({ viewport: { width: 375, height: 860 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openSignIn(page, server.adminUrl);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.locator('#admin-recovery-email').fill(EMAIL);
  await page.locator('#admin-recovery-code').fill(codes[8].toLowerCase());
  await page.getByRole('button', { name: 'Sign In With Recovery Code' }).click();
  await page.getByText(/You have 1 recovery code left\. Create a new set/).waitFor();
  assert.deepEqual(await overflow(page), []);

  // Before choosing a password, nothing else is allowed with this session.
  const ctxCookies = await ctx.cookies();
  const recoveryCookie = ctxCookies.find((c) => c.name === 'buh_admin')!;
  const blocked = await fetch(`${server.base}/api/admin/account`, { headers: { cookie: `buh_admin=${recoveryCookie.value}` } });
  assert.equal(blocked.status, 403);

  // A reload keeps the owner on "choose a new password".
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#admin-recovery-new').waitFor();

  password = 'Chosen-After-Recovery-7';
  await page.locator('#admin-recovery-new').fill(password);
  await page.locator('#admin-recovery-confirm').fill(password);
  await page.getByRole('button', { name: 'Save New Password' }).click();
  await page.getByRole('navigation', { name: 'Admin sections' }).waitFor();
  await openSettingsSection(page);
  await page.getByText(/1 of 10 codes left.*Running low/).waitFor();
  assert.deepEqual(await overflow(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
  await signInByApi(); // the new password works
});

test('passkey round trip (virtual authenticator): add at desktop width, sign in with it on a phone, then remove it', { skip }, async () => {
  // Passkeys need a domain name: the browser refuses numeric addresses, so use localhost.
  const base = server.base.replace('127.0.0.1', 'localhost');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  await openSignIn(page, `${base}${server.adminPath}`);
  await page.locator('input[autocomplete="username"]').first().fill(EMAIL);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.getByRole('button', { name: 'Unlock Admin Portal' }).click();
  await page.getByRole('navigation', { name: 'Admin sections' }).waitFor();
  await openSettingsSection(page);
  await page.getByText('No passkeys yet.').waitFor();
  await page.getByLabel('Name for this passkey').fill('Test laptop');
  await page.locator('#passkey-password').fill(password);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await page.getByText(/Passkey “Test laptop” added/).waitFor();
  const passkeys = page.getByRole('list', { name: 'Your passkeys' });
  await passkeys.getByText('Test laptop').waitFor();
  await passkeys.getByText(/Last used never/).waitFor();
  assert.deepEqual(await overflow(page), []);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true, 'a discoverable passkey');

  // Signed out; on a phone, sign in with the passkey alone (no email, no password).
  await ctx.clearCookies();
  await page.setViewportSize({ width: 375, height: 860 });
  await openSignIn(page, `${base}${server.adminPath}`);
  assert.deepEqual(await overflow(page), []);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.getByRole('navigation', { name: 'Admin sections' }).waitFor();
  await openSettingsSection(page);
  await passkeys.getByText('Test laptop').waitFor();
  assert.equal(await passkeys.getByText(/Last used never/).count(), 0, 'last used is recorded');
  // Just signed in with a passkey: new recovery codes without typing the password.
  await page.getByText('You signed in with a passkey a moment ago, so your password isn’t needed').or(page.getByText("You signed in with a passkey a moment ago, so your password isn't needed")).waitFor();
  assert.deepEqual(await overflow(page), []);

  // Forgot the password? Just signed in with a passkey: choose a new one without the old.
  await page.getByRole('heading', { name: 'Forgot your password?' }).waitFor();
  password = 'Chosen-After-Passkey-8';
  await page.locator('#passkey-new-password').fill(password);
  await page.locator('#passkey-new-password-again').fill(password);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await page.getByText('Password changed. Other devices are signed out.').waitFor();
  assert.deepEqual(await overflow(page), []);
  await signInByApi();

  // Removing a passkey needs the password (a session alone is not enough).
  const bare = await fetch(`${server.base}/api/admin/passkeys/someid`, { method: 'DELETE', headers: { ...h(), cookie } , body: '{}' });
  assert.equal(bare.status, 400);
  assert.match((await bare.json()).message, /current password/);

  // Remove it (asks first, with the password: this session came from the new password); then it no longer opens the Admin Hub.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openSettingsSection(page);
  await page.getByRole('button', { name: 'Remove passkey Test laptop' }).click();
  await passkeys.getByLabel('Current password').fill('wrong-password');
  await page.getByRole('button', { name: 'Yes, remove' }).click();
  await page.getByText('That is not your current password.').waitFor();
  await passkeys.getByLabel('Current password').fill(password);
  await page.getByRole('button', { name: 'Yes, remove' }).click();
  await page.getByText('No passkeys yet.').waitFor();
  await ctx.clearCookies();
  await openSignIn(page, `${base}${server.adminPath}`);
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await page.getByText(/That passkey was not accepted/).waitFor();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('after a restore the Admin Hub says to review passkeys and make new codes; a restored passkey can be kept (375 and 1280 px)', { skip }, async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restored-ui-'));
  // First start of this "restored" shop: the one-time password, then our own.
  let shop = await startServer({ DATA_DIR: dataDir });
  const hh = () => ({ 'content-type': 'application/json', origin: shop.base });
  await fetch(`${shop.base}/api/admin/login`, { method: 'POST', headers: hh(), body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  // The one-time password is printed once the account is created; under load that can take a while.
  let found: RegExpMatchArray | null = null;
  for (let i = 0; i < 150 && !(found = shop.log().match(/Password: (\S+)/)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(found, 'the one-time password was printed');
  const once = found[1];
  const first = await fetch(`${shop.base}/api/admin/login`, { method: 'POST', headers: hh(), body: JSON.stringify({ email: EMAIL, password: once }) });
  const pw = 'Restored-Shop-Pass-1';
  await fetch(`${shop.base}/api/admin/password`, { method: 'POST', headers: { ...hh(), cookie: (first.headers.get('set-cookie') || '').split(';')[0] }, body: JSON.stringify({ currentPassword: once, newPassword: pw }) });
  shop.stop();
  await new Promise((r) => setTimeout(r, 500));
  // What scripts/restore-backup.mjs leaves behind: a restored passkey, switched off, and the reminder.
  const db = new Database(path.join(dataDir, 'shop.db'));
  db.prepare("INSERT INTO admin_passkeys (id, public_key, name, rp_id, created_at) VALUES ('restoredKey1', x'00', 'Old phone', 'localhost', '2026-01-01T00:00:00Z')").run();
  const put = db.prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?)');
  put.run('admin:passkeys-suspended', JSON.stringify(['restoredKey1']), new Date().toISOString());
  put.run('admin:restored', JSON.stringify({ at: new Date().toISOString(), backup: 'buh-backup-20260101-1200.tar.gz' }), new Date().toISOString());
  db.close();
  shop = await startServer({ DATA_DIR: dataDir }, { adminPath: shop.adminPath });
  try {
    const login = await fetch(`${shop.base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: shop.base }, body: JSON.stringify({ email: EMAIL, password: pw }) });
    const [name, value] = (login.headers.get('set-cookie') || '').split(';')[0].split('=');
    for (const width of [375, 1280]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addCookies([{ name, value, url: shop.base }]);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
      await page.goto(shop.adminUrl, { waitUntil: 'domcontentloaded' });
      await checked;
      const banner = page.getByRole('alert').filter({ hasText: 'restored from a backup' });
      await banner.getByText(/Review your passkeys and create new recovery codes/).waitFor();
      await banner.getByText(/1 restored passkey is switched off/).waitFor();
      assert.deepEqual(await overflow(page), []);
      await banner.getByRole('button', { name: 'Review now' }).click();
      await page.getByRole('heading', { name: 'Recovery codes', exact: true }).waitFor();
      await page.getByText(/Switched off after a restore/).waitFor();
      assert.deepEqual(await overflow(page), []);
      if (width === 1280) {
        await page.getByRole('button', { name: 'Keep passkey Old phone' }).click();
        await page.getByRole('list', { name: 'Your passkeys' }).getByLabel('Current password').fill(pw);
        await page.getByRole('button', { name: 'Yes, keep it' }).click();
        await page.getByText(/Passkey “Old phone” kept/).waitFor();
        assert.equal(await page.getByText(/Switched off after a restore/).count(), 0);
        await banner.getByRole('button', { name: 'Done, hide this' }).click();
        await banner.waitFor({ state: 'detached' });
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
    const after = await fetch(`${shop.base}/api/admin/restore-notice`, { headers: { cookie: `${name}=${value}` } });
    assert.equal((await after.json()).notice, null, 'the reminder stays hidden');
  } finally {
    shop.stop();
  }
});
