import crypto from 'node:crypto';
import { audit } from './audit';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { getProduct, invalidateProducts, type StoredProduct } from './products';
import { insertMove, rowToMove, STOCK_REASONS, type MoveRow, type SizeChange, type StockMove, type StockReason } from './stockLedger';

/**
 * Moving stock from the Admin Hub: the + / − steppers, a typed number,
 * "Received stock" across several sizes, "Mark sold out", and Undo.
 *
 * Safe to retry and safe with two devices:
 *  - every request carries an idempotency key; the same key again returns the
 *    first answer and moves nothing (a different request under a used key is refused);
 *  - every request says what the device last saw for each size it changes
 *    (`expected`); if the stock is different now (another phone, a sale), nothing
 *    is changed and the answer is 409 "changed on another device";
 *  - the move is recorded (stock_moves) in the same transaction as the change,
 *    and in the audit log, before the answer says it is done.
 */

const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_QTY = 100_000;

export interface MoveRequest {
  key: string;
  reason: StockReason;
  changes: Array<{ sizeId: string; delta?: number; set?: number }>;
  expected: Record<string, number>;
  note: string;
}

export interface MoveResult {
  move: StockMove;
  product: StoredProduct;
  /** The same key was sent before: this is the first answer again, nothing moved now. */
  replayed: boolean;
}

function hashOf(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stockChanged(product: StoredProduct, current: Record<string, number>): HttpError {
  return new HttpError(409, 'Stock changed on another device: refresh to see the current numbers.', {}, { code: 'stock_changed', current, stockBySize: product.stockBySize });
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY.test(key)) throw new HttpError(400, 'Each change needs an idempotency key (8–80 letters, digits, - or _).');
  return key;
}

function whole(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}.`);
  return v;
}

/** Check a request body (already allow-listed) and turn it into a MoveRequest. */
export function parseMoveRequest(body: Record<string, unknown>): MoveRequest {
  const key = checkKey(body.key);
  const reason = body.reason;
  if (typeof reason !== 'string' || !(STOCK_REASONS as readonly string[]).includes(reason)) throw new HttpError(400, `Reason must be one of: ${STOCK_REASONS.join(', ')}.`);
  if (!Array.isArray(body.changes) || body.changes.length === 0 || body.changes.length > 12) throw new HttpError(400, 'Give 1 to 12 size changes.');
  const seen = new Set<string>();
  const changes = body.changes.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new HttpError(400, `Change ${i + 1} must be an object.`);
    const o = c as Record<string, unknown>;
    const extra = Object.keys(o).filter((k) => !['sizeId', 'delta', 'set'].includes(k));
    if (extra.length) throw new HttpError(400, `Unexpected field in change ${i + 1}: ${extra[0].slice(0, 30)}.`);
    if (typeof o.sizeId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,29}$/.test(o.sizeId)) throw new HttpError(400, `Change ${i + 1}: unknown size.`);
    if (seen.has(o.sizeId)) throw new HttpError(400, 'Each size may appear once.');
    seen.add(o.sizeId);
    if ((o.delta === undefined) === (o.set === undefined)) throw new HttpError(400, `Change ${i + 1}: give either delta or set.`);
    if (o.delta !== undefined) {
      const delta = whole(o.delta, 'Change', -1000, 1000);
      if (delta === 0) throw new HttpError(400, 'A change of 0 changes nothing.');
      return { sizeId: o.sizeId, delta };
    }
    return { sizeId: o.sizeId, set: whole(o.set, 'Stock', 0, MAX_QTY) };
  });
  const expected: Record<string, number> = {};
  if (body.expected !== undefined) {
    if (!body.expected || typeof body.expected !== 'object' || Array.isArray(body.expected)) throw new HttpError(400, 'expected must be an object of size → pieces.');
    for (const [size, qty] of Object.entries(body.expected as Record<string, unknown>)) {
      if (!seen.has(size)) throw new HttpError(400, 'expected may only name sizes being changed.');
      expected[size] = whole(qty, 'Expected stock', 0, MAX_QTY);
    }
  }
  // A typed number replaces what is there, so the device must say what it saw.
  for (const c of changes) if (c.set !== undefined && expected[c.sizeId] === undefined) throw new HttpError(400, 'Setting a number needs the number you saw (expected).');
  const note = body.note === undefined ? '' : typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
  if (body.note !== undefined && typeof body.note !== 'string') throw new HttpError(400, 'Note must be text.');
  return { key, reason: reason as StockReason, changes, expected, note };
}

function existingByKey(key: string): MoveRow | undefined {
  return getDb().prepare('SELECT * FROM stock_moves WHERE idempotency_key = ?').get(key) as MoveRow | undefined;
}

function replay(row: MoveRow, hash: string): MoveResult {
  if (row.request_hash !== hash) throw new HttpError(409, 'This change was already sent with different numbers. Refresh and try again.', {}, { code: 'key_reused' });
  const product = getProduct(row.product_id);
  if (!product) throw new HttpError(404, 'Product not found.');
  return { move: rowToMove(row), product, replayed: true };
}

function currentQty(productId: string, sizeId: string): number {
  return (getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').get(productId, sizeId) as { qty: number } | undefined)?.qty ?? 0;
}

function setQty(productId: string, sizeId: string, qty: number) {
  getDb()
    .prepare('INSERT INTO product_stock (product_id, size_id, qty) VALUES (?, ?, ?) ON CONFLICT(product_id, size_id) DO UPDATE SET qty = excluded.qty')
    .run(productId, sizeId, qty);
}

function record(move: StockMove, product: StoredProduct, key: string) {
  audit('product.stock_moved', {
    by: move.actor,
    productId: product.id,
    title: product.title,
    reason: move.reason,
    moveId: move.id,
    undoOf: move.undoOf ?? undefined,
    idempotencyKey: key,
    changes: move.changes.map((c) => `${c.sizeId}: ${c.from} → ${c.to}`),
    note: move.note || undefined,
  });
}

/** Apply a move to one product's stock (see the top of this file). */
export function applyStockMove(productId: string, req: MoveRequest, actor: string): MoveResult {
  const hash = hashOf({ productId, reason: req.reason, changes: req.changes, expected: req.expected, note: req.note });
  const prior = existingByKey(req.key);
  if (prior) return replay(prior, hash);
  const product = getProduct(productId);
  if (!product) throw new HttpError(404, 'Product not found.');
  if (product.archived) throw new HttpError(400, 'This product was removed: restore it first.');
  for (const c of req.changes) if (!product.profiles.some((p) => p.id === c.sizeId)) throw new HttpError(400, 'This product does not offer that size.');

  let replayed: MoveResult | null = null;
  const move = inTransaction(() => {
    // Checked again inside the write lock: two copies of the same request racing.
    const again = existingByKey(req.key);
    if (again) {
      replayed = replay(again, hash);
      return null;
    }
    const now: Record<string, number> = {};
    for (const c of req.changes) now[c.sizeId] = currentQty(productId, c.sizeId);
    const stale = req.changes.some((c) => req.expected[c.sizeId] !== undefined && req.expected[c.sizeId] !== now[c.sizeId]);
    if (stale) throw stockChanged(product, now);
    const changes: SizeChange[] = req.changes.map((c) => {
      const to = c.set ?? now[c.sizeId] + (c.delta as number);
      if (to < 0) {
        const name = product.profiles.find((p) => p.id === c.sizeId)?.name ?? c.sizeId;
        throw new HttpError(409, `There ${now[c.sizeId] === 1 ? 'is' : 'are'} only ${now[c.sizeId]} ${name} to take away.`, {}, { code: 'not_enough', current: now });
      }
      if (to > MAX_QTY) throw new HttpError(400, `Stock may be at most ${MAX_QTY}.`);
      return { sizeId: c.sizeId, from: now[c.sizeId], to };
    });
    const real = changes.filter((c) => c.from !== c.to);
    if (!real.length) throw new HttpError(400, 'That is already the number in stock.', {}, { code: 'no_change' });
    for (const c of real) setQty(productId, c.sizeId, c.to);
    return insertMove(getDb(), { key: req.key, hash, productId, actor, reason: req.reason, changes: real, note: req.note });
  });
  if (replayed) return replayed;
  invalidateProducts();
  const fresh = getProduct(productId)!;
  record(move!, fresh, req.key);
  return { move: move!, product: fresh, replayed: false };
}

/** Put back what one move changed, if nothing has changed those sizes since. Once only. */
export function undoStockMove(productId: string, moveId: unknown, keyIn: unknown, actor: string): MoveResult {
  const key = checkKey(keyIn);
  const id = whole(moveId, 'Move', 1, Number.MAX_SAFE_INTEGER);
  const hash = hashOf({ productId, undo: id });
  const prior = existingByKey(key);
  if (prior) return replay(prior, hash);
  const product = getProduct(productId);
  if (!product) throw new HttpError(404, 'Product not found.');

  let replayed: MoveResult | null = null;
  const move = inTransaction(() => {
    const again = existingByKey(key);
    if (again) {
      replayed = replay(again, hash);
      return null;
    }
    const row = getDb().prepare('SELECT * FROM stock_moves WHERE id = ? AND product_id = ?').get(id, productId) as MoveRow | undefined;
    if (!row) throw new HttpError(404, 'That change was not found.');
    if (row.reason === 'undo') throw new HttpError(400, 'An undo cannot itself be undone: change the number instead.');
    if (getDb().prepare('SELECT 1 FROM stock_moves WHERE undo_of = ?').get(id)) throw new HttpError(409, 'That change was already undone.', {}, { code: 'already_undone' });
    const original = rowToMove(row);
    const now: Record<string, number> = {};
    for (const c of original.changes) now[c.sizeId] = currentQty(productId, c.sizeId);
    if (original.changes.some((c) => now[c.sizeId] !== c.to)) throw stockChanged(product, now);
    const changes = original.changes.map((c) => ({ sizeId: c.sizeId, from: c.to, to: c.from }));
    for (const c of changes) setQty(productId, c.sizeId, c.to);
    return insertMove(getDb(), { key, hash, productId, actor, reason: 'undo', changes, note: `undo of #${id}`, undoOf: id });
  });
  if (replayed) return replayed;
  invalidateProducts();
  const fresh = getProduct(productId)!;
  record(move!, fresh, key);
  return { move: move!, product: fresh, replayed: false };
}

/** The latest moves of one product (newest first), with which were undone. */
export function listStockMoves(productId: string, limit = 20): StockMove[] {
  const rows = getDb().prepare('SELECT * FROM stock_moves WHERE product_id = ? ORDER BY id DESC LIMIT ?').all(productId, Math.max(1, Math.min(100, limit))) as MoveRow[];
  const undone = new Map(
    (getDb().prepare('SELECT undo_of, id FROM stock_moves WHERE product_id = ? AND undo_of IS NOT NULL').all(productId) as Array<{ undo_of: number; id: number }>).map((r) => [r.undo_of, r.id])
  );
  return rows.map((r) => ({ ...rowToMove(r), undoneBy: undone.get(r.id) ?? null }));
}
