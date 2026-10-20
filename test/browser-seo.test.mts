/**
 * Search (SEO) and SKUs against the production build. The new admin routes: without the door the
 * unknown address, without a session 401, cross-site 403, bad bodies 400/415. In Chromium at 375 px
 * and 1280 px: /gifts/diwali live with the products that have a Diwali gift line first (the line
 * shown); /shop/<category>; a product page's JSON-LD; Settings → Search (SEO) with Google-style
 * previews; a festival page's title edited there shows on the page; switched off it says noindex
 * and leaves the sitemap; the keyboard reaches the controls; text boxes are 16 px on phones; a new
 * product gets an SKU by itself (Regenerate, then edited), and its Google preview. Inventory's
 * "Fill them in". No sideways scroll anywhere. Screenshots go to SHOT_DIR (or the server's DATA_DIR).
 * Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !hasBuild || !pw;
type Page = import('playwright').Page;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
const SITE = 'https://beautifuluaehome.com';
const FORMAT = /^[A-Z0-9]{2,6}-[A-Z0-9]{2,3}-[A-Z0-9]{1,6}-\d{3,}$/;

before(async () => {
  if (skip) return;
  server = await startServer({ NEXT_PUBLIC_APP_URL: SITE });
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Search-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
const page$ = async (p: string) => (await rawFetch(`${server.base}${p}`)).text();
/** Pages and API routes keep their own copy of settings and products for up to 2 seconds: wait for it. */
async function eventually(p: string, ok: (html: string) => boolean, what: string): Promise<string> {
  let html = '';
  for (let i = 0; i < 40; i++) {
    html = await page$(p);
    if (ok(html)) return html;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.fail(`${what}: ${p}`);
}
const shotDir = () => process.env.SHOT_DIR || server.dataDir;
const shot = (page: Page, name: string, fullPage = false) => page.screenshot({ path: path.join(shotDir(), name), fullPage });
const overflow = (page: Page) => page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
async function answer(res: Response) {
  const body = await res.text();
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'date').map(([k, v]) => `${k}: ${v}`).sort();
  return { status: res.status, body, headers };
}
interface P {
  id: string;
  title: string;
  sku?: string;
  category: string;
  giftLines?: Record<string, string>;
}
const allProducts = async (): Promise<P[]> => (await (await api('GET', '/api/admin/products')).json()).products;

async function hub(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
  return { ctx, page, errors };
}

test('the new admin routes: no door → the unknown address; no session → 401; cross-site → 403; bad bodies 400/415', { skip }, async () => {
  const [a] = await allProducts();
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/seo'],
    ['PUT', '/api/admin/seo', { settings: { leadDays: 45 } }],
    ['PUT', '/api/admin/seo/product', { id: a.id, seoTitle: '', seoDescription: '' }],
    ['POST', '/api/admin/products/sku-suggest', { title: 'X', category: a.category }],
    ['GET', '/api/admin/products/sku-fill'],
    ['POST', '/api/admin/products/sku-fill', {}],
  ];
  const unknown = await answer(await rawFetch(`${server.base}/api/no-such-${crypto.randomBytes(4).toString('hex')}`, { headers: { cookie } }));
  for (const [method, url, body] of routes) {
    const init = (headers: Record<string, string>) => ({ method, headers: { 'content-type': 'application/json', origin: server.base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.deepEqual(await answer(await rawFetch(`${server.base}${url}`, init({ cookie }))), unknown, `${method} ${url} without the door`);
    const out = await rawFetch(`${server.base}${url}`, init({ cookie: server.door }));
    assert.equal(out.status, 401, `${method} ${url} without a session`);
    await out.arrayBuffer();
    if (method !== 'GET') {
      const res = await api(method, url, body, { origin: 'https://evil.example' });
      assert.equal(res.status, 403, `${method} ${url} cross-site`);
      await res.arrayBuffer();
      const wrongType = await api(method, url, 'x', { 'content-type': 'text/plain' });
      assert.equal(wrongType.status, 415, `${method} ${url} text body`);
      await wrongType.arrayBuffer();
    }
  }
  assert.equal((await api('PUT', '/api/admin/seo', { settings: { leadDays: 45 }, extra: 1 })).status, 400);
  assert.equal((await api('PUT', '/api/admin/seo', { settings: { googleVerification: '"><script>' } })).status, 400);
  assert.equal((await api('POST', '/api/admin/products/sku-suggest', { title: 'X', category: 'no-such' })).status, 400);
  const suggested = await (await api('POST', '/api/admin/products/sku-suggest', { title: 'Indigo Chevron', category: a.category })).json();
  assert.match(suggested.sku, FORMAT);
  assert.match(suggested.sku, /-INDCHV-/);
});

test('robots, sitemap and the IndexNow key file: as built', { skip }, async () => {
  const robots = await page$('/robots.txt');
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/beautifuluaehome\.com\/sitemap\.xml/);
  assert.ok(!robots.includes(server.adminPath) && !/hub/i.test(robots), 'the hub is never named');
  const sitemap = await page$('/sitemap.xml');
  assert.match(sitemap, /<loc>https:\/\/beautifuluaehome\.com\/gifts\/diwali<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/beautifuluaehome\.com\/shop\/bedsheets<\/loc>/);
  assert.match(sitemap, /<image:loc>/);
  assert.ok(!sitemap.includes(server.adminPath) && !/\/(c|hub|api|pay|invoice)\//.test(sitemap));
  const key = await rawFetch(`${server.base}/indexnow-key.txt`);
  assert.equal(key.status, 404, 'IndexNow is off by default: no key file');
  await key.arrayBuffer();
});

test('a product page carries its structured data: price per size in AED, stock, the SKU; never a rating', { skip }, async () => {
  const [p] = (await (await rawFetch(`${server.base}/api/products`)).json()).products as P[];
  const html = await page$(`/p/${p.id}`);
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const product = scripts.find((s) => s['@type'] === 'Product');
  assert.ok(product, 'Product JSON-LD');
  assert.equal(product.offers[0].priceCurrency, 'AED');
  assert.match(product.offers[0].price, /^\d+\.\d{2}$/);
  assert.ok(!('aggregateRating' in product) && !('review' in product));
  assert.ok(scripts.some((s) => s['@type'] === 'BreadcrumbList'));
  assert.match(html, /<link rel="canonical" href="https:\/\/beautifuluaehome\.com\/p\//);
});

for (const width of [375, 1280]) {
  test(`at ${width}px: /gifts/diwali (live) shows the products with a Diwali gift line first; /shop/bedsheets`, { skip: skipBrowser }, async () => {
    const list = (await (await rawFetch(`${server.base}/api/products`)).json()).products as P[];
    const chosen = list[list.length - 1];
    const line = `A Diwali gift that brightens the bedroom (${width})`;
    const res = await api('PATCH', `/api/admin/products/${chosen.id}`, { product: { giftLines: { diwali: line } } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await api('PUT', '/api/admin/seo', { settings: { festivals: { diwali: { mode: 'live' } } } })).status, 200);

    const ctx = await browser.newContext({ viewport: { width, height: 860 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await eventually('/gifts/diwali', (h) => h.includes(line), 'the gift line is on the page');
    await page.goto(`${server.base}/gifts/diwali`);
    await page.getByRole('heading', { level: 1, name: /Diwali gifts/ }).waitFor();
    assert.equal(await page.getByTestId('landing-notice').count(), 1, 'the dates');
    const first = page.getByTestId('landing-products').locator('li').first();
    assert.match(await first.innerText(), new RegExp(chosen.title.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await first.getByTestId('landing-gift-line').innerText(), line);
    assert.ok((await page.getByTestId('landing-products').locator('li').count()) > 1);
    const img = first.locator('img');
    assert.equal(await img.getAttribute('width'), '540');
    assert.ok((await img.getAttribute('alt'))!.length > 3, 'alt text');
    assert.match(await page.title(), /Diwali/);
    assert.equal(await page.locator('meta[name="robots"][content*="noindex"]').count(), 0);
    assert.deepEqual(await overflow(page), []);
    // Keyboard: the first product link is reached with Tab.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.closest('[data-testid="landing-products"]') !== null)) break;
    }
    assert.ok(await page.evaluate(() => document.activeElement?.closest('[data-testid="landing-products"]') !== null), 'Tab reaches the products');
    await shot(page, `gifts-diwali-${width}.png`);

    await page.goto(`${server.base}/shop/bedsheets`);
    await page.getByTestId('category-page').waitFor();
    assert.ok((await page.getByTestId('landing-products').locator('li').count()) > 0);
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), `${SITE}/shop/bedsheets`);
    assert.deepEqual(await overflow(page), []);
    if (width === 375) await shot(page, 'shop-bedsheets-375.png');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: Settings → Search (SEO): previews, a festival title edited and shown, switched off → noindex`, { skip: skipBrowser }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Settings/);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Search (SEO)', exact: true }).click();
    const panel = page.getByTestId('seo-settings');
    await panel.waitFor();
    assert.ok((await panel.getByTestId('seo-page-row').count()) > 10, 'home, categories, festivals and products');
    assert.ok((await panel.getByTestId('seo-pages').getByTestId('snippet-preview').count()) > 10, 'each with a Google-style preview');
    assert.deepEqual(await overflow(page), []);
    await shot(page, `seo-settings-${width}.png`);
    // Text boxes are 16 px on phones (no zoom on iPhones).
    const size = await page.locator('#seo-google').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    if (width < 640) assert.ok(size >= 16, `${size}px`);

    // The schedule: Diwali's words, edited with the keyboard.
    const row = panel.getByTestId('seo-schedule-row').filter({ has: page.getByText('Diwali', { exact: true }) });
    await row.scrollIntoViewIfNeeded();
    if (width === 1280) await shot(page, 'festival-schedule-1280.png');
    const edit = row.getByRole('button', { name: /^Edit words/ });
    await edit.focus();
    await page.keyboard.press('Enter');
    const title = `Diwali gift bedsheets in Dubai ${width}`;
    await row.getByLabel('Title').fill(title);
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await row.getByText('Saved.').waitFor();
    await eventually('/gifts/diwali', (h) => h.includes(`<title>${title}</title>`), 'the new title');
    assert.deepEqual(await overflow(page), []);

    // Off: noindex, out of the sitemap.
    await row.getByRole('button', { name: 'Off', exact: true }).click();
    await row.getByRole('button', { name: 'Off', exact: true, pressed: true }).waitFor();
    await eventually('/gifts/diwali', (h) => /<meta name="robots" content="noindex, follow"/.test(h), 'noindex');
    await eventually('/sitemap.xml', (h) => !h.includes('/gifts/diwali<'), 'out of the sitemap');
    await row.getByRole('button', { name: 'Automatic', exact: true }).click();
    await row.getByRole('button', { name: 'Automatic', exact: true, pressed: true }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: a new product gets its SKU by itself (Regenerate, edit), with its Google preview; Inventory fills missing SKUs`, { skip: skipBrowser }, async () => {
    // Two products without an SKU (as products from before SKUs were made).
    const db = new Database(path.join(server.dataDir, 'shop.db'));
    const rows = db.prepare('SELECT id, data FROM products WHERE archived = 0 LIMIT 2').all() as Array<{ id: string; data: string }>;
    for (const r of rows) {
      const d = JSON.parse(r.data);
      delete d.sku;
      db.prepare('UPDATE products SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(d), new Date().toISOString(), r.id);
    }
    db.prepare("INSERT INTO kv (key, data, updated_at) VALUES ('v:catalog', '1000', ?) ON CONFLICT(key) DO UPDATE SET data = CAST(CAST(data AS INTEGER) + 1 AS TEXT)").run(new Date().toISOString());
    db.close();
    for (let i = 0; i < 40 && (await (await api('GET', '/api/admin/products/sku-fill')).json()).missing < 2; i++) await new Promise((r) => setTimeout(r, 200));

    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('heading', { name: 'Inventory' }).waitFor();
    const fill = page.getByTestId('fill-skus');
    await fill.getByText(/no SKU/).waitFor();
    await fill.getByRole('button', { name: 'Fill them in' }).click();
    await fill.getByText(/SKUs given to \d+ product/).waitFor();
    for (const r of rows) assert.match((await allProducts()).find((p) => p.id === r.id)!.sku!, FORMAT);

    await page.getByRole('button', { name: 'Add product' }).first().click();
    const editor = page.getByRole('dialog', { name: 'Add a product' });
    await editor.waitFor();
    await editor.getByLabel('Choose photos from the gallery').setInputFiles([{ name: 'sheet-indigo.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join('test/fixtures', 'sheet-indigo.png')) }]);
    await editor.getByAltText('Cover photo').waitFor();
    await editor.getByRole('button', { name: /^Next: Details/ }).click();
    const name = `Indigo Chevron Set ${width}`;
    await editor.getByLabel('Name', { exact: true }).fill(name);
    const skuBox = editor.getByLabel('SKU', { exact: true });
    await page.waitForFunction(() => /^[A-Z0-9]+-[A-Z0-9]+-INDCHV-\d{3,}$/.test((document.getElementById('pe-sku') as HTMLInputElement | null)?.value ?? ''));
    const made = await skuBox.inputValue();
    assert.match(made, FORMAT);
    await editor.getByText('Made automatically — change it if you have your own codes.').waitFor();
    await editor.getByRole('button', { name: 'Regenerate' }).click();
    await page.waitForFunction(() => /-INDCHV-\d{3,}$/.test((document.getElementById('pe-sku') as HTMLInputElement | null)?.value ?? ''));
    assert.deepEqual(await overflow(page), [], 'details step');
    await shot(page, `sku-editor-${width}.png`);
    await skuBox.fill(`own-${width}`);
    assert.equal(await skuBox.inputValue(), `OWN-${width}`, 'capitals as typed');
    await editor.getByLabel('Price (AED)').fill('345');
    await editor.getByRole('button', { name: /^Next: Sizes/ }).click();
    await editor.getByRole('button', { name: /^Next: Publish/ }).click();
    await editor.getByText('Search (Google): title and description').click();
    await editor.getByLabel('SEO title (optional)').fill(`Indigo chevron bedsheets UAE ${width}`);
    await editor.getByTestId('product-snippet-preview').getByText(`Indigo chevron bedsheets UAE ${width}`).waitFor();
    assert.deepEqual(await overflow(page), [], 'publish step');
    if (width === 1280) await shot(page, 'product-snippet-preview-1280.png');
    await editor.getByRole('button', { name: 'Publish', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    const saved = (await allProducts()).find((p) => p.title === name)! as P & { seoTitle?: string };
    assert.equal(saved.sku, `OWN-${width}`);
    assert.equal(saved.seoTitle, `Indigo chevron bedsheets UAE ${width}`);
    await eventually(`/p/${saved.id}`, (h) => h.includes(`<title>Indigo chevron bedsheets UAE ${width}</title>`), 'the product’s own title');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('home page: the shop as structured data and the live festival linked, after the page is rebuilt', { skip }, async () => {
  assert.equal((await api('PUT', '/api/admin/seo', { settings: { festivals: { diwali: { mode: 'live' } }, googleVerification: 'HomeCode_abcdef12' } })).status, 200);
  let html = '';
  for (let i = 0; i < 40; i++) {
    html = await page$('/');
    if (html.includes('HomeCode_abcdef12')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.match(html, /<meta name="google-site-verification" content="HomeCode_abcdef12"/);
  assert.match(html, /data-testid="festival-gifts-link"/);
  assert.match(html, /href="\/shop\/bedsheets"/);
  assert.match(html, /"@type":"OnlineStore"/);
  assert.ok(!/aggregateRating/.test(html));
});
