import { getDb } from './db';

/**
 * Small shared state in the database (table kv): change counters, cached
 * exchange rates, festival dates. Stored here rather than in memory so that
 * every running copy of the shop (two, briefly, during an update) agrees.
 */

export function kvGet<T>(key: string): { data: T; updatedAt: string } | undefined {
  const row = getDb().prepare('SELECT data, updated_at FROM kv WHERE key = ?').get(key) as { data: string; updated_at: string } | undefined;
  if (!row) return undefined;
  try {
    return { data: JSON.parse(row.data) as T, updatedAt: row.updated_at };
  } catch {
    return undefined;
  }
}

export function kvSet(key: string, data: unknown): void {
  getDb()
    .prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(data), new Date().toISOString());
}

/** Add one to a counter and return the new value (atomic). */
export function kvBump(key: string): number {
  const db = getDb();
  db.prepare(
    "INSERT INTO kv (key, data, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET data = CAST(CAST(data AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at"
  ).run(key, new Date().toISOString());
  return Number((db.prepare('SELECT data FROM kv WHERE key = ?').get(key) as { data: string }).data);
}
