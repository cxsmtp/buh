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
  // 2: stock per size. Most designs are one or two pieces, so "King: 1, Queen: 1"
  //    is tracked, not one number for the product. products.stock stays as the
  //    total (kept in step by triggers) so older code reading it still works.
  (db) => {
    db.exec(`
      CREATE TABLE product_stock (
        product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        size_id     TEXT NOT NULL,
        qty         INTEGER NOT NULL CHECK (qty >= 0),
        PRIMARY KEY (product_id, size_id)
      );
      -- Removing a product archives it: past orders still point at it.
      ALTER TABLE products ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      CREATE TRIGGER product_stock_ins AFTER INSERT ON product_stock BEGIN
        UPDATE products SET stock = (SELECT COALESCE(SUM(qty), 0) FROM product_stock WHERE product_id = NEW.product_id) WHERE id = NEW.product_id;
      END;
      CREATE TRIGGER product_stock_upd AFTER UPDATE ON product_stock BEGIN
        UPDATE products SET stock = (SELECT COALESCE(SUM(qty), 0) FROM product_stock WHERE product_id = NEW.product_id) WHERE id = NEW.product_id;
      END;
      CREATE TRIGGER product_stock_del AFTER DELETE ON product_stock BEGIN
        UPDATE products SET stock = (SELECT COALESCE(SUM(qty), 0) FROM product_stock WHERE product_id = OLD.product_id) WHERE id = OLD.product_id;
      END;
    `);
    // Existing stock goes to each product's default size.
    const rows = db.prepare('SELECT id, data, stock FROM products').all() as Array<{ id: string; data: string; stock: number }>;
    const insert = db.prepare('INSERT INTO product_stock (product_id, size_id, qty) VALUES (?, ?, ?)');
    for (const r of rows) {
      let size = 'king';
      try {
        const p = JSON.parse(r.data) as { defaultProfileId?: string; profiles?: Array<{ id: string }> };
        size = p.defaultProfileId || p.profiles?.[0]?.id || size;
      } catch {
        // unreadable product JSON: keep the default
      }
      insert.run(r.id, size, r.stock);
    }
  },
  // 3: small shared state every running copy of the shop sees (during an
  //    update two copies run for a moment): change counters for live updates,
  //    cached exchange rates, festival dates and the like.
  (db) => {
    db.exec(`
      CREATE TABLE kv (
        key         TEXT PRIMARY KEY,
        data        TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      -- Festival dates fetched from the internet (they replace the offline ones), and the last refresh.
      CREATE TABLE IF NOT EXISTS festival_dates (
        festival_id TEXT,
        year        INTEGER,
        start       TEXT,
        end         TEXT,
        source      TEXT,
        PRIMARY KEY (festival_id, year)
      );
      CREATE TABLE IF NOT EXISTS festival_meta (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
      -- Earlier versions of each settings group, to restore a known-good one (keys blanked).
      CREATE TABLE settings_history (
        id        INTEGER PRIMARY KEY,
        key       TEXT NOT NULL,
        data      TEXT NOT NULL,
        saved_at  TEXT NOT NULL
      );
      CREATE INDEX settings_history_by_key ON settings_history(key, id);
      -- Older versions (before 2.0.0) reserve stock on products.stock and know nothing of sizes.
      -- If one ever runs on this database (a rollback, the move from the old setup), its sale
      -- fails instead of selling a piece the per-size stock no longer has.
      CREATE TRIGGER products_stock_guard BEFORE UPDATE OF stock ON products
      WHEN NEW.stock <> (SELECT COALESCE(SUM(qty), 0) FROM product_stock WHERE product_id = NEW.id)
      BEGIN
        SELECT RAISE(ABORT, 'stock is kept per size');
      END;
      -- Checkout SMS codes (hashed), shared by both copies of the shop during an update.
      CREATE TABLE otp_codes (
        phone       TEXT PRIMARY KEY,
        hash        TEXT NOT NULL,
        expires_at  INTEGER NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
  // 4: the shop's chat. A customer holds a secret for their own conversation (only its
  //    hash is kept); reply_key goes in the email subject, so an emailed reply finds it.
  (db) => {
    db.exec(`
      CREATE TABLE chat_threads (
        id                TEXT PRIMARY KEY,
        token_hash        TEXT NOT NULL,
        reply_key         TEXT NOT NULL UNIQUE,
        status            TEXT NOT NULL DEFAULT 'bot',
        customer_name     TEXT NOT NULL DEFAULT '',
        contact           TEXT NOT NULL DEFAULT '',
        page              TEXT NOT NULL DEFAULT '',
        ip                TEXT NOT NULL DEFAULT '',
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        handed_over_at    TEXT,
        reassured_at      TEXT,
        emailed_at        TEXT,
        customer_seen_at  TEXT,
        admin_seen_id     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX chat_threads_by_update ON chat_threads(updated_at);
      CREATE TABLE chat_messages (
        id         INTEGER PRIMARY KEY,
        thread_id  TEXT NOT NULL REFERENCES chat_threads(id),
        at         TEXT NOT NULL,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL,
        via        TEXT NOT NULL DEFAULT 'web'
      );
      CREATE INDEX chat_messages_by_thread ON chat_messages(thread_id, id);
      -- Emails already turned into chat messages (claimed atomically: two copies of the shop
      -- may read the mailbox at the same moment during an update).
      CREATE TABLE chat_mail_seen (
        message_id  TEXT PRIMARY KEY,
        at          TEXT NOT NULL
      );
      CREATE INDEX chat_threads_by_status ON chat_threads(status, updated_at);
    `);
  },
  // 5: ways back into the Admin Hub. Recovery codes are kept only as hashes; a
  //    code is used up by one UPDATE … WHERE used_at IS NULL, so it works once
  //    even when two copies of the shop share the database. Passkeys keep only
  //    the public key. Sign-in challenges are short-lived and single use.
  (db) => {
    db.exec(`
      CREATE TABLE admin_recovery_codes (
        code_hash   TEXT PRIMARY KEY,
        set_id      TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        used_at     TEXT
      );
      CREATE TABLE admin_passkeys (
        id            TEXT PRIMARY KEY,      -- credential ID, base64url
        public_key    BLOB NOT NULL,         -- COSE public key
        counter       INTEGER NOT NULL DEFAULT 0,
        transports    TEXT NOT NULL DEFAULT '[]',
        name          TEXT NOT NULL,
        rp_id         TEXT NOT NULL,         -- the shop's domain it was made for
        device_type   TEXT NOT NULL DEFAULT '',
        backed_up     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT
      );
      CREATE TABLE webauthn_challenges (
        id          TEXT PRIMARY KEY,
        purpose     TEXT NOT NULL,           -- 'register' or 'sign-in'
        challenge   TEXT NOT NULL,
        bound_to    TEXT NOT NULL DEFAULT '',
        expires_at  INTEGER NOT NULL
      );
      CREATE INDEX webauthn_challenges_by_expiry ON webauthn_challenges(expires_at);
    `);
  },
  // 6: stock moves from the Admin Hub (the + / − buttons, "Received stock", a typed number, Undo).
  //    One row per move, written in the same transaction as the stock it changes: who, why
  //    (a reason code), and every size's old → new. The idempotency key makes a retried request
  //    return the first answer instead of moving stock twice; a move can be undone once.
  //    Product drafts: the step-by-step editor saves itself here as the owner goes.
  (db) => {
    db.exec(`
      CREATE TABLE stock_moves (
        id               INTEGER PRIMARY KEY,
        idempotency_key  TEXT NOT NULL UNIQUE,
        request_hash     TEXT NOT NULL,
        product_id       TEXT NOT NULL,
        at               TEXT NOT NULL,
        actor            TEXT NOT NULL,
        reason           TEXT NOT NULL,
        changes          TEXT NOT NULL,      -- JSON: [{ sizeId, from, to }]
        note             TEXT NOT NULL DEFAULT '',
        undo_of          INTEGER
      );
      CREATE INDEX stock_moves_by_product ON stock_moves(product_id, id);
      CREATE UNIQUE INDEX stock_moves_undo_once ON stock_moves(undo_of) WHERE undo_of IS NOT NULL;
      CREATE TABLE product_drafts (
        id          TEXT PRIMARY KEY,        -- 'new' or the product being edited
        data        TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  TEXT NOT NULL DEFAULT ''
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
