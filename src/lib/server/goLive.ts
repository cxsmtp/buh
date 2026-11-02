import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Order } from '@/types';
import { auditOrThrow } from './audit';
import { createBackup } from './backup';
import { dataDir } from './dataDir';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { invalidateProducts } from './products';
import { auditBacklog, auditMove, insertMove, type SizeChange } from './stockLedger';

/**
 * Settings → System & backups → Go live (asked by the owner: "everything so far was a test; flush the
 * orders, financials to zero"). Before the shop takes real orders, the orders placed while testing are
 * removed for good: their history, VAT documents, card and refund records, Stripe event ids and
 * transfer screenshots, and (when asked) the customer chats. The pieces they held go back to stock.
 * Products, photos, settings and the audit log stay.
 *
 * It refuses while any order carries real money or a real shipment (a live card payment, or a courier
 * booking that was not a test), so a real sale is never wiped; and it makes a backup first, so the
 * removed orders can be brought back with the restore. Audited before anything is removed.
 */

export const GO_LIVE_PHRASE = 'GO LIVE';
const KV = 'shop:went_live';

export interface GoLivePreview {
  orders: number;
  /** Pieces the orders still hold (every order not cancelled): they go back to stock. */
  pieces: number;
  screenshots: number;
  chats: number;
  /** Orders that carry real money or a real shipment: Go live is refused while there is any. */
  blockers: string[];
  wentLive: { at: string; by: string; backup: string } | null;
}

export interface GoLiveResult {
  orders: number;
  pieces: number;
  screenshots: number;
  chats: number;
  backup: string;
  at: string;
}

interface Row {
  id: string;
  status: string;
  data: string;
  card_state: string | null;
  card_livemode: number | null;
}

const receiptsDir = () => path.join(dataDir(), 'receipts');

function screenshotFiles(): string[] {
  try {
    return fs.readdirSync(receiptsDir()).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
}

/** Why an order can't be removed: real money (a live card payment) or a real courier booking. */
function blockerOf(r: Row): string {
  if (r.card_livemode === 1 && r.card_state && ['pending', 'paid', 'refund_pending', 'refunded'].includes(r.card_state)) {
    return `${r.id} has a real card payment (Stripe live mode): Go live only removes test orders.`;
  }
  let order: Partial<Order> = {};
  try {
    order = JSON.parse(r.data) as Partial<Order>;
  } catch {
    return '';
  }
  const c = order.courier;
  // A live courier booking (not a test) on an order still open: a real parcel may be on its way.
  if (c && !c.simulated && (c.carrierEnv === 'live' || c.bookingState) && r.status !== 'cancelled') {
    return `${r.id} was booked with the courier for real (AWB ${c.awbNumber || 'not yet known'}): cancel that booking first. Go live only removes test orders.`;
  }
  return '';
}

/** The pieces each order still holds, by product and size (orders not cancelled). */
function heldPieces(rows: Row[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.status === 'cancelled') continue;
    let order: Partial<Order> = {};
    try {
      order = JSON.parse(r.data) as Partial<Order>;
    } catch {
      continue;
    }
    for (const item of order.items ?? []) {
      const q = Math.max(0, Math.round(Number(item.quantity) || 0));
      if (!q || !item.productId || !item.profileId) continue;
      const sizes = out.get(item.productId) ?? new Map<string, number>();
      sizes.set(item.profileId, (sizes.get(item.profileId) ?? 0) + q);
      out.set(item.productId, sizes);
    }
  }
  return out;
}

function rows(): Row[] {
  return getDb().prepare('SELECT id, status, data, card_state, card_livemode FROM orders').all() as Row[];
}

function chatCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM chat_threads').get() as { n: number }).n;
}

export function goLivePreview(): GoLivePreview {
  const all = rows();
  let pieces = 0;
  for (const sizes of heldPieces(all).values()) for (const q of sizes.values()) pieces += q;
  return {
    orders: all.length,
    pieces,
    screenshots: screenshotFiles().length,
    chats: chatCount(),
    blockers: all.map(blockerOf).filter(Boolean).slice(0, 20),
    wentLive: kvGet<GoLivePreview['wentLive']>(KV)?.data ?? null,
  };
}

/**
 * Remove the test orders (and, with `chats`, the customer chats): backup first, audited, then one
 * transaction; the screenshots' files go after it commits.
 */
export async function goLive(opts: { chats: boolean }, actor: string): Promise<GoLiveResult> {
  const before = goLivePreview();
  if (before.blockers.length) throw new HttpError(409, before.blockers[0], {}, { code: 'go_live_real_orders', blockers: before.blockers });
  // A backup first: the removed orders can be brought back with the restore.
  let backup = '';
  try {
    backup = path.basename((await createBackup()).file);
  } catch (err) {
    throw new HttpError(409, `No backup could be made, so nothing was removed: ${err instanceof Error ? err.message : String(err)}`, {}, { code: 'go_live_no_backup' });
  }
  const at = new Date().toISOString();
  const db = getDb();
  const all = rows();
  // Checked again on the rows that are removed (an order may have come in meanwhile).
  const blocker = all.map(blockerOf).find(Boolean);
  if (blocker) throw new HttpError(409, blocker, {}, { code: 'go_live_real_orders' });
  const held = heldPieces(all);
  let pieces = 0;
  for (const sizes of held.values()) for (const q of sizes.values()) pieces += q;
  const files = screenshotFiles();
  const chats = opts.chats ? chatCount() : 0;
  // Written to the audit log before anything is removed (and so before it is reported as done).
  auditOrThrow('shop.went_live', { by: actor, orders: all.length, pieces, screenshots: files.length, chats, backup });

  const moves = inTransaction(() => {
    const out: ReturnType<typeof insertMove>[] = [];
    for (const [productId, sizes] of held) {
      if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(productId)) continue;
      const changes: SizeChange[] = [];
      for (const [sizeId, qty] of sizes) {
        const from = (db.prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').get(productId, sizeId) as { qty: number } | undefined)?.qty ?? 0;
        db.prepare('INSERT INTO product_stock (product_id, size_id, qty) VALUES (?, ?, ?) ON CONFLICT(product_id, size_id) DO UPDATE SET qty = qty + excluded.qty').run(productId, sizeId, qty);
        changes.push({ sizeId, from, to: from + qty });
      }
      if (changes.length) out.push(insertMove(db, { key: `go-live-${crypto.randomUUID()}`, hash: '', productId, actor, reason: 'correction', changes, note: 'Go live: the test orders were removed' }));
    }
    // Children first (foreign keys), then the orders.
    for (const table of ['order_events', 'order_vat', 'card_refunds', 'vat_credit_notes', 'vat_invoices', 'stripe_events', 'otp_codes']) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare('DELETE FROM orders').run();
    if (opts.chats) for (const table of ['chat_messages', 'chat_mail_seen', 'chat_threads']) db.prepare(`DELETE FROM ${table}`).run();
    kvSet(KV, { at, by: actor, backup });
    return out;
  });
  for (const m of moves) auditMove(db, m, {});
  auditBacklog(db);
  invalidateProducts();
  for (const f of files) {
    try {
      fs.rmSync(path.join(receiptsDir(), f), { force: true });
    } catch {
      // A file that can't be removed stays; it is in the backup either way.
    }
  }
  logEvent('info', 'shop_went_live', { orders: all.length, pieces, screenshots: files.length, chats });
  return { orders: all.length, pieces, screenshots: files.length, chats, backup, at };
}
