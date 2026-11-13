/**
 * Reported by the full test run (BUH-02.42.00): two quick ticks in the Google Drive setup wizard
 * could leave one shown as not done, when the answer to the first save came back after the
 * second's and replaced it on screen. Now only the latest save's answer is shown, and the saves
 * go to the server one after another, so it keeps the newest. The first answer is held back here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';
/** The owner password for this run (made up when the tests start). */
const OWNER_PASSWORD = ownerPassword();

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const SHOTS = process.env.BUH_SHOTS_DIR || '';
const PASSWORD = OWNER_PASSWORD;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
/** Every backup password this test saw (none may reach the log, the audit log or another reply). */
const seen: string[] = [];

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
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
});


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

test('two quick ticks: both stay ticked on screen and on the server, even when the first save answers last', { skip }, async () => {
  for (const width of [375, 1280]) {
    const { ctx, page, errors } = await hub(width);
    const wizard = page.getByTestId('drive-backup-card').getByTestId('drive-wizard');
    await wizard.waitFor();
    const start = Number((await wizard.getByTestId('drive-wizard-progress').innerText()).split(' ')[0]);
    // Hold back the answer to the first save until the second has been answered.
    let n = 0;
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    await page.route('**/api/admin/backup/drive/wizard', async (route: import('playwright').Route) => {
      const mine = ++n;
      const res = await route.fetch();
      if (mine === 1) await firstHeld;
      await route.fulfill({ response: res });
      if (mine === 2) setTimeout(releaseFirst, 300);
    });
    const a = width === 375 ? 'Step 3 done' : 'Step 1 done';
    const b = width === 375 ? 'Step 4 done' : 'Step 2 done';
    await wizard.getByLabel(a).check();
    await wizard.getByLabel(b).check();
    setTimeout(releaseFirst, 4000); // never stuck if the saves are sent one after another
    await wizard.getByTestId('drive-wizard-progress').filter({ hasText: `${start + 2} of 4 done` }).waitFor();
    await page.waitForTimeout(5000);
    assert.equal(await wizard.getByTestId('drive-wizard-progress').innerText(), `${start + 2} of 4 done`, 'still both ticked after every answer came back');
    assert.equal(await wizard.getByLabel(a).isChecked(), true);
    assert.equal(await wizard.getByLabel(b).isChecked(), true);
    await page.unroute('**/api/admin/backup/drive/wizard');
    // The server kept both: a fresh page shows them ticked.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openAdminSection(page, /^Settings/);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'System & backups', exact: true }).click();
    const again = page.getByTestId('drive-backup-card').getByTestId('drive-wizard');
    await again.getByTestId('drive-wizard-progress').filter({ hasText: `${start + 2} of 4 done` }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
