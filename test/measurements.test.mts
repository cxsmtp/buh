/**
 * Reported: "In measurement there should be a check box for fitted, else by default it's a flat
 * bed sheet. If the measurement is not given, don't show it to the customer, because not every
 * sheet comes with a duvet cover. Same with colours: only when selected."
 *
 * Measurements are the product's own (per size), the shop shows only what is filled in, one sheet
 * line (Fitted or Flat), colours only when the owner gave some; the products already in the shop
 * are carried over once (duvet cover only for duvet products), marked for review, audited once.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const { measurementRows, sheetRow, isDuvetProduct, standardMeasurements } = await import('@/lib/measurements');
const { getDb, _closeDb } = await import('@/lib/server/db');
const products = await import('@/lib/server/products');
const { DEFAULT_BED_PROFILES } = await import('@/data/bedProfiles');
const { INITIAL_PRODUCTS } = await import('@/data/initialData');
const { _resetAuditState } = await import('@/lib/server/audit');

const size = (over: Record<string, unknown> = {}) => ({ id: 'king', name: 'King', badge: '', mattressSize: '180 x 200 cm', fittedSheet: '', flatSheet: '', pillowcases: '', piecesIncluded: 3, priceDelta: 0, ...over });
const auditEntries = (d: string, action: string) =>
  fs
    .readdirSync(d)
    .filter((f) => f.startsWith('audit-') && f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> }))
    .filter((e) => e.action === action);

test('only the filled-in measurements are shown: flat sheet + pillowcases is exactly those two rows', () => {
  const rows = measurementRows({ fitted: false }, size({ flatSheet: '260 x 270 cm', pillowcases: '2 pcs 50 x 75 cm', fittedSheet: '180 x 200 + 40 cm' }));
  assert.deepEqual(rows.map((r) => [r.label, r.value]), [['Flat sheet', '260 x 270 cm'], ['Pillowcases', '2 pcs 50 x 75 cm']]);
});

test('fitted ticked: the sheet line is "Fitted sheet" with the fitted size (and never the flat one)', () => {
  const s = size({ flatSheet: '260 x 270 cm', fittedSheet: '180 x 200 + 40 cm' });
  assert.deepEqual(measurementRows({ fitted: true }, s).map((r) => [r.label, r.value]), [['Fitted sheet', '180 x 200 + 40 cm']]);
  // Fitted, but only a flat size given: no sheet line at all (nothing is made up).
  assert.deepEqual(measurementRows({ fitted: true }, size({ flatSheet: '260 x 270 cm' })), []);
  assert.equal(sheetRow({}, size())?.label, undefined);
});

test('no measurements: no rows; blanks and spaces count as none; duvet cover and other pieces only when given', () => {
  assert.deepEqual(measurementRows({}, size({ flatSheet: '  ', pillowcases: '' })), []);
  const rows = measurementRows({}, size({ duvetCover: '240 x 260 cm', otherPieces: '2 cushion covers 45 x 45 cm' }));
  assert.deepEqual(rows.map((r) => r.label), ['Duvet cover', 'Other pieces']);
});

test('"Use standard sizes" suggests sheets and pillowcases, the duvet cover only for a duvet product', () => {
  const king = DEFAULT_BED_PROFILES.king;
  const sheet = { category: 'bedsheets', title: 'Indigo set', description: '', shortDescription: '' };
  assert.deepEqual(standardMeasurements(sheet, king), { fittedSheet: king.fittedSheet, flatSheet: king.flatSheet, pillowcases: king.pillowcases });
  assert.equal(standardMeasurements({ ...sheet, category: 'duvet-covers' }, king).duvetCover, king.duvetCover);
  assert.equal(standardMeasurements({ ...sheet, description: 'With a matching duvet cover.' }, king).duvetCover, king.duvetCover);
  assert.equal(isDuvetProduct({ ...sheet, title: 'Heritage DUVET set' }), true);
  assert.deepEqual(standardMeasurements(sheet, undefined), { fittedSheet: '', flatSheet: '', pillowcases: '' });
});

// ── the products already in the shop ────────────────────────────────────────

const legacy = (id: string, over: Record<string, unknown>) => ({
  ...INITIAL_PRODUCTS[0],
  id,
  colors: [{ name: 'As pictured', hex: '#ffffff' }],
  profiles: [{ ...DEFAULT_BED_PROFILES.king }, { ...DEFAULT_BED_PROFILES.queen, flatSheet: 'Own flat 230 x 250 cm', pillowcases: '' }],
  ...over,
});

test('existing products are carried over once: sheets and pillowcases kept, duvet only for duvet products, fitted for fitted sheets, marked for review, one audit entry', () => {
  // A shop from before this release: products with the standard measurements, no step done yet.
  const db = getDb();
  const insert = db.prepare('INSERT INTO products (id, data, stock, active, position, updated_at) VALUES (?, ?, 0, 1, ?, ?)');
  const rows = [
    legacy('old-sheet', { title: 'Jaipur block print set', category: 'bedsheets', description: 'Hand block printed.', shortDescription: '' }),
    legacy('old-duvet', { title: 'Paisley set', category: 'duvet-covers', description: '', shortDescription: '' }),
    legacy('old-mentions', { title: 'Sage set', category: 'bedsheets', description: 'Comes with a duvet cover.', shortDescription: '' }),
    legacy('old-fitted', { title: 'Cotton fitted sheet', category: 'fitted-sheets', description: '', shortDescription: '' }),
  ];
  rows.forEach((p, i) => insert.run(p.id, JSON.stringify(p), i, new Date().toISOString()));

  const all = products.listProducts({ includeHidden: true, includeArchived: true });
  const by = (id: string) => all.find((p) => p.id === id)!;
  const sheet = by('old-sheet');
  assert.equal(sheet.measurementsReview, true, 'marked "Check measurements"');
  assert.equal(sheet.fitted, false, 'a flat sheet by default');
  assert.equal(sheet.profiles[0].flatSheet, DEFAULT_BED_PROFILES.king.flatSheet, 'sheet kept as shown today');
  assert.equal(sheet.profiles[0].pillowcases, DEFAULT_BED_PROFILES.king.pillowcases);
  assert.equal(sheet.profiles[0].duvetCover, undefined, 'no duvet cover claimed for a sheet set');
  assert.equal(sheet.profiles[1].flatSheet, 'Own flat 230 x 250 cm', "the product's own value wins");
  assert.equal(sheet.profiles[1].pillowcases, DEFAULT_BED_PROFILES.queen.pillowcases, 'an empty one gets the standard size');
  assert.deepEqual(sheet.colors, [{ name: 'As pictured', hex: '#ffffff' }], 'saved colours are kept');
  assert.equal(by('old-duvet').profiles[0].duvetCover, DEFAULT_BED_PROFILES.king.duvetCover, 'duvet category keeps it');
  assert.equal(by('old-mentions').profiles[1].duvetCover, DEFAULT_BED_PROFILES.queen.duvetCover, 'mentions a duvet: kept');
  assert.equal(by('old-fitted').fitted, true, 'fitted sheets are fitted');
  assert.deepEqual(measurementRows(by('old-fitted'), by('old-fitted').profiles[0]).map((r) => r.label), ['Fitted sheet', 'Pillowcases']);

  const entries = auditEntries(dir, 'product.measurements_carried_over');
  assert.equal(entries.length, 1, 'one audit entry');
  assert.equal(entries[0].details.products, 4);
  assert.equal(entries[0].details.fitted, 1);
  assert.equal(entries[0].details.withDuvetCover, 2);
  const marker = JSON.parse((db.prepare('SELECT data FROM kv WHERE key = ?').get('step:measurements-per-product') as { data: string }).data);
  assert.equal(marker.audited, true);
});

test('the carry-over is idempotent: again (a restart, another copy of the shop) changes nothing and logs nothing', () => {
  const before = getDb().prepare('SELECT id, data FROM products ORDER BY id').all();
  // The owner reviews one and saves it from the editor: the mark goes, the next run leaves it so.
  products.updateProduct('old-sheet', { measurementsReview: false, profiles: [size({ flatSheet: '260 x 270 cm', pillowcases: '2 pcs' })] }, 'owner@test');
  products.carryOverMeasurementsOnce();
  products.invalidateProducts();
  products.listProducts();
  products.carryOverMeasurementsOnce();
  const after = getDb().prepare('SELECT id, data FROM products ORDER BY id').all() as Array<{ id: string; data: string }>;
  assert.deepEqual(after.filter((r) => r.id !== 'old-sheet'), (before as Array<{ id: string }>).filter((r) => r.id !== 'old-sheet'));
  assert.equal(products.getProduct('old-sheet')!.measurementsReview, undefined, 'reviewed stays reviewed');
  assert.equal(auditEntries(dir, 'product.measurements_carried_over').length, 1);
  // Other saves (show/hide) keep the mark.
  products.updateProduct('old-duvet', { active: false });
  assert.equal(products.getProduct('old-duvet')!.measurementsReview, true);
});

test('validation: measurement fields allow-listed and capped at 80, fitted only true/false, colours optional (none stays none)', () => {
  const base = { ...products.getProduct('old-sheet')!, id: undefined };
  const made = products.createProduct({ ...base, title: 'Plain set', colors: [], fitted: 'yes', measurementsReview: 'x', profiles: [size({ flatSheet: '260 x 270 cm', evil: '<script>', otherPieces: '2 cushion covers' })], stockBySize: { king: 1 } });
  assert.deepEqual(made.colors, [], 'no default colour injected');
  assert.equal(made.fitted, false);
  assert.equal(made.measurementsReview, undefined);
  assert.equal(made.profiles[0].otherPieces, '2 cushion covers');
  assert.equal('evil' in made.profiles[0], false, 'unknown fields dropped');
  const status = (fn: () => unknown) => {
    try {
      fn();
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };
  for (const k of ['flatSheet', 'fittedSheet', 'pillowcases', 'duvetCover', 'otherPieces']) {
    assert.equal(status(() => products.updateProduct(made.id, { profiles: [size({ [k]: 'x'.repeat(81) })] })), 400, k);
    assert.equal(status(() => products.updateProduct(made.id, { profiles: [size({ [k]: 42 })] })), 400, `${k} must be text`);
  }
  assert.equal(products.updateProduct(made.id, { fitted: true }).fitted, true);
});

test('a product without colours: the order has no colour, and a colour from an older bag is ignored', async () => {
  const orders = await import('@/lib/server/orders');
  const { issuePhoneToken } = await import('@/lib/server/phoneToken');
  const p = products.listProducts().find((x) => x.title === 'Plain set')!;
  const order = (color?: string) =>
    orders.placeOrder({
      idempotencyKey: `measure-${color ?? 'none'}-${Date.now()}`,
      verificationToken: issuePhoneToken(`+97150200${color ? '1111' : '2222'}`),
      customer: { fullName: 'Fatima Al Mansoori', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '12' },
      items: [{ productId: p.id, profileId: 'king', quantity: 1, ...(color ? { color } : {}) }],
      paymentMethod: 'cod',
    }).order;
  assert.equal(order().items[0].color, undefined);
  products.updateProduct(p.id, { stockBySize: { king: 1 } });
  assert.equal(order('Standard').items[0].color, undefined);
});

test('the shop never gets the review mark (the public catalogue strips it)', async () => {
  const { GET } = await import('@/app/api/products/route');
  const res = GET();
  const text = await res.text();
  assert.ok(text.includes('old-duvet') || text.includes('old-mentions'));
  assert.equal(text.includes('measurementsReview'), false);
});

test('a new shop: the starter catalogue claims no duvet cover on sheet sets and needs no review', () => {
  _closeDb();
  _resetAuditState();
  const fresh = tempDataDir();
  products.invalidateProducts();
  const all = products.listProducts({ includeHidden: true, includeArchived: true });
  assert.ok(all.length >= 3);
  for (const p of all) {
    assert.equal(p.measurementsReview, undefined, p.id);
    if (!isDuvetProduct(p)) assert.ok(p.profiles.every((s) => !s.duvetCover), `${p.id}: no duvet cover`);
  }
  assert.equal(auditEntries(fresh, 'product.measurements_carried_over').length, 0);
});
