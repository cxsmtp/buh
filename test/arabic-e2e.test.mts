/**
 * The Arabic shop in a real browser (BUH-02.36.00): a phone set to Arabic gets the shop in Arabic,
 * right to left, with the product's Arabic name; the switch at the top changes to English and the
 * choice is kept; the Terms page in both languages; the checkout line linking the Terms. Phone
 * (375 px) and laptop (1280 px), no sideways scroll.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild || !pw;
type Page = import('playwright').Page;
const EMAIL = 'admin@beautifuluaehome.com';
const OWNER_PASSWORD = ownerPassword();

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
let arabicName = '';

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

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
  await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877', legalName: 'Beautiful Home Trading LLC', tradeLicenceNumber: '1234567' } });
  const products = (await (await fetch(`${server.base}/api/products`)).json()).products as Array<{ id: string }>;
  arabicName = 'طقم سرير الياسمين الأبيض';
  const res = await api('PATCH', `/api/admin/products/${products[0].id}`, { product: { titleAr: arabicName, shortDescriptionAr: 'قطن ناعم ونقشة هادئة.' } });
  assert.equal(res.status, 200, await res.text());
  browser = await pw!.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

for (const width of [375, 1280]) {
  test(`a device in Arabic gets the shop in Arabic, right to left, and the switch keeps English (${width} px)`, { skip }, async () => {
    const ctx = await browser.newContext({ locale: 'ar-AE', viewport: { width, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(server.base + '/');
    await page.waitForFunction(() => document.documentElement.dir === 'rtl');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ar-AE');
    const sw = page.getByTestId('language-switch').first();
    await sw.waitFor();
    assert.equal((await sw.textContent())?.trim(), 'English');
    await page.getByText(arabicName).first().waitFor();
    assert.equal(await overflow(page), false, 'no sideways scroll in Arabic');
    // The terms link in the footer, in Arabic.
    const terms = page.getByTestId('footer-terms');
    assert.match((await terms.textContent()) ?? '', /الشروط والأحكام/);
    // Switch to English: left to right, English words, and kept after a reload.
    await sw.click();
    await page.waitForFunction(() => document.documentElement.dir === 'ltr');
    assert.equal((await page.getByTestId('language-switch').first().textContent())?.trim(), 'العربية');
    assert.match((await page.getByTestId('footer-terms').textContent()) ?? '', /Terms & Conditions/);
    await page.reload();
    await page.getByTestId('language-switch').first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'ltr', 'the choice is kept');
    assert.equal(await overflow(page), false, 'no sideways scroll in English');
    await ctx.close();
  });

  test(`the Terms page: Arabic for an Arabic device, English after the switch, the seller's details filled in (${width} px)`, { skip }, async () => {
    const ctx = await browser.newContext({ locale: 'ar-AE', viewport: { width, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(server.base + '/terms');
    await page.getByRole('heading', { level: 1, name: 'الشروط والأحكام' }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
    const text = (await page.getByTestId('terms').textContent()) ?? '';
    assert.match(text, /Beautiful Home Trading LLC/);
    assert.match(text, /1234567/);
    assert.doesNotMatch(text, /\{(legal|licence|address|contact|site)\}/);
    assert.equal(await overflow(page), false);
    await page.getByTestId('language-switch').click();
    await page.getByRole('heading', { level: 1, name: 'Terms & Conditions' }).waitFor();
    const en = (await page.getByTestId('terms').textContent()) ?? '';
    assert.match(en, /no returns|not accept returns/i);
    assert.match(en, /48 hours/);
    // The contents link jumps to its section.
    await page.getByRole('link', { name: /Damaged, faulty|faulty/i }).first().click();
    await page.waitForFunction(() => location.hash === '#faulty');
    assert.equal(await overflow(page), false);
    await ctx.close();
  });
}

test('an English device gets English, left to right; the switch offers Arabic', { skip }, async () => {
  const ctx = await browser.newContext({ locale: 'en-GB', viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(server.base + '/');
  const sw = page.getByTestId('language-switch').first();
  await sw.waitFor();
  assert.equal((await sw.textContent())?.trim(), 'العربية');
  assert.equal(await page.evaluate(() => document.documentElement.dir || 'ltr'), 'ltr');
  const res = await fetch(`${server.base}/terms`);
  assert.equal(res.status, 200);
  await ctx.close();
});

for (const width of [375, 1280]) {
  test(`Money → Courier: Jeebly's statement is previewed, saved once, and totalled; no sideways scroll (${width} px)`, { skip }, async () => {
    const hub = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    const { openAdminSection } = await import('./helpers.mjs');
    await openAdminSection(hp, /^Money/);
    await hp.getByRole('button', { name: 'Courier', exact: true }).click();
    await hp.getByTestId('courier-charges').waitFor();
    const awb = `JBE2E${width}`;
    await hp.getByTestId('courier-statement-file').setInputFiles({ name: 'jeebly-statement.csv', mimeType: 'text/csv', buffer: Buffer.from(`AWB No,Shipping Charges,COD Amount,Date\n${awb},18.50,250,01/11/2026\n`) });
    const preview = hp.getByTestId('courier-statement-preview');
    await preview.waitFor();
    assert.match((await preview.textContent()) ?? '', new RegExp(`${awb}.*18\\.50.*Not a shop order`));
    assert.equal(await overflow(hp), false);
    await hp.getByTestId('courier-statement-save').click();
    await hp.getByText(/Saved: 1 new/).waitFor();
    // The total counts every charge so far (the other width's run too); this one is in the list.
    assert.match((await hp.getByTestId('courier-charges-total').textContent()) ?? '', /AED \d/);
    await hp.getByTestId('courier-charges').getByText(awb).first().waitFor();
    const expenses = (await (await api('GET', '/api/admin/expenses')).json()).expenses as Array<{ note: string; amountFils: number; categoryId: string }>;
    assert.equal(expenses.filter((e) => e.note.includes(awb)).length, 1);
    assert.equal(expenses.find((e) => e.note.includes(awb))!.categoryId, 'courier');
    assert.equal(await overflow(hp), false);
    assert.deepEqual(errors, []);
    await hub.close();
  });
}
