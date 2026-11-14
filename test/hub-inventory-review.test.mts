/**
 * Review fixes for the Admin Hub's Inventory, product editor and Settings (server side and the
 * editor's pure helpers):
 * - a product save carries the version the editor loaded: a product saved meanwhile is not
 *   overwritten (409), and a stock change is not such a change;
 * - a draft remembers what it was made against, so only the owner's own changes go on top of a
 *   product that changed meanwhile;
 * - a settings save carries the version its form was loaded from: a group saved meanwhile is not
 *   put back (409);
 * - a product can have no weave: none is made up, the AI's guess is only a suggestion, the spec
 *   line leaves it out, and shoppers never get the suggestion;
 * - a category products still use can't be deleted;
 * - Move up / down swaps two products, whatever is between them;
 * - the marketplace export never sends an AI picture as the main image while labelling is off;
 * - new products and the starter catalogue carry no invented rating;
 * - the owner's emails use the shop's own name.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const settings = await import('@/lib/server/settings');
const products = await import('@/lib/server/products');
const drafts = await import('@/lib/server/productDrafts');
const { getDb } = await import('@/lib/server/db');
const { marketplaceRows, MARKETPLACE_HEADERS } = await import('@/lib/server/marketplace');
const { specLine } = await import('@/lib/productType');
const { rebaseDraft, touchedKeys } = await import('@/components/admin/inventory/draftMerge');
const { INITIAL_PRODUCTS } = await import('@/data/initialData');
type Draft = import('@/components/admin/inventory/draftMerge').Draft;

const photo = 'https://images.example.com/sheet.jpg';
const king = () => settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
function newProduct(over: Record<string, unknown> = {}) {
  return products.createProduct({ title: 'Review Set', category: 'bedsheets', price: 100, featuredImage: photo, profiles: king(), defaultProfileId: 'king', stockBySize: { king: 2 }, ...over });
}
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err as { status?: number; extra?: Record<string, unknown>; message: string; code?: string };
  }
  return null;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

// ── #2 ───────────────────────────────────────────────────────────────────────

test('a product save with the version the editor loaded is refused once the product was saved elsewhere; nothing is overwritten', async () => {
  const p = newProduct({ title: 'Version Set' });
  assert.ok(p.updatedAt, 'the hub gets the product\'s version');
  const loaded = p.updatedAt!;
  await tick();
  // Another device puts the price up; the first editor still has 100.
  const elsewhere = products.updateProduct(p.id, { price: 150 });
  assert.notEqual(elsewhere.updatedAt, loaded);
  const err = status(() => products.updateProduct(p.id, { title: 'Version Set (renamed)', price: 100, expectedUpdatedAt: loaded }));
  assert.equal(err?.status, 409);
  assert.match(err!.message, /changed somewhere else/);
  assert.equal(products.getProduct(p.id)!.price, 150, 'the newer price is still there');
  assert.equal(products.getProduct(p.id)!.title, 'Version Set');
  // With today's version, the save goes through.
  const saved = products.updateProduct(p.id, { title: 'Version Set (renamed)', expectedUpdatedAt: elsewhere.updatedAt });
  assert.equal(saved.title, 'Version Set (renamed)');
  assert.equal(saved.price, 150);
  // The version never ends up in the stored product.
  const raw = JSON.parse((getDb().prepare('SELECT data FROM products WHERE id = ?').get(p.id) as { data: string }).data) as Record<string, unknown>;
  assert.equal('updatedAt' in raw, false);
  assert.equal('expectedUpdatedAt' in raw, false);
});

test('a sale or a stock count is not a change to the product: the editor\'s save still goes through', async () => {
  const p = newProduct({ title: 'Stock Version Set' });
  await tick();
  products.adjustStock(p.id, 'king', -1); // a piece sold, or counted out
  getDb().prepare('UPDATE product_stock SET qty = qty - 1 WHERE product_id = ? AND size_id = ?').run(p.id, 'king'); // as an order reserves it
  products.invalidateProducts();
  assert.equal(products.getProduct(p.id)!.updatedAt, p.updatedAt, 'stock does not move the product\'s version');
  const saved = products.updateProduct(p.id, { title: 'Stock Version Set 2', expectedUpdatedAt: p.updatedAt });
  assert.equal(saved.title, 'Stock Version Set 2');
  assert.equal(saved.stockBySize.king, 0);
});

test('a copy of a product is its own product: the version is not copied into it', () => {
  const p = newProduct({ title: 'Copy Source' });
  const { product: copy } = products.duplicateProduct(p.id, 'copy-key-12345678');
  const raw = JSON.parse((getDb().prepare('SELECT data FROM products WHERE id = ?').get(copy.id) as { data: string }).data) as Record<string, unknown>;
  assert.equal('updatedAt' in raw, false);
});

test('a draft keeps the version it was made against, the photos it started from and which fields the owner changed', () => {
  const p = newProduct({ title: 'Draft Set' });
  const saved = drafts.saveDraft(p.id, { title: 'Draft Set v2', price: '100', photos: [photo], sizes: king(), baseUpdatedAt: p.updatedAt, touched: ['title', 'not a field!', 7], basePhotos: [photo, 'javascript:alert(1)'] }, 'owner@shop.test');
  assert.equal(saved.data.baseUpdatedAt, p.updatedAt);
  assert.deepEqual(saved.data.touched, ['title']);
  assert.deepEqual(saved.data.basePhotos, [photo]);
  assert.equal(drafts.getDraft(p.id)!.data.baseUpdatedAt, p.updatedAt);
});

test('only what the owner changed goes on top of a product that changed meanwhile: the newer price and the new picture stay', () => {
  const size = king()[0];
  const base: Draft = {
    step: 0, productType: 'bedding', title: 'Indigo Set', sku: 'BUH-1', skuAuto: false, seoTitle: '', seoDescription: '', shortDescription: '', description: '', titleAr: '', shortDescriptionAr: '', descriptionAr: '',
    category: 'bedsheets', material: '', threadCount: '', weave: '', price: '100', compareAtPrice: '', colors: [], photos: ['a.jpg'], fitted: false, sizes: [size], stock: { king: 2 }, defaultProfileId: 'king', active: true,
    isFeatured: false, isNewArrival: false, seenStock: { king: 2 }, legacy: {}, giftLines: {}, stagingNotes: '', setPhotos: {}, hasComforter: false, aiMotif: '', aiDesign: '',
  };
  // The owner renamed it in a draft, and went to step 2.
  const mine: Draft = { ...base, step: 1, title: 'Indigo Garden Set' };
  assert.deepEqual(touchedKeys(base, mine), ['title']);
  // Meanwhile: the price went up, the Picture studio added a picture, and one piece was sold.
  const current: Draft = { ...base, price: '150', photos: ['studio.png', 'a.jpg'], stock: { king: 1 }, seenStock: { king: 1 } };
  const merged = rebaseDraft(current, mine, touchedKeys(base, mine), base.photos);
  assert.equal(merged.title, 'Indigo Garden Set', 'the owner\'s change');
  assert.equal(merged.price, '150', 'the newer price is not put back to 100');
  assert.deepEqual(merged.photos, ['studio.png', 'a.jpg'], 'the new picture is not dropped');
  assert.deepEqual(merged.stock, { king: 1 });
  assert.deepEqual(merged.seenStock, { king: 1 });
  assert.equal(merged.step, 1);

  // The owner had also reordered the photos and counted stock up: their order stays, the new picture is added after, their count is kept with the figure they saw.
  const mine2: Draft = { ...base, photos: ['b.jpg', 'a.jpg'], stock: { king: 5 } };
  const merged2 = rebaseDraft(current, mine2, touchedKeys(base, mine2), base.photos);
  assert.deepEqual(merged2.photos, ['b.jpg', 'a.jpg', 'studio.png']);
  assert.deepEqual(merged2.stock, { king: 5 });
  assert.deepEqual(merged2.seenStock, { king: 2 }, 'sent as "expected": the server says the stock changed meanwhile');
  assert.equal(merged2.price, '150');
});

// ── #3 ───────────────────────────────────────────────────────────────────────

test('a settings save with the version its form was loaded from is refused once the group was saved elsewhere', async () => {
  await settings.updateSettings('store', { whatsappNumber: '+971501111111' });
  const loaded = settings.settingsUpdatedAt('store');
  assert.ok(loaded);
  settings.assertSettingsUnchanged('store', loaded); // unchanged: fine
  settings.assertSettingsUnchanged('store', undefined); // no version sent: no check (callers that load and save in one step)
  await tick();
  // The phone changes the number while the laptop has the section open.
  await settings.updateSettings('store', { whatsappNumber: '+971502222222' });
  const err = status(() => settings.assertSettingsUnchanged('store', loaded));
  assert.equal(err?.status, 409);
  assert.match(err!.message, /changed somewhere else/);
  assert.equal(settings.getSettings('store').whatsappNumber.replace(/\D/g, ''), '971502222222');
  // A group never saved has no version: null matches only while it is still unsaved.
  assert.equal(settings.settingsUpdatedAt('delivery'), null);
  settings.assertSettingsUnchanged('delivery', null);
  assert.equal(status(() => settings.assertSettingsUnchanged('store', null))?.status, 409);
  assert.equal(status(() => settings.assertSettingsUnchanged('store', 5))?.status, 400);
});

// ── #4 ───────────────────────────────────────────────────────────────────────

test('a product saved without a weave has none: nothing is made up, and the spec line leaves it out', () => {
  const p = newProduct({ title: 'No Weave Set', material: '100% Cotton', threadCount: 300 });
  assert.equal(p.weave, '', 'not "Sateen", not the first weave in the list');
  assert.equal(specLine(p), '100% Cotton · 300 TC');
  assert.equal(specLine({ ...p, material: '', threadCount: 0 }), '');
  // A chosen weave is saved; an unknown one is still refused; it can be taken off again.
  assert.equal(products.updateProduct(p.id, { weave: 'Percale' }).weave, 'Percale');
  assert.throws(() => products.updateProduct(p.id, { weave: 'Moonbeam' }), /Unknown weave/);
  assert.equal(products.updateProduct(p.id, { weave: '' }).weave, '');
  assert.equal(specLine(products.getProduct(p.id)!), '100% Cotton · 300 TC');
});

test('the AI\'s guess at the weave is only a suggestion for the owner: never the weave, never sent to shoppers, gone once a weave is chosen', async () => {
  const p = newProduct({ title: 'Guessed Weave Set' });
  const guessed = products.updateProduct(p.id, { weaveSuggestion: 'Percale' });
  assert.equal(guessed.weave, '');
  assert.equal(guessed.weaveSuggestion, 'Percale');
  assert.equal(specLine(guessed), '');
  // A guess that is not one of the shop's weaves is dropped.
  assert.equal(products.updateProduct(p.id, { weaveSuggestion: 'Moonbeam' }).weaveSuggestion, undefined);
  products.updateProduct(p.id, { weaveSuggestion: 'Linen' });
  const shop = await import('@/app/api/products/route');
  const sent = ((await shop.GET().json()) as { products: Array<Record<string, unknown>> }).products.find((x) => x.id === p.id)!;
  assert.equal('weaveSuggestion' in sent, false);
  assert.equal('updatedAt' in sent, false);
  assert.equal(sent.weave, '');
  // The owner chooses: the suggestion has done its job.
  const chosen = products.updateProduct(p.id, { weave: 'Sateen' });
  assert.equal(chosen.weave, 'Sateen');
  assert.equal(chosen.weaveSuggestion, undefined);
});

// ── #8 ───────────────────────────────────────────────────────────────────────

test('a category that products still use cannot be deleted (it says which); an unused one can', async () => {
  const cats = settings.getSettings('catalog').categories;
  await settings.updateSettings('catalog', { categories: [...cats, { id: 'throws', label: 'Throws', icon: '🧶' }, { id: 'spare', label: 'Spare', icon: '🧵' }] });
  const a = newProduct({ title: 'Wool Throw', category: 'throws' });
  newProduct({ title: 'Cotton Throw', category: 'throws' });
  const without = (id: string) => settings.getSettings('catalog').categories.filter((c) => c.id !== id);
  await assert.rejects(settings.updateSettings('catalog', { categories: without('throws') }), (err: { status?: number; message: string }) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /“Throws” is still the category of 2 products \(Cotton Throw, Wool Throw\)/);
    assert.match(err.message, /Move them to another category first/);
    return true;
  });
  assert.ok(settings.getSettings('catalog').categories.some((c) => c.id === 'throws'), 'still listed');
  // Unused: goes. And once its products are moved or removed, the used one goes too.
  await settings.updateSettings('catalog', { categories: without('spare') });
  assert.equal(settings.getSettings('catalog').categories.some((c) => c.id === 'spare'), false);
  products.updateProduct(a.id, { category: 'bedsheets' });
  await assert.rejects(settings.updateSettings('catalog', { categories: without('throws') }), /still the category of 1 product \(Cotton Throw\)\. Move it/);
  products.setArchived(settings.productsInCategory('throws')[0].id, true);
  await settings.updateSettings('catalog', { categories: without('throws') });
  assert.equal(settings.getSettings('catalog').categories.some((c) => c.id === 'throws'), false);
});

// ── #12 ──────────────────────────────────────────────────────────────────────

test('Move up / down swaps two products in the shop\'s order, whatever is between them', () => {
  const order = () => products.listProducts({ includeHidden: true, includeArchived: true }).map((p) => p.id);
  const before = order();
  assert.ok(before.length >= 4);
  // The first and the fourth (two filtered-out products between them) change places; the rest stay.
  products.swapProducts(before[0], before[3]);
  const after = order();
  assert.deepEqual(after, [before[3], before[1], before[2], before[0], ...before.slice(4)]);
  assert.throws(() => products.swapProducts(before[0], 'prod-nope'), /Unknown product/);
  assert.throws(() => products.swapProducts(before[0], before[0]), /two products/);
  assert.throws(() => products.swapProducts(undefined, before[0]), /two products/);
});

// ── #14 ──────────────────────────────────────────────────────────────────────

test('the marketplace export never sends an AI picture as the main image while styled photos are not labelled', () => {
  const ai = '/api/images/' + 'a'.repeat(64) + '.png';
  const ai2 = '/api/images/' + 'c'.repeat(64) + '.png';
  const real = '/api/images/' + 'b'.repeat(64) + '.jpg';
  const p = { ...newProduct({ title: 'Export Set' }), featuredImage: ai, galleryImages: [ai2, real], aiTransformedImage: undefined, stagedPhotos: { [ai]: { staged: true as const }, [ai2]: { staged: true as const } } };
  const opts = { base: 'https://shop.example', brand: 'Shop', categories: settings.getSettings('catalog').categories };
  const h = (name: (typeof MARKETPLACE_HEADERS)[number]) => MARKETPLACE_HEADERS.indexOf(name);
  // Labelling off (AI pictures first is the default order): the first real photo is the main image, no AI picture anywhere.
  const off = marketplaceRows([p], { ...opts, labelStyledPhotos: false })[0];
  assert.equal(off[h('main_image_url')], `https://shop.example${real}`);
  assert.equal(off[h('other_image_urls')], '');
  // Only AI pictures: no image at all rather than an unlabelled AI one.
  const onlyAi = marketplaceRows([{ ...p, galleryImages: [ai2] }], { ...opts, labelStyledPhotos: false })[0];
  assert.equal(onlyAi[h('main_image_url')], '');
  assert.equal(onlyAi[h('other_image_urls')], '');
  // Labelling on: as before.
  const on = marketplaceRows([p], { ...opts, labelStyledPhotos: true })[0];
  assert.equal(on[h('main_image_url')], `https://shop.example${ai}`);
  assert.equal(on[h('other_image_urls')], [ai2, real].map((u) => `https://shop.example${u}`).join('|'));
});

// ── ratings, shop name ───────────────────────────────────────────────────────

test('no invented rating: a new product has none, and the starter catalogue carries none', () => {
  const p = newProduct({ title: 'Unrated Set' });
  assert.equal(p.rating, 0);
  assert.equal(p.reviewsCount, 0);
  for (const s of INITIAL_PRODUCTS) {
    assert.equal(s.rating, 0, s.title);
    assert.equal(s.reviewsCount, 0, s.title);
  }
});

test('the owner\'s daily summary uses the shop\'s own name', async () => {
  const monitor = await import('@/lib/server/monitor');
  await settings.updateSettings('brand', { storeName: 'Noor <Linen> House' });
  const s = monitor.dailySummary(new Date());
  assert.match(s.text, /^Noor <Linen> House: your summary for /);
  assert.match(s.html, /Noor &lt;Linen&gt; House/);
  assert.doesNotMatch(s.text + s.html, /Beautiful UAE Home/);
});
