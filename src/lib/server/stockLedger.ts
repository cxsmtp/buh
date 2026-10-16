import type Database from 'better-sqlite3';

/**
 * The stock ledger (table stock_moves): one row per change of stock made in the
 * Admin Hub, written in the same transaction as the change itself, so no stock
 * moves without its record (who, why, every size's old → new).
 */

/** Why stock moved. Shown in the Admin Hub and kept in the audit log. */
export const STOCK_REASONS = ['received', 'sold_offline', 'damaged', 'correction'] as const;
export type StockReason = (typeof STOCK_REASONS)[number];
/** Reasons the shop records by itself (not chosen by a person). */
export type LedgerReason = StockReason | 'undo';

export interface SizeChange {
  sizeId: string;
  from: number;
  to: number;
}

export interface StockMove {
  id: number;
  productId: string;
  at: string;
  actor: string;
  reason: LedgerReason;
  changes: SizeChange[];
  note: string;
  undoOf: number | null;
  /** Set when a later move undid this one. */
  undoneBy?: number | null;
}

export interface MoveRow {
  id: number;
  idempotency_key: string;
  request_hash: string;
  product_id: string;
  at: string;
  actor: string;
  reason: string;
  changes: string;
  note: string;
  undo_of: number | null;
}

export function rowToMove(r: MoveRow): StockMove {
  return {
    id: r.id,
    productId: r.product_id,
    at: r.at,
    actor: r.actor,
    reason: r.reason as LedgerReason,
    changes: JSON.parse(r.changes) as SizeChange[],
    note: r.note,
    undoOf: r.undo_of,
  };
}

/** Record a move (call inside the transaction that changes the stock). */
export function insertMove(
  db: Database.Database,
  m: { key: string; hash: string; productId: string; actor: string; reason: LedgerReason; changes: SizeChange[]; note?: string; undoOf?: number | null }
): StockMove {
  const at = new Date().toISOString();
  const r = db
    .prepare('INSERT INTO stock_moves (idempotency_key, request_hash, product_id, at, actor, reason, changes, note, undo_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.key, m.hash, m.productId, at, m.actor.slice(0, 200), m.reason, JSON.stringify(m.changes), (m.note ?? '').slice(0, 200), m.undoOf ?? null);
  return { id: Number(r.lastInsertRowid), productId: m.productId, at, actor: m.actor, reason: m.reason, changes: m.changes, note: m.note ?? '', undoOf: m.undoOf ?? null };
}
