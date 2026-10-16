/**
 * Moving stock from the phone (BUH-02.05): the stepper endpoint is idempotent (a retried tap
 * never moves stock twice), refuses a change made from stale numbers (another device), records
 * every move (who, why, old → new) in the ledger and the audit log, takes reason codes, adds
 * "received stock" across several sizes at once, and undoes a move once. Drafts and the ledger
 * are in backups and come back from a restore. The API half runs against the real build.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

const dir = tempDataDir();
const products = await import('@/lib/server/products');
const moves = await import('@/lib/server/stockMoves');
const drafts = await import('@/lib/server/productDrafts');

const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};
const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as { status: number; details: Record<string, unknown>; message: string };
  }
  throw new Error('expected an error');
};
let n = 0;
const key = () => `test-key-${process.pid}-${++n}`;
const req = (body: Record<string, unknown>) => moves.parseMoveRequest({ key: key(), reason: 'correction', ...body });

function auditEntries(action: string) {
  const files = fs.readdirSync(dir).filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f));
  return files
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((e) => e.action === action);
}

function product() {
  return products.createProduct(
    {
      title: `Stock test ${++n}`,
      category: 'bedsheets',
      price: 300,
      featuredImage: 'https://images.unsplash.com/photo-1?w=10',
      profiles: [
        { id: 'king', name: 'King', piecesIncluded: 4, priceDelta: 0 },
        { id: 'queen', name: 'Queen', piecesIncluded: 4, priceDelta: 0 },
        { id: 'single', name: 'Single', piecesIncluded: 3, priceDelta: 0 },
      ],
      stockBySize: { king: 2, queen: 1, single: 0 },
    },
    'owner@shop.test'
  );
}

test('a tap moves one piece, is recorded with who, why and old → new, and is in the audit log', () => {
  const p = product();
  const k = key();
  const r = moves.applyStockMove(p.id, moves.parseMoveRequest({ key: k, reason: 'sold_offline', changes: [{ sizeId: 'king', delta: -1 }], expected: { king: 2 } }), 'owner@shop.test');
  assert.equal(r.replayed, false);
  assert.equal(r.product.stockBySize.king, 1);
  assert.deepEqual(r.move.changes, [{ sizeId: 'king', from: 2, to: 1 }]);
  assert.equal(r.move.reason, 'sold_offline');
  assert.equal(r.move.actor, 'owner@shop.test');
  const listed = moves.listStockMoves(p.id);
  assert.equal(listed[0].id, r.move.id);
  const entry = auditEntries('product.stock_moved').find((e) => e.details.moveId === r.move.id);
  assert.ok(entry, 'in the audit log');
  assert.equal(entry.details.reason, 'sold_offline');
  assert.deepEqual(entry.details.changes, ['king: 2 → 1']);
  assert.match(entry.details.by, /^o\*\*\*@shop\.test$/, 'who (masked in the log)');
});

test('the same idempotency key twice moves stock once and answers the same', () => {
  const p = product();
  const body = { key: key(), reason: 'received', changes: [{ sizeId: 'queen', delta: 3 }], expected: { queen: 1 } };
  const first = moves.applyStockMove(p.id, moves.parseMoveRequest(body), 'a@b.c');
  const again = moves.applyStockMove(p.id, moves.parseMoveRequest(body), 'a@b.c');
  assert.equal(first.product.stockBySize.queen, 4);
  assert.equal(again.replayed, true);
  assert.equal(again.move.id, first.move.id);
  assert.equal(products.getProduct(p.id)!.stockBySize.queen, 4, 'not 7');
  assert.equal(moves.listStockMoves(p.id).filter((m) => m.reason === 'received' && m.note !== 'new product').length, 1);
  // The same key with other numbers is refused, not applied.
  const reused = errorOf(() => moves.applyStockMove(p.id, moves.parseMoveRequest({ ...body, changes: [{ sizeId: 'queen', delta: 5 }] }), 'a@b.c'));
  assert.equal(reused.status, 409);
  assert.equal(reused.details.code, 'key_reused');
  assert.equal(products.getProduct(p.id)!.stockBySize.queen, 4);
});

test('a change from stale numbers (another device changed it) is refused and nothing moves', () => {
  const p = product();
  // Device A: King 2 → 3.
  moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'king', delta: 1 }], expected: { king: 2 } }), 'phone-a');
  // Device B still shows 2.
  const e = errorOf(() => moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'king', set: 5 }], expected: { king: 2 } }), 'phone-b'));
  assert.equal(e.status, 409);
  assert.equal(e.details.code, 'stock_changed');
  assert.deepEqual(e.details.current, { king: 3 });
  assert.match(e.message, /changed on another device/);
  assert.equal(products.getProduct(p.id)!.stockBySize.king, 3);
  // Typing a number always needs what was seen.
  assert.equal(statusOf(() => req({ changes: [{ sizeId: 'king', set: 5 }] })), 400);
});

test('reason codes: only the four known ones', () => {
  for (const reason of ['received', 'sold_offline', 'damaged', 'correction']) assert.equal(statusOf(() => moves.parseMoveRequest({ key: key(), reason, changes: [{ sizeId: 'king', delta: 1 }] })), 200);
  for (const reason of ['', 'stolen', 'undo', 1]) assert.equal(statusOf(() => moves.parseMoveRequest({ key: key(), reason, changes: [{ sizeId: 'king', delta: 1 }] })), 400);
  assert.equal(statusOf(() => moves.parseMoveRequest({ reason: 'received', changes: [{ sizeId: 'king', delta: 1 }] })), 400, 'no key');
  assert.equal(statusOf(() => moves.parseMoveRequest({ key: 'x', reason: 'received', changes: [{ sizeId: 'king', delta: 1 }] })), 400, 'short key');
  assert.equal(statusOf(() => req({ changes: [{ sizeId: 'king', delta: 1, price: 1 }] })), 400, 'unknown field in a change');
  assert.equal(statusOf(() => req({ changes: [{ sizeId: 'king', delta: 0.5 }] })), 400);
  assert.equal(statusOf(() => req({ changes: [{ sizeId: 'king', delta: 1, set: 2 }], expected: { king: 1 } })), 400);
  assert.equal(statusOf(() => req({ changes: [{ sizeId: 'king', delta: 1 }, { sizeId: 'king', delta: 1 }] })), 400);
});

test('received stock adds to several sizes at once, as one move', () => {
  const p = product();
  const r = moves.applyStockMove(p.id, moves.parseMoveRequest({ key: key(), reason: 'received', changes: [{ sizeId: 'king', delta: 3 }, { sizeId: 'queen', delta: 2 }, { sizeId: 'single', delta: 5 }], expected: { king: 2, queen: 1, single: 0 } }), 'owner');
  assert.deepEqual(r.product.stockBySize, { king: 5, queen: 3, single: 5 });
  assert.deepEqual(r.move.changes, [
    { sizeId: 'king', from: 2, to: 5 },
    { sizeId: 'queen', from: 1, to: 3 },
    { sizeId: 'single', from: 0, to: 5 },
  ]);
  // All or nothing: one stale size refuses the lot.
  const e = errorOf(() => moves.applyStockMove(p.id, moves.parseMoveRequest({ key: key(), reason: 'received', changes: [{ sizeId: 'king', delta: 1 }, { sizeId: 'queen', delta: 1 }], expected: { king: 5, queen: 99 } }), 'owner'));
  assert.equal(e.status, 409);
  assert.deepEqual(products.getProduct(p.id)!.stockBySize, { king: 5, queen: 3, single: 5 });
});

test('never below zero; a size the product does not offer is refused; a removed product cannot move', () => {
  const p = product();
  const e = errorOf(() => moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'single', delta: -1 }] }), 'o'));
  assert.equal(e.status, 409);
  assert.equal(e.details.code, 'not_enough');
  assert.equal(statusOf(() => moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'double', delta: 1 }] }), 'o')), 400);
  assert.equal(statusOf(() => moves.applyStockMove('nope', req({ changes: [{ sizeId: 'king', delta: 1 }] }), 'o')), 404);
  products.setArchived(p.id, true);
  assert.equal(statusOf(() => moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'king', delta: 1 }] }), 'o')), 400);
});

test('undo puts the numbers back once, only if nothing changed them since; retried undo is idempotent', () => {
  const p = product();
  const m = moves.applyStockMove(p.id, req({ reason: 'damaged', changes: [{ sizeId: 'king', delta: -2 }], expected: { king: 2 } }), 'o').move;
  const k = key();
  const u = moves.undoStockMove(p.id, m.id, k, 'o');
  assert.equal(u.product.stockBySize.king, 2);
  assert.equal(u.move.reason, 'undo');
  assert.equal(u.move.undoOf, m.id);
  assert.equal(moves.undoStockMove(p.id, m.id, k, 'o').replayed, true, 'same key: same answer');
  assert.equal(products.getProduct(p.id)!.stockBySize.king, 2, 'not applied twice');
  const twice = errorOf(() => moves.undoStockMove(p.id, m.id, key(), 'o'));
  assert.equal(twice.status, 409);
  assert.equal(twice.details.code, 'already_undone');
  assert.equal(moves.listStockMoves(p.id).find((x) => x.id === m.id)!.undoneBy, u.move.id);
  // A move followed by another change cannot be undone silently.
  const m2 = moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'queen', delta: 1 }], expected: { queen: 1 } }), 'o').move;
  moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'queen', delta: 1 }], expected: { queen: 2 } }), 'o');
  const stale = errorOf(() => moves.undoStockMove(p.id, m2.id, key(), 'o'));
  assert.equal(stale.details.code, 'stock_changed');
  assert.equal(products.getProduct(p.id)!.stockBySize.queen, 3);
  assert.ok(auditEntries('product.stock_moved').some((e) => e.details.reason === 'undo' && e.details.undoOf === m.id));
});

test('the product editor’s stock changes are in the ledger too', () => {
  const p = product();
  products.updateProduct(p.id, { stockBySize: { king: 7 }, expectedStockBySize: { king: 2 } }, 'editor@shop.test');
  const m = moves.listStockMoves(p.id)[0];
  assert.deepEqual(m.changes, [{ sizeId: 'king', from: 2, to: 7 }]);
  assert.equal(m.actor, 'editor@shop.test');
  assert.equal(m.note, 'product editor');
});

test('duplicate: a hidden copy with no stock, right after the original; the same key gives the same copy', () => {
  const p = product();
  const k = key();
  const a = products.duplicateProduct(p.id, k, 'o');
  const b = products.duplicateProduct(p.id, k, 'o');
  assert.equal(a.product.id, b.product.id);
  assert.equal(b.replayed, true);
  assert.equal(a.product.title, `${p.title} (copy)`);
  assert.equal(a.product.active, false);
  assert.equal(a.product.stockCount, 0);
  const ids = products.listProducts({ includeHidden: true }).map((x) => x.id);
  assert.equal(ids.indexOf(a.product.id), ids.indexOf(p.id) + 1);
});

test('SKU: optional, searchable text, checked', () => {
  const p = product();
  assert.equal(products.updateProduct(p.id, { sku: 'BUH-K-001' }).sku, 'BUH-K-001');
  assert.equal(statusOf(() => products.updateProduct(p.id, { sku: '<script>' })), 400);
});

test('drafts keep only the editor’s fields; photos must be uploaded first; unknown products refused', () => {
  const saved = drafts.saveDraft('new', { title: 'Half done', price: '199', photos: ['/api/images/' + 'a'.repeat(64) + '.jpg'], sizes: [{ id: 'king', name: 'King' }], stock: { king: 2 }, step: 2, evil: '<x>' }, 'o');
  assert.equal(saved.data.title, 'Half done');
  assert.equal('evil' in saved.data, false);
  assert.equal(drafts.getDraft('new')!.data.step, 2);
  assert.equal(statusOf(() => drafts.saveDraft('new', { photos: ['data:image/png;base64,AAAA'] }, 'o')), 400);
  assert.equal(statusOf(() => drafts.saveDraft('new', { photos: ['javascript:alert(1)'] }, 'o')), 400);
  assert.equal(statusOf(() => drafts.saveDraft('no-such-product', { title: 'x' }, 'o')), 404);
  assert.equal(statusOf(() => drafts.saveDraft('new', { description: 'x'.repeat(4000), colors: Array(12).fill({ name: 'y'.repeat(40), hex: '#ffffff' }), sizes: Array(12).fill({ id: 'k', name: 'z'.repeat(60), mattressSize: 'm'.repeat(80), fittedSheet: 'f'.repeat(80), flatSheet: 'f'.repeat(80), pillowcases: 'p'.repeat(80) }) }, 'o')), 200);
});

test('backups carry the stock ledger and drafts; the restore script brings them back', async () => {
  const p = product();
  moves.applyStockMove(p.id, req({ reason: 'damaged', changes: [{ sizeId: 'queen', delta: -1 }], expected: { queen: 1 } }), 'o');
  drafts.saveDraft(p.id, { title: 'Edited on the phone' }, 'o');
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  assert.ok(result.csv.some((c) => c.name === 'stock_moves.csv' && /damaged/.test(c.data.toString())), 'stock_moves.csv');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-stock-'));
  const r = spawnSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /[1-9]\d* stock moves, 2 product drafts/);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  const restored = db.prepare("SELECT changes FROM stock_moves WHERE product_id = ? AND reason = 'damaged'").get(p.id) as { changes: string };
  assert.deepEqual(JSON.parse(restored.changes), [{ sizeId: 'queen', from: 1, to: 0 }]);
  assert.equal((db.prepare('SELECT data FROM product_drafts WHERE id = ?').get(p.id) as { data: string }).data.includes('Edited on the phone'), true);
  db.close();
});

// ── Review fixes (BUH-02.05 review) ─────────────────────────────────────────

const rawDb = async () => (await import('@/lib/server/db')).getDb();

test('review: undo refuses a size the product no longer offers (no orphan stock row) and a removed product', async () => {
  const db = await rawDb();
  const p = product();
  // Mark sold out (every size to 0), then take King out of the product in the editor.
  const soldOut = moves.applyStockMove(p.id, req({ changes: [{ sizeId: 'king', set: 0 }, { sizeId: 'queen', set: 0 }], expected: { king: 2, queen: 1 } }), 'o').move;
  products.updateProduct(p.id, { profiles: p.profiles.filter((s) => s.id !== 'king'), defaultProfileId: 'queen' }, 'o');
  const e = errorOf(() => moves.undoStockMove(p.id, soldOut.id, key(), 'o'));
  assert.equal(e.status, 409);
  assert.match(e.message, /no longer offers/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM product_stock WHERE product_id = ? AND size_id = 'king'").get(p.id) as { n: number }).n, 0, 'no orphan King row');
  assert.equal((db.prepare('SELECT stock FROM products WHERE id = ?').get(p.id) as { stock: number }).stock, 0, 'products.stock not inflated');

  const q = product();
  const m = moves.applyStockMove(q.id, req({ changes: [{ sizeId: 'king', delta: 1 }], expected: { king: 2 } }), 'o').move;
  products.setArchived(q.id, true);
  const archived = errorOf(() => moves.undoStockMove(q.id, m.id, key(), 'o'));
  assert.equal(archived.status, 400);
  assert.match(archived.message, /removed/);
  assert.equal(products.getProduct(q.id)!.stockBySize.king, 3);
});

test('review: when the audit log cannot be written the move is not reported done; the retry (same key) writes the audit', async () => {
  const p = product();
  const k = key();
  const body = { key: k, reason: 'received', changes: [{ sizeId: 'king', delta: 4 }], expected: { king: 2 } };
  // The audit log file becomes unwritable (as with a full disk): a directory in its place.
  const file = path.join(dir, `audit-${new Date().toISOString().slice(0, 7)}.jsonl`);
  const aside = `${file}.aside`;
  fs.renameSync(file, aside);
  fs.mkdirSync(file);
  let first: { status: number } | null = null;
  try {
    first = errorOf(() => moves.applyStockMove(p.id, moves.parseMoveRequest(body), 'o'));
  } catch {
    first = null;
  } finally {
    fs.rmdirSync(file);
    fs.renameSync(aside, file);
  }
  assert.ok(first, 'not reported as done');
  assert.equal(first!.status, 503);
  assert.equal(products.getProduct(p.id)!.stockBySize.king, 6, 'the stock change itself is kept (and recorded in the ledger)');
  const again = moves.applyStockMove(p.id, moves.parseMoveRequest(body), 'o');
  assert.equal(again.replayed, true);
  assert.equal(products.getProduct(p.id)!.stockBySize.king, 6, 'not applied twice');
  const entries = auditEntries('product.stock_moved').filter((e) => e.details.moveId === again.move.id);
  assert.equal(entries.length, 1, 'audited exactly once, on the retry');
  moves.applyStockMove(p.id, moves.parseMoveRequest(body), 'o');
  assert.equal(auditEntries('product.stock_moved').filter((e) => e.details.moveId === again.move.id).length, 1, 'a later replay does not audit again');
});

test('review: a duplicate key belongs to its product; a deleted copy is a clear 404', async () => {
  const a = product();
  const b = product();
  const k = key();
  products.duplicateProduct(a.id, k, 'o');
  const other = errorOf(() => products.duplicateProduct(b.id, k, 'o'));
  assert.equal(other.status, 409);
  const k2 = key();
  const copy = products.duplicateProduct(a.id, k2, 'o').product;
  const db = await rawDb();
  db.prepare('DELETE FROM product_stock WHERE product_id = ?').run(copy.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(copy.id);
  products.invalidateProducts();
  const gone = errorOf(() => products.duplicateProduct(a.id, k2, 'o'));
  assert.equal(gone.status, 404);
  assert.match(gone.message, /copy/);
});

test('review: the editor dropping a size with stock records it (old → 0) in the same correction move', () => {
  const p = product();
  products.updateProduct(p.id, { profiles: p.profiles.filter((s) => s.id !== 'queen'), stockBySize: { king: 5 }, expectedStockBySize: { king: 2 } }, 'editor');
  const m = moves.listStockMoves(p.id)[0];
  assert.equal(m.reason, 'correction');
  assert.deepEqual(m.changes, [
    { sizeId: 'king', from: 2, to: 5 },
    { sizeId: 'queen', from: 1, to: 0 },
  ]);
  // A size dropped with nothing in stock needs no entry.
  const q = product();
  products.updateProduct(q.id, { profiles: q.profiles.filter((s) => s.id !== 'single') }, 'editor');
  assert.equal(moves.listStockMoves(q.id)[0].note, 'new product');
});

// ── The same through HTTP, against the production build ─────────────────────

describe('stock API (real build)', { skip: !hasBuild }, () => {
  let server: RunningServer;
  let cookie = '';
  before(async () => {
    server = await startServer();
    const h = { 'content-type': 'application/json', origin: server.base };
    await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
    await new Promise((r) => setTimeout(r, 300));
    const once = server.log().match(/Password: (\S+)/)![1];
    const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
    const first = (login.headers.get('set-cookie') || '').split(';')[0];
    const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Stock-Owner-Pass-1' }) });
    cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  });
  after(() => server?.stop());
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

  test('admin only, same-site only, allow-listed, size-capped', async () => {
    const { products: list } = await (await call('GET', '/api/admin/products')).json();
    const p = list[0];
    const body = { key: key(), reason: 'received', changes: [{ sizeId: p.profiles[0].id, delta: 1 }] };
    assert.equal((await call('POST', `/api/admin/products/${p.id}/stock`, body, { cookie: '' })).status, 401);
    assert.equal((await call('POST', `/api/admin/products/${p.id}/stock`, body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call('POST', `/api/admin/products/${p.id}/stock`, { ...body, price: 1 })).status, 400);
    assert.equal((await call('POST', `/api/admin/products/${p.id}/stock`, { ...body, note: 'x'.repeat(5000) })).status, 413);
    const old = await call('POST', `/api/admin/products/${p.id}/stock`, { sizeId: p.profiles[0].id, delta: 1 });
    assert.equal(old.status, 400, 'an out-of-date page is told to refresh');
    for (const route of ['/api/admin/images', `/api/admin/products/${p.id}/duplicate`, '/api/admin/products/drafts/new']) {
      assert.equal((await call(route.includes('drafts') ? 'PUT' : 'POST', route, {}, { cookie: '' })).status, 401, route);
      assert.equal((await call(route.includes('drafts') ? 'PUT' : 'POST', route, { surprise: 1 })).status, 400, route);
    }
  });

  test('a retried request (same key) moves stock once; a second device with old numbers gets 409; Undo works', async () => {
    const { products: list } = await (await call('GET', '/api/admin/products')).json();
    const p = list[1];
    const size = p.profiles[0].id;
    const seen = p.stockBySize[size];
    const body = { key: key(), reason: 'received', changes: [{ sizeId: size, delta: 2 }], expected: { [size]: seen } };
    const [a, b] = await Promise.all([call('POST', `/api/admin/products/${p.id}/stock`, body), call('POST', `/api/admin/products/${p.id}/stock`, body)]);
    const ja = await a.json();
    const jb = await b.json();
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(ja.move.id, jb.move.id);
    assert.equal([ja.replayed, jb.replayed].filter(Boolean).length, 1, 'one of them was the replay');
    assert.equal(ja.product.stockBySize[size], seen + 2);
    const stale = await call('POST', `/api/admin/products/${p.id}/stock`, { key: key(), reason: 'correction', changes: [{ sizeId: size, set: 1 }], expected: { [size]: seen } });
    assert.equal(stale.status, 409);
    const js = await stale.json();
    assert.equal(js.code, 'stock_changed');
    assert.equal(js.current[size], seen + 2);
    const undo = await call('POST', `/api/admin/products/${p.id}/stock`, { key: key(), undo: ja.move.id });
    assert.equal(undo.status, 200);
    assert.equal((await undo.json()).product.stockBySize[size], seen);
    const history = await (await call('GET', `/api/admin/products/${p.id}/stock`)).json();
    assert.equal(history.moves[0].reason, 'undo');
    assert.equal(history.moves[1].undoneBy, history.moves[0].id);
  });

  test('photo upload goes through the image checks; drafts save and come back', async () => {
    const bad = await call('POST', '/api/admin/images', { image: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' });
    assert.equal(bad.status, 400);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
    const ok = await call('POST', '/api/admin/images', { image: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
    assert.equal(ok.status, 201);
    const { url } = await ok.json();
    assert.match(url, /^\/api\/images\/[a-f0-9]{64}\.jpg$/);
    assert.equal((await call('PUT', '/api/admin/products/drafts/new', { draft: { title: 'From the phone', photos: [url], step: 1 } })).status, 200);
    const back = await (await call('GET', '/api/admin/products/drafts/new')).json();
    assert.deepEqual(back.draft.data.photos, [url]);
    assert.equal((await call('DELETE', '/api/admin/products/drafts/new')).status, 200);
    assert.equal((await (await call('GET', '/api/admin/products/drafts/new')).json()).draft, null);
  });
});
