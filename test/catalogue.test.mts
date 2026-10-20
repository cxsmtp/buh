/**
 * BUH-02.17 catalogue: shareable multi-product links (collections), simple (non-bed-linen)
 * products, the Amazon / Noon export (groundwork) and where the Admin Hub opens.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { jsonRequest, tempDataDir } from './helpers.mjs';

tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const products = await import('@/lib/server/products');
const collections = await import('@/lib/server/collections');
const orders = await import('@/lib/server/orders');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getSettings, updateSettings } = await import('@/lib/server/settings');
const { getDb } = await import('@/lib/server/db');
const backup = await import('@/lib/server/backup');
const { marketplaceCsv, marketplaceRows, parentSku, variantSku, MARKETPLACE_HEADERS } = await import('@/lib/server/marketplace');
const { shipmentWeight } = await import('@/lib/shipmentWeight');
const { labelContents } = await import('@/lib/labelContents');
const { matchesSearch } = await import('@/lib/catalogFilter');
const { measurementRows, sheetRow } = await import('@/lib/measurements');
const { cleanDraft } = await import('@/lib/server/productDrafts');
const { defaultTypeFor, productTypeOf } = await import('@/lib/productType');
const { defaultHubTab, initialHubTab, rememberHubTab } = await import('@/lib/client/hubLanding');
const { moneyHighlights, todayTodos, countsAsSale } = await import('@/lib/hubToday');
const { dubaiToday } = await import('@/lib/reportPeriods');

const template = products.listProducts()[0];
const customer = { fullName: 'Mariam Test', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' };
let n = 0;
function buy(productId: string, profileId: string, quantity = 1, phone = '+971501234567') {
  return orders.placeOrder({
    idempotencyKey: `cat-${Date.now()}-${n++}-abcdefghij`,
    verificationToken: issuePhoneToken(phone),
    customer,
    items: [{ productId, profileId, quantity }],
    paymentMethod: 'cod',
  }).order;
}
function towel(over: Record<string, unknown> = {}) {
  return products.createProduct({
    productType: 'simple',
    title: 'Hammam Towel',
    category: template.category,
    price: 60,
    material: '100% Turkish cotton',
    featuredImage: template.featuredImage,
    galleryImages: [],
    colors: [{ name: 'Sand', hex: '#d8c3a5' }],
    defaultProfileId: 'v-bath',
    profiles: [
      // Bed fields sent by mistake are dropped for a simple product.
      { id: 'v-bath', name: 'Bath towel', dimensions: '70 × 140 cm', priceDelta: 0, weightGrams: 600, mattressSize: '180 x 200', fittedSheet: 'x' },
      { id: 'v-hand', name: 'Hand towel', dimensions: '50 × 90 cm', priceDelta: -25, weightGrams: 250 },
    ],
    stockBySize: { 'v-bath': 3, 'v-hand': 2 },
    ...over,
  });
}
const stored = (id: string) => JSON.parse((getDb().prepare('SELECT data FROM products WHERE id = ?').get(id) as { data: string }).data);

// ── simple products ──────────────────────────────────────────────────────────

test('a simple product: plain variants with dimensions, price, stock and weight; no bed measurements', () => {
  const p = towel();
  assert.equal(p.productType, 'simple');
  assert.equal(p.fitted, false);
  assert.deepEqual(p.profiles.map((s) => [s.id, s.name, s.dimensions, s.priceDelta, s.weightGrams]), [
    ['v-bath', 'Bath towel', '70 × 140 cm', 0, 600],
    ['v-hand', 'Hand towel', '50 × 90 cm', -25, 250],
  ]);
  assert.equal(p.profiles[0].mattressSize, '');
  assert.equal(p.profiles[0].fittedSheet, '');
  assert.deepEqual(p.stockBySize, { 'v-bath': 3, 'v-hand': 2 });
  assert.equal(stored(p.id).productType, 'simple');
  // The shop shows its dimensions (not a sheet line).
  assert.deepEqual(measurementRows(p, p.profiles[0]), [{ key: 'dimensions', label: 'Dimensions', value: '70 × 140 cm' }]);
  assert.equal(sheetRow(p, p.profiles[1])?.value, '50 × 90 cm');
  // A variant needs a name; the type must be one of the two.
  assert.throws(() => towel({ profiles: [{ id: 'v-x', name: '' }] }), /Variant 1 name is required/);
  assert.throws(() => towel({ productType: 'furniture' }), /bedding or simple/);
});

test('bedding products are unchanged: no type stored, measurements kept, dimensions dropped', () => {
  const p = products.createProduct({ ...template, stockBySize: undefined, stockCount: undefined, title: 'Plain Bedding Set', galleryImages: [], profiles: [{ ...template.profiles[0], dimensions: 'should go', flatSheet: '260 x 270 cm' }], defaultProfileId: template.profiles[0].id });
  assert.equal(productTypeOf(p), 'bedding');
  assert.ok(!('productType' in stored(p.id)), 'the JSON has no type field');
  assert.equal(p.profiles[0].flatSheet, '260 x 270 cm');
  assert.equal(p.profiles[0].dimensions, undefined);
  // Products stored before this version (no field) read as bedding.
  assert.equal(productTypeOf(template), 'bedding');
  assert.ok(products.listProducts().filter((x) => x.id !== p.id && !x.title.includes('Towel')).every((x) => x.productType === undefined));
});

test('buying a simple product: the variant is reserved, its weight and dimensions copied onto the order; label, tracking and courier name it', () => {
  const p = towel({ title: 'Buyable Towel' });
  const placed = buy(p.id, 'v-hand', 2);
  const item = placed.items[0];
  assert.equal(item.profileName, 'Hand towel');
  assert.equal(item.dimensions, '50 × 90 cm');
  assert.equal(item.productType, 'simple');
  assert.equal(item.unitPrice, 35, '60 − 25');
  assert.equal(item.weightGrams, 250);
  assert.equal(item.mattressSize, '');
  assert.equal(products.getProduct(p.id)!.stockBySize['v-hand'], 0, 'stock 2 → 0');
  assert.equal(products.getProduct(p.id)!.stockBySize['v-bath'], 3, 'other variant untouched');
  assert.throws(() => buy(p.id, 'v-hand'), /sold out/);
  const w = shipmentWeight(placed, 200);
  assert.equal(w.grams, 700);
  assert.match(w.breakdown, /2 × Hand towel 0\.3 kg/);
  assert.equal(labelContents(placed), 'Buyable Towel (Hand towel) × 2');
  const tracked = orders.lookupOrder(placed.id, '+971501234567')!;
  assert.equal(tracked.items[0].dimensions, '50 × 90 cm');
  // Bed linen labels read as before.
  const bed = buy(template.id, template.profiles[0].id);
  assert.equal(labelContents(bed), `${template.title} × 1`);
  assert.equal(bed.items[0].productType, undefined);
});

test('search finds a simple product by its variants; the feed, products.csv and the editor draft carry it', async () => {
  const p = towel({ title: 'Searchable Towel' });
  assert.ok(matchesSearch(p, 'bath towel'));
  assert.ok(matchesSearch(p, 'hand'));
  assert.ok(!matchesSearch(template, 'hand towel'));
  process.env.NEXT_PUBLIC_APP_URL = 'https://shop.example';
  const feed = await (await import('@/app/feeds/meta.csv/route')).GET();
  delete process.env.NEXT_PUBLIC_APP_URL;
  const csv = await feed.text();
  assert.match(csv, new RegExp(`${p.id}-v-bath,Searchable Towel \\(Bath towel\\)`));
  const files = backup.openBackup(fs.readFileSync((await backup.createBackup()).file));
  const productsCsv = files.find((e) => e.name === 'products.csv')!.data.toString();
  assert.match(productsCsv, /Searchable Towel.*Bath towel 70 × 140 cm \(\+0\).*,simple,/);
  // A draft keeps the type and the dimensions.
  const draft = cleanDraft({ productType: 'simple', sizes: [{ id: 'v-a', name: 'Cushion', dimensions: '45 × 45 cm' }] });
  assert.equal(draft.productType, 'simple');
  assert.equal((draft.sizes as Array<{ dimensions?: string }>)[0].dimensions, '45 × 45 cm');
  assert.equal(cleanDraft({ productType: 'sofa' }).productType, undefined);
});

test('categories can make new products start as simple (Settings → Catalogue)', async () => {
  const catalog = getSettings('catalog');
  await updateSettings('catalog', { categories: [...catalog.categories, { id: 'towels', label: 'Towels', icon: '🛁', defaultType: 'simple' }] });
  const saved = getSettings('catalog');
  assert.equal(saved.categories.find((c) => c.id === 'towels')?.defaultType, 'simple');
  assert.equal(defaultTypeFor(saved, 'towels'), 'simple');
  assert.equal(defaultTypeFor(saved, catalog.categories[0].id), 'bedding');
  assert.ok(!('defaultType' in saved.categories[0]), 'bed linen is not stored');
  await assert.rejects(updateSettings('catalog', { categories: [{ id: 'x', label: 'X', icon: '', defaultType: 'sofa' }] }), /default type/);
});

// ── marketplace export ───────────────────────────────────────────────────────

test('the Amazon / Noon CSV: one row per size or variant, stable SKUs (own or from the id), prices with the size', () => {
  const p = towel({ title: 'Export Towel', sku: 'TWL-01' });
  const bare = towel({ title: 'Export Towel 2' });
  const opts = { base: 'https://shop.example', brand: 'Beautiful UAE Home', categories: getSettings('catalog').categories };
  const rows = marketplaceRows([p, bare, template], opts);
  const h = (name: (typeof MARKETPLACE_HEADERS)[number]) => MARKETPLACE_HEADERS.indexOf(name);
  assert.equal(rows.length, 2 + 2 + template.profiles.length);
  assert.equal(rows[0][h('sku')], 'TWL-01-V-BATH');
  assert.equal(rows[1][h('sku')], 'TWL-01-V-HAND');
  assert.equal(rows[1][h('parent_sku')], 'TWL-01');
  assert.equal(rows[1][h('price_aed')], '35.00');
  assert.equal(rows[1][h('quantity')], 2);
  assert.equal(rows[1][h('size')], 'Hand towel');
  assert.equal(rows[1][h('size_detail')], '50 × 90 cm');
  assert.equal(rows[1][h('product_type')], 'simple');
  assert.equal(rows[1][h('brand')], 'Beautiful UAE Home');
  assert.match(String(rows[1][h('main_image_url')]), /^https:\/\//);
  // A product saved without an SKU gets one made by the shop (BUH-<category>-<name>-<number>).
  assert.match(String(bare.sku), /^BUH-[A-Z0-9]{2,3}-EXPTWL-\d{3,}$/);
  assert.equal(parentSku(bare), bare.sku);
  // One with no SKU at all (from before SKUs were made): one made from the id, the same every time, at most 40 characters.
  const old = { id: bare.id, sku: undefined };
  assert.equal(parentSku(old), `BUH-${bare.id.replace(/^prod-/, '').toUpperCase()}`);
  assert.equal(variantSku(bare, 'v-bath'), variantSku(bare, 'v-bath'));
  assert.ok(variantSku({ id: 'prod-' + 'a'.repeat(60), sku: undefined }, 'super-king-with-a-very-long-id').length <= 40);
  // Bedding rows carry the mattress size.
  assert.equal(rows[4][h('size_detail')], template.profiles[0].mattressSize);
  const csv = marketplaceCsv([p], opts);
  assert.ok(csv.startsWith('﻿sku,parent_sku,title,description,brand,price_aed'), 'UTF-8 BOM, then the headers');
});

// ── collections ──────────────────────────────────────────────────────────────

test('a collection: short unguessable slug from the title, products in order, idempotent create', () => {
  const [a, b] = products.listProducts();
  const key = 'k-create-0000001';
  const { collection, replayed } = collections.createCollection({ key, title: '  Eid   picks!  ', productIds: [b.id, a.id, b.id] }, 'owner@x');
  assert.equal(replayed, false);
  assert.equal(collection.title, 'Eid picks!');
  assert.match(collection.slug, /^eid-picks-[a-z2-9]{5}$/);
  assert.match(collection.slug, collections.SLUG_PATTERN);
  assert.deepEqual(collection.productIds, [b.id, a.id], 'once each, in order');
  assert.equal(collection.expiresOn, null);
  const again = collections.createCollection({ key, title: 'Something else', productIds: [a.id] }, 'owner@x');
  assert.equal(again.replayed, true);
  assert.equal(again.collection.id, collection.id, 'a double tap makes one');
  const other = collections.createCollection({ key: 'k-create-0000002', title: 'Eid picks!', productIds: [a.id] }, 'owner@x').collection;
  assert.notEqual(other.slug, collection.slug, 'same title, another link');
  // Arabic or emoji-only titles still get an address.
  assert.match(collections.createCollection({ key: 'k-create-0000003', title: 'عيد مبارك', productIds: [a.id] }, 'o').collection.slug, /^picks-[a-z2-9]{5}$/);
});

test('a collection is validated: title, products that exist, a real last day not in the past, an idempotency key', () => {
  const [a] = products.listProducts();
  const make = (body: Record<string, unknown>) => collections.createCollection({ key: `k-v-${Math.random().toString(36).slice(2, 12)}`, title: 'T', productIds: [a.id], ...body }, 'o');
  assert.throws(() => make({ title: '' }), /title/);
  assert.throws(() => make({ title: 'x'.repeat(61) }), /too long/);
  assert.throws(() => make({ productIds: [] }), /at least one/);
  assert.throws(() => make({ productIds: ['prod-nope'] }), /no longer exists/);
  assert.throws(() => make({ productIds: Array.from({ length: 61 }, () => a.id) }), /At most 60/);
  assert.throws(() => make({ expiresOn: '2020-01-01' }), /past/);
  assert.throws(() => make({ expiresOn: '2026-02-30' }), /real date/);
  assert.throws(() => make({ expiresOn: 'tomorrow' }), /YYYY-MM-DD/);
  assert.throws(() => collections.createCollection({ title: 'T', productIds: [a.id] }, 'o'), /idempotency/);
  assert.equal(make({ expiresOn: dubaiToday() }).collection.expiresOn, dubaiToday(), 'today is fine');
});

test('the public view shows only products on sale; edit keeps the link; expiry by the UAE date; delete', () => {
  const [a, b, c] = products.listProducts();
  const col = collections.createCollection({ key: 'k-public-000001', title: 'Weekend', productIds: [a.id, b.id, c.id] }, 'o').collection;
  products.updateProduct(b.id, { active: false });
  products.setArchived(c.id, true);
  const view = collections.publicCollection(col.slug)!;
  assert.deepEqual(view.productIds, [a.id], 'hidden and removed products are left out');
  assert.equal(view.ended, false);
  products.updateProduct(b.id, { active: true });
  products.setArchived(c.id, false);
  products.updateProduct(c.id, { active: true });

  const edited = collections.updateCollection(col.id, { title: 'Weekend edit', productIds: [c.id, a.id], expiresOn: dubaiToday() }, 'o');
  assert.equal(edited.slug, col.slug, 'renaming keeps the address');
  assert.deepEqual(edited.productIds, [c.id, a.id]);
  // Last day = today (UAE): open until midnight in Dubai, then ended.
  const midnightUae = Date.parse(`${dubaiToday()}T00:00:00+04:00`) + 86_400_000;
  assert.equal(collections.hasEnded(edited.expiresOn, midnightUae - 1000), false);
  assert.equal(collections.hasEnded(edited.expiresOn, midnightUae + 1000), true);
  assert.equal(collections.publicCollection(col.slug, midnightUae + 1000)!.ended, true);
  assert.equal(collections.countCollectionEvent(col.slug, 'view', midnightUae + 1000), false, 'an ended link counts nothing');
  // An already-past last day may stay (to keep it ended) but not be set anew.
  getDb().prepare("UPDATE collections SET expires_on = '2020-01-01' WHERE id = ?").run(col.id);
  assert.equal(collections.updateCollection(col.id, { title: 'Still ended' }, 'o').expiresOn, '2020-01-01');
  assert.equal(collections.publicCollection(col.slug)!.ended, true);
  assert.throws(() => collections.updateCollection(col.id, { expiresOn: '2020-01-02' }, 'o'), /past/);
  assert.equal(collections.updateCollection(col.id, { expiresOn: null }, 'o').expiresOn, null, 'cleared: no end');

  collections.deleteCollection(col.id, 'o');
  assert.equal(collections.publicCollection(col.slug), undefined);
  assert.throws(() => collections.deleteCollection(col.id, 'o'), /not found/);
  assert.throws(() => collections.updateCollection('../etc', {}, 'o'), /not found/);
  assert.equal(collections.getCollectionBySlug("x' OR 1=1 --"), undefined);
});

test('counters: views and adds to bag, through the public route (same site only, allow-listed body)', async () => {
  const [a] = products.listProducts();
  const col = collections.createCollection({ key: 'k-count-0000001', title: 'Counted', productIds: [a.id] }, 'o').collection;
  const route = await import('@/app/api/collections/[slug]/route');
  const call = (body: unknown, headers: Record<string, string> = { origin: 'http://shop.test' }, slug = col.slug) =>
    route.POST(jsonRequest(body, headers, `http://shop.test/api/collections/${slug}`), { params: Promise.resolve({ slug }) });
  assert.equal((await call({ kind: 'view' })).status, 200);
  assert.equal((await call({ kind: 'bag' })).status, 200);
  assert.equal((await call({ kind: 'bag' })).status, 200);
  assert.equal((await call({ kind: 'view' }, { origin: 'https://evil.example' })).status, 403, 'cross-site refused');
  assert.equal((await call({ kind: 'view' }, {})).status, 403, 'no Origin or Referer (a script, not the shop page) is refused');
  assert.equal((await call({ kind: 'like' })).status, 400);
  assert.equal((await call({ kind: 'view', who: 'me' })).status, 400, 'only kind is accepted');
  assert.deepEqual(await (await call({ kind: 'view' }, undefined, 'nope-aaaaa')).json(), { counted: false });
  const now = collections.getCollection(col.id)!;
  assert.equal(now.views, 1);
  assert.equal(now.bagAdds, 2);
});

test('backups: collections are in the database copy and collections.csv, and the restore script restores them', async () => {
  const [a] = products.listProducts();
  const col = collections.createCollection({ key: 'k-backup-000001', title: 'Backed up', productIds: [a.id] }, 'o').collection;
  const result = await backup.createBackup();
  const entries = backup.openBackup(fs.readFileSync(result.file));
  const csv = entries.find((e) => e.name === 'collections.csv')!.data.toString();
  assert.match(csv, new RegExp(`${col.id},/c/${col.slug},Backed up,${a.id}`));
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-col-')), 'data');
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /\d+ shared selections/);
  assert.match(out, /Integrity check: ok/);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT slug, title, product_ids FROM collections WHERE id = ?').get(col.id) as { slug: string; title: string; product_ids: string };
    assert.deepEqual(row, { slug: col.slug, title: 'Backed up', product_ids: JSON.stringify([a.id]) });
  } finally {
    db.close();
  }
});

test('migration 15 only adds (a table and an index)', () => {
  const src = fs.readFileSync('src/lib/server/db.ts', 'utf8');
  const m = src.slice(src.indexOf('// 15: shareable selections'));
  const sql = m.slice(m.indexOf('db.exec(`') + 9, m.indexOf('`);'));
  const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  assert.equal(statements.length, 2);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX) /, s);
});

// ── where the hub opens ──────────────────────────────────────────────────────

test('the hub opens on Orders on a phone and the Overview on a laptop, then on the last section chosen on this device', () => {
  assert.equal(defaultHubTab('phone'), 'orders');
  assert.equal(defaultHubTab('laptop'), 'overview');
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(initialHubTab('phone', storage), 'orders');
  rememberHubTab('phone', 'inventory', storage);
  assert.equal(initialHubTab('phone', storage), 'inventory');
  assert.equal(initialHubTab('laptop', storage), 'overview', 'per view');
  rememberHubTab('laptop', 'add-product', storage);
  assert.equal(initialHubTab('laptop', storage), 'overview', 'a half-done Add product is not landed on');
  store.set('buh_hub_tab_laptop', 'nonsense');
  assert.equal(initialHubTab('laptop', storage), 'overview');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(initialHubTab('phone', blocked), 'orders', 'storage blocked: the default');
  assert.doesNotThrow(() => rememberHubTab('phone', 'money', blocked));
  assert.equal(initialHubTab('phone', null), 'orders');
});

test("today's to-dos and the money highlights (fils, UAE dates; cancelled and unpaid card orders left out)", () => {
  const now = Date.parse('2026-10-19T08:00:00Z');
  const o = (id: string, createdAt: string, total: number, status = 'confirmed', card?: string) =>
    ({ id, createdAt, total, status, ...(card ? { card: { state: card } } : {}) }) as never;
  const list = [
    o('A', '2026-10-19T05:00:00Z', 100.1, 'pending_confirmation'),
    o('B', '2026-10-18T21:30:00Z', 0.2), // 01:30 on the 19th in Dubai
    o('C', '2026-10-14T10:00:00Z', 50),
    o('D', '2026-10-01T10:00:00Z', 10),
    o('E', '2026-09-30T19:59:00Z', 999), // 23:59 on 30 Sep in Dubai: last month
    o('F', '2026-10-19T06:00:00Z', 500, 'cancelled'),
    o('G', '2026-10-19T06:00:00Z', 300, 'pending_payment', 'pending'),
    o('H', '2026-10-19T06:00:00Z', 40, 'confirmed', 'paid'),
  ];
  assert.equal(countsAsSale(list[6]), false);
  const [today, week, month] = moneyHighlights(list, now);
  assert.deepEqual(today, { label: 'Today', fils: 14030, orders: 3 });
  assert.deepEqual(week, { label: 'Last 7 days', fils: 19030, orders: 4 });
  assert.deepEqual(month, { label: 'This month', fils: 20030, orders: 5 });
  const todos = todayTodos(list, [{ ...template, stockBySize: { [template.profiles[0].id]: 1 }, active: true }, { ...template, id: 'x', stockBySize: {}, active: true }], 2);
  assert.deepEqual(todos, { toConfirm: 1, toDispatch: 5, lowStock: 1, soldOut: 1 });
});

test('the Amazon/Noon export leaves styled (AI) photos out while the shop does not label them, like the Meta feed', async () => {
  const { marketplaceRows } = await import('@/lib/server/marketplace');
  const [a] = products.listProducts();
  const styled = '/api/images/' + 'b'.repeat(64) + '.png';
  const real = '/api/images/' + 'c'.repeat(64) + '.png';
  const p = { ...a, galleryImages: [real, styled], stagedPhotos: { [styled]: { staged: true as const } } };
  const opts = { base: 'https://shop.test', brand: 'B', categories: [] };
  const images = (label: boolean) => String(marketplaceRows([p], { ...opts, labelStyledPhotos: label })[0].find((c) => typeof c === 'string' && c.includes(real)) ?? '');
  assert.match(images(true), new RegExp(styled.replace(/[/.]/g, '\\$&')), 'labelled: styled photos may go out');
  assert.doesNotMatch(images(false), /b{64}/, 'not labelled: no styled photo goes out');
  assert.match(images(false), /c{64}/, 'the real photo still goes out');
});
