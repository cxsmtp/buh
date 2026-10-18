import crypto from 'node:crypto';
import { getDb } from './db';
import { kvGet, kvSet } from './kv';
import { mac } from './secrets';

/**
 * The private page of a bank-transfer order, /pay/<token>: the shop's bank details, the amount,
 * the reference to use, and an upload for the transfer screenshot. The bank account is never on
 * the public website; it is only here, behind a link sent to the customer.
 *
 * The token (43 characters, 256 bits) is never stored: it is the server's HMAC ("pay" purpose) of
 * the order number and a random nonce kept with the order, so the shop can show it again (the
 * hub, Track Order, the email) while a copy of the database alone (a backup) cannot. Only its
 * SHA-256 is kept, to find the order. It opens the page until the order is paid or cancelled, or
 * for 14 days. Logs mask it like the admin link (src/lib/server/log.ts: maskSecretPaths).
 *
 * Light on imports: the front gate (src/lib/server/frontGate.ts) checks tokens with it.
 */

export const PAY_TTL_MS = 14 * 24 * 3600 * 1000;
export const PAY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PAY_ROUTE = '/pay';

export const hashPayToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function payToken(orderId: string, nonce: string): string {
  return mac('pay', `${orderId}\n${nonce}`);
}

/** A new private link for an order (inside the transaction that makes the order). */
export function issuePayLink(orderId: string, createdAt: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const token = payToken(orderId, nonce);
  const expires = new Date(Date.parse(createdAt) + PAY_TTL_MS).toISOString();
  getDb().prepare('UPDATE orders SET pay_nonce = ?, pay_token_hash = ?, pay_expires_at = ? WHERE id = ?').run(nonce, hashPayToken(token), expires, orderId);
  return token;
}

/** The SQL that says a private link still opens its order. */
const OPEN = "pay_expires_at > ? AND status <> 'cancelled' AND payment_status NOT IN ('verified', 'paid') AND bank_state <> 'paid'";

/** The order a token opens, or null (unknown, expired, paid or cancelled). */
export function openPayOrderId(token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string' || !PAY_TOKEN_PATTERN.test(token)) return null;
  const row = getDb().prepare(`SELECT id FROM orders WHERE pay_token_hash = ? AND ${OPEN}`).get(hashPayToken(token), new Date(now).toISOString()) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The order's private page (/pay/<token>) while it is open, from its row. */
export function payPathOf(row: { id: string; pay_nonce: string | null; pay_expires_at: string | null; status: string; payment_status: string; bank_state: string }, now = Date.now()): string | undefined {
  if (!row.pay_nonce || !row.pay_expires_at || Date.parse(row.pay_expires_at) <= now) return undefined;
  if (row.status === 'cancelled' || row.payment_status === 'verified' || row.payment_status === 'paid' || row.bank_state === 'paid') return undefined;
  return `${PAY_ROUTE}/${payToken(row.id, row.pay_nonce)}`;
}

/**
 * After a restore onto a server with another key, the stored hashes no longer match the tokens
 * the shop makes: hash them again (once per key), so the links the hub and Track Order show work.
 * (Links sent before the move stop working; the hub has the new one.)
 */
export function refreshPayHashes(): number {
  const fingerprint = mac('pay-key', 'fingerprint');
  if (kvGet<string>('pay:key')?.data === fingerprint) return 0;
  const rows = getDb().prepare('SELECT id, pay_nonce FROM orders WHERE pay_nonce IS NOT NULL').all() as Array<{ id: string; pay_nonce: string }>;
  const update = getDb().prepare('UPDATE orders SET pay_token_hash = ? WHERE id = ?');
  getDb().transaction(() => {
    for (const r of rows) update.run(hashPayToken(payToken(r.id, r.pay_nonce)), r.id);
  })();
  kvSet('pay:key', fingerprint);
  return rows.length;
}
