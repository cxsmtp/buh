/**
 * The shop's search, filters and sort (src/lib/catalogFilter.ts): what the address bar holds, which
 * products show, the filter options offered (only the ones that make a difference, with counts),
 * the removable chips, and the round "story" chips built from the catalogue.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Product } from '@/types';

const f = await import('@/lib/catalogFilter');

const size = (id: string, name: string, priceDelta = 0) => ({ id, name, priceDelta, mattressSize: '', fittedSheet: '', flatSheet: '', pillowcases: '', piecesIncluded: 4 }) as unknown as Product['profiles'][number];

function product(over: Partial<Product> & { id: string }): Product {
  return {
    title: over.id,
    slug: over.id,
    description: 'A lovely set',
    shortDescription: '',
    category: 'bedsheets',
    price: 300,
    material: 'Cotton',
    threadCount: 300,
    weave: 'Percale',
    colors: [{ name: 'Indigo', hex: '#2B3A4A' }],
    featuredImage: `https://images.unsplash.com/${over.id}?w=1200`,
    galleryImages: [],
    stockCount: 2,
    stockBySize: { queen: 1, king: 1 },
    isFeatured: false,
    rating: 5,
    reviewsCount: 1,
    profiles: [size('queen', 'Queen Size Bed'), size('king', 'King Size Bed (Most Popular)', 50)],
    defaultProfileId: 'king',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Product;
}

const categories = [
  { id: 'bedsheets', label: 'Hand Block Sets', icon: '🛏️' },
  { id: 'duvets', label: 'Duvet Covers', icon: '☁️' },
  { id: 'empty', label: 'Nothing here yet', icon: '·' },
];

const catalog: Product[] = [
  product({ id: 'mughal', title: 'Mughal Garden Set', price: 365, compareAtPrice: 495, isNewArrival: true, createdAt: '2026-10-10T00:00:00Z', colors: [{ name: 'Sand Dune Rose', hex: '#C28277' }] }),
  product({ id: 'jaipur', title: 'Jaipur Jaal Linen', price: 440, createdAt: '2026-10-08T00:00:00Z', colors: [{ name: 'Oatmeal', hex: '#D8CBB5' }], stockBySize: { queen: 0, king: 1 }, stockCount: 1 }),
  product({ id: 'paisley', title: 'Heritage Paisley Duvet', category: 'duvets', price: 410, createdAt: '2026-10-05T00:00:00Z', colors: [{ name: 'Antique Olive', hex: '#6F7755' }], profiles: [size('single', 'Single / Twin Bed')], stockBySize: { single: 0 }, stockCount: 0 }),
  product({ id: 'indigo', title: 'Indigo River Set', price: 600, createdAt: '2026-10-12T00:00:00Z', colors: [{ name: 'Indigo River & Ivory', hex: '#264653' }, { name: 'Madder Rust', hex: '#9E2A2B' }] }),
];

test('the address bar round-trips every filter; junk is ignored', () => {
  const filters = { ...f.EMPTY_FILTERS, q: 'mughal', cats: ['bedsheets', 'duvets'], sizes: ['king'], colors: ['blue'], min: 400, max: 500, inStock: true, sale: true, newIn: true, sort: 'price-asc' as const };
  const search = f.filtersToSearch(filters);
  assert.equal(search, '?q=mughal&cat=bedsheets%2Cduvets&size=king&color=blue&min=400&max=500&stock=1&sale=1&new=1&sort=price-asc');
  assert.deepEqual(f.parseFilters(search), filters);
  assert.equal(f.filtersToSearch(f.EMPTY_FILTERS), '', 'nothing on: a clean address');
  // Other keys (an open product, a campaign tag) are kept.
  assert.equal(f.filtersToSearch({ ...f.EMPTY_FILTERS, sizes: ['queen'] }, '?p=abc&cat=old&utm_source=ig'), '?p=abc&utm_source=ig&size=queen');

  const junk = f.parseFilters('?sort=cheapest&min=-5&max=abc&stock=yes&cat=,,a,a,b&q=' + 'x'.repeat(200));
  assert.equal(junk.sort, 'featured');
  assert.equal(junk.min, null);
  assert.equal(junk.max, null);
  assert.equal(junk.inStock, false);
  assert.deepEqual(junk.cats, ['a', 'b']);
  assert.equal(junk.q.length, 80);
  // A range the wrong way round is dropped rather than showing nothing.
  assert.deepEqual([f.parseFilters('?min=500&max=400').min, f.parseFilters('?min=500&max=400').max], [null, null]);
  // At most 20 values per list.
  assert.equal(f.parseFilters(`?size=${Array.from({ length: 50 }, (_, i) => `s${i}`).join(',')}`).sizes.length, 20);
});

test('search matches every word typed, in the name, category, colours or fabric, ignoring case and accents', () => {
  const ids = (q: string) => f.applyFilters(catalog, { ...f.EMPTY_FILTERS, q }, categories).map((p) => p.id);
  assert.deepEqual(ids('mughal'), ['mughal']);
  assert.deepEqual(ids('MUGHAL set'), ['mughal']);
  assert.deepEqual(ids('mughal duvet'), []);
  assert.deepEqual(ids('duvet'), ['paisley'], 'category label');
  assert.deepEqual(ids('rust'), ['indigo'], 'colour name');
  assert.deepEqual(ids('jaípur'), ['jaipur'], 'accents ignored');
  assert.deepEqual(ids('  '), ['mughal', 'jaipur', 'paisley', 'indigo']);
});

test('filters combine: category, size, colour family, price, in stock, sale, new; sort keeps the shop order for ties', () => {
  const ids = (patch: Partial<import('@/lib/catalogFilter').Filters>) => f.applyFilters(catalog, { ...f.EMPTY_FILTERS, ...patch }, categories).map((p) => p.id);
  assert.deepEqual(ids({ cats: ['duvets'] }), ['paisley']);
  assert.deepEqual(ids({ cats: ['duvets', 'bedsheets'] }), ['mughal', 'jaipur', 'paisley', 'indigo']);
  assert.deepEqual(ids({ sizes: ['single'] }), ['paisley'], 'a size offered (sold out or not)');
  assert.deepEqual(ids({ sizes: ['single'], inStock: true }), [], 'in stock only: that size must have a piece left');
  assert.deepEqual(ids({ sizes: ['queen'], inStock: true }), ['mughal', 'indigo'], 'jaipur has no queen left');
  assert.deepEqual(ids({ inStock: true }), ['mughal', 'jaipur', 'indigo']);
  assert.deepEqual(ids({ colors: ['blue'] }), ['indigo']);
  assert.deepEqual(ids({ colors: ['cream', 'red'] }), ['mughal', 'jaipur', 'indigo'], 'any of the chosen colours');
  assert.deepEqual(ids({ min: 400, max: 500 }), ['jaipur', 'paisley'], 'min inclusive, max exclusive');
  assert.deepEqual(ids({ max: 400 }), ['mughal']);
  assert.deepEqual(ids({ min: 440 }), ['jaipur', 'indigo']);
  assert.deepEqual(ids({ sale: true }), ['mughal']);
  assert.deepEqual(ids({ newIn: true }), ['mughal']);
  assert.deepEqual(ids({ sort: 'price-asc' }), ['mughal', 'paisley', 'jaipur', 'indigo']);
  assert.deepEqual(ids({ sort: 'price-desc' }), ['indigo', 'jaipur', 'paisley', 'mughal']);
  assert.deepEqual(ids({ sort: 'new' }), ['indigo', 'mughal', 'jaipur', 'paisley']);
  // The shop's own order for equal prices.
  const twins = [product({ id: 'b', price: 100 }), product({ id: 'a', price: 100 })];
  assert.deepEqual(f.applyFilters(twins, { ...f.EMPTY_FILTERS, sort: 'price-asc' }).map((p) => p.id), ['b', 'a']);
  // The input is never reordered.
  assert.deepEqual(catalog.map((p) => p.id), ['mughal', 'jaipur', 'paisley', 'indigo']);
});

test('colour families come from the swatch: what a shopper means by blue, cream or red', () => {
  const fam = (hex: string) => f.colorFamily(hex)?.id;
  assert.equal(fam('#2B3A4A'), 'blue'); // heritage indigo
  assert.equal(fam('#1C2E4A'), 'blue');
  assert.equal(fam('#264653'), 'blue');
  assert.equal(fam('#D8CBB5'), 'cream'); // oatmeal
  assert.equal(fam('#F0ECE1'), 'cream'); // alabaster
  assert.equal(fam('#C28277'), 'red'); // dusty rose
  assert.equal(fam('#9E2A2B'), 'red'); // madder
  assert.equal(fam('#B85D43'), 'orange'); // terracotta
  assert.equal(fam('#6F7755'), 'green'); // olive
  assert.equal(fam('#606C5A'), 'green'); // sage
  assert.equal(fam('#D4A63A'), 'yellow');
  assert.equal(fam('#6B4A8A'), 'purple');
  assert.equal(fam('#111111'), 'black');
  assert.equal(fam('#808080'), 'grey');
  assert.equal(fam('#ffffff'), 'cream');
  assert.equal(fam('not a colour'), undefined);
});

test('facets: only options that make a difference, each with what it would leave; the chosen one stays', () => {
  const facets = f.computeFacets(catalog, f.EMPTY_FILTERS, categories);
  assert.deepEqual(facets.categories.map((o) => [o.id, o.count]), [['bedsheets', 3], ['duvets', 1]], 'an empty category is not offered');
  assert.deepEqual(facets.sizes.map((o) => [o.label, o.count]), [['Queen', 3], ['King', 3], ['Single', 1]]);
  assert.deepEqual(facets.colors.map((o) => o.id), ['cream', 'red', 'green', 'blue'], 'in a fixed, familiar order');
  assert.equal(facets.total, 4);
  assert.equal(facets.inStock, 3, 'one piece is sold out: "In stock only" is worth offering');
  assert.equal(facets.sale, 1);
  assert.equal(facets.newIn, 1);
  assert.deepEqual(facets.prices.map((b) => [b.label, b.count]), [['Under AED 400', 1], ['AED 400–500', 2], ['AED 600 and over', 1]], 'an empty band is left out');

  // Counts keep the other filters: with Duvet Covers chosen, sizes count only duvets...
  const duvets = f.computeFacets(catalog, { ...f.EMPTY_FILTERS, cats: ['duvets'] }, categories);
  assert.deepEqual(duvets.sizes, [], 'only one size left to choose: nothing to filter, not offered');
  const king = f.computeFacets(catalog, { ...f.EMPTY_FILTERS, colors: ['blue', 'cream'] }, categories);
  assert.deepEqual(king.sizes.map((o) => [o.id, o.count]), [['queen', 2], ['king', 2]], 'options with nothing behind them are left out');
  // ...while the category facet still shows what each category would give (so it can be switched).
  assert.deepEqual(duvets.categories.map((o) => [o.id, o.count, o.selected]), [['bedsheets', 3, false], ['duvets', 1, true]]);
  assert.equal(duvets.total, 1);
  assert.equal(duvets.inStock, null, 'nothing left in stock to narrow to: the toggle is not offered');

  // A facet with a single option filters nothing: not shown.
  const one = f.computeFacets([catalog[0]], f.EMPTY_FILTERS, categories);
  assert.deepEqual([one.categories, one.colors, one.prices, one.inStock, one.sale], [[], [], [], null, null]);

  // Every piece on sale: "On sale" would change nothing, so it is not offered (unless already on).
  const allSale = catalog.map((p) => ({ ...p, compareAtPrice: p.price + 10 }));
  assert.equal(f.computeFacets(allSale, f.EMPTY_FILTERS, categories).sale, null);
  assert.equal(f.computeFacets(allSale, { ...f.EMPTY_FILTERS, sale: true }, categories).sale, 4);

  // A price range from an old link that isn't one of today's bands still shows, chosen, so it can be cleared.
  const odd = f.computeFacets(catalog, { ...f.EMPTY_FILTERS, min: 123, max: 456 }, categories);
  assert.ok(odd.prices.some((b) => b.selected && b.min === 123 && b.max === 456));
});

test('price bands have round edges and cover every price', () => {
  assert.deepEqual(f.priceBands([365, 440, 410, 385]), [{ min: null, max: 375 }, { min: 375, max: 400 }, { min: 400, max: 425 }, { min: 425, max: null }]);
  const bands = f.priceBands([365, 440, 410, 385, 600]);
  assert.ok(bands.length >= 2 && bands.length <= 4, JSON.stringify(bands));
  for (const price of [365, 440, 410, 385, 600]) {
    assert.equal(bands.filter((b) => (b.min === null || price >= b.min) && (b.max === null || price < b.max)).length, 1, `${price} is in exactly one band`);
  }
  for (const b of bands) for (const edge of [b.min, b.max]) if (edge !== null) assert.equal(edge % 5, 0, `round edge ${edge}`);
  assert.deepEqual(f.priceBands([300, 300]), [], 'one price: no bands');
  assert.deepEqual(f.priceBands([300]), []);
  assert.equal(f.priceLabel(null, 400), 'Under AED 400');
  assert.equal(f.priceLabel(400, 500), 'AED 400–500');
  assert.equal(f.priceLabel(500, null), 'AED 500 and over');
});

test('chips: one per filter, each removable on its own; Clear keeps the search and sort', () => {
  const on = { ...f.EMPTY_FILTERS, q: 'set', cats: ['duvets'], sizes: ['king'], colors: ['blue'], min: 400, max: null, inStock: true, sale: true, newIn: true, sort: 'new' as const };
  const chips = f.activeChips(on, catalog, categories);
  assert.deepEqual(chips.map((c) => c.label), ['“set”', 'Duvet Covers', 'Size: King', 'Blue & indigo', 'AED 400 and over', 'In stock', 'On sale', 'New in']);
  const noKing = chips.find((c) => c.key === 'size:king')!.without;
  assert.deepEqual(noKing.sizes, []);
  assert.deepEqual(noKing.cats, ['duvets'], 'only that one is removed');
  assert.equal(f.activeCount(on), 7, 'search and sort are not counted on the Filter button');
  const cleared = f.clearFilters(on);
  assert.equal(f.activeCount(cleared), 0);
  assert.equal(cleared.q, 'set');
  assert.equal(cleared.sort, 'new');
  assert.equal(f.shortSize('Super King / Emperor Bed'), 'Super King');
  assert.equal(f.shortSize('Custom Dimensions'), 'Custom Dimensions');
});

test('stories: All, then New in and On sale when they narrow things down, then each category with products, with its first photo', () => {
  const stories = f.buildStories(catalog, categories);
  assert.deepEqual(stories.map((s) => s.label), ['All', 'New in', 'On sale', 'Hand Block Sets', 'Duvet Covers']);
  const duvets = stories.find((s) => s.id === 'cat:duvets')!;
  assert.equal(duvets.image, catalog[2].featuredImage);
  // A story replaces the other stories' filters but keeps search, size and sort.
  const before = { ...f.EMPTY_FILTERS, q: 'set', sizes: ['king'], sale: true, sort: 'new' as const };
  const after = duvets.apply(before);
  assert.deepEqual([after.cats, after.sale, after.q, after.sizes, after.sort], [['duvets'], false, 'set', ['king'], 'new']);
  assert.equal(duvets.isActive(after), true);
  assert.equal(stories[0].isActive(after), false);
  assert.equal(stories[0].isActive(stories[0].apply(after)), true, 'All clears the story filters');
  // Every piece new and one category: only All (the row is not shown).
  const same = catalog.filter((p) => p.category === 'bedsheets').map((p) => ({ ...p, isNewArrival: true, compareAtPrice: undefined }));
  assert.deepEqual(f.buildStories(same, categories).map((s) => s.id), ['all']);
  assert.deepEqual(f.buildStories([], categories).map((s) => s.id), ['all']);
});
