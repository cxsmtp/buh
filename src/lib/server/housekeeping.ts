import { getDb } from './db';
import { logEvent } from './log';

/**
 * Small records that are only needed for a while and would otherwise grow for ever. Removed once
 * a day, at most PRUNE_BATCH of each per round (a long backlog goes over a few days, never one
 * long write):
 *  - stripe_events: each Stripe event's id, so an event sent again is applied once. Stripe sends
 *    an event again for up to 3 days, and it can be sent again by hand for 30; the shop only takes
 *    events signed in the last 5 minutes. Nothing else reads them (an order's history is in
 *    order_events and the audit log, which are never pruned). Kept 90 days.
 *  - chat_mail_seen: the Message-IDs of emails already turned into chat messages. The mailbox is
 *    only read for unread mail of the last 3 days. Kept 90 days.
 *  - kv chat:owner-emails:<hour>: how many chat emails went to the owner in that hour; only the
 *    current hour's is read. Kept 7 days.
 */
export const STRIPE_EVENTS_KEEP_DAYS = 90;
export const CHAT_MAIL_SEEN_KEEP_DAYS = 90;
export const CHAT_HOUR_KEYS_KEEP_DAYS = 7;
export const PRUNE_BATCH = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_KEY = 'chat:owner-emails:';

export interface PruneResult {
  stripeEvents: number;
  chatMailSeen: number;
  chatHourKeys: number;
}

/** One round. Each part on its own: one that fails is logged and the others still run. */
export function pruneOldRecords(now = Date.now()): PruneResult {
  const db = getDb();
  const iso = (days: number) => new Date(now - days * DAY_MS).toISOString();
  const part = (name: string, fn: () => number): number => {
    try {
      return fn();
    } catch (err) {
      logEvent('warn', 'prune_failed', { what: name, error: err instanceof Error ? err.message : String(err) });
      return 0;
    }
  };
  const result: PruneResult = {
    stripeEvents: part('stripe_events', () => db.prepare('DELETE FROM stripe_events WHERE id IN (SELECT id FROM stripe_events WHERE at < ? LIMIT ?)').run(iso(STRIPE_EVENTS_KEEP_DAYS), PRUNE_BATCH).changes),
    chatMailSeen: part('chat_mail_seen', () => db.prepare('DELETE FROM chat_mail_seen WHERE message_id IN (SELECT message_id FROM chat_mail_seen WHERE at < ? LIMIT ?)').run(iso(CHAT_MAIL_SEEN_KEEP_DAYS), PRUNE_BATCH).changes),
    // The keys end with the hour (2026-11-14T09), so they sort by time.
    chatHourKeys: part('chat_hour_keys', () =>
      db.prepare('DELETE FROM kv WHERE key IN (SELECT key FROM kv WHERE key >= ? AND key < ? LIMIT ?)').run(HOUR_KEY, `${HOUR_KEY}${iso(CHAT_HOUR_KEYS_KEEP_DAYS).slice(0, 13)}`, PRUNE_BATCH).changes
    ),
  };
  if (result.stripeEvents || result.chatMailSeen || result.chatHourKeys) logEvent('info', 'old_records_pruned', { ...result });
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** A few minutes after the start, then once a day. Off with HOUSEKEEPING_DISABLED=1. */
export function startHousekeeping(): void {
  if (timer || process.env.HOUSEKEEPING_DISABLED === '1') return;
  const tick = () => {
    try {
      pruneOldRecords();
    } catch (err) {
      logEvent('warn', 'prune_failed', { what: 'all', error: err instanceof Error ? err.message : String(err) });
    }
  };
  setTimeout(tick, 5 * 60_000).unref();
  timer = setInterval(tick, DAY_MS);
  timer.unref();
}
