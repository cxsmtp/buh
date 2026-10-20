/**
 * Backups when there is something new, in the hub (Settings → System & backups), against the
 * production build in Chromium at 375 px and 1280 px: the status shows the last backup and the
 * changes it held, the next one ("by …, N changes waiting") or "Nothing new", and the weekly check;
 * "When to back up" saves the delay, the email choice and the weekly check (by keyboard), warns
 * when email is the only copy away from the server and the choice leaves it a week or more, and the
 * status follows. No sideways scroll, text boxes 16px on phones, no page errors.
 * Screenshots go to BUH_SHOTS_DIR when it is set. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const SHOTS = process.env.BUH_SHOTS_DIR || '';
const PASSWORD = 'Backup-Schedule-Owner-Pass-1';

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
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
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

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
const overflow = (page: Page) => page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
const shot = async (loc: import('playwright').Locator, name: string) => {
  if (!SHOTS) return;
  await loc.scrollIntoViewIfNeeded();
  await loc.screenshot({ path: path.join(SHOTS, name) });
};

test('the route: "Back up now" takes only { email }; the status says what waits', { skip }, async () => {
  assert.equal((await api('POST', '/api/admin/backup', { email: 'yes' })).status, 400);
  assert.equal((await api('POST', '/api/admin/backup', { email: false, other: 1 })).status, 400, 'allow-listed');
  assert.equal((await api('POST', '/api/admin/backup', {}, { cookie: '' })).status, 401);
  // The first backup of a new shop also sees the sample catalogue being made; the next one has nothing new.
  await api('POST', '/api/admin/backup', { email: false });
  // Reading the shop (pages, lists) changes nothing.
  for (const p of ['/api/products', '/api/admin/orders', '/api/admin/settings', '/api/admin/backup']) await api('GET', p);
  const done = await (await api('POST', '/api/admin/backup', { email: false })).json();
  assert.ok(done.lastSuccessAt, JSON.stringify(done));
  assert.equal(done.pending.total, 0);
  assert.equal(done.nextDueAt, null);
  assert.deepEqual(done.settings, { delayMinutes: 120, email: 'daily', weeklyCheck: true });
  // A change in the hub (a settings save): due 2 h later.
  assert.equal((await api('PUT', '/api/admin/settings/store', { settings: { supportEmail: 'help@shop.test' } })).status, 200);
  const h = await (await api('GET', '/api/admin/backup')).json();
  assert.ok(h.pending.total >= 1);
  assert.match(h.pending.labels, /settings/);
  const due = Date.parse(h.nextDueAt) - Date.now();
  assert.ok(due > 1.9 * 3600_000 && due <= 2 * 3600_000, String(due));
  assert.equal((await api('PUT', '/api/admin/settings/backups', { settings: { delayMinutes: 10 } })).status, 400);
});

for (const width of [375, 1280]) {
  test(`the backup status and "When to back up" at ${width}px`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    const settings = page.getByRole('region', { name: 'System & backups' }).or(page.locator('body'));
    const status = settings.getByRole('status').filter({ has: page.getByTestId('backup-next') }).last();
    await status.waitFor();
    assert.match(await status.getByTestId('backup-last').innerText(), /^Last backup: \d{1,2}:\d{2}\s?(am|pm) \((Back up now|after \d+ changes?.*)\)\.$/i);
    assert.match(await status.getByTestId('backup-next').innerText(), /Next: by (tomorrow )?\d{1,2}:\d{2}\s?(am|pm) — \d+ changes? waiting \(.*settings.*\)\./i);
    assert.match(await status.getByTestId('backup-weekly').innerText(), /Weekly check: (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\./);
    await shot(status, `backup-card-${width}.png`);

    const card = page.getByTestId('backup-schedule-card');
    await card.waitFor();
    const select = card.getByLabel('Back up after the first change');
    assert.equal(await select.inputValue(), width === 375 ? '120' : '60', 'the saved delay');
    if (width === 375) {
      const size = await select.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      assert.ok(size >= 16, `select font ${size}px`);
    }
    // By keyboard: "Only the weekly check" → the week-long warning (no Drive), then back to one a day.
    await card.getByRole('radio', { name: /Only the weekly check/ }).focus();
    await page.keyboard.press('Space');
    await card.getByTestId('backup-offserver-warning').waitFor();
    assert.match(await card.getByTestId('backup-offserver-warning').innerText(), /up to a week/);
    await card.getByRole('radio', { name: /At most one a day/ }).focus();
    await page.keyboard.press('Space');
    // This test shop has no email set up either: the warning says so instead.
    await card.getByTestId('backup-offserver-warning').filter({ hasText: 'Email is not set up and Google Drive is not connected' }).waitFor();
    // One hour at 375 px; three hours and the weekly check off (by keyboard) at 1280 px.
    await select.focus();
    await select.selectOption(width === 375 ? '60' : '180');
    if (width === 1280) {
      const weekly = card.getByRole('checkbox', { name: /Weekly check/ });
      await weekly.focus();
      await page.keyboard.press('Space');
      assert.equal(await weekly.isChecked(), false);
    }
    if (width === 375) await shot(card, 'backup-settings-375.png');
    const before = await status.getByTestId('backup-next').innerText();
    await card.getByRole('button', { name: 'Save backup choices' }).focus();
    await page.keyboard.press('Enter');
    await card.getByTestId('backup-schedule-status').filter({ hasText: 'Saved.' }).waitFor();
    const saved = (await (await api('GET', '/api/admin/backup')).json()).settings;
    assert.deepEqual(saved, width === 375 ? { delayMinutes: 60, email: 'daily', weeklyCheck: true } : { delayMinutes: 180, email: 'daily', weeklyCheck: false });
    // The status follows: the due time moves with the delay (and the weekly check goes when off).
    await page.waitForFunction((old) => document.querySelector('[data-testid="backup-next"]')?.textContent !== old, before);
    if (width === 1280) assert.equal(await status.getByTestId('backup-weekly').count(), 0);
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
