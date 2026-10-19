/**
 * Settings → Catalogue → Weaves: the four weaves by default (also for settings saved before the
 * list existed), names checked, a weave products still use can't be removed (the message says how
 * many and which), Rename moves every product (archived ones and drafts too) in one audited
 * transaction, and products are checked against the list.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const settings = await import('@/lib/server/settings');
const products = await import('@/lib/server/products');
const weaves = await import('@/lib/server/weaves');
const drafts = await import('@/lib/server/productDrafts');
const { getDb } = await import('@/lib/server/db');

const photo = 'https://images.example.com/sheet.jpg';
function newProduct(over: Record<string, unknown> = {}) {
  const sizes = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  return products.createProduct({ title: 'Weave Test Set', category: 'bedsheets', price: 300, featuredImage: photo, profiles: sizes, defaultProfileId: 'king', stockBySize: { king: 1 }, ...over });
}
const auditEntries = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> });

test('the four weaves by default, and for catalogue settings saved before weaves existed', () => {
  assert.deepEqual(settings.getSettings('catalog').weaves, ['Sateen', 'Percale', 'Linen', 'Jacquard']);
  const { weaves: _w, ...old } = settings.getSettings('catalog');
  void _w;
  getDb().prepare("INSERT INTO settings (key, data, updated_at) VALUES ('catalog', ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(JSON.stringify({ ...old, lowStockThreshold: 3 }), new Date().toISOString());
  settings._clearSettingsCache();
  const c = settings.getSettings('catalog');
  assert.equal(c.lowStockThreshold, 3);
  assert.deepEqual(c.weaves, ['Sateen', 'Percale', 'Linen', 'Jacquard']);
});

test('weave names are checked: 1–30 characters, no markup, each once ignoring capitals, 1 to 30 of them', async () => {
  await assert.rejects(settings.updateSettings('catalog', { weaves: [] }), /Keep 1 to 30 weaves/);
  await assert.rejects(settings.updateSettings('catalog', { weaves: Array.from({ length: 31 }, (_, i) => `W${i}`) }), /Keep 1 to 30 weaves/);
  await assert.rejects(settings.updateSettings('catalog', { weaves: ['Sateen', 'Percale', 'Linen', 'Jacquard', 'x'.repeat(31)] }), /at most 30 characters/);
  await assert.rejects(settings.updateSettings('catalog', { weaves: ['Sateen', 'Percale', 'Linen', 'Jacquard', '<b>Waffle</b>'] }), /letters, digits/);
  await assert.rejects(settings.updateSettings('catalog', { weaves: ['Sateen', 'Percale', 'Linen', 'Jacquard', 'sateen'] }), /in the list twice/);
  await assert.rejects(settings.updateSettings('catalog', { weaves: ['Sateen', 'Percale', 'Linen', 'Jacquard', ''] }), /needs a name/);
  await settings.updateSettings('catalog', { weaves: ['  Sateen ', 'Percale', 'Linen', 'Jacquard', 'Waffle  Weave', "Oxford (2/2) & co's"] });
  assert.deepEqual(settings.getSettings('catalog').weaves, ['Sateen', 'Percale', 'Linen', 'Jacquard', 'Waffle Weave', "Oxford (2/2) & co's"]);
  // Reordered, and an unused one removed.
  await settings.updateSettings('catalog', { weaves: ['Jacquard', 'Sateen', 'Percale', 'Linen', 'Waffle Weave'] });
  assert.deepEqual(settings.getSettings('catalog').weaves, ['Jacquard', 'Sateen', 'Percale', 'Linen', 'Waffle Weave']);
});

test('a weave products still use cannot be removed: the message names how many and which (first 5)', async () => {
  const before = products.listProducts({ includeHidden: true }).filter((p) => p.weave === 'Percale');
  assert.ok(before.length >= 1, 'the starter catalogue has Percale sets');
  for (let i = 0; i < 6; i++) newProduct({ title: `Percale Set ${i + 1}`, weave: 'Percale' });
  const count = before.length + 6;
  await assert.rejects(settings.updateSettings('catalog', { weaves: ['Jacquard', 'Sateen', 'Linen', 'Waffle Weave'] }), (e: { status: number; message: string; details: Record<string, unknown> }) => {
    assert.equal(e.status, 400);
    assert.match(e.message, new RegExp(`“Percale” is still the weave of ${count} products`));
    // In the shop's order (new products first): the first 5 by name, then an ellipsis.
    assert.match(e.message, /\(Percale Set 6, Percale Set 5, Percale Set 4, Percale Set 3, Percale Set 2, …\)/);
    assert.match(e.message, /use Rename/);
    assert.equal(e.details.code, 'weave_in_use');
    return true;
  });
  assert.ok(settings.getSettings('catalog').weaves.includes('Percale'), 'nothing changed');
  // An autosave is refused the same way.
  await assert.rejects(settings.updateSettings('catalog', { weaves: ['Sateen'] }, { auto: true }), /still the weave of/);
  assert.equal(weaves.weaveUsage().Percale, count);
});

test('products are checked against the list; a product may keep its own weave once it is gone from the list', async () => {
  assert.throws(() => newProduct({ weave: 'Chambray' }), /Unknown weave: add it in Settings → Catalogue → Weaves first/);
  await settings.updateSettings('catalog', { weaves: [...settings.getSettings('catalog').weaves, 'Chambray'] });
  const p = newProduct({ weave: 'Chambray', title: 'Chambray Set' });
  assert.equal(p.weave, 'Chambray');
  // No weave given: the first in the list.
  assert.equal(newProduct({ weave: '' }).weave, settings.getSettings('catalog').weaves[0]);
  // Archived, it no longer blocks removing Chambray; edited later, it keeps it.
  products.setArchived(p.id, true);
  await settings.updateSettings('catalog', { weaves: settings.getSettings('catalog').weaves.filter((w) => w !== 'Chambray') });
  const kept = products.updateProduct(p.id, { price: 310 });
  assert.equal(kept.weave, 'Chambray');
  assert.throws(() => products.updateProduct(kept.id, { weave: 'Twill' }), /Unknown weave/);
});

test('Rename moves every product (archived and drafts too) and the list, in one audited transaction', async () => {
  const percale = products.listProducts({ includeHidden: true, includeArchived: true }).filter((p) => p.weave === 'Percale');
  const archived = percale[percale.length - 1];
  products.setArchived(archived.id, true);
  drafts.saveDraft('new', { title: 'Draft', weave: 'Percale' }, 'owner@shop.test');
  const order = settings.getSettings('catalog').weaves;
  const r = weaves.renameWeave('Percale', ' Cotton  Percale ', 'owner@shop.test');
  assert.equal(r.to, 'Cotton Percale');
  assert.equal(r.products, percale.length);
  assert.equal(r.drafts, 1);
  assert.equal(r.merged, false);
  assert.deepEqual(settings.getSettings('catalog').weaves, order.map((w) => (w === 'Percale' ? 'Cotton Percale' : w)), 'same place in the list');
  const all = products.listProducts({ includeHidden: true, includeArchived: true });
  assert.equal(all.filter((p) => p.weave === 'Percale').length, 0);
  assert.equal(all.filter((p) => p.weave === 'Cotton Percale').length, percale.length);
  assert.equal(products.getProduct(archived.id)!.weave, 'Cotton Percale');
  assert.equal(drafts.getDraft('new')!.data.weave, 'Cotton Percale');
  // Settings read fresh from the database agree (the change was committed, not only cached).
  settings._clearSettingsCache();
  assert.ok(settings.getSettings('catalog').weaves.includes('Cotton Percale'));
  const entry = auditEntries().reverse().find((e) => e.action === 'catalog.weave_renamed')!;
  assert.deepEqual({ by: entry.details.by, from: entry.details.from, to: entry.details.to, products: entry.details.products }, { by: 'owner@shop.test', from: 'Percale', to: 'Cotton Percale', products: percale.length });
  // The old name is free to be removed or added again; the new one can't be removed while used.
  await assert.rejects(settings.updateSettings('catalog', { weaves: settings.getSettings('catalog').weaves.filter((w) => w !== 'Cotton Percale') }), /still the weave of/);
});

test('Rename into a weave already in the list merges them; bad renames change nothing', async () => {
  newProduct({ title: 'Linen Set', weave: 'Linen' });
  const linen = products.listProducts({ includeHidden: true, includeArchived: true }).filter((p) => p.weave === 'Linen').length;
  const sateen = products.listProducts({ includeHidden: true, includeArchived: true }).filter((p) => p.weave === 'Sateen').length;
  assert.throws(() => weaves.renameWeave('Nope', 'X', 'o'), /not in the list/);
  assert.throws(() => weaves.renameWeave('Linen', '<i>x</i>', 'o'), /letters, digits/);
  assert.throws(() => weaves.renameWeave('Linen', 'Linen', 'o'), /different name/);
  const r = weaves.renameWeave('Linen', 'sateen', 'o');
  assert.equal(r.to, 'Sateen', 'keeps the existing spelling');
  assert.equal(r.merged, true);
  assert.ok(!settings.getSettings('catalog').weaves.includes('Linen'));
  assert.equal(products.listProducts({ includeHidden: true, includeArchived: true }).filter((p) => p.weave === 'Sateen').length, sateen + linen);
  // Only capitals changed: a rename too.
  const c = weaves.renameWeave('Jacquard', 'JACQUARD', 'o');
  assert.equal(c.to, 'JACQUARD');
  assert.ok(settings.getSettings('catalog').weaves.includes('JACQUARD'));
});

test('a rename whose audit entry cannot be written changes nothing (products, list or cache)', async () => {
  const before = settings.getSettings('catalog').weaves;
  const sateenIds = products.listProducts({ includeHidden: true, includeArchived: true }).filter((p) => p.weave === 'Sateen').map((p) => p.id);
  // The audit log's month file made unwritable (a directory in its place).
  const month = path.join(dir, `audit-${new Date().toISOString().slice(0, 7)}.jsonl`);
  const moved = `${month}.bak`;
  fs.renameSync(month, moved);
  fs.mkdirSync(month);
  try {
    assert.throws(() => weaves.renameWeave('Sateen', 'Silky Sateen', 'o'), (e: { status: number }) => e.status === 503);
  } finally {
    fs.rmdirSync(month);
    fs.renameSync(moved, month);
  }
  assert.deepEqual(settings.getSettings('catalog').weaves, before);
  settings._clearSettingsCache();
  assert.deepEqual(settings.getSettings('catalog').weaves, before);
  products.invalidateProducts();
  for (const id of sateenIds) assert.equal(products.getProduct(id)!.weave, 'Sateen');
});

test('a backup keeps the weaves and the AI model, never the AI key; the restore script restores them', async () => {
  delete process.env.BACKUP_PASSPHRASE;
  await settings.updateSettings('ai', { anthropicApiKey: 'sk-ant-api03-BACKUPKEY-abcdefghijklmnopqrstuvwxyz', enabled: true, model: 'claude-haiku-5-5' });
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-weaves-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    const row = (key: string) => JSON.parse((db.prepare('SELECT data FROM settings WHERE key = ?').get(key) as { data: string }).data);
    assert.deepEqual(row('catalog').weaves, settings.getSettings('catalog').weaves);
    const restoredAi = row('ai');
    assert.equal(restoredAi.model, 'claude-haiku-5-5');
    assert.equal(restoredAi.anthropicApiKey, '', 'the key is blanked in every backup');
    const weave = (db.prepare("SELECT json_extract(data, '$.weave') AS w FROM products WHERE json_extract(data, '$.title') = 'Linen Set'").get() as { w: string }).w;
    assert.equal(weave, 'Sateen', 'products keep their (renamed) weave');
  } finally {
    db.close();
  }
});
