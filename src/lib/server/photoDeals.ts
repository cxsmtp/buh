import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DealView, PaymentMethod } from '@/types';
import { auditedTransaction } from './audit';
import { markChanged } from './dataChanges';
import { dataDir } from './dataDir';
import { getDb } from './db';
import { folderRoomProblem } from './diskRoom';
import { HttpError } from './http';
import { parseImageDataUrl } from './imageInput';
import { kvGet, kvSet } from './kv';
import { bump } from './live';
import { logEvent } from './log';
import { mac } from './secrets';

/**
 * Photo deals: the owner's own "order from a photo". For a piece agreed on WhatsApp, the owner
 * uploads its pictures in the hub, sets the price (delivery included) and the ways the customer
 * may pay, and sends the private link (/deal/<token>). The customer sees the pictures and the
 * fixed price, adds their address, and pays (card, cash on delivery or bank transfer, as the owner
 * allowed). The price comes from here, never from the browser, so the customer can't change it,
 * and the order needs no "Confirm amount": the owner set it.
 *
 * The token (43 characters) is never stored: it is the server's HMAC ("deal") of the deal's id and
 * a random nonce, so the hub can show the link again while a copy of the database alone cannot;
 * only its SHA-256 is kept, to find the deal. A link opens its deal until it is ordered (an order
 * that is later cancelled, like an unpaid card try, opens it again), cancelled by the owner, or it
 * expires. Light on imports: the front gate (frontGate.ts) checks tokens with it.
 */

export const DEAL_ROUTE = '/deal';
export const DEAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEAL_LIMITS = { maxPhotos: 12, maxPhotoBytes: 1_200_000, minAmount: 1, maxAmount: 20_000, maxPieces: 20, noteMax: 300, forMax: 60, minDays: 1, maxDays: 30, defaultDays: 7 };
export const DEAL_PAYMENTS: PaymentMethod[] = ['cod', 'bank_transfer', 'online_card'];
const PHOTO_TYPES: Record<string, 'png' | 'jpg' | 'webp'> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
/** Room for the pictures: the same folder (and limits) as the transfer screenshots. */
const ROOM_LIMITS = { folderBytes: 2 * 1024 ** 3, minFreeBytes: 1024 ** 3 };

export const hashDealToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const dealToken = (id: string, nonce: string) => mac('deal', `${id}\n${nonce}`);

export type DealState = 'open' | 'ordered' | 'expired' | 'cancelled';

interface DealRow {
  id: string;
  created_at: string;
  created_by: string;
  for_whom: string | null;
  note: string | null;
  pieces: number;
  amount_fils: number;
  payments: string;
  photos: number;
  nonce: string;
  expires_at: string;
  status: string;
  order_id: string | null;
  ordered_at: string | null;
  cancelled_at: string | null;
  order_status?: string | null;
}

/** The owner's view of a deal (the hub). */
export interface PhotoDeal {
  id: string;
  createdAt: string;
  createdBy: string;
  forWhom?: string;
  note?: string;
  pieces: number;
  /** The fixed price the customer pays, delivery included, in AED. */
  amount: number;
  payments: PaymentMethod[];
  photos: number;
  expiresAt: string;
  state: DealState;
  orderId?: string;
  /** The private link (path) while it still opens. */
  link?: string;
}

/** What the customer sees on the deal's page (never who made it). */
export type { DealView };

/** Inside placeOrder: the deal the order is for, its pictures read from disk. */
export interface DealForOrder {
  id: string;
  createdBy: string;
  note: string;
  pieces: number;
  amountFils: number;
  payments: PaymentMethod[];
  files: { ext: 'png' | 'jpg' | 'webp'; bytes: Buffer }[];
}

function dealsDir(): string {
  const dir = path.join(dataDir(), 'receipts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const photoPath = (id: string, n: number, ext: string) => path.join(dealsDir(), `${id}.photo${n}.${ext}`);

function newDealId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  return `DEAL-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${random}`;
}

/** The SQL that says a deal still opens: not cancelled, not expired, and not ordered (unless that order was cancelled). */
const OPEN_SQL = "d.status = 'open' AND d.expires_at > ? AND (d.order_id IS NULL OR (SELECT status FROM orders WHERE id = d.order_id) IS 'cancelled')";
const SELECT = 'SELECT d.*, (SELECT status FROM orders WHERE id = d.order_id) AS order_status FROM photo_deals d';

function stateOf(r: DealRow, now: number): DealState {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.order_id && r.order_status !== 'cancelled') return 'ordered';
  if (Date.parse(r.expires_at) <= now) return 'expired';
  return 'open';
}

function paymentsOf(s: string): PaymentMethod[] {
  return s.split(',').filter((p): p is PaymentMethod => (DEAL_PAYMENTS as string[]).includes(p));
}

function toDeal(r: DealRow, now = Date.now()): PhotoDeal {
  const state = stateOf(r, now);
  return {
    id: r.id,
    createdAt: r.created_at,
    createdBy: r.created_by,
    ...(r.for_whom ? { forWhom: r.for_whom } : {}),
    ...(r.note ? { note: r.note } : {}),
    pieces: r.pieces,
    amount: r.amount_fils / 100,
    payments: paymentsOf(r.payments),
    photos: r.photos,
    expiresAt: r.expires_at,
    state,
    ...(state === 'ordered' && r.order_id ? { orderId: r.order_id } : {}),
    ...(state === 'open' ? { link: `${DEAL_ROUTE}/${dealToken(r.id, r.nonce)}` } : {}),
  };
}

type Obj = Record<string, unknown>;

function cleanText(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, `${field}: at most ${max} characters.`);
  return s;
}

/** The fixed price: a number in AED, at most two decimals, within the limits; as fils. */
function amountFils(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, 'Price: type the amount in AED, e.g. 350.');
  const f = Math.round(v * 100);
  if (Math.abs(v * 100 - f) > 1e-6) throw new HttpError(400, 'Price: at most two decimals (fils).');
  if (f < DEAL_LIMITS.minAmount * 100 || f > DEAL_LIMITS.maxAmount * 100) throw new HttpError(400, `Price: from AED ${DEAL_LIMITS.minAmount} to AED ${DEAL_LIMITS.maxAmount.toLocaleString('en-US')}.`);
  return f;
}

const DEAL_FIELDS = ['photos', 'note', 'forWhom', 'pieces', 'amount', 'payments', 'days'];

/**
 * The owner makes a deal: checked field by field (allow-listed), the pictures written beside the
 * order photos (backed up and restored with them), the row and its audit entry in one transaction.
 * Returns the deal with its private link.
 */
export function createDeal(input: unknown, actor: string): PhotoDeal {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'The deal must be an object.');
  const o = input as Obj;
  const unknown = Object.keys(o).filter((k) => !DEAL_FIELDS.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field: ${unknown[0].slice(0, 40)}.`);
  if (!Array.isArray(o.photos) || o.photos.length < 1) throw new HttpError(400, 'Add at least one picture.', {}, { code: 'photo_missing' });
  if (o.photos.length > DEAL_LIMITS.maxPhotos) throw new HttpError(400, `At most ${DEAL_LIMITS.maxPhotos} pictures.`);
  const files = o.photos.map((p) => {
    const { mime, bytes } = parseImageDataUrl(p, DEAL_LIMITS.maxPhotoBytes);
    return { ext: PHOTO_TYPES[mime], bytes };
  });
  const pieces = o.pieces === undefined ? 1 : o.pieces;
  if (typeof pieces !== 'number' || !Number.isInteger(pieces) || pieces < 1 || pieces > DEAL_LIMITS.maxPieces) throw new HttpError(400, `Pieces: a whole number from 1 to ${DEAL_LIMITS.maxPieces}.`);
  const price = amountFils(o.amount);
  if (!Array.isArray(o.payments) || !o.payments.length || o.payments.some((p) => typeof p !== 'string' || !(DEAL_PAYMENTS as string[]).includes(p))) {
    throw new HttpError(400, 'Payments: choose at least one of cash on delivery, bank transfer and card.');
  }
  const payments = DEAL_PAYMENTS.filter((p) => (o.payments as string[]).includes(p));
  const days = o.days === undefined ? DEAL_LIMITS.defaultDays : o.days;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < DEAL_LIMITS.minDays || days > DEAL_LIMITS.maxDays) throw new HttpError(400, `Link valid for: ${DEAL_LIMITS.minDays} to ${DEAL_LIMITS.maxDays} days.`);
  const note = cleanText(o.note, 'What it is', DEAL_LIMITS.noteMax);
  const forWhom = cleanText(o.forWhom, 'For', DEAL_LIMITS.forMax);

  const room = folderRoomProblem(dealsDir(), files.reduce((n, f) => n + f.bytes.length, 0), ROOM_LIMITS, 'receipts');
  if (room) throw new HttpError(507, `There is no room for the pictures right now (${room}). Free some space, then try again.`, {}, { code: 'no_room' });

  let id = newDealId();
  while (getDb().prepare('SELECT 1 FROM photo_deals WHERE id = ?').get(id)) id = newDealId();
  // The pictures first (a failed save removes them), then the deal.
  const written: string[] = [];
  try {
    files.forEach((f, i) => {
      const file = photoPath(id, i + 1, f.ext);
      fs.writeFileSync(file, f.bytes, { mode: 0o600 });
      written.push(file);
    });
    const now = new Date();
    const nonce = crypto.randomBytes(16).toString('hex');
    const expires = new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString();
    auditedTransaction((auditOrThrow) => {
      getDb()
        .prepare(
          `INSERT INTO photo_deals (id, created_at, created_by, for_whom, note, pieces, amount_fils, payments, photos, nonce, token_hash, expires_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
        )
        .run(id, now.toISOString(), actor, forWhom || null, note || null, pieces, price, payments.join(','), files.length, nonce, hashDealToken(dealToken(id, nonce)), expires);
      auditOrThrow('deal.created', { by: actor, dealId: id, amountFils: price, pieces, payments, photos: files.length, expiresAt: expires });
    });
  } catch (err) {
    for (const f of written) fs.rmSync(f, { force: true });
    throw err;
  }
  markChanged('orders');
  bump('orders');
  logEvent('info', 'deal_created', { dealId: id, photos: files.length });
  return getDeal(id)!;
}

export function getDeal(id: string, now = Date.now()): PhotoDeal | null {
  const r = getDb().prepare(`${SELECT} WHERE d.id = ?`).get(id) as DealRow | undefined;
  return r ? toDeal(r, now) : null;
}

/** The latest deals for the hub (newest first). */
export function listDeals(limit = 50, now = Date.now()): PhotoDeal[] {
  return (getDb().prepare(`${SELECT} ORDER BY d.created_at DESC LIMIT ?`).all(Math.max(1, Math.min(200, limit))) as DealRow[]).map((r) => toDeal(r, now));
}

/** The owner stops a link (a deal already ordered stays: its order is the record). Idempotent, audited. */
export function cancelDeal(id: string, actor: string): PhotoDeal {
  const result = auditedTransaction((auditOrThrow) => {
    const deal = getDeal(id);
    if (!deal) throw new HttpError(404, 'Deal not found.');
    if (deal.state === 'cancelled') return { deal, changed: false };
    if (deal.state === 'ordered') throw new HttpError(409, `${id} is already ordered (${deal.orderId}): manage it in Orders.`, {}, { code: 'deal_ordered' });
    getDb().prepare("UPDATE photo_deals SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?").run(new Date().toISOString(), actor, id);
    auditOrThrow('deal.cancelled', { by: actor, dealId: id });
    return { deal: getDeal(id)!, changed: true };
  });
  if (result.changed) bump('orders');
  return result.deal;
}

/** The deal a token opens, or null (unknown, expired, ordered or cancelled). */
export function openDealId(token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string' || !DEAL_TOKEN_PATTERN.test(token)) return null;
  const row = getDb().prepare(`SELECT d.id FROM photo_deals d WHERE d.token_hash = ? AND ${OPEN_SQL}`).get(hashDealToken(token), new Date(now).toISOString()) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The customer's page: the pictures (through the token), the fixed price, the ways to pay. */
export function dealView(token: string, now = Date.now()): DealView | null {
  const id = openDealId(token, now);
  const r = id ? (getDb().prepare(`${SELECT} WHERE d.id = ?`).get(id) as DealRow | undefined) : undefined;
  if (!r) return null;
  return {
    token,
    ...(r.note ? { note: r.note } : {}),
    pieces: r.pieces,
    amountFils: r.amount_fils,
    payments: paymentsOf(r.payments),
    photos: Array.from({ length: r.photos }, (_, i) => `/api${DEAL_ROUTE}/${token}/photos/${i + 1}`),
    expiresAt: r.expires_at,
  };
}

/** A deal's picture n (1 first). */
export function readDealPhoto(id: string, n: number): { bytes: Buffer; mime: string } | null {
  if (!/^DEAL-[A-Z0-9-]{4,40}$/.test(id) || !Number.isInteger(n) || n < 1 || n > DEAL_LIMITS.maxPhotos) return null;
  for (const [mime, ext] of Object.entries(PHOTO_TYPES)) {
    try {
      return { bytes: fs.readFileSync(photoPath(id, n, ext)), mime };
    } catch {
      // try the next type
    }
  }
  return null;
}

/** The order's side of a deal: { token } only, checked here (open, its pictures on disk). */
export function dealForOrder(input: unknown, now = Date.now()): DealForOrder {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'The deal must be an object.');
  const o = input as Obj;
  if (Object.keys(o).some((k) => k !== 'token')) throw new HttpError(400, 'Unknown field in the deal.');
  const id = openDealId(o.token, now);
  if (!id) throw new HttpError(410, 'This link has expired or was already used. Please message us on WhatsApp for a new one.', {}, { code: 'deal_closed' });
  const r = getDb().prepare(`${SELECT} WHERE d.id = ?`).get(id) as DealRow;
  const files: DealForOrder['files'] = [];
  for (let n = 1; n <= r.photos; n++) {
    const photo = readDealPhoto(id, n);
    if (photo) files.push({ ext: PHOTO_TYPES[photo.mime], bytes: photo.bytes });
  }
  return { id, createdBy: r.created_by, note: r.note ?? '', pieces: r.pieces, amountFils: r.amount_fils, payments: paymentsOf(r.payments), files };
}

/** Inside the order's transaction: the deal is taken by this order (refused if another order has it). */
export function claimDeal(dealId: string, orderId: string, now = Date.now()): void {
  const at = new Date(now).toISOString();
  const res = getDb().prepare(`UPDATE photo_deals AS d SET order_id = ?, ordered_at = ? WHERE d.id = ? AND ${OPEN_SQL}`).run(orderId, at, dealId, at);
  if (res.changes !== 1) throw new HttpError(409, 'This link was just used for another order. Please message us on WhatsApp.', {}, { code: 'deal_closed' });
}

/** After a restore onto a server with another key: the stored hashes are made again (once per key). */
export function refreshDealHashes(): number {
  const fingerprint = mac('deal-key', 'fingerprint');
  if (kvGet<string>('deal:key')?.data === fingerprint) return 0;
  const rows = getDb().prepare('SELECT id, nonce FROM photo_deals').all() as Array<{ id: string; nonce: string }>;
  const update = getDb().prepare('UPDATE photo_deals SET token_hash = ? WHERE id = ?');
  getDb().transaction(() => {
    for (const r of rows) update.run(hashDealToken(dealToken(r.id, r.nonce)), r.id);
  })();
  kvSet('deal:key', fingerprint);
  return rows.length;
}
