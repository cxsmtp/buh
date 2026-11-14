/**
 * Review fixes for the Admin Hub's Inventory, product editor and Settings, in Chromium against the
 * production build, at 375 px (a phone) and 1280 px (a laptop):
 * - a draft made before the product changed elsewhere is not applied by itself: the owner keeps
 *   its changes on top of today's product, or discards it; no draft is left after a save;
 * - a save from an editor left open while the product changed elsewhere is refused, says so, and
 *   the owner's changes go on top of today's product;
 * - a product can have no weave; the AI's guess is offered, not applied;
 * - a new size starts with 0 pieces; removing a size with stock asks first, naming the pieces;
 * - "Sold out" asks first;
 * - Move up / down swaps with the nearest product shown;
 * - a category in use can't be deleted, and deleting any category asks first;
 * - a settings form left open while the settings changed elsewhere does not put the old ones back:
 *   it is reloaded and the owner is told;
 * - a change refused after its Settings section was left is shown.
 * Every screen: no sideways scroll, no page errors. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';
const OWNER_PASSWORD = ownerPassword();

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;
type Locator = import('playwright').Locator;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

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
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  await browser?.close();
  server?.stop();
});

interface P {
  id: string;
  title: string;
  price: number;
  weave: string;
  weaveSuggestion?: string;
  category: string;
  active: boolean;
  updatedAt?: string;
  featuredImage: string;
  galleryImages: string[];
  stockBySize: Record<string, number>;
  profiles: Array<{ id: string; name: string }>;
}
interface Cat {
  id: string;
  label: string;
  icon: string;
}

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const all = async (): Promise<P[]> => (await (await api('GET', '/api/admin/products')).json()).products;
const one = async (id: string) => (await all()).find((p) => p.id === id)!;
const draftOf = async (id: string) => (await (await api('GET', `/api/admin/products/drafts/${id}`)).json()).draft as { data: Record<string, unknown> } | null;
const settingsNow = async () => (await (await api('GET', '/api/admin/settings')).json()) as { store: { value: Record<string, unknown> }; catalog: { value: { categories: Cat[] } & Record<string, unknown> } };
const PHOTO = 'https://images.example.com/review-sheet.jpg';
const STUDIO = 'https://images.example.com/review-studio.jpg';
let sizes: Array<Record<string, unknown>> = [];
async function make(title: string, over: Record<string, unknown> = {}): Promise<P> {
  if (!sizes.length) sizes = ((await settingsNow()).catalog.value as unknown as { sizes: Array<Record<string, unknown>> }).sizes;
  const pick = (id: string) => sizes.find((s) => s.id === id)!;
  const res = await api('POST', '/api/admin/products', { product: { title, category: 'bedsheets', price: 100, featuredImage: PHOTO, profiles: [pick('king'), pick('queen')], defaultProfileId: 'king', stockBySize: { king: 2, queen: 3 }, ...over } });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  await page.getByRole('status').filter({ hasText: /Backup/ }).waitFor();
  return { ctx, page, errors };
}
async function inventory(width: number) {
  const h = await hub(width);
  await openAdminSection(h.page, /^Inventory/);
  await h.page.getByRole('heading', { name: 'Inventory' }).waitFor();
  return h;
}
async function settingsSection(page: Page, name: string) {
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true }).click();
  await page.getByRole('heading', { name, exact: true, level: 2 }).waitFor();
}
async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}
/** Find one product in the list and open its actions. */
async function openRow(page: Page, title: string) {
  await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(title);
  const row = page.getByRole('button', { name: `Stock and actions for ${title}`, exact: true });
  await row.waitFor();
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
}
async function openEditor(page: Page, title: string): Promise<Locator> {
  await openRow(page, title);
  await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: `Edit ${title}` });
  await editor.waitFor();
  return editor;
}
const step = (editor: Locator, name: string) => editor.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: new RegExp(name) }).click();
/** The next confirm(): its text, answered as given. */
function nextDialog(page: Page, accept: boolean): Promise<string> {
  return new Promise((resolve) =>
    page.once('dialog', (d) => {
      resolve(d.message());
      void (accept ? d.accept() : d.dismiss());
    })
  );
}

for (const width of [375, 1280]) {
  test(`at ${width}px: a draft from before the product changed elsewhere is not applied by itself: keep its changes on top, or discard it; no draft is left after saving`, { skip }, async () => {
    const p = await make(`Stale Draft Set ${width}`);
    const { ctx, page, errors } = await inventory(width);
    let editor = await openEditor(page, p.title);
    await step(editor, 'Details');
    await editor.getByLabel('Name', { exact: true }).fill(`Stale Draft Set ${width} renamed`);
    await editor.getByText('Draft saved').waitFor();
    assert.equal((await draftOf(p.id))!.data.baseUpdatedAt, p.updatedAt, 'the draft remembers the version it was made against');
    assert.deepEqual((await draftOf(p.id))!.data.touched, ['title'], 'and what the owner changed');
    await editor.getByRole('button', { name: 'Close (the draft is kept)' }).click();
    await editor.waitFor({ state: 'detached' });

    // Later, elsewhere: the price goes up and a picture is added (as the Picture studio does).
    const patched = await api('PATCH', `/api/admin/products/${p.id}`, { product: { price: 150, galleryImages: [STUDIO] } });
    assert.equal(patched.status, 200);
    await waitFor(() => page.getByText('AED 150').count(), (n) => n > 0, 'the list shows the new price');

    editor = await openEditor(page, p.title);
    const stale = editor.getByTestId('stale-draft');
    await stale.waitFor();
    assert.match(await stale.innerText(), /This product was changed after you started your draft/);
    assert.deepEqual(await overflow(page), [], 'the choice');
    assert.equal(await editor.getByRole('button', { name: 'Save changes' }).count(), 0, 'nothing to save until the owner chooses');
    assert.equal((await one(p.id)).price, 150);
    // Keyboard: the two choices are buttons, in order.
    await stale.getByRole('button', { name: "Keep my draft's changes" }).focus();
    await page.keyboard.press('Enter');
    await stale.waitFor({ state: 'detached' });
    await step(editor, 'Details');
    assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), `Stale Draft Set ${width} renamed`, 'the owner\'s change');
    assert.equal(await editor.getByLabel('Price (AED)').inputValue(), '150', 'today\'s price, not the draft\'s 100');
    await step(editor, 'Photos');
    assert.equal(await editor.getByRole('list', { name: 'Photos in order' }).locator(`img[src="${STUDIO}"]`).count(), 1, 'the new picture is still there');
    await step(editor, 'Publish');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await editor.waitFor({ state: 'detached' });
    const saved = await one(p.id);
    assert.equal(saved.title, `Stale Draft Set ${width} renamed`);
    assert.equal(saved.price, 150, 'the price was not put back');
    assert.deepEqual(saved.galleryImages, [STUDIO], 'the picture was not dropped');
    // No draft comes back after the save (a late autosave would have landed by now).
    await sleep(1800);
    assert.equal(await draftOf(p.id), null);

    // Again, and this time the draft is discarded.
    editor = await openEditor(page, saved.title);
    await step(editor, 'Details');
    await editor.getByLabel('Price (AED)').fill('90');
    await editor.getByText('Draft saved').waitFor();
    await editor.getByRole('button', { name: 'Close (the draft is kept)' }).click();
    await editor.waitFor({ state: 'detached' });
    assert.equal((await api('PATCH', `/api/admin/products/${p.id}`, { product: { price: 175 } })).status, 200);
    await waitFor(() => page.getByText('AED 175').count(), (n) => n > 0, 'the list shows the new price');
    editor = await openEditor(page, saved.title);
    await editor.getByTestId('stale-draft').getByRole('button', { name: 'Discard the draft' }).click();
    await editor.getByTestId('stale-draft').waitFor({ state: 'detached' });
    await step(editor, 'Details');
    assert.equal(await editor.getByLabel('Price (AED)').inputValue(), '175');
    assert.equal(await draftOf(p.id), null, 'the draft is gone');
    await page.keyboard.press('Escape');
    assert.equal((await one(p.id)).price, 175);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: saving from an editor left open while the product changed elsewhere is refused and says so; the owner's change goes on top`, { skip }, async () => {
    const p = await make(`Open Editor Set ${width}`);
    const { ctx, page, errors } = await inventory(width);
    const editor = await openEditor(page, p.title);
    await step(editor, 'Details');
    await editor.getByLabel('Name', { exact: true }).fill(`Open Editor Set ${width} v2`);
    // Meanwhile, on another device.
    assert.equal((await api('PATCH', `/api/admin/products/${p.id}`, { product: { price: 222 } })).status, 200);
    await step(editor, 'Publish');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    const alert = editor.getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /changed somewhere else while you were editing it \(changed there: price\)\. Nothing was overwritten/);
    assert.deepEqual(await overflow(page), [], 'the message');
    let now = await one(p.id);
    assert.equal(now.price, 222, 'not overwritten');
    assert.equal(now.title, p.title, 'and nothing half-saved');
    await step(editor, 'Details');
    assert.equal(await editor.getByLabel('Price (AED)').inputValue(), '222', 'today\'s price is shown');
    assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), `Open Editor Set ${width} v2`, 'the owner\'s change is kept');
    await step(editor, 'Publish');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await editor.waitFor({ state: 'detached' });
    now = await one(p.id);
    assert.equal(now.title, `Open Editor Set ${width} v2`);
    assert.equal(now.price, 222);
    await sleep(1800);
    assert.equal(await draftOf(p.id), null, 'no draft left behind');

    // A sale meanwhile is not "changed elsewhere": the save goes through.
    const again = await openEditor(page, now.title);
    await step(again, 'Details');
    await again.getByLabel('Name', { exact: true }).fill(`Open Editor Set ${width} v3`);
    const sold = await api('POST', `/api/admin/products/${p.id}/stock`, { key: `review-sale-${width}-${Date.now()}`, reason: 'correction', changes: [{ sizeId: 'queen', set: 1 }], expected: { queen: 3 } });
    assert.equal(sold.status, 200, await sold.clone().text());
    await step(again, 'Publish');
    await again.getByRole('button', { name: 'Save changes' }).click();
    await again.waitFor({ state: 'detached' });
    now = await one(p.id);
    assert.equal(now.title, `Open Editor Set ${width} v3`);
    assert.equal(now.stockBySize.queen, 1, 'the stock change stays');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: no weave is a choice; the AI's guess is offered, not applied; a new size starts at 0; removing a size with stock asks first`, { skip }, async () => {
    const p = await make(`Weave And Sizes Set ${width}`);
    assert.equal(p.weave, '', 'saved without a weave: none made up');
    assert.equal((await api('PATCH', `/api/admin/products/${p.id}`, { product: { weaveSuggestion: 'Percale' } })).status, 200);
    const shop = (await (await fetch(`${server.base}/api/products`)).json()).products.find((x: P) => x.id === p.id);
    assert.equal(shop.weave, '');
    assert.equal('weaveSuggestion' in shop, false, 'shoppers never get the guess');

    const { ctx, page, errors } = await inventory(width);
    const editor = await openEditor(page, p.title);
    await step(editor, 'Details');
    await editor.getByText(/More details/).click();
    const weave = editor.getByLabel('Weave', { exact: true });
    assert.equal(await weave.inputValue(), '');
    assert.equal(await weave.locator('option:checked').innerText(), 'No weave (none shown)');
    const hint = editor.getByTestId('weave-suggestion');
    assert.match(await hint.innerText(), /the AI thinks this may be Percale/);
    assert.deepEqual(await overflow(page), [], 'details');
    await hint.getByRole('button', { name: 'Use Percale' }).click();
    assert.equal(await weave.inputValue(), 'Percale');
    await hint.waitFor({ state: 'detached' });

    // Sizes: a size added now starts with no pieces.
    await step(editor, 'Sizes');
    await editor.getByRole('button', { name: /^Add size Single/ }).click();
    assert.equal(await editor.getByLabel(/^Pieces of Single/).inputValue(), '0', 'not 1: a piece that may not exist');
    // Removing a size that has stock: asked first, with the number of pieces.
    const refuse = nextDialog(page, false);
    await editor.getByRole('button', { name: /^Remove Queen/ }).click();
    assert.match(await refuse, /Remove Queen.*\? It has 3 pieces in stock: those 3 pieces will be removed from your stock when you save\./);
    assert.equal(await editor.getByLabel(/^Pieces of Queen/).count(), 1, 'kept');
    const agree = nextDialog(page, true);
    await editor.getByRole('button', { name: /^Remove Queen/ }).click();
    await agree;
    await waitFor(() => editor.getByLabel(/^Pieces of Queen/).count(), (n) => n === 0, 'removed');
    // A size without stock goes without a question.
    let asked = false;
    const listen = (d: import('playwright').Dialog) => {
      asked = true;
      void d.accept();
    };
    page.on('dialog', listen);
    await editor.getByRole('button', { name: /^Remove Single/ }).click();
    await waitFor(() => editor.getByLabel(/^Pieces of Single/).count(), (n) => n === 0, 'removed without asking');
    page.off('dialog', listen);
    assert.equal(asked, false);
    assert.deepEqual(await overflow(page), [], 'sizes');
    await step(editor, 'Publish');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await editor.waitFor({ state: 'detached' });
    const saved = await one(p.id);
    assert.equal(saved.weave, 'Percale');
    assert.equal(saved.weaveSuggestion, undefined);
    assert.deepEqual(saved.stockBySize, { king: 2 });

    // A new product: its first size starts at 0, and the Publish step says it will show as sold out.
    await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill('');
    await page.getByRole('button', { name: 'Add product' }).first().click();
    await page.getByRole('button', { name: /Use the full editor/ }).click();
    const fresh = page.getByRole('dialog', { name: 'Add a product' });
    await fresh.getByLabel('Choose photos from the gallery').setInputFiles([{ name: 'sheet-indigo.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join('test/fixtures', 'sheet-indigo.png')) }]);
    await fresh.getByAltText('Cover photo').waitFor();
    await fresh.getByRole('button', { name: /^Next: Details/ }).click();
    await fresh.getByLabel('Name', { exact: true }).fill(`Zero Stock Set ${width}`);
    await fresh.getByLabel('Price (AED)').fill('120');
    await fresh.getByText(/More details/).click();
    assert.equal(await fresh.getByLabel('Weave', { exact: true }).inputValue(), '', 'a new product starts with no weave');
    await fresh.getByRole('button', { name: /^Next: Sizes/ }).click();
    assert.equal(await fresh.getByLabel(/^Pieces of King/).inputValue(), '0');
    await fresh.getByRole('button', { name: /^Next: Publish/ }).click();
    assert.match(await fresh.getByTestId('no-stock-note').innerText(), /No pieces in stock yet/);
    assert.deepEqual(await overflow(page), [], 'publish, no stock');
    await fresh.getByRole('button', { name: 'Publish', exact: true }).click();
    await fresh.waitFor({ state: 'detached' });
    const made = (await all()).find((x) => x.title === `Zero Stock Set ${width}`)!;
    assert.deepEqual(made.stockBySize, { king: 0 });
    assert.equal(made.weave, '');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: “Sold out” asks first; Move up swaps with the nearest product shown`, { skip }, async () => {
    const a = await make(`MoveTest ${width} A`);
    const b = await make(`Between ${width} B`);
    const c = await make(`MoveTest ${width} C`);
    // In the shop's order: C, B, A (new products go first).
    const order = async () => (await all()).map((x) => x.id).filter((id) => [a.id, b.id, c.id].includes(id));
    assert.deepEqual(await order(), [c.id, b.id, a.id]);
    const { ctx, page, errors } = await inventory(width);
    await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(`MoveTest ${width}`);
    const titles = () => page.getByRole('button', { name: /^Stock and actions for / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace('Stock and actions for ', '')));
    await waitFor(titles, (t) => t.length === 2, 'two shown');
    assert.deepEqual(await titles(), [c.title, a.title]);
    await page.getByRole('button', { name: `Stock and actions for ${a.title}`, exact: true }).click();
    assert.equal(await page.getByRole('button', { name: `Move ${a.title} down`, exact: true }).isDisabled(), true, 'the last one shown cannot go further down');
    await page.getByRole('button', { name: `Move ${a.title} up`, exact: true }).click();
    // It visibly moves: above C, the product shown next to it (not past B, which is not shown).
    await waitFor(titles, (t) => t[0] === a.title, 'A is first now');
    assert.deepEqual(await titles(), [a.title, c.title]);
    assert.deepEqual(await order(), [a.id, b.id, c.id], 'A and C changed places; B stayed where it was');

    // Sold out: asked first, with what is in stock; "Cancel" changes nothing.
    const refuse = nextDialog(page, false);
    await page.getByRole('button', { name: `Sold out: set every size of ${a.title} to 0`, exact: true }).click();
    assert.match(await refuse, new RegExp(`Mark “${a.title}” as sold out\\? This sets every size to 0 \\(King 2, Queen 3: 5 pieces now\\)`));
    await sleep(600);
    assert.deepEqual((await one(a.id)).stockBySize, { king: 2, queen: 3 });
    const agree = nextDialog(page, true);
    await page.getByRole('button', { name: `Sold out: set every size of ${a.title} to 0`, exact: true }).click();
    await agree;
    await waitFor(() => one(a.id), (x) => x.stockBySize.king === 0 && x.stockBySize.queen === 0, 'sold out');
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: Settings → Catalogue: a category in use can't be deleted (it says which products); deleting an unused one asks first`, { skip }, async () => {
    const cats = (await settingsNow()).catalog.value.categories;
    const used = { id: `throws-${width}`, label: `Throws ${width}`, icon: '🧶' };
    const spare = { id: `spare-${width}`, label: `Spare ${width}`, icon: '🧵' };
    assert.equal((await api('PUT', '/api/admin/settings/catalog', { settings: { categories: [...cats, used, spare] } })).status, 200);
    const p = await make(`Wool Throw ${width}`, { category: used.id });
    // The server refuses it too.
    const direct = await api('PUT', '/api/admin/settings/catalog', { settings: { categories: [...cats, spare] } });
    assert.equal(direct.status, 400);
    assert.match((await direct.json()).message, new RegExp(`“${used.label}” is still the category of 1 product \\(${p.title}\\)`));

    const { ctx, page, errors } = await hub(width);
    await settingsSection(page, 'Catalogue');
    const bin = page.getByRole('button', { name: `Delete category ${used.label}`, exact: true });
    await bin.waitFor();
    const box = (await bin.boundingBox())!;
    assert.ok(box.width >= 44 && box.height >= 44, `a finger-sized bin: ${box.width}×${box.height}`);
    let asked = 0;
    const count = (d: import('playwright').Dialog) => {
      asked++;
      void d.dismiss();
    };
    page.on('dialog', count);
    await sleep(1200); // the card has read which products are in each category
    await bin.click();
    await page.getByTestId('category-in-use').waitFor();
    page.off('dialog', count);
    assert.equal(asked, 0, 'nothing to confirm: it cannot be deleted');
    assert.match(await page.getByTestId('category-in-use').innerText(), new RegExp(`“${used.label}” is still the category of 1 product \\(${p.title}\\)\\. Move it to another category first`));
    assert.equal(await page.getByRole('button', { name: `Delete category ${used.label}`, exact: true }).count(), 1, 'still listed');
    assert.deepEqual(await overflow(page), [], 'catalogue');

    const spareBin = page.getByRole('button', { name: `Delete category ${spare.label}`, exact: true });
    const refuse = nextDialog(page, false);
    await spareBin.click();
    assert.match(await refuse, new RegExp(`Delete the category “${spare.label}”\\?`));
    assert.equal(await spareBin.count(), 1, 'kept');
    const agree = nextDialog(page, true);
    await spareBin.focus();
    await page.keyboard.press('Enter');
    await agree;
    await spareBin.waitFor({ state: 'detached' });
    await waitFor(settingsNow, (s) => !s.catalog.value.categories.some((c) => c.id === spare.id), 'saved by itself');
    assert.ok((await settingsNow()).catalog.value.categories.some((c) => c.id === used.id));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: Settings left open while they change elsewhere: the old ones are not put back, the form is reloaded and says so`, { skip }, async () => {
    const mine = `+97150${width === 375 ? '1110001' : '1110002'}`;
    const theirs = `+97150${width === 375 ? '2220001' : '2220002'}`;
    assert.equal((await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: mine } })).status, 200);
    // The route: a save carrying an older version is refused; the versions are readable.
    const versions = async () => ((await (await api('GET', '/api/admin/settings?versions=1')).json()) as { versions: Record<string, string | null> }).versions;
    const v0 = (await versions()).store;
    assert.ok(v0);

    const { ctx, page, errors } = await hub(width);
    await settingsSection(page, 'Store & contact');
    const number = page.getByLabel('WhatsApp number', { exact: true });
    await waitFor(() => number.inputValue(), (v) => v.replace(/\s/g, '') === mine, 'loaded');
    await sleep(400); // the form has read which version it shows

    // The phone changes the number.
    assert.equal((await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: theirs } })).status, 200);
    const stale = await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: mine }, updatedAt: v0 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'changed_elsewhere');
    assert.equal(String((await settingsNow()).store.value.whatsappNumber), theirs);

    // The laptop flips an unrelated switch: its whole (older) form is autosaved.
    assert.equal((await number.inputValue()).replace(/\s/g, ''), mine, 'the open form still shows the old number');
    const before = Boolean((await settingsNow()).store.value.showWhatsAppButton);
    await page.getByLabel('Show the floating WhatsApp button on every page').click();
    const notice = page.getByTestId('settings-notices');
    await notice.waitFor();
    assert.match(await notice.innerText(), /Store & contact: These settings were changed somewhere else \(another phone or computer, or another part of the hub\) while this page was open\. The current settings are shown now\./);
    await waitFor(() => page.getByLabel('WhatsApp number', { exact: true }).inputValue(), (v) => v.replace(/\s/g, '') === theirs, 'the form shows the current number');
    const now = (await settingsNow()).store.value;
    assert.equal(String(now.whatsappNumber), theirs, 'the phone\'s number was not reverted');
    assert.equal(Boolean(now.showWhatsAppButton), before, 'the refused change was not half-saved');
    assert.deepEqual(await overflow(page), [], 'the notice');
    // Told once; dismissed with the keyboard. The change made again now saves.
    await notice.getByRole('button', { name: 'Dismiss this message' }).focus();
    await page.keyboard.press('Enter');
    await notice.waitFor({ state: 'detached' });
    await page.getByLabel('Show the floating WhatsApp button on every page').click();
    await page.getByText('Saved automatically.').waitFor();
    const after = (await settingsNow()).store.value;
    assert.equal(Boolean(after.showWhatsAppButton), !before);
    assert.equal(String(after.whatsappNumber), theirs);
    // Undo still works (settings history).
    await page.getByRole('button', { name: 'Undo' }).click();
    await waitFor(settingsNow, (s) => Boolean(s.store.value.showWhatsAppButton) === before, 'undone');
    assert.equal(String((await settingsNow()).store.value.whatsappNumber), theirs);
    // The Save button has the same check.
    await sleep(400);
    assert.equal((await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: mine } })).status, 200);
    await page.getByRole('button', { name: 'Save store settings' }).click();
    await page.getByTestId('settings-notices').waitFor();
    assert.equal(String((await settingsNow()).store.value.whatsappNumber), mine, 'Save did not put the older number back either');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`at ${width}px: a change typed just before leaving a Settings section is sent, and the server's refusal is shown`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await settingsSection(page, 'Store & contact');
    const good = `orders-${width}@example.ae`;
    await sleep(400);
    await page.getByLabel('Support email').fill(good);
    // Left at once (before the 1.5 s autosave): it is still saved.
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Catalogue', exact: true }).click();
    await waitFor(settingsNow, (s) => s.store.value.supportEmail === good, 'sent on leaving');
    assert.equal(await page.getByTestId('settings-notices').count(), 0, 'nothing to report');

    // Now something the server refuses.
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Store & contact', exact: true }).click();
    await waitFor(() => page.getByLabel('Support email').inputValue(), (v) => v === good, 'reopened');
    await sleep(400);
    await page.getByLabel('Support email').fill('not an email');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Catalogue', exact: true }).click();
    const notice = page.getByTestId('settings-notices');
    await notice.waitFor();
    assert.match(await notice.innerText(), /Store & contact: Your last change was not saved\. Please check the support email\./);
    assert.equal((await settingsNow()).store.value.supportEmail, good, 'the last good settings stay');
    assert.deepEqual(await overflow(page), [], 'the notice');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
