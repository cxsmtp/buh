/**
 * BUH-02.17 catalogue against the production build. Every new admin route: without the door the
 * unknown address, without a session 401, cross-site 403, bad bodies 400/415/413. In Chromium at
 * 375 px (a phone) and 1280 px (a laptop): the hub opens on Orders with today's to-dos (phone) or
 * the Overview with the money highlights (laptop) and then remembers the owner's last section;
 * a simple product (towels) made in the editor and bought on the shop; several products picked in
 * Inventory and shared as one link; the shopper's /c/<slug> page (OpenGraph preview, add to bag,
 * the counters); an ended link; the Amazon / Noon export. No sideways scroll anywhere.
 * Screenshots go to SHOT_DIR (or the server's DATA_DIR). Skipped without a build or Playwright.
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
const skipBrowser = !pw;
type Page = import('playwright').Page;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Catalogue-Owner-Pass-1' }) });
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
interface P {
  id: string;
  title: string;
  productType?: string;
  stockBySize: Record<string, number>;
  profiles: Array<{ id: string; name: string; dimensions?: string; weightGrams?: number }>;
}
const allProducts = async (): Promise<P[]> => (await (await api('GET', '/api/admin/products')).json()).products;
interface C {
  id: string;
  slug: string;
  title: string;
  productIds: string[];
  views: number;
  bagAdds: number;
}
const allCollections = async (): Promise<C[]> => (await (await api('GET', '/api/admin/collections')).json()).collections;

const shotDir = () => process.env.SHOT_DIR || server.dataDir;
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(shotDir(), name), fullPage: false });
async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}
async function answer(res: Response) {
  const body = await res.text();
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'date').map(([k, v]) => `${k}: ${v}`).sort();
  return { status: res.status, body, headers };
}
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let v = await fn();
  for (let i = 0; i < 50 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 200));
    v = await fn();
  }
  assert.ok(ok(v), `${what}: ${JSON.stringify(v)}`);
  return v;
}
async function hub(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800, acceptDownloads: true });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  return { ctx, page, errors };
}

test('every new admin route: no door → the unknown address; no session → 401; cross-site → 403; bad bodies 400/415/413', { skip }, async () => {
  const [a] = await allProducts();
  const made = await api('POST', '/api/admin/collections', { key: crypto.randomUUID(), title: 'Door test', productIds: [a.id] });
  assert.equal(made.status, 201, await made.clone().text());
  const col = (await made.json()).collection as C;
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/collections'],
    ['POST', '/api/admin/collections', { key: crypto.randomUUID(), title: 'X', productIds: [a.id] }],
    ['PATCH', `/api/admin/collections/${col.id}`, { title: 'Y' }],
    ['DELETE', `/api/admin/collections/${col.id}`],
    ['GET', '/api/admin/exports/marketplace'],
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
    }
  }
  assert.equal((await api('POST', '/api/admin/collections', { key: crypto.randomUUID(), title: 'X', productIds: [a.id], isPublic: true })).status, 400, 'unexpected field');
  assert.equal((await api('PATCH', `/api/admin/collections/${col.id}`, { slug: 'mine-aaaaa' })).status, 400, 'the slug cannot be chosen');
  assert.equal((await api('POST', '/api/admin/collections', '{nope')).status, 400);
  assert.equal((await api('POST', '/api/admin/collections', 'a=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await api('POST', '/api/admin/collections', { key: crypto.randomUUID(), title: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await api('PATCH', '/api/admin/collections/col-000000000000', { title: 'Z' })).status, 404);
  const bad = await api('POST', '/api/admin/collections', { key: crypto.randomUUID(), title: 'X', productIds: ['prod-nope'] });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await bad.text(), /sqlite|stack|at Object/i, 'nothing internal');
  // The public counter: same site only, a tiny body.
  assert.equal((await rawFetch(`${server.base}/api/collections/${col.slug}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"kind":"view"}' })).status, 403);
  assert.equal((await rawFetch(`${server.base}/api/collections/${col.slug}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify({ kind: 'view', pad: 'x'.repeat(400) }) })).status, 413);
  assert.equal((await api('DELETE', `/api/admin/collections/${col.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/admin/collections/${col.id}`)).status, 404);
});

test('the Amazon / Noon export over HTTP: a CSV download, one row per size', { skip }, async () => {
  const res = await api('GET', '/api/admin/exports/marketplace');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^text\/csv/);
  assert.match(res.headers.get('content-disposition') || '', /^attachment; filename="marketplace-export-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 with a BOM (Excel)');
  const lines = bytes.subarray(3).toString('utf8').trim().split('\r\n');
  assert.ok(lines[0].startsWith('sku,parent_sku,title,description,brand,price_aed'));
  const shop = (await (await fetch(`${server.base}/api/products`)).json()).products as P[];
  assert.equal(lines.length - 1, shop.reduce((n, p) => n + p.profiles.length, 0), 'one row per size of each product on sale');
  assert.match(lines[1], /^BUH-[A-Z0-9]+-[A-Z0-9-]+,BUH-/);
});

for (const width of [375, 1280]) {
  test(`at ${width}px: the hub opens on ${width < 800 ? 'Orders with today’s to-dos' : 'the Overview with the money highlights'}, then on the section last chosen on this device`, { skip: skip || skipBrowser }, async () => {
    const { ctx, page, errors } = await hub(width);
    const todos = page.getByTestId('today-todos');
    await todos.waitFor();
    if (width < 800) {
      assert.equal(await page.getByTestId('hub-overview').count(), 0);
      const nav = page.getByRole('navigation', { name: 'Admin sections' });
      assert.equal(await nav.getByRole('button', { name: /^Orders/ }).getAttribute('aria-current'), 'page');
    } else {
      await page.getByTestId('money-highlights').waitFor();
      assert.equal(await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: 'Overview' }).getAttribute('aria-current'), 'page');
    }
    assert.deepEqual(await overflow(page), [], 'landing: no sideways scroll');
    await shot(page, `hub-landing-${width}.png`);
    // The owner picks Inventory: next time this device opens there.
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('heading', { name: 'Inventory' }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Inventory' }).waitFor();
    assert.equal(await todos.count(), 0);
    // And back to the default for the rest of the tests.
    await openAdminSection(page, width < 800 ? /^Orders/ : /^Overview/);
    await todos.waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: a simple product (towels) in the editor, its variants on the shop and in the bag`, { skip: skip || skipBrowser }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('heading', { name: 'Inventory' }).waitFor();
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const editor = page.getByRole('dialog', { name: 'Add a product' });
    await editor.waitFor();
    await editor.getByLabel('Choose photos from the gallery').setInputFiles([{ name: 'towel.png', mimeType: 'image/png', buffer: fs.readFileSync('test/fixtures/sheet-indigo.png') }]);
    await editor.getByAltText('Cover photo').waitFor();
    await editor.getByRole('button', { name: /^Next: Details/ }).click();
    const title = `Hammam Towel ${width}`;
    await editor.getByLabel('Name', { exact: true }).fill(title);
    await editor.getByLabel('Price (AED)').fill('60');
    await editor.getByRole('radio', { name: /^Other/ }).check();
    await editor.getByText(/More details/).click();
    assert.equal(await editor.getByLabel('Thread count').count(), 0, 'no thread count or weave for a towel');
    assert.deepEqual(await overflow(page), [], 'details step');
    await editor.getByRole('button', { name: /^Next: Sizes/ }).click();
    const variants = editor.getByTestId('variants');
    await variants.waitFor();
    assert.equal(await editor.getByText(/Fitted sheet/).count(), 0, 'no bed measurements');
    await variants.getByLabel('Variant 1 name').fill('Bath towel');
    await variants.getByLabel('Dimensions (optional)').first().fill('70 × 140 cm');
    await variants.getByLabel('Weight (g)').first().fill('600');
    await variants.getByRole('button', { name: 'Add a variant' }).click();
    await variants.getByLabel('Variant 2 name').fill('Hand towel');
    await variants.getByLabel('Dimensions (optional)').nth(1).fill('50 × 90 cm');
    await variants.getByLabel('Price difference (AED, + or −)').nth(1).fill('-25');
    await variants.getByLabel('Weight (g)').nth(1).fill('250');
    await variants.getByLabel('Pieces of Hand towel in stock').fill('4');
    assert.deepEqual(await overflow(page), [], 'variants step');
    await shot(page, `simple-editor-${width}.png`);
    await editor.getByRole('button', { name: /^Next: Publish/ }).click();
    await editor.getByRole('button', { name: 'Publish', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    const towel = (await allProducts()).find((p) => p.title === title)!;
    assert.ok(towel, 'published');
    assert.equal(towel.productType, 'simple');
    assert.deepEqual(towel.profiles.map((s) => [s.name, s.dimensions, s.weightGrams]), [
      ['Bath towel', '70 × 140 cm', 600],
      ['Hand towel', '50 × 90 cm', 250],
    ]);
    await ctx.close();

    // The shop: the variants, their dimensions, and add to bag.
    const shopCtx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const shop = await shopCtx.newPage();
    shop.on('pageerror', (e) => errors.push(e.message));
    await shop.goto(`${server.base}/p/${towel.id}`, { waitUntil: 'domcontentloaded' });
    const sheet = shop.getByRole('dialog', { name: title });
    await sheet.waitFor();
    assert.equal(await sheet.getByText(/ TC · /).count(), 0, 'no thread count');
    await sheet.getByRole('button', { name: /^Hand towel/ }).click();
    await sheet.locator('summary', { hasText: 'Size details' }).click();
    await sheet.getByText('50 × 90 cm').first().waitFor();
    assert.match(await sheet.innerText(), /AED 35/);
    assert.deepEqual(await overflow(shop), [], 'product sheet');
    await shot(shop, `simple-shop-${width}.png`);
    await sheet.getByRole('button', { name: /^Add to Bag/ }).click();
    const bag = shop.getByRole('dialog', { name: /bag/i });
    await bag.getByText('Dimensions: 50 × 90 cm').waitFor();
    assert.deepEqual(await overflow(shop), [], 'bag');
    await shopCtx.close();
    assert.deepEqual(errors, []);
  });

  test(`at ${width}px: select products in Inventory, share them as one link, open /c/<slug> as a shopper, add to bag; the counters, an ended link`, { skip: skip || skipBrowser }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('heading', { name: 'Inventory' }).waitFor();
    const list = await allProducts();
    const [first, second] = list.filter((p) => !p.title.startsWith('Hammam Towel'));
    if (width < 800) {
      // On a phone: Select mode, then tap the rows.
      assert.equal(await page.getByLabel(`Select ${first.title} to share`).isVisible(), false, 'no checkboxes until Select');
      await page.getByRole('button', { name: 'Select to share' }).click();
      await page.getByRole('button', { name: `Select ${first.title}` }).click();
      await page.getByRole('button', { name: `Select ${second.title}` }).click();
    } else {
      await page.getByLabel(`Select ${first.title} to share`).check();
      await page.getByLabel(`Select ${second.title} to share`).check();
    }
    const bar = page.getByTestId('selection-bar');
    await bar.getByText('2 selected').waitFor();
    assert.deepEqual(await overflow(page), [], 'selecting');
    await shot(page, `collection-select-${width}.png`);
    await bar.getByRole('button', { name: 'Share these' }).click();
    const share = page.getByRole('dialog', { name: 'Share these' });
    await share.waitFor();
    const title = `Eid picks ${width}`;
    await share.getByLabel('Title').fill(title);
    await share.getByRole('button', { name: 'Create link' }).click();
    const made = page.getByTestId('collection-made');
    await made.waitFor();
    await made.getByRole('button', { name: 'Copy link' }).waitFor();
    const wa = await made.getByRole('link', { name: 'WhatsApp' }).getAttribute('href');
    assert.match(wa!, /^https:\/\/wa\.me\/\?text=/);
    const link = await made.getByRole('link', { name: /\/c\// }).innerText();
    const slug = link.split('/c/')[1];
    assert.match(slug, new RegExp(`^eid-picks-${width}-[a-z2-9]{5}$`));
    assert.ok(decodeURIComponent(wa!).includes(`/c/${slug}`));
    assert.deepEqual(await overflow(page), [], 'link made');
    await shot(page, `collection-share-${width}.png`);
    await page.getByRole('dialog', { name: 'Your link is ready' }).getByRole('button', { name: 'Done' }).click();
    const col = (await allCollections()).find((c) => c.slug === slug)!;
    assert.deepEqual(col.productIds, [first.id, second.id]);

    // The preview WhatsApp and Instagram read: the title and the first product's photo.
    const html = await (await rawFetch(`${server.base}/c/${slug}`)).text();
    assert.match(html, new RegExp(`<meta property="og:title" content="${title}"`));
    assert.match(html, /<meta property="og:image" content="[^"]+\/api\/images\/|<meta property="og:image" content="https?:\/\//);
    assert.match(html, /<meta name="robots" content="noindex, follow"/);

    // The shopper's page: just those two, add to bag counts.
    const shopCtx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const shop = await shopCtx.newPage();
    shop.on('pageerror', (e) => errors.push(e.message));
    await shop.goto(`${server.base}/c/${slug}`, { waitUntil: 'domcontentloaded' });
    await shop.getByRole('heading', { name: title, level: 1 }).waitFor();
    const feed = shop.getByTestId('feed');
    await feed.waitFor();
    assert.equal(await feed.locator('article').count(), 2);
    assert.equal(await shop.getByRole('button', { name: /^Filter/ }).count(), 0, 'no filters on a selection');
    assert.deepEqual(await overflow(shop), [], 'collection page');
    await shot(shop, `collection-page-${width}.png`);
    await feed.locator('article').first().locator('a').first().click();
    const sheet = shop.getByRole('dialog', { name: first.title });
    await sheet.waitFor();
    await sheet.getByRole('button', { name: /^Add to Bag/ }).click();
    await shop.getByRole('dialog', { name: /bag/i }).waitFor();
    const counted = await waitFor(async () => (await allCollections()).find((c) => c.slug === slug)!, (c) => c.views === 1 && c.bagAdds === 1, 'counters');
    assert.equal(counted.views, 1);
    // The same visit again: not another view.
    await shop.reload({ waitUntil: 'domcontentloaded' });
    await shop.getByTestId('feed').waitFor();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await allCollections()).find((c) => c.slug === slug)!.views, 1);

    // Shared links in the hub: the counters, Share, Edit, Delete.
    await page.getByRole('button', { name: 'Shared links' }).click();
    const links = page.getByRole('dialog', { name: 'Shared links' });
    const row = links.getByTestId('collection-row').filter({ hasText: title });
    await row.getByText('1 view').waitFor();
    await row.getByText('1 added to bag').waitFor();
    assert.deepEqual(await overflow(page), [], 'shared links');
    await shot(page, `collection-links-${width}.png`);
    await row.getByRole('button', { name: `Edit ${title}` }).click();
    const edit = page.getByRole('dialog', { name: `Edit ${title}` });
    await edit.getByLabel('Title').fill(`${title} (edited)`);
    await edit.getByRole('checkbox').first().waitFor();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await edit.waitFor({ state: 'detached' });
    await links.getByText(`${title} (edited)`).waitFor();
    assert.equal((await allCollections()).find((c) => c.id === col.id)!.slug, slug, 'the link stays the same');

    // Ended: the last day has passed (written as a day long gone).
    const db = new Database(path.join(server.dataDir, 'shop.db'));
    db.pragma('busy_timeout = 5000');
    db.prepare("UPDATE collections SET expires_on = '2020-01-01' WHERE id = ?").run(col.id);
    db.close();
    await shop.goto(`${server.base}/c/${slug}`, { waitUntil: 'domcontentloaded' });
    await shop.getByRole('heading', { name: 'This selection has ended' }).waitFor();
    await shop.getByRole('link', { name: 'Browse the shop' }).waitFor();
    assert.deepEqual(await overflow(shop), [], 'ended page');
    await shot(shop, `collection-ended-${width}.png`);
    // An address that names nothing: the same friendly page.
    await shop.goto(`${server.base}/c/nothing-here-aaaaa`, { waitUntil: 'domcontentloaded' });
    await shop.getByRole('heading', { name: /isn’t available/ }).waitFor();

    page.once('dialog', (d) => void d.accept());
    await links.getByTestId('collection-row').filter({ hasText: `${title} (edited)` }).getByRole('button', { name: /^Delete/ }).click();
    await waitFor(allCollections, (l) => !l.some((c) => c.id === col.id), 'deleted');
    await shopCtx.close();
    await ctx.close();
    assert.deepEqual(errors, []);
  });

  test(`at ${width}px: Settings → Catalogue: a category's default type and the Amazon / Noon export (groundwork)`, { skip: skip || skipBrowser }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Settings/);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Catalogue', exact: true }).click();
    await page.getByRole('heading', { name: 'Catalogue', exact: true, level: 2 }).waitFor();
    const note = page.getByTestId('marketplace-groundwork');
    await note.waitFor();
    assert.match(await note.innerText(), /check the template your seller account gives you; column names differ by category/);
    await note.scrollIntoViewIfNeeded();
    assert.deepEqual(await overflow(page), [], 'catalogue settings');
    await shot(page, `catalogue-settings-${width}.png`);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download CSV' }).click()]);
    assert.match(download.suggestedFilename(), /^marketplace-export-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.ok((await page.getByRole('combobox', { name: /^New products in / }).count()) >= 1, 'a default type per category');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
