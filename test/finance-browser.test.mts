/**
 * The accountant's hub, Settings → Payments → VAT and the tax invoice, in Chromium at 375 and 1280 px:
 * the accountant sees only Money (no other section, no settings, read-only expenses) and can move
 * through it by keyboard; the VAT card turns VAT on with the typed confirmation; the tax invoice has
 * no sideways scroll and prints (print styles, a PDF). Screenshots go to BUH_SHOTS (when set).
 * Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild || !pw;
type Page = import('playwright').Page;

const EMAIL = 'admin@beautifuluaehome.com';
const CA = 'books@firm.test';
const CA_PASSWORD = 'Ledger-Reader-2026!';
const SHOTS = process.env.BUH_SHOTS || '';

let server: RunningServer;
let browser: import('playwright').Browser;
let owner = '';
let accountant = '';

const h = () => ({ 'content-type': 'application/json', origin: server.base });
const as = (cookie: string, method: string, p: string, body?: unknown) => fetch(`${server.base}${p}`, { method, headers: { ...h(), cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

before(async () => {
  if (skip) return;
  server = await startServer();
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h(), cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Finance-Owner-Pass-1' }) });
  owner = (changed.headers.get('set-cookie') || '').split(';')[0];
  // The accountant, set up through the API (the setup screen itself is walked below too).
  const inv = (await (await as(owner, 'POST', '/api/admin/staff', { email: CA })).json()) as { link: string };
  const token = decodeURIComponent(inv.link.split('#setup=')[1]);
  const setup = await fetch(`${server.base}/api/admin/staff/setup`, { method: 'POST', headers: h(), body: JSON.stringify({ token, password: CA_PASSWORD }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  accountant = (setup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('buh_admin='))!;
  // An expense with VAT to read.
  await as(owner, 'POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: today(), amount: '105', categoryId: 'packaging', method: 'card', payee: 'Box Co' });
  browser = await pw!.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

async function hubPage(cookie: string, width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800, acceptDownloads: true });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  return { ctx, page };
}

test('the setup link: choose a password, straight into the read-only accounts', { skip }, async () => {
  const inv = (await (await as(owner, 'POST', '/api/admin/staff', { email: 'second@firm.test' })).json()) as { link: string };
  const url = inv.link.replace(/^https?:\/\/[^/]+/, server.base);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 860 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const form = page.getByTestId('accountant-setup');
  await form.waitFor();
  assert.ok(!page.url().includes('#setup='), 'the token is taken out of the address bar');
  await shot(page, 'accountant-setup-375');
  await form.getByLabel('New password').fill(CA_PASSWORD);
  await form.getByLabel('Type it again').fill(CA_PASSWORD);
  await form.getByRole('button', { name: /Save and open/ }).click();
  await page.getByTestId('accountant-hub').waitFor();
  await ctx.close();
});

for (const width of [375, 1280]) {
  test(`the accountant at ${width} px sees only Money, read-only, and moves through it by keyboard`, { skip }, async () => {
    const { ctx, page } = await hubPage(accountant, width);
    const hub = page.getByTestId('accountant-hub');
    await hub.waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Admin sections' }).count(), 0, 'no other sections');
    for (const other of ['Orders & Dispatches', 'Inventory', 'Customers', 'Settings', 'Chats']) assert.equal(await page.getByRole('button', { name: other, exact: true }).count(), 0, other);
    const sections = page.getByRole('group', { name: 'Money sections' });
    await sections.waitFor();
    assert.match(await hub.innerText(), /Read-only access for books@firm\.test/);
    await page.getByRole('heading', { name: 'Reports' }).waitFor();
    assert.equal(await page.locator('select[id$="-start"]').isDisabled(), true, 'the financial year’s start can’t be changed');
    await shot(page, `accountant-money-reports-${width}`);
    // Expenses: the list, no Add/Edit/Remove.
    const expenses = sections.getByRole('button', { name: 'Expenses' });
    await expenses.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Expenses' }).waitFor();
    await page.getByTestId('expense-item').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add expense' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Remove' }).count(), 0);
    assert.ok((await page.getByRole('button', { name: 'History' }).count()) > 0, 'history is readable');
    await shot(page, `accountant-money-expenses-${width}`);
    await page.keyboard.press('Tab');
    await sections.getByRole('button', { name: 'Audit log' }).click();
    await page.getByRole('heading', { name: /Audit log/ }).first().waitFor();
    assert.ok((await sideways(page)) <= 0, `no sideways scroll at ${width}`);
    await ctx.close();
  });
}

for (const width of [375, 1280]) {
  test(`Settings → Payments → VAT at ${width} px: off, the typed confirmation, then on`, { skip }, async () => {
    const { ctx, page } = await hubPage(owner, width);
    await openAdminSection(page, /^Settings/);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Payments', exact: true }).click();
    const card = page.getByTestId('vat-settings');
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    if (width === 375) {
      assert.match(await card.innerText(), /VAT · off/);
      assert.match(await card.innerText(), /Talk to your accountant before turning this on/);
      const on = card.getByRole('button', { name: 'Turn VAT on' });
      await card.getByLabel('TRN (15 digits)').fill('100123456700003');
      await card.getByLabel('Address on tax invoices').fill('Shop 4, Marina Walk, Dubai');
      assert.equal(await on.isDisabled(), true, 'not without the typed confirmation');
      await card.getByLabel(/To turn VAT on, type TURN ON VAT/).fill('TURN ON VAT');
      await card.screenshot({ path: SHOTS ? path.join(SHOTS, 'vat-settings-off-375.png') : undefined });
      await on.click();
      await card.getByText(/VAT is on from/).waitFor();
    }
    assert.match(await card.innerText(), /VAT · on/);
    // Unticking "Prices include VAT" warns that shoppers then see prices before VAT (not saved here).
    const inclusive = card.getByRole('checkbox', { name: /Prices include VAT/ });
    assert.equal(await inclusive.isChecked(), true, 'inclusive by default');
    assert.equal(await card.getByTestId('vat-exclusive-warning').count(), 0);
    await inclusive.uncheck();
    assert.match(await card.getByTestId('vat-exclusive-warning').innerText(), /shoppers see every price before VAT/);
    assert.ok((await sideways(page)) <= 0, `no sideways scroll with the warning at ${width}`);
    await inclusive.check();
    await card.getByTestId('vat-exclusive-warning').waitFor({ state: 'detached' });
    assert.ok((await sideways(page)) <= 0, `no sideways scroll at ${width}`);
    if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `vat-settings-on-${width}.png`) });
    await ctx.close();
  });
}

test('the tax invoice at 375 and 1280 px: no sideways scroll, and it prints', { skip }, async () => {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const placed = await rawFetch(`${server.base}/api/orders`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      customer: { fullName: 'Fatima Al Mansoori', email: 'fatima@example.com', phone: '+971507771299', emirate: 'Abu Dhabi', area: 'Al Reem Island', streetAddress: 'Sun Tower', buildingVilla: 'Sun Tower', flatVillaNo: '2304' },
      items: [
        { productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 2 },
        { productId: products[1].id, profileId: products[1].profiles[0].id, quantity: 1 },
      ],
      paymentMethod: 'cod',
    }),
  });
  assert.equal(placed.status, 201, await placed.clone().text());
  const order = ((await placed.json()) as { order: { id: string; documentPath: string; documentLabel: string } }).order;
  assert.equal(order.documentLabel, 'Tax invoice', 'VAT is on (the test before)');
  assert.equal((await as(owner, 'PATCH', `/api/admin/orders/${order.id}`, { status: 'confirmed', shipUnconfirmed: true })).status, 200);
  // The hub's Money → VAT return shows it.
  {
    const { ctx, page } = await hubPage(accountant, 375);
    await page.getByRole('group', { name: 'Money sections' }).getByRole('button', { name: 'VAT' }).click();
    await page.getByTestId('vat-output-vat').waitFor();
    assert.notEqual((await page.getByTestId('vat-output-vat').innerText()).trim(), '0.00');
    await shot(page, 'accountant-vat-return-375');
    await ctx.close();
  }
  for (const width of [375, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const res = await page.goto(`${server.base}${order.documentPath}`);
    assert.equal(res!.status(), 200);
    await page.getByRole('heading', { name: 'Tax Invoice' }).waitFor();
    assert.ok((await sideways(page)) <= 0, `no sideways scroll at ${width}`);
    // Styled (the inline style is allowed by the policy sent), the print note hidden in print.
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector('main')!).borderTopStyle), 'none');
    await shot(page, `tax-invoice-${width}`);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.print')!).display), 'none');
    if (width === 1280) {
      const pdf = await page.pdf({ format: 'A4' });
      assert.ok(pdf.length > 1000 && pdf.subarray(0, 5).toString() === '%PDF-', 'prints to PDF');
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'tax-invoice.pdf'), pdf);
    }
    await ctx.close();
  }
});
