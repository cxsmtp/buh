import Database from 'better-sqlite3';
import { dataFile } from './dataDir';

/**
 * The shop's database: one SQLite file in DATA_DIR (shop.db), opened once per
 * process. WAL mode, foreign keys on, a busy timeout, and full sync on commit
 * so an order the customer was told about survives a power cut.
 *
 * Schema changes are numbered migrations below; each runs once, in a
 * transaction, and the applied number is kept in PRAGMA user_version.
 */

type DB = Database.Database;

const MIGRATIONS: Array<(db: DB) => void> = [
  // 1: catalogue, orders, settings
  (db) => {
    db.exec(`
      CREATE TABLE products (
        id          TEXT PRIMARY KEY,
        data        TEXT NOT NULL,          -- the Product, as JSON
        stock       INTEGER NOT NULL CHECK (stock >= 0),
        active      INTEGER NOT NULL DEFAULT 1,
        position    INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE orders (
        id               TEXT PRIMARY KEY,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        phone            TEXT NOT NULL,      -- E.164, verified by SMS code
        status           TEXT NOT NULL,
        payment_method   TEXT NOT NULL,
        payment_status   TEXT NOT NULL,
        total_fils       INTEGER NOT NULL,   -- AED x 100, computed on the server
        idempotency_key  TEXT UNIQUE,        -- one checkout attempt = one order
        data             TEXT NOT NULL       -- the full Order, as JSON
      );
      CREATE INDEX orders_by_phone ON orders(phone);
      CREATE INDEX orders_by_created ON orders(created_at);

      CREATE TABLE order_events (
        id        INTEGER PRIMARY KEY,
        order_id  TEXT NOT NULL REFERENCES orders(id),
        at        TEXT NOT NULL,
        actor     TEXT NOT NULL,
        event     TEXT NOT NULL,
        detail    TEXT
      );
      CREATE INDEX order_events_by_order ON order_events(order_id);

      CREATE TABLE settings (
        key         TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
  },
];

let db: DB | null = null;
let openedFile = '';

export function getDb(): DB {
  const file = dataFile('shop.db');
  if (db && openedFile === file) return db;
  if (db) db.close();

  db = new Database(file);
  openedFile = file;
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db!);
      db!.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

/** Run fn in one transaction (IMMEDIATE, so concurrent writers queue instead of failing mid-way). */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

/** Consistent online backup to a file, safe while the shop is serving. */
export async function backupTo(file: string): Promise<void> {
  await getDb().backup(file);
}

/** Test hook: close so a new DATA_DIR is used next time. */
export function _closeDb() {
  db?.close();
  db = null;
  openedFile = '';
}
