import { getDb } from './db';

/**
 * What changed since the last backup. The database counts every write to the shop's data itself
 * (triggers in migration 16, table data_changes), so no write path can be missed; files kept beside
 * the database without a row of their own (product photos) are marked here with markChanged().
 *
 * Each area keeps: n (writes ever), backed (n when the last successful backup began), first_at (the
 * first write not yet in a backup) and last_at. A backup reads a mark before it starts and, only
 * once it has succeeded, records that mark as backed: a failed backup leaves everything pending,
 * and a write made while a backup runs stays pending for the next one.
 */

/** Areas, in the order the hub names them. Critical ones are backed up within the delay; the others ride along. */
export const CHANGE_AREAS: Record<string, { label: string; critical: boolean }> = {
  orders: { label: 'orders', critical: true },
  payments: { label: 'payments', critical: true },
  stock: { label: 'stock', critical: true },
  products: { label: 'products', critical: true },
  photos: { label: 'photos', critical: true },
  collections: { label: 'collections', critical: true },
  expenses: { label: 'expenses', critical: true },
  vat: { label: 'VAT documents', critical: true },
  settings: { label: 'settings', critical: true },
  accounts: { label: 'accounts', critical: true },
  chats: { label: 'chats', critical: false },
  visits: { label: 'visits', critical: false },
};

interface Row {
  area: string;
  critical: number;
  n: number;
  backed: number;
  first_at: string | null;
  last_at: string | null;
}

/** Waiting for a backup: how many writes per area, and since when. */
export interface PendingChanges {
  total: number;
  /** Writes per area not yet in a backup (only areas with some). */
  areas: Record<string, number>;
  critical: boolean;
  /** The first write not yet in a backup (any area). */
  firstChangeAt: string | null;
  /** The first critical write not yet in a backup. */
  firstCriticalAt: string | null;
  lastChangeAt: string | null;
}

/** What a backup records when it begins: each area's count. */
export interface ChangeMark {
  at: string;
  counts: Record<string, number>;
  pending: PendingChanges;
}

function rows(): Row[] {
  try {
    return getDb().prepare('SELECT area, critical, n, backed, first_at, last_at FROM data_changes').all() as Row[];
  } catch {
    // A database from before migration 16 (never here: getDb() migrates); nothing known.
    return [];
  }
}

const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

function summarise(list: Row[]): PendingChanges {
  const out: PendingChanges = { total: 0, areas: {}, critical: false, firstChangeAt: null, firstCriticalAt: null, lastChangeAt: null };
  for (const r of list) {
    const waiting = r.n - r.backed;
    if (waiting <= 0) continue;
    out.total += waiting;
    out.areas[r.area] = waiting;
    out.firstChangeAt = earliest(out.firstChangeAt, r.first_at);
    out.lastChangeAt = latest(out.lastChangeAt, r.last_at);
    if (r.critical) {
      out.critical = true;
      out.firstCriticalAt = earliest(out.firstCriticalAt, r.first_at);
    }
  }
  return out;
}

export function pendingChanges(): PendingChanges {
  return summarise(rows());
}

/** "orders, stock" (in the hub's order). */
export function describeAreas(areas: Record<string, number>): string {
  return Object.keys(CHANGE_AREAS)
    .filter((a) => (areas[a] ?? 0) > 0)
    .concat(Object.keys(areas).filter((a) => !(a in CHANGE_AREAS) && areas[a] > 0))
    .map((a) => CHANGE_AREAS[a]?.label ?? a)
    .join(', ');
}

/** Count a change the database can't see (a file written beside it). Never throws. */
export function markChanged(area: keyof typeof CHANGE_AREAS | string): void {
  try {
    const now = new Date().toISOString();
    getDb()
      .prepare('UPDATE data_changes SET n = n + 1, last_at = ?, first_at = CASE WHEN n = backed OR first_at IS NULL THEN ? ELSE first_at END WHERE area = ?')
      .run(now, now, area);
  } catch {
    // Never stops the write it follows; the next backup (weekly at the latest) still takes it.
  }
}

/** Taken just before a backup begins. */
export function changeMark(now = new Date()): ChangeMark {
  const list = rows();
  return { at: now.toISOString(), counts: Object.fromEntries(list.map((r) => [r.area, r.n])), pending: summarise(list) };
}

/**
 * The backup that began at `mark` succeeded: what it holds is no longer pending. A write made after
 * the mark stays pending, its clock starting no later than the mark (a little early, never late).
 */
export function markBackedUp(mark: ChangeMark): void {
  const db = getDb();
  const update = db.prepare(
    'UPDATE data_changes SET backed = @n, first_at = CASE WHEN n <= @n THEN NULL WHEN first_at IS NOT NULL AND first_at > @at THEN first_at ELSE @at END WHERE area = @area AND backed < @n'
  );
  db.transaction(() => {
    for (const [area, n] of Object.entries(mark.counts)) update.run({ area, n, at: mark.at });
  })();
}
