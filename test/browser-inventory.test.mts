/**
 * Managing stock from a phone (BUH-02.05), in Chromium against the production build, at 375 px
 * (a phone) and 1280 px (a laptop): search and filters, − / + with Undo, typing a number,
 * "Received stock", reason codes, a change from a second device with old numbers (refused,
 * "changed on another device"), the low-stock badge on the bottom bar, and the step-by-step
 * product editor with photo upload (fixture images), reorder, cover, draft and publish.
 * Every screen: no sideways scroll, no page errors. Skipped without a build or Playwright.
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
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Inventory-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  await browser?.close();
  server?.stop();
});

interface P {
  id: string;
  title: string;
  sku?: string;
  category: string;
  active: boolean;
  archived?: boolean;
  featuredImage: string;
  galleryImages: string[];
  stockBySize: Record<string, number>;
  profiles: Array<{ id: string; name: string }>;
}

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const all = async (): Promise<P[]> => (await (await api('GET', '/api/admin/products')).json()).products;
const one = async (id: string) => (await all()).find((p) => p.id === id)!;
/** The starter products (new ones go first in the list, so remember which these are). */
let starters: string[] = [];
const seeded = async (): Promise<P[]> => {
  if (!starters.length) starters = (await all()).slice(0, 4).map((p) => p.id);
  return Promise.all(starters.map(one));
};
let keyN = 0;
/** Set sizes to exact numbers, as another device would (with what it saw). */
async function setStock(id: string, values: Record<string, number>) {
  const p = await one(id);
  const changes = Object.entries(values).filter(([s, v]) => p.stockBySize[s] !== v).map(([sizeId, set]) => ({ sizeId, set }));
  if (!changes.length) return;
  const res = await api('POST', `/api/admin/products/${id}/stock`, { key: `test-set-${Date.now()}-${++keyN}`, reason: 'correction', changes, expected: Object.fromEntries(changes.map((c) => [c.sizeId, p.stockBySize[c.sizeId]])) });
  assert.equal(res.status, 200, await res.text());
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
const total = (p: P) => p.profiles.reduce((n, s) => n + (p.stockBySize[s.id] ?? 0), 0);
const expectedAlerts = (list: P[]) => list.filter((p) => !p.archived && p.active !== false && total(p) <= 2).length;

async function adminInventory(width: number, { live = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  // A second device that hears nothing: its numbers stay as they were when it opened.
  if (!live) await page.route('**/api/admin/events', (r) => r.abort());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.getByRole('status').filter({ hasText: /Backup/ }).waitFor();
  await openAdminSection(page, /^Inventory/);
  await page.getByRole('heading', { name: 'Inventory' }).waitFor();
  return { ctx, page, errors };
}

async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}
const rows = (page: Page) => page.getByRole('button', { name: /^Stock and actions for / });
async function rowTitles(page: Page) {
  return (await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace('Stock and actions for ', '')))).sort();
}

for (const width of [375, 1280]) {
  test(`inventory at ${width}px: search by name and SKU; filters low, sold out, hidden and category; the badge follows live`, { skip }, async () => {
    const [p0, p1, p2, p3] = await seeded();
    await api('PATCH', `/api/admin/products/${p0.id}`, { product: { sku: `SKU-${width}-A` } });
    await api('PATCH', `/api/admin/products/${p1.id}`, { product: { active: false } });
    await setStock(p0.id, Object.fromEntries(p0.profiles.map((s) => [s.id, 5])));
    await setStock(p2.id, Object.fromEntries(p2.profiles.map((s) => [s.id, 0]))); // sold out
    await setStock(p3.id, Object.fromEntries(p3.profiles.map((s, i) => [s.id, i === 0 ? 1 : 0]))); // low: 1 left
    const { ctx, page, errors } = await adminInventory(width);
    const nav = page.getByRole('navigation', { name: 'Admin sections' });
    const badgeEl = nav.getByRole('button', { name: /^Inventory/ }).locator('[aria-label$="sold out or low"]');
    const badge = async () => ((await badgeEl.count()) ? Number(await badgeEl.textContent()) : 0);
    const want = expectedAlerts(await all());
    assert.ok(want >= 2);
    await waitFor(badge, (n) => n === want, 'badge');

    // Search: SKU, then part of a name.
    const search = page.getByRole('searchbox', { name: 'Search name or SKU' });
    await search.fill(`sku-${width}-a`);
    await waitFor(() => rowTitles(page), (t) => t.length === 1, 'one match');
    assert.deepEqual(await rowTitles(page), [p0.title]);
    await search.fill(p3.title.split(' ').slice(0, 2).join(' '));
    await waitFor(() => rowTitles(page), (t) => t.includes(p3.title), 'name match');
    await search.fill('');

    const show = page.getByRole('group', { name: 'Show' });
    const now = await all();
    const titles = (f: (p: P) => boolean) => now.filter((p) => !p.archived && f(p)).map((p) => p.title).sort();
    const soldOut = titles((p) => p.active !== false && total(p) === 0);
    await show.getByRole('button', { name: /^Sold out/ }).click();
    assert.deepEqual(await rowTitles(page), soldOut);
    assert.ok(soldOut.includes(p2.title));
    await show.getByRole('button', { name: /^Low/ }).click();
    assert.deepEqual(await rowTitles(page), titles((p) => p.active !== false && total(p) > 0 && total(p) <= 2));
    assert.ok((await rowTitles(page)).includes(p3.title));
    await show.getByRole('button', { name: /^Hidden/ }).click();
    assert.deepEqual(await rowTitles(page), titles((p) => p.active === false));
    assert.ok((await rowTitles(page)).includes(p1.title));
    await show.getByRole('button', { name: /^All/ }).click();
    await page.getByLabel('Category').selectOption(p0.category);
    const inCategory = (await all()).filter((p) => !p.archived && p.category === p0.category).map((p) => p.title).sort();
    assert.deepEqual(await rowTitles(page), inCategory);
    await page.getByLabel('Category').selectOption('');
    // The alert cards open the lists.
    await page.getByRole('group', { name: 'Stock alerts' }).getByRole('button', { name: /sold out/ }).click();
    assert.deepEqual(await rowTitles(page), soldOut);
    assert.deepEqual(await overflow(page), [], 'no sideways scroll');

    // Another device sells the last pieces of p0: the badge here goes up by itself.
    const before = await badge();
    await setStock(p0.id, Object.fromEntries(p0.profiles.map((s, i) => [s.id, i === 0 ? 1 : 0])));
    await waitFor(badge, (n) => n === before + 1, 'badge went up live');
    await setStock(p0.id, Object.fromEntries(p0.profiles.map((s) => [s.id, 5])));
    await waitFor(badge, (n) => n === before, 'badge back down');
    // Put things back for the other tests.
    await api('PATCH', `/api/admin/products/${p1.id}`, { product: { active: true } });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`inventory at ${width}px: − / + save at once with Undo; typing a number; reason codes; received stock across sizes`, { skip }, async () => {
    const [p0] = await seeded();
    const [king, second] = p0.profiles;
    await setStock(p0.id, { [king.id]: 5, [second.id]: 5 });
    const { ctx, page, errors } = await adminInventory(width);
    await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(p0.title);
    await page.getByRole('button', { name: `Stock and actions for ${p0.title}` }).click();
    const plus = page.getByRole('button', { name: `One more ${king.name}` });
    const minus = page.getByRole('button', { name: `One fewer ${king.name}` });
    for (const b of [plus, minus]) {
      const box = (await b.boundingBox())!;
      assert.ok(box.width >= 44 && box.height >= 44, `targets of at least 44 px (${box.width}x${box.height})`);
    }
    await plus.click();
    await plus.click();
    const toast = page.getByRole('status').filter({ hasText: /^Saved\./ });
    await toast.waitFor();
    await waitFor(async () => (await one(p0.id)).stockBySize[king.id], (n) => n === 7, 'two taps saved');
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByRole('status').filter({ hasText: /^Undone\./ }).waitFor();
    assert.equal((await one(p0.id)).stockBySize[king.id], 5, 'undone');

    // Tap the number and type it.
    await page.getByRole('button', { name: new RegExp(`^${king.name.replace(/[()]/g, '\\$&')}: 5 in stock`) }).click();
    const typed = page.getByRole('spinbutton', { name: `Pieces of ${king.name} in stock` });
    await typed.fill('12');
    await typed.press('Enter');
    await waitFor(async () => (await one(p0.id)).stockBySize[king.id], (n) => n === 12, 'typed number saved');

    // Reason codes: "Damaged" for the next −.
    await page.getByLabel('Reason for − / +').selectOption('damaged');
    await minus.click();
    await waitFor(async () => (await one(p0.id)).stockBySize[king.id], (n) => n === 11, 'minus saved');
    const moves = (await (await api('GET', `/api/admin/products/${p0.id}/stock`)).json()).moves;
    assert.equal(moves[0].reason, 'damaged');
    assert.deepEqual(moves[0].changes, [{ sizeId: king.id, from: 12, to: 11 }]);
    assert.equal(moves[0].actor, 'admin@beautifuluaehome.com');
    assert.equal(moves[1].changes[0].to, 12);

    // Received stock: several sizes at once, one move.
    await page.getByRole('button', { name: `Received stock for ${p0.title}` }).click();
    const sheet = page.getByRole('dialog', { name: 'Received stock' });
    await sheet.getByRole('button', { name: `Receive one more ${king.name}` }).click();
    await sheet.getByRole('button', { name: `Receive one more ${king.name}` }).click();
    await sheet.getByLabel(`Pieces of ${second.name} received`).fill('3');
    await sheet.getByLabel(/Note/).fill('Jaipur supplier, invoice 77');
    assert.deepEqual(await overflow(page), []);
    await sheet.getByRole('button', { name: 'Add 5 pieces' }).click();
    await waitFor(async () => (await one(p0.id)).stockBySize, (s) => s[king.id] === 13 && s[second.id] === 8, 'received');
    const last = (await (await api('GET', `/api/admin/products/${p0.id}/stock`)).json()).moves[0];
    assert.equal(last.reason, 'received');
    assert.equal(last.note, 'Jaipur supplier, invoice 77');
    assert.deepEqual(last.changes, [
      { sizeId: king.id, from: 11, to: 13 },
      { sizeId: second.id, from: 5, to: 8 },
    ]);
    // The history sheet shows who and old → new.
    await page.getByRole('button', { name: `Stock history of ${p0.title}` }).click();
    await page.getByRole('dialog', { name: 'Stock history' }).getByText(/by admin@beautifuluaehome\.com/).first().waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`inventory at ${width}px: a second device with old numbers is refused ("changed on another device"), and Refresh shows the truth`, { skip }, async () => {
    const [p0] = await seeded();
    const king = p0.profiles[0];
    await setStock(p0.id, { [king.id]: 4 });
    const { ctx, page, errors } = await adminInventory(width, { live: false });
    await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(p0.title);
    await page.getByRole('button', { name: `Stock and actions for ${p0.title}` }).click();
    await page.getByRole('button', { name: new RegExp(`: 4 in stock`) }).first().waitFor();
    // The first device (here: the API) sets 9 meanwhile.
    await setStock(p0.id, { [king.id]: 9 });
    await page.getByRole('button', { name: `One more ${king.name}` }).click();
    await page.getByRole('status').filter({ hasText: 'Changed on another device: refresh' }).waitFor();
    assert.equal((await one(p0.id)).stockBySize[king.id], 9, 'nothing overwritten');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`^${king.name.replace(/[()]/g, '\\$&')}: 9 in stock`) }).waitFor();
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`product editor at ${width}px: photos from the gallery, reorder and cover, details, sizes, publish; the draft saves itself`, { skip }, async () => {
    const { ctx, page, errors } = await adminInventory(width);
    await page.getByRole('button', { name: 'Add product' }).first().click();
    // Add product opens quick add; these steps are the full editor's.
    await page.getByRole('button', { name: /Use the full editor/ }).click();
    const editor = page.getByRole('dialog', { name: 'Add a product' });
    await editor.waitFor();
    const camera = editor.getByLabel('Take a photo with the camera');
    assert.equal(await camera.getAttribute('capture'), 'environment');
    assert.equal(await camera.getAttribute('accept'), 'image/*');
    const gallery = editor.getByLabel('Choose photos from the gallery');
    assert.equal(await gallery.getAttribute('multiple'), '');
    const fixtures = ['sheet-indigo.png', 'sheet-terracotta.png'].map((f) => ({ name: f, mimeType: 'image/png', buffer: fs.readFileSync(path.join('test/fixtures', f)) }));
    await gallery.setInputFiles(fixtures);
    await editor.getByAltText('Photo 2').waitFor();
    const cover = () => editor.getByAltText('Cover photo').getAttribute('src');
    const second = () => editor.getByAltText('Photo 2').getAttribute('src');
    const [u1, u2] = [await cover(), await second()];
    assert.match(u1!, /^\/api\/images\/[a-f0-9]{64}\.jpg$/, 'shrunk to JPEG on the phone and uploaded');
    assert.notEqual(u1, u2);
    await editor.getByRole('button', { name: 'Make photo 2 the cover' }).click();
    assert.equal(await cover(), u2);
    await editor.getByRole('button', { name: 'Move photo 1 later' }).click();
    assert.equal(await cover(), u1);
    if (width >= 800) {
      // Drag the second photo onto the first.
      await editor.locator('[data-photo-index="1"]').dragTo(editor.locator('[data-photo-index="0"]'));
    } else {
      await editor.getByRole('button', { name: 'Move photo 2 earlier' }).click();
    }
    assert.equal(await cover(), u2, 'reordered');
    assert.deepEqual(await overflow(page), [], 'photos step');
    // The draft saves itself (photos as uploaded URLs).
    await editor.getByText('Draft saved').waitFor();
    const draft = (await (await api('GET', '/api/admin/products/drafts/new')).json()).draft;
    assert.deepEqual(draft.data.photos, [u2, u1]);

    await editor.getByRole('button', { name: /^Next: Details/ }).click();
    await editor.getByLabel('Name', { exact: true }).fill(`Wizard Set ${width}`);
    await editor.getByLabel('Price (AED)').fill('333');
    await editor.getByText(/More details/).click();
    // The SKU sits by the name (made by the shop); typing one makes it the owner's.
    await editor.getByLabel('SKU', { exact: true }).fill(`WZ-${width}`);
    assert.deepEqual(await overflow(page), [], 'details step');
    await editor.getByRole('button', { name: /^Next: Sizes/ }).click();
    await editor.getByRole('button', { name: /^Add size Queen/ }).click();
    await editor.getByRole('button', { name: /^One more King/ }).click();
    await editor.getByLabel(/^Pieces of Queen/).fill('3');
    assert.deepEqual(await overflow(page), [], 'sizes step');
    await editor.getByRole('button', { name: /^Next: Publish/ }).click();
    await editor.getByText('Shown in the shop').waitFor();
    assert.deepEqual(await overflow(page), [], 'publish step');
    await editor.getByRole('button', { name: 'Publish', exact: true }).click();
    await editor.waitFor({ state: 'detached' });

    const made = (await all()).find((p) => p.title === `Wizard Set ${width}`)!;
    assert.ok(made, 'published');
    assert.equal(made.featuredImage, u2);
    assert.deepEqual(made.galleryImages, [u1]);
    assert.equal(made.sku, `WZ-${width}`);
    assert.deepEqual(made.stockBySize, { king: 2, queen: 3 });
    assert.equal(made.active, true);
    assert.equal((await (await api('GET', '/api/admin/products/drafts/new')).json()).draft, null, 'draft cleared after publishing');
    const shop = (await (await fetch(`${server.base}/api/products`)).json()).products;
    assert.ok(shop.some((p: P) => p.id === made.id), 'in the shop');

    // Quick actions: duplicate (hidden copy, opens the editor) and hide.
    await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(`Wizard Set ${width}`);
    await page.getByRole('button', { name: `Stock and actions for Wizard Set ${width}` }).click();
    await page.getByRole('button', { name: `Duplicate Wizard Set ${width} (for another colour)` }).click();
    await page.getByRole('dialog', { name: `Edit Wizard Set ${width} (copy)` }).waitFor();
    await page.keyboard.press('Escape');
    const copy = (await all()).find((p) => p.title === `Wizard Set ${width} (copy)`)!;
    assert.equal(copy.active, false);
    assert.equal(total(copy), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
