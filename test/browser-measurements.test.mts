/**
 * Measurements and colours as the owner fills them in (reported: "only those details filled by
 * admin should be shown; a check box for fitted, else it's a flat sheet; colours only when
 * selected"), in Chromium against the production build at 375 px and 1280 px: the product sheet
 * shows only the rows given ("Flat sheet" or "Fitted sheet"), no Measurements section when there
 * are none, no colour choice without colours, one colour as a label; the bag line follows; the
 * editor's Fitted checkbox (keyboard), "Use standard sizes" and the "Check measurements" mark.
 * Screenshots go to SHOT_DIR (or the server's DATA_DIR). Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

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
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Measure-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

interface P {
  id: string;
  title: string;
  fitted?: boolean;
  measurementsReview?: boolean;
  featuredImage: string;
  profiles: Array<Record<string, unknown> & { id: string }>;
}
const all = async (): Promise<P[]> => (await (await api('GET', '/api/admin/products')).json()).products;

const king = (over: Record<string, unknown>) => ({ id: 'king', name: 'King Size Bed', badge: 'King', mattressSize: '180 x 200 cm', fittedSheet: '', flatSheet: '', pillowcases: '', piecesIncluded: 3, priceDelta: 0, ...over });
async function make(title: string, over: Record<string, unknown>): Promise<P> {
  const base = (await all())[0];
  const res = await api('POST', '/api/admin/products', {
    product: { title, category: 'bedsheets', price: 300, featuredImage: base.featuredImage, galleryImages: [], material: 'Cotton', threadCount: 300, weave: 'Percale', description: 'A set.', shortDescription: '', defaultProfileId: 'king', stockBySize: { king: 5 }, ...over },
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).product;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// SHOT_DIR keeps them after the run (the server's DATA_DIR is removed when it stops).
const shotDir = () => process.env.SHOT_DIR || server.dataDir;
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shotDir(), name), fullPage: false });

async function openProduct(width: number, p: P) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${server.base}/p/${p.id}`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog', { name: p.title });
  await sheet.waitFor();
  return { ctx, page, sheet, errors };
}
const rows = (sheet: import('playwright').Locator) => sheet.getByTestId('measurements').locator('dt').allTextContents();

let made: Record<string, P> | null = null;
async function products() {
  if (made) return made;
  made = {
    flat: await make('Flat Only Set', { colors: [], profiles: [king({ flatSheet: '260 x 270 cm', pillowcases: '2 pcs (50 x 75 cm)' })] }),
    fitted: await make('Fitted One Colour Set', { fitted: true, colors: [{ name: 'Ivory', hex: '#f5f0e6' }], profiles: [king({ fittedSheet: '180 x 200 + 40 cm pocket', flatSheet: '260 x 270 cm', duvetCover: '240 x 260 cm' })] }),
    bare: await make('Bare Two Colour Set', { colors: [{ name: 'Sage', hex: '#88a080' }, { name: 'Rose', hex: '#c28277' }], profiles: [king({ mattressSize: '' })] }),
  };
  return made;
}

for (const width of [375, 1280]) {
  test(`product sheet at ${width}px: only the measurements given, Flat or Fitted sheet, colours only when given`, { skip }, async () => {
    const m = await products();

    // Flat sheet + pillowcases: exactly those two rows, no colour at all.
    let { ctx, page, sheet, errors } = await openProduct(width, m.flat);
    const summary = sheet.locator('summary', { hasText: 'Measurements for' });
    await summary.focus();
    await page.keyboard.press('Enter'); // keyboard opens it
    await sheet.getByTestId('measurements').locator('dl').waitFor();
    assert.deepEqual(await rows(sheet), ['Flat sheet', 'Pillowcases']);
    await sheet.getByText('260 x 270 cm').waitFor();
    assert.equal(await sheet.getByText(/Duvet cover|Fitted sheet|Mattress/).count(), 0);
    assert.equal(await sheet.getByTestId('colour-picker').count(), 0);
    assert.equal(await sheet.getByTestId('colour-label').count(), 0);
    assert.equal(await sheet.getByText(/^Colour/).count(), 0);
    assert.equal(await overflow(page), 0);
    await shot(page, `measure-flat-${width}.png`);
    // The bag line: the flat sheet's size, and no colour.
    await sheet.getByRole('button', { name: /^Add to Bag/ }).click();
    const bag = page.getByRole('dialog', { name: /bag/i });
    await bag.getByText('Flat sheet: 260 x 270 cm').waitFor();
    await page.waitForTimeout(500); // the bag has finished sliding in
    assert.equal(await bag.getByText(/undefined|Standard/).count(), 0);
    assert.equal(await overflow(page), 0);
    await shot(page, `measure-bag-${width}.png`);
    assert.deepEqual(errors, []);
    await ctx.close();

    // Fitted ticked: "Fitted sheet" (never the flat size), the duvet cover given; one colour as a label.
    ({ ctx, page, sheet, errors } = await openProduct(width, m.fitted));
    await sheet.locator('summary', { hasText: 'Measurements for' }).click();
    assert.deepEqual(await rows(sheet), ['Fitted sheet', 'Duvet cover']);
    assert.equal(await sheet.getByText('260 x 270 cm').count(), 0, 'the flat size is not shown on a fitted set');
    await sheet.getByTestId('colour-label').getByText('Ivory').waitFor();
    assert.equal(await sheet.getByRole('button', { name: 'Ivory' }).count(), 0, 'one colour: a label, not a choice');
    assert.equal(await overflow(page), 0);
    await shot(page, `measure-fitted-${width}.png`);
    assert.deepEqual(errors, []);
    await ctx.close();

    // No measurements: no section. Two colours: a choice.
    ({ ctx, page, sheet, errors } = await openProduct(width, m.bare));
    assert.equal(await sheet.getByTestId('measurements').count(), 0);
    assert.equal(await sheet.getByText(/Measurements for/).count(), 0);
    await sheet.getByTestId('colour-picker').waitFor();
    await sheet.getByRole('button', { name: 'Rose' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await sheet.getByRole('button', { name: 'Rose' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await overflow(page), 0);
    await shot(page, `measure-bare-${width}.png`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`editor at ${width}px: "Check measurements", the Fitted checkbox by keyboard, "Use standard sizes", "Put it back" (what the update kept aside); saving clears the mark`, { skip }, async () => {
    await products();
    const title = `Review Set ${width}`;
    const p = await make(title, { colors: [], profiles: [king({ pillowcases: 'Own: 2 pcs' })] });
    // As the update marks the products already in the shop.
    assert.equal((await api('PATCH', `/api/admin/products/${p.id}`, { product: { measurementsReview: true, legacyMeasurements: { king: { duvetCover: '240 x 260 cm' } } } })).status, 200);

    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await ctx.addCookies([{ name, value, url: server.base }]);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('heading', { name: 'Inventory' }).waitFor();
    await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(title);
    const row = page.getByRole('button', { name: `Stock and actions for ${title}` });
    await row.getByText('Check measurements').waitFor();
    await row.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    assert.equal(await overflow(page), 0);
    await shot(page, `measure-badge-${width}.png`);
    await row.click();
    await page.getByRole('button', { name: `Edit ${title}` }).click();
    const editor = page.getByRole('dialog', { name: `Edit ${title}` });
    await editor.waitFor();
    await editor.getByRole('button', { name: /^Next: Details/ }).click();
    await editor.getByRole('button', { name: /^Next: Sizes/ }).click();
    await editor.getByTestId('measurements-review').waitFor();
    const keptAside = editor.getByTestId('measurements-legacy');
    await keptAside.getByText(/Taken off the shop by the update:.*King.* duvet cover 240 x 260 cm/).waitFor();
    await shot(page, `measure-editor-top-${width}.png`);

    // The Fitted checkbox, by keyboard.
    const fitted = editor.getByRole('checkbox', { name: /Fitted sheet \(elastic corners\)/ });
    assert.equal(await fitted.isChecked(), false, 'flat by default');
    await editor.getByText(/the set has a flat sheet/).waitFor();
    await fitted.focus();
    await page.keyboard.press('Space');
    assert.equal(await fitted.isChecked(), true);

    await editor.getByRole('button', { name: 'Measurements & price' }).click();
    // Only the fitted sheet's field now; empty, the standard size only as a hint.
    const fittedField = editor.getByLabel('Fitted sheet', { exact: true });
    assert.equal(await fittedField.inputValue(), '');
    assert.match((await fittedField.getAttribute('placeholder')) || '', /^e\.g\. 180 x 200/);
    assert.equal(await editor.getByLabel('Flat sheet', { exact: true }).count(), 0);
    await editor.getByRole('button', { name: 'Use standard sizes for King Size Bed' }).focus();
    await page.keyboard.press('Enter');
    assert.match(await fittedField.inputValue(), /^180 x 200/, 'filled from the standard size');
    assert.equal(await editor.getByLabel('Pillowcases', { exact: true }).inputValue(), 'Own: 2 pcs', 'what was typed is kept');
    assert.equal(await editor.getByLabel('Duvet cover', { exact: true }).inputValue(), '', 'no duvet cover for a sheet set');
    await editor.getByLabel('Other pieces (e.g. cushion covers)').fill('2 cushion covers 45 x 45 cm');
    // "Put it back", by keyboard: the duvet cover the update took off returns to the size.
    await keptAside.getByRole('button', { name: 'Put it back' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await editor.getByLabel('Duvet cover', { exact: true }).inputValue(), '240 x 260 cm');
    await waitGone(editor.getByTestId('measurements-legacy'));
    assert.equal(await overflow(page), 0);
    await shot(page, `measure-editor-${width}.png`);

    await editor.getByRole('button', { name: /^Next: Publish/ }).click();
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await editor.waitFor({ state: 'detached' });
    const saved = (await all()).find((x) => x.id === p.id)!;
    assert.equal(saved.fitted, true);
    assert.equal(saved.measurementsReview, undefined, 'reviewed');
    assert.match(String(saved.profiles[0].fittedSheet), /^180 x 200/);
    assert.equal(saved.profiles[0].duvetCover, '240 x 260 cm', 'put back by the owner');
    assert.equal((saved as { legacyMeasurements?: unknown }).legacyMeasurements, undefined, 'nothing left aside');
    assert.equal(saved.profiles[0].otherPieces, '2 cushion covers 45 x 45 cm');
    await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(title);
    await page.getByRole('button', { name: `Stock and actions for ${title}` }).waitFor();
    await waitGone(page.getByRole('button', { name: `Stock and actions for ${title}` }).getByText('Check measurements'));
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

async function waitGone(loc: import('playwright').Locator) {
  for (let i = 0; i < 50 && (await loc.count()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await loc.count(), 0);
}

