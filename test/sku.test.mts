/**
 * SKUs made by the shop: the format, uniqueness (ignoring case), the running number never reused
 * (also after a product is removed and after a restore), a duplicate typed by the owner refused
 * with the next free one, the prefix and category codes validated, "Fill them in" (once, audited),
 * the sizes' SKUs, the order line's SKU, and the marketplace export unchanged for SKUs already there.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;

const sku = await import('@/lib/sku');
const serverSku = await import('@/lib/server/sku');
const products = await import('@/lib/server/products');
const settings = await import('@/lib/server/settings');
const marketplace = await import('@/lib/server/marketplace');
const backup = await import('@/lib/server/backup');

const FORMAT = /^[A-Z0-9]{2,6}-[A-Z0-9]{2,3}-[A-Z0-9]{1,6}-\d{3,}$/;

function newProduct(title: string, extra: Record<string, unknown> = {}) {
  const base = products.listProducts()[0];
  return products.createProduct({ ...base, id: undefined, title, sku: '', stockBySize: { [base.profiles[0].id]: 1 }, ...extra });
}

function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('codes: the category from its name, the title’s design words, the size as the export writes it', () => {
  assert.equal(sku.categoryCode('Hand Block Sets'), 'HBS');
  assert.equal(sku.categoryCode('Duvet Covers'), 'DC');
  assert.equal(sku.categoryCode('Towels'), 'TWL');
  assert.equal(sku.titleCode('Indigo Chevron King Bed Sheet Set'), 'INDCHV');
  assert.equal(sku.titleCode('Jaipur Hand Block Printed Cotton Set'), 'JAIPUR');
  assert.equal(sku.titleCode('Bed Sheet Set'), 'BDSHST', 'only generic words: they are used');
  assert.equal(sku.titleCode('Café Crème Bloom'), 'CFCRBL');
  assert.equal(sku.titleCode(''), 'ITEM');
  assert.equal(sku.composeSku('BUH', 'HBS', 'INDCHV', 7), 'BUH-HBS-INDCHV-007');
  assert.equal(sku.sizeCode('super-king'), 'SUPER-KING');
  assert.equal(sku.normalizeSku(' buh jai_01 '), 'BUH-JAI-01');
  assert.equal(sku.skuNumber('BUH-HBS-INDCHV-007', 'BUH'), 7);
  assert.equal(sku.skuNumber('OWN-CODE', 'BUH'), null);
});

test('a new product gets an SKU in the format, numbered after the last; each number once', () => {
  const a = newProduct('Indigo Chevron Set');
  const b = newProduct('Indigo Chevron Set');
  assert.match(a.sku!, FORMAT);
  assert.match(a.sku!, /-INDCHV-/);
  assert.notEqual(a.sku, b.sku);
  const na = sku.skuNumber(a.sku!, 'BUH')!;
  const nb = sku.skuNumber(b.sku!, 'BUH')!;
  assert.equal(nb, na + 1);
  // Removed products keep their number: the next one is still new.
  products.setArchived(b.id, true);
  const c = newProduct('Saffron Lotus Set');
  assert.equal(sku.skuNumber(c.sku!, 'BUH'), nb + 1, 'never reused after a removal');
  assert.match(serverSku.suggestSku('Saffron Lotus Set', c.category), new RegExp(`-${String(nb + 2).padStart(3, '0')}$`));
});

test('an SKU typed by the owner: capitals made, refused when another product has it (ignoring case), with the next free one', () => {
  const a = newProduct('Rose Garden Set', { sku: 'own code 1' });
  assert.equal(a.sku, 'OWN-CODE-1');
  assert.throws(
    () => newProduct('Other Set', { sku: 'own-code-1' }),
    (err: { status?: number; message: string; details?: { code?: string; suggestion?: string } }) => {
      assert.equal(err.status, 409);
      assert.equal(err.details?.code, 'sku_taken');
      assert.match(err.details!.suggestion!, FORMAT);
      assert.match(err.message, /already has the SKU OWN-CODE-1/);
      return true;
    },
  );
  assert.throws(() => newProduct('Bad', { sku: 'BUH—HBS!' }), /capital letters, digits and dashes/);
  // Typed in our own format with a higher number: the counter moves past it.
  const high = newProduct('Typed', { sku: 'BUH-HBS-TYPED-500' });
  assert.equal(high.sku, 'BUH-HBS-TYPED-500');
  const after = newProduct('After Typed');
  assert.equal(sku.skuNumber(after.sku!, 'BUH'), 501);
});

test('an SKU already saved is kept as it is (even an older form), and changing it is audited', () => {
  const p = newProduct('Old Form');
  const db = new Database(path.join(dir, 'shop.db'));
  const data = JSON.parse((db.prepare('SELECT data FROM products WHERE id = ?').get(p.id) as { data: string }).data);
  data.sku = 'old sku/1';
  db.prepare('UPDATE products SET data = ? WHERE id = ?').run(JSON.stringify(data), p.id);
  db.close();
  products.invalidateProducts();
  const saved = products.updateProduct(p.id, { price: 321 });
  assert.equal(saved.sku, 'old sku/1', 'not rewritten behind the owner’s back');
  const changed = products.updateProduct(p.id, { sku: 'NEW-CODE-9' });
  assert.equal(changed.sku, 'NEW-CODE-9');
  const entry = auditEntries().reverse().find((e) => e.action === 'product.updated' && e.details.productId === p.id)!;
  assert.deepEqual((entry.details.changes as Record<string, unknown>).sku, { from: 'old sku/1', to: 'NEW-CODE-9' });
});

test('the prefix and category codes: validated, and used', async () => {
  await assert.rejects(settings.updateSettings('catalog', { skuPrefix: 'B' }), /2 to 6 capital letters/);
  await assert.rejects(settings.updateSettings('catalog', { skuPrefix: 'TOOLONGX' }), /2 to 6 capital letters/);
  const cats = settings.getSettings('catalog').categories;
  await assert.rejects(settings.updateSettings('catalog', { categories: cats.map((c, i) => (i === 0 ? { ...c, code: 'B-S' } : c)) }), /2 or 3 capital letters/);
  await settings.updateSettings('catalog', { skuPrefix: 'bh', categories: cats.map((c, i) => (i === 0 ? { ...c, code: 'bs' } : c)) });
  assert.equal(settings.getSettings('catalog').skuPrefix, 'BH');
  const p = newProduct('Peacock Paisley Set', { category: cats[0].id });
  assert.match(p.sku!, /^BH-BS-PCCPSL-\d{3}$/);
  await settings.updateSettings('catalog', { skuPrefix: 'BUH', categories: cats });
});

test('a duplicated product gets its own SKU', () => {
  const p = newProduct('Copy Me');
  const { product: copy } = products.duplicateProduct(p.id, `dup-${Date.now()}-abc`);
  assert.ok(copy.sku && copy.sku !== p.sku);
  assert.match(copy.sku!, FORMAT);
});

test('"Fill them in": every product without an SKU gets one, once, audited; SKUs already there stay', () => {
  const before = products.productsWithoutSku().length;
  const db = new Database(path.join(dir, 'shop.db'));
  const rows = (db.prepare('SELECT id, data FROM products WHERE archived = 0').all() as Array<{ id: string; data: string }>).filter((r) => JSON.parse(r.data).sku);
  const keep = rows.find((r) => JSON.parse(r.data).sku === 'OWN-CODE-1')!;
  let cleared = 0;
  for (const r of rows) {
    if (r.id === keep.id) continue;
    if (cleared++ >= 3) break;
    const d = JSON.parse(r.data);
    delete d.sku;
    db.prepare('UPDATE products SET data = ? WHERE id = ?').run(JSON.stringify(d), r.id);
  }
  db.close();
  products.invalidateProducts();
  assert.equal(products.productsWithoutSku().length, before + 3);
  const filled = products.fillMissingSkus('owner@shop.test');
  assert.equal(filled.length, before + 3);
  for (const f of filled) assert.match(f.sku, FORMAT);
  assert.equal(new Set(products.listProducts({ includeHidden: true, includeArchived: true }).map((p) => p.sku?.toUpperCase())).size, products.listProducts({ includeHidden: true, includeArchived: true }).length, 'all unique');
  assert.equal(products.getProduct(keep.id)!.sku, 'OWN-CODE-1');
  assert.deepEqual(products.fillMissingSkus('owner@shop.test'), [], 'pressed again: nothing to do');
  const audits = auditEntries().filter((e) => e.action === 'product.skus_filled');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].details.count, before + 3);
  assert.equal(audits[0].details.by, 'owner@shop.test');
});

test('sizes’ SKUs: the product’s plus the size; the marketplace export keeps SKUs already there; an order line carries it', async () => {
  const own = { id: 'prod-x', sku: 'BUH-JAI-01' };
  assert.equal(marketplace.parentSku(own), 'BUH-JAI-01');
  assert.equal(marketplace.variantSku(own, 'king'), 'BUH-JAI-01-KING');
  assert.equal(marketplace.variantSku(own, 'super-king'), 'BUH-JAI-01-SUPER-KING');
  assert.equal(marketplace.parentSku({ id: 'prod-abc123', sku: undefined }), 'BUH-ABC123', 'no SKU: the fixed one from the id, as before');

  const { issuePhoneToken } = await import('@/lib/server/phoneToken');
  const { placeOrder } = await import('@/lib/server/orders');
  const p = products.listProducts().find((x) => x.stockCount > 0 && x.sku)!;
  const size = p.profiles.find((s) => (p.stockBySize[s.id] ?? 0) > 0)!;
  const order = placeOrder({
    idempotencyKey: `sku-${Date.now()}`,
    verificationToken: issuePhoneToken('+971501234567'),
    customer: { fullName: 'Sara', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: size.id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
  assert.equal(order.items[0].sku, marketplace.variantSku(p, size.id));
});

test('the running number survives a backup and restore: a restored shop never repeats one', async () => {
  const last = newProduct('Before Backup');
  const n = sku.skuNumber(last.sku!, 'BUH')!;
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-sku-restore-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  const counter = Number(JSON.parse((db.prepare("SELECT data FROM kv WHERE key = 'sku:counter'").get() as { data: string }).data));
  db.close();
  assert.ok(counter >= n, `the counter came back (${counter} ≥ ${n})`);
  // The restored shop, opened like the running one: the next SKU is after the last.
  const { execFileSync: run } = await import('node:child_process');
  const out = run(process.execPath, ['--import', 'tsx', '-e', "const m = await import('@/lib/server/sku'); const s = m.peekSkuNumber ? m : m.default; console.log(s.peekSkuNumber());"], { env: { ...process.env, DATA_DIR: target }, cwd: process.cwd() }).toString().trim();
  assert.equal(Number(out.split('\n').pop()), n + 1);
});
