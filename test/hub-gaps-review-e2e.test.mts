/**
 * The Admin Hub gaps the last review round left open, in Chromium against the production build, at
 * 375 px (a phone) and 1280 px (a laptop):
 *  1. every button and link inside an order card's boxes (WhatsApp check, bank transfer, invoice,
 *     payment moved, history) and the photo-deal links is at least 44 px tall on a phone, and stays
 *     compact on a laptop;
 *  2. the settings saved with their own Save button (Festival themes, the announcement bar,
 *     Couriers, the bank details) carry the version the form was loaded from: a change made
 *     elsewhere is not overwritten, the form is reloaded and the owner is told; saving twice in a
 *     row still works, and a form no longer asks the server for its version when it opens;
 *  3. a setting refused just as the owner leaves Settings is said on the hub tab they moved to;
 *  5. the bank, payments, SMS and email settings and inviting an accountant need the owner again
 *     (a sign-in in the last 10 minutes, or the password): the routes refuse, the hub asks once and
 *     sends the change again, an autosave never opens the dialog by itself.
 * Every screen: no sideways scroll, no page errors, the keyboard works. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { fake, ownerPassword, wrongLogin } from './fixtures/fake.mjs';

const OWNER_PASSWORD = ownerPassword();
/** The server's signing key for this run (so the test can age a session; made up when the tests start). */
const SESSION_KEY = fake('hub-gaps-', crypto.randomBytes(24).toString('hex'));

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;
const EMAIL = 'admin@beautifuluaehome.com';
const BANK = { bankName: 'Mashreq', accountName: 'BUH TEXTILES TRADING LLC', iban: 'AE07 0331 2345 6789 0123 456', accountNumber: '1012345678901', swiftCode: 'BOMLAEAD', branch: 'Al Wasl', instructions: 'Please put your order number in the transfer remarks.' };

let server: RunningServer;
let browser: import('playwright').Browser;
/** A session from a sign-in just now. */
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer({ SESSION_SECRET: SESSION_KEY });
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
  assert.equal((await api('PUT', '/api/admin/settings/bank', { settings: BANK, currentPassword: OWNER_PASSWORD })).status, 200);
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

/** The same session as if the owner had signed in `minutes` ago (still signed in, no longer "just now"). */
function aged(sessionCookie: string, minutes = 11): string {
  const at = sessionCookie.indexOf('=');
  const body = sessionCookie.slice(at + 1).split('.')[0];
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const next = Buffer.from(JSON.stringify({ ...payload, iat: payload.iat - minutes * 60_000 })).toString('base64url');
  return `${sessionCookie.slice(0, at)}=${next}.${crypto.createHmac('sha256', Buffer.from(SESSION_KEY, 'utf8')).update(`session\n${next}`).digest('base64url')}`;
}

const call = (as: string, method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie: as }, body: body === undefined ? undefined : JSON.stringify(body) });
const api = (method: string, p: string, body?: unknown) => call(cookie, method, p, body);
const post = (p: string, body: unknown) => rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(body) });
interface Group<T = Record<string, unknown>> {
  value: T;
  updatedAt?: string | null;
}
const settingsNow = async () => (await (await api('GET', '/api/admin/settings')).json()) as Record<'brand' | 'bank' | 'store' | 'theme' | 'courier' | 'payments', Group>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let v = await fn();
  for (let i = 0; i < 50 && !ok(v); i++) {
    await sleep(200);
    v = await fn();
  }
  assert.ok(ok(v), `${what}: ${JSON.stringify(v)}`);
  return v;
}
/** Set HUB_GAPS_SHOTS_DIR to keep a picture of each screen (to look at by eye). */
const SHOTS = process.env.HUB_GAPS_SHOTS_DIR || '';
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

async function hub(width: number, as = cookie) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
  const at = as.indexOf('=');
  await ctx.addCookies([{ name: as.slice(0, at), value: as.slice(at + 1), url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => void d.accept().catch(() => undefined));
  const versionReads: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/admin/settings?versions=1')) versionReads.push(r.url());
  });
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.getByRole('status').filter({ hasText: /Backup/ }).waitFor();
  return { ctx, page, errors, versionReads };
}
async function settingsSection(page: Page, name: string) {
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('heading', { name, exact: true, level: 2 }).waitFor();
}

let phoneN = 0;
async function order(paymentMethod: 'cod' | 'bank_transfer'): Promise<{ id: string; total: number }> {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Rohini R Nair', phone: `+97150776${String(++phoneN).padStart(4, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod,
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}
const PNG = `data:image/png;base64,${fs.readFileSync('test/fixtures/sheet-indigo.png').toString('base64')}`;

// ── 5 (and 2), the routes ────────────────────────────────────────────────────

test('gap 5: the routes refuse a bank, payments, SMS or email save, a restore of one and an invitation from a session that is only signed in', { skip }, async () => {
  const old = aged(cookie);
  assert.equal((await call(old, 'GET', '/api/admin/settings')).status, 200, 'the aged session is still signed in');
  // Other settings save as before.
  assert.equal((await call(old, 'PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877' } })).status, 200);

  for (const [key, settings] of [
    ['bank', { ...BANK, branch: 'Changed Without Asking' }],
    ['payments', { cardFeePercent: 9 }],
    ['sms', { isEnabled: false }],
    ['email', { smtpHost: '' }],
  ] as const) {
    const res = await call(old, 'PUT', `/api/admin/settings/${key}`, { settings });
    assert.equal(res.status, 400, key);
    const body = await res.json();
    assert.equal(body.code, 'owner_confirm', key);
    assert.match(body.message, /Type your hub password/);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  assert.equal((await settingsNow()).bank.value.branch, BANK.branch, 'nothing was saved');

  // A wrong password: still refused, with its own code. The right one saves, and is remembered.
  const wrong = await call(old, 'PUT', '/api/admin/settings/bank', { settings: { ...BANK, branch: 'Wrong Password' }, currentPassword: 'not-the-password' });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, 'owner_confirm_wrong');
  assert.equal((await settingsNow()).bank.value.branch, BANK.branch);
  const right = await call(old, 'PUT', '/api/admin/settings/bank', { settings: { ...BANK, branch: 'Confirmed Branch' }, currentPassword: OWNER_PASSWORD });
  assert.equal(right.status, 200, await right.clone().text());
  assert.equal((await settingsNow()).bank.value.branch, 'Confirmed Branch');
  const renewed = (right.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(renewed.startsWith('buh_admin='), 'the typed password is a new sign-in');
  assert.match(right.headers.get('set-cookie') || '', /HttpOnly/i);
  const next = await call(renewed, 'PUT', '/api/admin/settings/bank', { settings: BANK });
  assert.equal(next.status, 200, 'not asked again with that sign-in');
  assert.equal(next.headers.get('set-cookie'), null);
  assert.equal(JSON.stringify(await next.json()).includes(OWNER_PASSWORD), false);

  // Putting an earlier version of the bank details back is a save of them too.
  const versions = ((await (await api('GET', '/api/admin/settings/history')).json()) as { versions: Array<{ id: number; key: string }> }).versions;
  const bankVersion = versions.find((v) => v.key === 'bank');
  const storeVersion = versions.find((v) => v.key === 'store');
  assert.ok(bankVersion && storeVersion);
  const restore = await call(old, 'POST', '/api/admin/settings/history', { id: bankVersion!.id });
  assert.equal(restore.status, 400);
  assert.equal((await restore.json()).code, 'owner_confirm');
  assert.equal((await call(old, 'POST', '/api/admin/settings/history', { id: storeVersion!.id })).status, 200, 'other groups restore as before');

  // Inviting an accountant.
  const invite = await call(old, 'POST', '/api/admin/staff', { email: 'books-route@example.ae' });
  assert.equal(invite.status, 400);
  assert.equal((await invite.json()).code, 'owner_confirm');
  const staff = async () => ((await (await api('GET', '/api/admin/staff')).json()) as { accounts: Array<{ email: string }> }).accounts.map((a) => a.email);
  assert.equal((await staff()).includes('books-route@example.ae'), false, 'no account was made');
  const invited = await call(old, 'POST', '/api/admin/staff', { email: 'books-route@example.ae', currentPassword: OWNER_PASSWORD });
  assert.equal(invited.status, 200, await invited.clone().text());
  assert.ok((await staff()).includes('books-route@example.ae'));
  assert.equal((await call(old, 'POST', '/api/admin/staff', { email: 'x@example.ae', password: 'x' })).status, 400, 'fields are allow-listed');

  // The audit log never holds the password.
  const log = fs.readdirSync(server.dataDir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(`${server.dataDir}/${f}`, 'utf8')).join('\n');
  assert.equal(log.includes(OWNER_PASSWORD), false);
  assert.match(log, /settings\.owner_confirmed/);
});

test('gap 2: the hub is given each group’s version with its values', { skip }, async () => {
  const all = await settingsNow();
  const versions = ((await (await api('GET', '/api/admin/settings?versions=1')).json()) as { versions: Record<string, string | null> }).versions;
  for (const key of ['brand', 'bank', 'store', 'theme', 'courier', 'payments'] as const) assert.equal(all[key].updatedAt, versions[key], key);
  assert.ok(all.bank.updatedAt, 'a saved group has a version');
});

// ── In the browser ───────────────────────────────────────────────────────────

for (const width of [375, 1280]) {
  test(`gap 1 at ${width}px: every button and link in an order card's boxes and the photo-deal links is ${width < 768 ? 'at least 44 px tall' : 'compact'}`, { skip: skip || skipBrowser }, async () => {
    const deal = await api('POST', '/api/admin/deals', { photos: [PNG], note: `Deal ${width}`, forWhom: `Customer ${width}`, pieces: 1, amount: 300, payments: ['cod'] });
    assert.equal(deal.status, 201, await deal.clone().text());
    const cod = await order('cod');
    const bank = await order('bank_transfer');
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Orders/);
    const card = (id: string) => page.locator('div.bg-surface.rounded-2xl').filter({ hasText: id }).first();

    // The cash order: confirmed on WhatsApp (its small buttons), an invoice made, its history open.
    const codCard = card(cod.id);
    await codCard.getByTestId('whatsapp-check').getByRole('button', { name: 'Confirmed on WhatsApp' }).click();
    await codCard.getByTestId('whatsapp-confirmed-reply').waitFor();
    await codCard.getByTestId('order-invoice').getByRole('button', { name: /Make invoice/ }).click();
    await codCard.getByTestId('order-invoice').getByRole('link', { name: 'Open PDF' }).waitFor();
    await codCard.getByRole('button', { name: 'History' }).click();
    // The bank order: its open box first, then paid (one compact line) with "use it on another order".
    const bankCard = card(bank.id);
    await bankCard.getByTestId('bank-transfer').getByRole('button', { name: 'Payment received' }).waitFor();
    // The photo deals: the page's settings open.
    await page.getByTestId('photo-page-settings').locator('summary').click();

    const measure = () =>
      page.evaluate(() => {
        const roots = [...document.querySelectorAll('[data-testid="whatsapp-check"],[data-testid="bank-transfer"],[data-testid="order-invoice"],[data-testid="order-credit"],[data-testid="photo-deals"]')];
        const targets = roots.flatMap((r) => [...r.querySelectorAll<HTMLElement>('button, a[href], summary, select, textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), label:has(input[type="checkbox"]), label:has(input[type="file"])')]);
        const history = [...document.querySelectorAll<HTMLElement>('button[aria-expanded]')].filter((b) => (b.textContent || '').trim() === 'History');
        return [...targets, ...history]
          .filter((e) => e.offsetParent !== null)
          .map((e) => {
            const r = e.getBoundingClientRect();
            return { what: `${e.tagName.toLowerCase()} “${(e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '').trim().slice(0, 40)}”`, h: Math.round(r.height * 10) / 10, w: Math.round(r.width) };
          });
      });
    const check = async (stage: string) => {
      const found = await measure();
      assert.ok(found.length >= 8, `${stage}: found the buttons (${found.length})`);
      if (width < 768) {
        assert.deepEqual(found.filter((f) => f.h < 43.5), [], `${stage}: every tap target at least 44 px tall`);
      }
      return found;
    };
    const open = await check('open boxes');
    for (const name of ['Open PDF', 'History', 'Copy tracking link', 'Copy link', 'Payment received']) assert.ok(open.some((f) => f.what.includes(name)), `measured: ${name}`);
    if (width >= 768) {
      // The compact order card the owner asked for stays compact on a laptop.
      for (const name of ['Open PDF', 'Copy tracking link', 'History']) {
        const f = open.find((x) => x.what.includes(name))!;
        assert.ok(f.h <= 36, `${name} stays compact at ${width}px (${f.h}px)`);
      }
    }

    // Paid: the compact line, and the payment that can be moved.
    await bankCard.getByTestId('bank-transfer').getByRole('button', { name: 'Payment received' }).click();
    await bankCard.getByTestId('bank-badge').filter({ hasText: /received|Paid/i }).waitFor();
    const credit = bankCard.getByTestId('order-credit');
    if (await credit.count()) {
      const use = credit.getByRole('button', { name: 'Use it on another order' });
      if (await use.isEnabled()) await use.click();
    }
    const paid = await check('paid');
    await shot(page, `orders-${width}`);
    if (width >= 768) {
      const tell = paid.find((x) => x.what.includes('Tell the customer on WhatsApp'));
      if (tell) assert.ok(tell.h <= 36, `the paid line stays compact (${tell.h}px)`);
    }
    // The keyboard reaches them: the history button opens and closes with Enter.
    const historyButton = codCard.getByRole('button', { name: 'History' });
    const wasOpen = await historyButton.getAttribute('aria-expanded');
    await historyButton.focus();
    await page.keyboard.press('Enter');
    assert.equal(await historyButton.getAttribute('aria-expanded'), wasOpen === 'true' ? 'false' : 'true');
    assert.equal(await overflow(page), false, `orders at ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`gap 2 at ${width}px: Festival themes, the announcement bar, Couriers and the bank details do not overwrite a change made elsewhere; saving twice works`, { skip: skip || skipBrowser }, async () => {
    const { ctx, page, errors, versionReads } = await hub(width);
    const notice = page.getByTestId('settings-notices');
    const dismiss = async () => {
      await notice.getByRole('button', { name: 'Dismiss this message' }).first().click();
      await notice.waitFor({ state: 'detached' });
    };

    // Festival themes: the phone flips one switch while this form is open; this form flips another.
    await settingsSection(page, 'Festival themes');
    const banner = page.getByLabel('Festival greeting in the banner');
    await banner.waitFor();
    const t0 = (await settingsNow()).theme.value as { showBanner: boolean; showMarquee: boolean };
    assert.equal((await api('PUT', '/api/admin/settings/theme', { settings: { ...t0, showMarquee: !t0.showMarquee } })).status, 200);
    await banner.click();
    await notice.waitFor();
    assert.match(await notice.innerText(), /Festival themes: These settings were changed somewhere else/);
    let t = (await settingsNow()).theme.value as { showBanner: boolean; showMarquee: boolean };
    assert.equal(t.showMarquee, !t0.showMarquee, 'the phone’s change was not put back');
    assert.equal(t.showBanner, t0.showBanner, 'the refused change was not saved');
    await waitFor(() => page.getByLabel('Festival lines in the scrolling bar').isChecked(), (v) => v === !t0.showMarquee, 'the form shows the current settings');
    assert.equal(await overflow(page), false);
    await dismiss();
    // Made again, it saves; and again (the form's version moved on with its own save).
    await page.getByLabel('Festival greeting in the banner').click();
    await waitFor(settingsNow, (s) => (s.theme.value as { showBanner: boolean }).showBanner === !t0.showBanner, 'saved');
    await page.getByText('Saved. The shop shows it now.').waitFor();
    await page.getByLabel('Festival greeting in the banner').click();
    await waitFor(settingsNow, (s) => (s.theme.value as { showBanner: boolean }).showBanner === t0.showBanner, 'saved again');
    assert.equal(await notice.count(), 0, 'its own saves are not taken for someone else’s');
    t = (await settingsNow()).theme.value as { showBanner: boolean; showMarquee: boolean };
    assert.equal(t.showMarquee, !t0.showMarquee);

    // The announcement bar (saved with the branding): the tagline changes elsewhere meanwhile.
    await settingsSection(page, 'Store & contact');
    const save = page.getByRole('button', { name: 'Save announcements' });
    await save.waitFor();
    const b0 = (await settingsNow()).brand.value as { tagline: string; marquee?: { messages?: string[] } };
    const tagline = `Tagline from the phone ${width}`;
    assert.equal((await api('PUT', '/api/admin/settings/brand', { settings: { ...b0, tagline } })).status, 200);
    await page.locator('#marquee-0').fill(`Free delivery this week ${width}`);
    await save.click();
    await notice.waitFor();
    assert.match(await notice.innerText(), /Branding: These settings were changed somewhere else/);
    let b = (await settingsNow()).brand.value as { tagline: string; marquee?: { messages?: string[] } };
    assert.equal(b.tagline, tagline, 'the tagline from the phone stays');
    assert.equal((b.marquee?.messages ?? []).includes(`Free delivery this week ${width}`), false);
    await dismiss();
    await page.locator('#marquee-0').fill(`Free delivery this week ${width}`);
    await page.getByRole('button', { name: 'Save announcements' }).click();
    await waitFor(settingsNow, (s) => ((s.brand.value as { marquee?: { messages?: string[] } }).marquee?.messages ?? []).includes(`Free delivery this week ${width}`), 'saved after the reload');
    b = (await settingsNow()).brand.value as { tagline: string };
    assert.equal(b.tagline, tagline);
    await page.locator('#marquee-0').fill(`Free delivery all month ${width}`);
    await page.getByRole('button', { name: 'Save announcements' }).click();
    await waitFor(settingsNow, (s) => ((s.brand.value as { marquee?: { messages?: string[] } }).marquee?.messages ?? []).includes(`Free delivery all month ${width}`), 'saved twice in a row');
    assert.equal(await notice.count(), 0);

    // Couriers (autosave and a Save button): the pickup name changes elsewhere, then Save here.
    await settingsSection(page, 'Couriers');
    const saveCouriers = page.getByRole('button', { name: 'Save Carrier Settings' });
    await saveCouriers.waitFor();
    const c0 = (await settingsNow()).courier.value as { jeebly: Record<string, unknown> };
    const pickup = `Phone Pickup ${width}`;
    assert.equal((await api('PUT', '/api/admin/settings/courier', { settings: { ...c0, jeebly: { ...c0.jeebly, pickupLocationName: pickup } } })).status, 200);
    await saveCouriers.click();
    await notice.waitFor();
    assert.match(await notice.innerText(), /Couriers: These settings were changed somewhere else/);
    assert.equal(((await settingsNow()).courier.value as { jeebly: { pickupLocationName: string } }).jeebly.pickupLocationName, pickup, 'Save did not put the older pickup back');
    await dismiss();
    await waitFor(() => page.getByLabel('Pickup name (optional)').inputValue(), (v) => v === pickup, 'the form shows the current pickup');
    // Save, an autosave, and Save again: each is this form's own.
    await page.getByRole('button', { name: 'Save Carrier Settings' }).click();
    await page.getByLabel('Pickup name (optional)').fill(`Hub Pickup ${width}`);
    await waitFor(settingsNow, (s) => (s.courier.value as { jeebly: { pickupLocationName: string } }).jeebly.pickupLocationName === `Hub Pickup ${width}`, 'autosaved after Save');
    await page.getByRole('button', { name: 'Save Carrier Settings' }).click();
    await sleep(600);
    assert.equal(await notice.count(), 0, 'no false alarm');

    // The bank details (signed in just now: not asked): Save, an autosave, Save again.
    await settingsSection(page, 'Branding & bank');
    await page.getByLabel('Branch', { exact: true }).fill(`Branch A ${width}`);
    await page.getByRole('button', { name: 'Save bank details' }).click();
    await waitFor(settingsNow, (s) => s.bank.value.branch === `Branch A ${width}`, 'bank saved');
    await page.getByLabel('Branch', { exact: true }).fill(`Branch B ${width}`);
    await waitFor(settingsNow, (s) => s.bank.value.branch === `Branch B ${width}`, 'bank autosaved after Save');
    await page.getByRole('button', { name: 'Save bank details' }).click();
    await page.getByText('Saved: new bank-transfer orders get these details.').waitFor();
    // Changed elsewhere, then Save here: refused, reloaded, said.
    assert.equal((await api('PUT', '/api/admin/settings/bank', { settings: { ...BANK, branch: 'Branch From The Phone' } })).status, 200);
    await page.getByRole('button', { name: 'Save bank details' }).click();
    await notice.waitFor();
    assert.match(await notice.innerText(), /Bank details: These settings were changed somewhere else/);
    assert.equal((await settingsNow()).bank.value.branch, 'Branch From The Phone');
    assert.equal(await page.getByTestId('owner-confirm').count(), 0, 'signed in just now: no password asked');
    assert.equal(await overflow(page), false);

    assert.deepEqual(versionReads, [], 'no form asked the server for its version: the hub gave it with the values');
    assert.deepEqual(errors, []);
    await ctx.close();
    assert.equal((await api('PUT', '/api/admin/settings/bank', { settings: BANK })).status, 200);
  });

  test(`gap 3 at ${width}px: a setting refused just as the owner leaves Settings is said on the tab they moved to`, { skip: skip || skipBrowser }, async () => {
    const before = (await settingsNow()).store.value.supportEmail;
    const { ctx, page, errors } = await hub(width);
    await settingsSection(page, 'Store & contact');
    await sleep(300);
    await page.getByLabel('Support email').fill('not an email');
    // Off to the orders at once (before the 1.5 s autosave).
    await openAdminSection(page, /^Orders/);
    const notice = page.getByTestId('hub-settings-notices');
    await notice.waitFor();
    assert.match(await notice.innerText(), /Settings → Store & contact: Your last change was not saved\. Please check the support email\./);
    assert.equal((await settingsNow()).store.value.supportEmail, before, 'the last good settings stay');
    assert.equal(await overflow(page), false, 'the notice');
    await shot(page, `hub-notice-${width}`);
    // It follows the owner to the next tab, and is in Settings too (once, in Settings' own place).
    await openAdminSection(page, /^Inventory/);
    await notice.waitFor();
    await openAdminSection(page, /^Settings/);
    await page.getByTestId('settings-notices').waitFor();
    assert.equal(await notice.count(), 0, 'not twice in Settings');
    // Dismissed with the keyboard, it is gone everywhere.
    const close = page.getByTestId('settings-notices').getByRole('button', { name: 'Dismiss this message' });
    const box = await close.boundingBox();
    assert.ok(box && box.height >= 44 && box.width >= 44, 'a 44 px dismiss button');
    await close.focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('settings-notices').waitFor({ state: 'detached' });
    await openAdminSection(page, /^Orders/);
    await sleep(300);
    assert.equal(await notice.count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`gap 5 at ${width}px: the hub asks for the password once for the bank details (never by itself while typing), then saves and does not ask again`, { skip: skip || skipBrowser }, async () => {
    assert.equal((await api('PUT', '/api/admin/settings/bank', { settings: BANK })).status, 200);
    const { ctx, page, errors } = await hub(width, aged(cookie));
    const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await settingsSection(page, 'Branding & bank');
    const branch = page.getByLabel('Branch', { exact: true });
    await waitFor(() => branch.inputValue(), (v) => v === BANK.branch, 'loaded');

    // Typing: the autosave is refused, said on the status line, and no dialog pops up.
    await branch.fill(`Jumeirah ${width}`);
    const waiting = page.getByTestId('autosave-confirm');
    await waiting.waitFor();
    assert.match(await waiting.innerText(), /Not saved yet: your hub password is needed to change these settings\./);
    assert.equal(await dialog.count(), 0, 'an autosave never opens the dialog by itself');
    assert.equal((await settingsNow()).bank.value.branch, BANK.branch, 'nothing saved without the owner');
    // More typing does not stack prompts.
    await branch.fill(`Jumeirah Beach ${width}`);
    await sleep(2200);
    assert.equal(await dialog.count(), 0);
    assert.equal(await waiting.count(), 1);
    await shot(page, `autosave-confirm-${width}`);
    assert.equal(await overflow(page), false);

    // The owner asks to be asked: the dialog, the keyboard inside it.
    const typeIt = waiting.getByRole('button', { name: 'Type your password' });
    const size = await typeIt.boundingBox();
    assert.ok(size && size.height >= 44, 'a 44 px button');
    await typeIt.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Type your hub password to change the bank details/);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'owner-confirm-password', 'focus is in the password field');
    assert.equal(await overflow(page), false, 'the dialog');
    await sleep(400);
    await shot(page, `confirm-dialog-${width}`);
    for (const name of ['Confirm', 'Cancel']) {
      // Its laid-out height (the sheet is still sliding in, which scales what is drawn).
      const h = await dialog.getByRole('button', { name, exact: true }).evaluate((e) => (e as HTMLElement).offsetHeight);
      assert.ok(h >= 44, `${name}: 44 px (${h})`);
    }
    // Tab stays inside the dialog.
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true, 'Tab stays in the dialog');
    // A wrong password: said, asked again, nothing saved.
    await page.locator('#owner-confirm-password').fill('not-the-password');
    await page.keyboard.press('Enter');
    await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').innerText(), /That is not your current password\./);
    assert.equal((await settingsNow()).bank.value.branch, BANK.branch);
    assert.equal(await page.locator('#owner-confirm-password').inputValue(), '', 'the wrong one is not kept');
    // The right one: saved, the dialog gone.
    await page.locator('#owner-confirm-password').fill(OWNER_PASSWORD);
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    await waitFor(settingsNow, (s) => s.bank.value.branch === `Jumeirah Beach ${width}`, 'saved once confirmed');
    assert.equal(await waiting.count(), 0);
    // Not asked again: the next change saves by itself, and so does Save.
    await page.getByLabel('Branch', { exact: true }).fill(`Marina ${width}`);
    await waitFor(settingsNow, (s) => s.bank.value.branch === `Marina ${width}`, 'the next autosave is not asked');
    await page.getByRole('button', { name: 'Save bank details' }).click();
    await page.getByText('Saved: new bank-transfer orders get these details.').waitFor();
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.getByTestId('settings-notices').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`gap 5 at ${width}px: Save asks straight away (Escape cancels and says so); inviting an accountant asks too`, { skip: skip || skipBrowser }, async () => {
    // Payments → Save, from a session that is only signed in.
    const first = await hub(width, aged(cookie));
    const dialog = first.page.getByRole('dialog', { name: 'Confirm it’s you' });
    await settingsSection(first.page, 'Payments');
    const fee = first.page.getByLabel('Card payment fee (%)');
    await fee.waitFor();
    const save = first.page.getByRole('button', { name: 'Save payment settings' });
    await save.focus();
    await first.page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Type your hub password to change the payment settings/);
    await first.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await first.page.getByText('Nothing was changed: your hub password is needed for this.').waitFor();
    await first.page.waitForFunction(() => document.activeElement?.tagName === 'BUTTON' && (document.activeElement.textContent || '').includes('Save payment settings'), undefined, { timeout: 5000 });
    await first.page.keyboard.press('Enter');
    await dialog.waitFor();
    await first.page.locator('#owner-confirm-password').fill(OWNER_PASSWORD);
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await first.page.getByText('Saved. Card payments are off.').waitFor();
    assert.equal(await overflow(first.page), false);
    assert.deepEqual(first.errors, []);
    await first.ctx.close();

    // Security → invite an accountant, from another session that is only signed in.
    const second = await hub(width, aged(cookie));
    const ask = second.page.getByRole('dialog', { name: 'Confirm it’s you' });
    await settingsSection(second.page, 'Security');
    const who = `books-${width}@example.ae`;
    await second.page.getByLabel('Accountant’s email').fill(who);
    await second.page.getByRole('button', { name: 'Invite', exact: true }).click();
    await ask.waitFor();
    assert.match(await ask.innerText(), /inviting an accountant/);
    const staff = async () => ((await (await api('GET', '/api/admin/staff')).json()) as { accounts: Array<{ email: string }> }).accounts.map((a) => a.email);
    assert.equal((await staff()).includes(who), false, 'nobody is invited before the owner confirms');
    await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
    await ask.waitFor({ state: 'detached' });
    await second.page.getByText('Nothing was changed: your hub password is needed for this.').waitFor();
    assert.equal((await staff()).includes(who), false);
    await second.page.getByRole('button', { name: 'Invite', exact: true }).click();
    await ask.waitFor();
    await second.page.locator('#owner-confirm-password').fill(OWNER_PASSWORD);
    await second.page.keyboard.press('Enter');
    await ask.waitFor({ state: 'detached' });
    await waitFor(staff, (list) => list.includes(who), 'invited once confirmed');
    await second.page.getByRole('list', { name: 'Accountant accounts' }).getByText(who).waitFor();
    assert.equal(await overflow(second.page), false);
    assert.deepEqual(second.errors, []);
    await second.ctx.close();
  });
}
