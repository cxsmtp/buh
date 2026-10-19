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
  // 7: when each stock move reached the audit log. A move is only reported done once it has;
  //    if the log could not be written, the retry (same key) writes it. Moves recorded before
  //    this column existed were audited when they were made.
  (db) => {
    db.exec(`
      ALTER TABLE stock_moves ADD COLUMN audited_at TEXT;
      UPDATE stock_moves SET audited_at = at;
      CREATE INDEX stock_moves_unaudited ON stock_moves(id) WHERE audited_at IS NULL;
    `);
  },
  // 8: "Confirm on WhatsApp". The customer sends the shop one WhatsApp message (order number +
  //    wa_code); the owner marks it confirmed, or that the number didn't match. Own columns, so
  //    an older version rewriting the order's JSON (during an update or after a rollback)
  //    leaves them alone. Orders from before have phone_check 'none' (never asked).
  (db) => {
    db.exec(`
      ALTER TABLE orders ADD COLUMN wa_code TEXT;
      ALTER TABLE orders ADD COLUMN phone_check TEXT NOT NULL DEFAULT 'none';   -- none | awaiting | confirmed | mismatch
      ALTER TABLE orders ADD COLUMN wa_hold INTEGER NOT NULL DEFAULT 0;         -- 1: not confirmed or booked until confirmed
      ALTER TABLE orders ADD COLUMN wa_opened_at TEXT;
      ALTER TABLE orders ADD COLUMN phone_checked_at TEXT;
      ALTER TABLE orders ADD COLUMN phone_checked_by TEXT;
      CREATE INDEX orders_awaiting_whatsapp ON orders(created_at) WHERE phone_check = 'awaiting';
    `);
  },
  // 9: card payments through the owner's Stripe account. Own columns, like migration 8, so an
  //    older version rewriting the order's JSON leaves them alone; the order itself uses values
  //    every version knows (payment method 'online_card', status 'pending_payment', JSON payment
  //    status 'pending' → 'paid'). payment_ref is the PaymentIntent id Stripe gave (never made
  //    up here); card_secret_hash lets the paying browser (which holds the client secret) ask
  //    about its own order. stripe_events: each webhook event is applied once (Stripe resends).
  (db) => {
    db.exec(`
      ALTER TABLE orders ADD COLUMN card_state TEXT NOT NULL DEFAULT 'none';   -- none | pending | failed | paid | refund_pending | refunded | canceled
      ALTER TABLE orders ADD COLUMN payment_ref TEXT;
      ALTER TABLE orders ADD COLUMN card_secret_hash TEXT;
      ALTER TABLE orders ADD COLUMN paid_fils INTEGER;
      ALTER TABLE orders ADD COLUMN paid_at TEXT;
      ALTER TABLE orders ADD COLUMN card_label TEXT;
      ALTER TABLE orders ADD COLUMN refund_ref TEXT;
      ALTER TABLE orders ADD COLUMN refunded_at TEXT;
      ALTER TABLE orders ADD COLUMN card_livemode INTEGER;     -- 1 live, 0 test: the Stripe mode the PaymentIntent was made in
      ALTER TABLE orders ADD COLUMN card_ip TEXT;              -- hash of the placing connection's address (a cap on unpaid card orders)
      ALTER TABLE orders ADD COLUMN refunded_fils INTEGER;     -- refunded so far (a partial refund made in the Stripe dashboard)
      ALTER TABLE orders ADD COLUMN refund_outside_at TEXT;    -- cancelled without a Stripe refund through the shop (refunded in Stripe's dashboard)
      ALTER TABLE orders ADD COLUMN needs_attention TEXT;      -- JSON {kind, text, at}: something the owner must look at
      CREATE UNIQUE INDEX orders_by_payment_ref ON orders(payment_ref) WHERE payment_ref IS NOT NULL;
      CREATE INDEX orders_card_open ON orders(created_at) WHERE card_state IN ('pending', 'failed');
      CREATE TABLE stripe_events (
        id        TEXT PRIMARY KEY,          -- Stripe's event id (evt_…)
        type      TEXT NOT NULL,
        order_id  TEXT,
        at        TEXT NOT NULL,
        outcome   TEXT NOT NULL
      );
    `);
  },
  // 10: bank transfer without the bank account on the website. Each bank-transfer order has a
  //     private page (/pay/<token>) with the details and an upload for the transfer screenshot.
  //     The token is never stored: it is made from the server's key and pay_nonce, and only its
  //     hash is kept (to find the order). Own columns, like migrations 8 and 9, so an older version
  //     rewriting the order's JSON leaves them alone. Orders from before carry on as they were:
  //     a transfer already uploaded at checkout is "to check", the others wait for the transfer.
  (db) => {
    db.exec(`
      ALTER TABLE orders ADD COLUMN pay_nonce TEXT;
      ALTER TABLE orders ADD COLUMN pay_token_hash TEXT;
      ALTER TABLE orders ADD COLUMN pay_expires_at TEXT;
      ALTER TABLE orders ADD COLUMN bank_state TEXT NOT NULL DEFAULT 'none';   -- none | awaiting | uploaded | not_received | paid
      ALTER TABLE orders ADD COLUMN transfer_uploads INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orders ADD COLUMN transfer_uploaded_at TEXT;
      ALTER TABLE orders ADD COLUMN bank_emailed_at TEXT;
      ALTER TABLE orders ADD COLUMN bank_checked_at TEXT;
      ALTER TABLE orders ADD COLUMN bank_checked_by TEXT;
      CREATE UNIQUE INDEX orders_by_pay_token ON orders(pay_token_hash) WHERE pay_token_hash IS NOT NULL;
      CREATE INDEX orders_transfer_to_check ON orders(created_at) WHERE bank_state = 'uploaded';
      UPDATE orders SET bank_state = CASE
          WHEN payment_status IN ('verified', 'paid') THEN 'paid'
          WHEN payment_status = 'receipt_uploaded' THEN 'uploaded'
          ELSE 'awaiting' END,
        transfer_uploads = CASE WHEN json_extract(data, '$.paymentReceiptUrl') IS NOT NULL THEN 1 ELSE 0 END
        WHERE payment_method = 'bank_transfer';
    `);
  },
  // 11 (phone check by WhatsApp): checkout sends no SMS code; the customer's one WhatsApp message
  //     (or the owner's phone call) confirms the order. phone_check_method says which ('whatsapp' |
  //     'call'); wa_cancel_at is when an order still unconfirmed is cancelled (set at checkout from
  //     Settings → Phone check, so changing the setting later never cancels an order early). The
  //     connection's hashed address goes in card_ip (migration 9) for every order now, for the
  //     per-connection cap. wa_unopened_cancel_at is sooner: when it is cancelled if the customer
  //     never even opened WhatsApp (wa_opened_at still empty). A bank transfer is never cancelled
  //     for this: at wa_cancel_at it is flagged for the owner. Own columns, like migrations 8–10, so
  //     an older version rewriting the order's JSON leaves them alone; an older version simply never
  //     cancels such an order.
  (db) => {
    db.exec(`
      ALTER TABLE orders ADD COLUMN phone_check_method TEXT;     -- whatsapp | call (once confirmed)
      ALTER TABLE orders ADD COLUMN wa_cancel_at TEXT;           -- ISO time: cancelled if still not confirmed
      ALTER TABLE orders ADD COLUMN wa_unopened_cancel_at TEXT;  -- ISO time: cancelled sooner if WhatsApp was never opened
      CREATE INDEX orders_unconfirmed_due ON orders(wa_cancel_at) WHERE wa_cancel_at IS NOT NULL AND phone_check IN ('awaiting', 'mismatch');
      CREATE INDEX orders_unopened_due ON orders(wa_unopened_cancel_at) WHERE wa_unopened_cancel_at IS NOT NULL AND phone_check IN ('awaiting', 'mismatch');
    `);
  },
  // 12: expenses, with photos or PDFs of the bills (in DATA_DIR/expenses/), for the accountant's
  //     reports. Nothing is ever overwritten or deleted: every state of an expense is a row in
  //     expense_versions (made, each edit, removed), a removed expense keeps its row with who, when
  //     and why, and a bill taken off an expense keeps its file. Amounts are whole fils. The
  //     categories are the owner's list (these to start with; more can be added). card_refunds: the
  //     refunds ledger, one row per refund to a card (and a negative row when one failed afterwards),
  //     so a report books each refund on the day it was made. Orders refunded before it are filled
  //     in by backfillRefundLedger() (src/lib/server/orders.ts), their dates marked approximate.
  (db) => {
    db.exec(`
      CREATE TABLE expense_categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        position    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        created_by  TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE expenses (
        id               TEXT PRIMARY KEY,           -- EXP-YYMMDD-XXXXXX
        spent_on         TEXT NOT NULL,              -- YYYY-MM-DD, the UAE date on the bill
        amount_fils      INTEGER NOT NULL CHECK (amount_fils > 0),
        category_id      TEXT NOT NULL REFERENCES expense_categories(id),
        payee            TEXT NOT NULL DEFAULT '',
        method           TEXT NOT NULL,              -- cash | card | bank_transfer | other
        note             TEXT NOT NULL DEFAULT '',
        version          INTEGER NOT NULL DEFAULT 1,
        idempotency_key  TEXT UNIQUE,                -- one "Save" = one expense, even if sent twice
        created_at       TEXT NOT NULL,
        created_by       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        updated_by       TEXT NOT NULL,
        removed_at       TEXT,
        removed_by       TEXT,
        removed_why      TEXT
      );
      CREATE INDEX expenses_by_date ON expenses(spent_on);
      CREATE TABLE expense_versions (
        id          INTEGER PRIMARY KEY,
        expense_id  TEXT NOT NULL REFERENCES expenses(id),
        version     INTEGER NOT NULL,
        change      TEXT NOT NULL,                   -- created | edited | removed
        data        TEXT NOT NULL,                   -- the expense as it was after this change (JSON)
        at          TEXT NOT NULL,
        by          TEXT NOT NULL,
        UNIQUE (expense_id, version)
      );
      CREATE TABLE expense_bills (
        id             TEXT PRIMARY KEY,             -- also the file's name in expenses/ (with its extension)
        expense_id     TEXT NOT NULL REFERENCES expenses(id),
        ext            TEXT NOT NULL,                -- jpg | png | webp | heic | pdf
        mime           TEXT NOT NULL,
        size           INTEGER NOT NULL,
        sha256         TEXT NOT NULL,
        original_name  TEXT NOT NULL DEFAULT '',
        added_at       TEXT NOT NULL,
        added_by       TEXT NOT NULL,
        removed_at     TEXT,
        removed_by     TEXT,
        removed_why    TEXT
      );
      CREATE INDEX expense_bills_by_expense ON expense_bills(expense_id);
      CREATE TABLE card_refunds (
        id                INTEGER PRIMARY KEY,
        order_id          TEXT NOT NULL REFERENCES orders(id),
        amount_fils       INTEGER NOT NULL CHECK (amount_fils <> 0),   -- negative: a refund that failed afterwards
        at                TEXT NOT NULL,                               -- when the money went back (ISO, UTC)
        source            TEXT NOT NULL CHECK (source IN ('stripe', 'hub')),
        stripe_refund_id  TEXT,                                        -- Stripe's re_… (never made up here)
        date_approx       INTEGER NOT NULL DEFAULT 0                   -- 1: filled in from an order made before this table
      );
      CREATE UNIQUE INDEX card_refunds_by_stripe_id ON card_refunds(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL AND amount_fils > 0;
      CREATE UNIQUE INDEX card_refunds_reversal_by_stripe_id ON card_refunds(stripe_refund_id) WHERE stripe_refund_id IS NOT NULL AND amount_fils < 0;
      CREATE INDEX card_refunds_by_order ON card_refunds(order_id);
      CREATE INDEX card_refunds_by_at ON card_refunds(at);
    `);
    const add = db.prepare("INSERT INTO expense_categories (id, name, position, created_at, created_by) VALUES (?, ?, ?, ?, 'shop')");
    const now = new Date().toISOString();
    [
      ['stock', 'Stock & fabric'],
      ['packaging', 'Packaging'],
      ['courier', 'Courier & delivery'],
      ['marketing', 'Marketing & ads'],
      ['rent', 'Rent'],
      ['utilities', 'Utilities'],
      ['software', 'Software & fees'],
      ['bank_fees', 'Bank & card charges'],
      ['other', 'Other'],
    ].forEach(([id, name], i) => add.run(id, name, i, now));
  },
  // 13: looks (Settings → Look). The shop's look until now (Ivory & Gold, always light) is kept as
  //     the first entry of the look history, timestamped now and pinned (never pruned), so the
  //     owner can always switch back to it. The look from now on: Ivory & Gold, matching the device.
  //     Rows only (no schema change): an older version ignores the 'look' settings.
  (db) => {
    const at = new Date().toISOString();
    const before = { preset: 'ivory-gold', mode: 'light', label: 'Ivory & Gold — the look before themes', changedAt: at, changedBy: '', pinned: true };
    const now = { preset: 'ivory-gold', mode: 'system', label: 'Ivory & Gold · Match the device', changedAt: at, changedBy: '' };
    if (!db.prepare("SELECT 1 FROM settings WHERE key = 'look'").get()) {
      db.prepare("INSERT INTO settings_history (key, data, saved_at) VALUES ('look', ?, ?)").run(JSON.stringify(before), at);
      db.prepare("INSERT INTO settings (key, data, updated_at) VALUES ('look', ?, ?)").run(JSON.stringify(now), at);
    }
  },
  // 14: the accountant's read-only sign-in, and UAE VAT (opt-in, off by default). Add-only: an older
  //     version ignores these tables and columns (src/lib/server/staffAuth.ts, src/lib/server/vat.ts).
  //     staff_accounts: people the owner invited (role 'accountant' only); the setup link is kept as
  //     hashes, single use, 72 h. order_vat: an order's VAT breakdown in fils, written once when it is
  //     placed while VAT is on (from the effective date); never for an older order, never rewritten.
  //     vat_invoices / vat_credit_notes: the gap-free numbered series (seq 1, 2, 3…, taken inside an
  //     IMMEDIATE transaction). Expenses gain the VAT on the bill and the supplier's TRN (input VAT).
  (db) => {
    db.exec(`
      CREATE TABLE staff_accounts (
        id                TEXT PRIMARY KEY,
        email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role              TEXT NOT NULL CHECK (role IN ('accountant')),
        name              TEXT NOT NULL DEFAULT '',
        password_hash     TEXT,
        status            TEXT NOT NULL CHECK (status IN ('invited', 'active', 'revoked')),
        setup_hash        TEXT,
        setup_grant_hash  TEXT,
        setup_expires_at  INTEGER,
        session_gen       INTEGER NOT NULL DEFAULT 1,
        invited_at        TEXT NOT NULL,
        invited_by        TEXT NOT NULL,
        activated_at      TEXT,
        last_sign_in_at   TEXT,
        revoked_at        TEXT,
        revoked_by        TEXT
      );
      CREATE UNIQUE INDEX staff_by_setup ON staff_accounts(setup_hash) WHERE setup_hash IS NOT NULL;
      CREATE UNIQUE INDEX staff_by_grant ON staff_accounts(setup_grant_hash) WHERE setup_grant_hash IS NOT NULL;
      CREATE TABLE order_vat (
        order_id    TEXT PRIMARY KEY REFERENCES orders(id),
        rate_bp     INTEGER NOT NULL,          -- 500 = 5%
        inclusive   INTEGER NOT NULL,          -- 1: the prices included VAT
        net_fils    INTEGER NOT NULL,
        vat_fils    INTEGER NOT NULL,
        total_fils  INTEGER NOT NULL,
        lines       TEXT NOT NULL,             -- JSON [{ kind, label, quantity, totalFils, netFils, vatFils }]
        supplier    TEXT NOT NULL,             -- JSON { name, address, trn } when it was placed
        created_at  TEXT NOT NULL
      );
      CREATE TABLE vat_invoices (
        seq         INTEGER PRIMARY KEY,       -- 1, 2, 3… with no gaps
        number      TEXT NOT NULL UNIQUE,      -- INV-000001
        order_id    TEXT NOT NULL UNIQUE REFERENCES orders(id),
        issued_at   TEXT NOT NULL,
        issued_on   TEXT NOT NULL,             -- the UAE date
        net_fils    INTEGER NOT NULL,
        vat_fils    INTEGER NOT NULL,
        total_fils  INTEGER NOT NULL
      );
      CREATE INDEX vat_invoices_by_date ON vat_invoices(issued_on);
      CREATE TABLE vat_credit_notes (
        seq          INTEGER PRIMARY KEY,      -- 1, 2, 3… with no gaps
        number       TEXT NOT NULL UNIQUE,     -- CN-000001
        invoice_seq  INTEGER NOT NULL REFERENCES vat_invoices(seq),
        order_id     TEXT NOT NULL REFERENCES orders(id),
        reason       TEXT NOT NULL,            -- refund | cancelled | refund_reversed
        issued_at    TEXT NOT NULL,
        issued_on    TEXT NOT NULL,
        net_fils     INTEGER NOT NULL,         -- negative: a refund that failed afterwards (the credit comes back)
        vat_fils     INTEGER NOT NULL,
        total_fils   INTEGER NOT NULL CHECK (total_fils <> 0)
      );
      CREATE INDEX vat_credit_notes_by_order ON vat_credit_notes(order_id);
      CREATE INDEX vat_credit_notes_by_date ON vat_credit_notes(issued_on);
      ALTER TABLE expenses ADD COLUMN vat_fils INTEGER;
      ALTER TABLE expenses ADD COLUMN supplier_trn TEXT;
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
