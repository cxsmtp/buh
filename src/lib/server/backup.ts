import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { Order } from '@/types';
import { audit } from './audit';
import { dataDir, dataFile, writePrivateFile } from './dataDir';
import { backupTo, getDb } from './db';
import { logEvent } from './log';
import { emailConfigured, ownerEmail, sender, transport } from './mail';
import { allOrders, listCustomers } from './orders';
import { blankSecretsIn } from './settings';
import { listProducts } from './products';
import { readTar, TAR_END, tarHeader, tarPadding, type TarEntry } from './tar';
import { diskRoomProblem } from './diskRoom';
import { kvGet, kvSet } from './kv';
import { expenseCsvFiles } from './expenses';
import { toCsv } from './csv';

/**
 * Backups, every 12 hours (BACKUP_INTERVAL_HOURS), taken by the running shop:
 *
 *  - a consistent copy of the database (SQLite online backup, safe mid-sale),
 *    with the courier and SMS keys blanked (re-enter them after a restore);
 *  - flat files anyone can open in Excel: orders.csv, order_items.csv,
 *    customers.csv, products.csv, chats.csv, stock_moves.csv (every stock
 *    change made in the Admin Hub: who, why, old → new);
 *  - product drafts, the stock ledger and the shared selections (/c/<slug>) are tables in the
 *    database copy; collections.csv lists the selections too;
 *  - the bank-transfer receipts (every screenshot a customer uploaded, the earlier ones
 *    too), the product photos and the audit log;
 *  - the expenses (tables in the database copy, every earlier version and removed ones too),
 *    expenses.csv and expense_bills.csv, and every bill photo or PDF (expenses/, replaced and
 *    removed ones too);
 *  - the owner's passkeys (public keys only) and recovery codes (hashes
 *    only), in the database; a restore switches them off until reviewed,
 *    since the backup may predate a revocation.
 *
 * All packed in one .tar.gz, streamed (each file read a piece at a time, compressed and encrypted
 * as it goes, so a big bills folder never sits in memory); with BACKUP_PASSPHRASE set it is
 * encrypted (AES-256-GCM, key from scrypt) to .tar.gz.enc. The data to back up may be at most
 * BACKUP_LIMITS.totalBytes (6 GB): the monitor warns from 80%, and beyond it the backup is refused
 * (and the owner told) rather than made too big to restore. It is emailed to
 * BACKUP_EMAIL through the SMTP server in SMTP_*, and the newest 14 are kept
 * in DATA_DIR/backups. Every run is recorded (backup-state.json and the audit
 * log) and shown in the admin hub; a failure is emailed when email works.
 *
 * Restore: node scripts/restore-backup.mjs <file> <empty folder>.
 */

const scrypt = promisify(crypto.scrypt) as (pass: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

/** A collection's product ids for collections.csv; one unreadable row never stops a backup. */
function productIdsText(raw: unknown): string {
  try {
    const ids = JSON.parse(String(raw));
    return Array.isArray(ids) ? ids.map(String).join('; ') : '';
  } catch {
    return '';
  }
}

export const BACKUP_MAGIC = 'BUHBK1\n';
/**
 * The most data one backup takes (the database, receipts, photos, bills and the audit log), and
 * where the monitor starts warning. A restore needs that much free disk twice over. (Changeable by
 * tests only.)
 */
export const BACKUP_LIMITS = { totalBytes: 6 * 1024 ** 3, warnRatio: 0.8, minFreeBytes: 512 * 1024 ** 2 };
const KEEP = 14;
// Gmail and most mail servers accept 25 MB per message; base64 adds a third.
const EMAIL_LIMIT_BYTES = 17 * 1024 * 1024;

export interface BackupState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastSummary?: string;
  lastError?: string;
  lastEmailedAt?: string;
  lastEmailError?: string;
  lastFailureEmailAt?: string;
  encrypted?: boolean;
}

export function intervalHours(): number {
  const h = Number(process.env.BACKUP_INTERVAL_HOURS || 12);
  return Number.isFinite(h) && h >= 1 && h <= 168 ? h : 12;
}

function backupsDir(): string {
  const dir = path.join(dataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readBackupState(): BackupState {
  try {
    return JSON.parse(fs.readFileSync(dataFile('backup-state.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeBackupState(patch: BackupState) {
  writePrivateFile(dataFile('backup-state.json'), JSON.stringify({ ...readBackupState(), ...patch }, null, 2));
}

// ── CSV (safe to open in Excel) ─────────────────────────────────────────────

// toCsv lives in ./csv (shared with the accountant's export); kept importable from here.
export { toCsv } from './csv';

function csvFiles(): TarEntry[] {
  const orders = allOrders();
  const o = (x: Order) => [
    x.id, x.createdAt, x.status, x.paymentMethod, x.paymentStatus, x.subtotal, x.deliveryFee, x.codFee, x.discount, x.total,
    x.customer.fullName, x.customer.phone, x.customer.email ?? '', x.customer.emirate, x.customer.area, x.customer.streetAddress,
    x.customer.buildingVilla, x.customer.flatVillaNo, x.customer.landmark ?? '', x.bankTransferRef ?? '',
    x.courier.provider, x.courier.awbNumber, x.courier.simulated ? 'yes' : '', x.courier.status, x.adminNotes ?? '',
    x.source?.source ?? '', x.source?.campaign ?? '', x.deliveryOption ?? 'standard',
    x.whatsappCheck?.status ?? '', x.whatsappCheck?.checkedAt ?? '', x.whatsappCheck?.checkedBy ?? '',
    x.card?.state ?? '', x.card?.ref ?? '', x.card?.label ?? '', x.card?.paidAt ?? '', x.card?.paidAmount ?? '', x.card?.refundRef ?? '', x.card?.refundedAt ?? '',
    x.card?.refundedAmount ?? '', x.card?.mode ?? '', x.card?.refundOutsideAt ?? '', x.attention?.text ?? '',
    // The bank transfer (never its private link: only the shop can make that again).
    x.bankTransfer?.state ?? '', x.bankTransfer?.uploads ?? '', x.bankTransfer?.uploadedAt ?? '', x.bankTransfer?.emailedAt ?? '', x.bankTransfer?.checkedAt ?? '', x.bankTransfer?.checkedBy ?? '',
    // The card payment fee (part of total_aed), and a bank transfer whose details the customer asks for on WhatsApp.
    x.cardFee ?? '', x.cardFeePercent ?? '', x.bankDetailsBy ?? '',
  ];
  return [
    {
      name: 'orders.csv',
      data: Buffer.from(toCsv(
        ['order_id', 'created_at', 'status', 'payment_method', 'payment_status', 'subtotal_aed', 'delivery_fee_aed', 'cod_fee_aed', 'discount_aed', 'total_aed',
          'customer_name', 'phone', 'email', 'emirate', 'area', 'street', 'building_villa', 'flat_villa_no', 'landmark', 'bank_transfer_ref',
          'courier', 'awb', 'awb_simulated', 'courier_status', 'admin_notes', 'source', 'campaign', 'delivery',
          'whatsapp_check', 'whatsapp_checked_at', 'whatsapp_checked_by',
          'card_payment', 'payment_ref', 'card', 'paid_at', 'paid_aed', 'refund_ref', 'refunded_at',
          'refunded_aed', 'stripe_mode', 'refund_outside_stripe_at', 'needs_attention',
          'bank_transfer', 'transfer_screenshots', 'transfer_uploaded_at', 'bank_details_emailed_at', 'bank_checked_at', 'bank_checked_by',
          'card_fee_aed', 'card_fee_percent', 'bank_details_by'],
        orders.map(o)
      )),
    },
    {
      name: 'order_items.csv',
      data: Buffer.from(toCsv(
        ['order_id', 'product_id', 'title', 'size', 'colour', 'unit_price_aed', 'quantity', 'line_total_aed'],
        orders.flatMap((x) => x.items.map((i) => [x.id, i.productId, i.title, i.profileName, i.color ?? '', i.unitPrice, i.quantity, i.totalPrice]))
      )),
    },
    {
      name: 'customers.csv',
      data: Buffer.from(toCsv(
        ['name', 'phone', 'email', 'emirate', 'area', 'orders', 'total_spent_aed', 'last_order_at'],
        listCustomers().map((c) => [c.fullName, c.phone, c.email ?? '', c.emirate, c.area, c.totalOrders, c.totalSpent, c.lastOrderDate])
      )),
    },
    {
      name: 'chats.csv',
      data: Buffer.from(toCsv(
        ['chat_id', 'at', 'from', 'via', 'customer_name', 'contact', 'status', 'message'],
        (getDb()
          .prepare('SELECT m.thread_id, m.at, m.author, m.via, t.customer_name, t.contact, t.status, m.body FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id ORDER BY m.id')
          .all() as Array<Record<string, string>>).map((r) => [r.thread_id, r.at, r.author, r.via, r.customer_name, r.contact, r.status, r.body])
      )),
    },
    {
      name: 'stock_moves.csv',
      data: Buffer.from(toCsv(
        ['move_id', 'at', 'product_id', 'by', 'reason', 'changes', 'note', 'undo_of'],
        (getDb().prepare('SELECT id, at, product_id, actor, reason, changes, note, undo_of FROM stock_moves ORDER BY id').all() as Array<Record<string, string | number | null>>).map((r) => [
          r.id, r.at, r.product_id, r.actor, r.reason,
          (JSON.parse(String(r.changes)) as Array<{ sizeId: string; from: number; to: number }>).map((c) => `${c.sizeId} ${c.from}→${c.to}`).join('; '),
          r.note, r.undo_of ?? '',
        ])
      )),
    },
    ...expenseCsvFiles(),
    {
      // Shared selections (/c/<slug>): their products and counters (the table is in the database copy too).
      name: 'collections.csv',
      data: Buffer.from(toCsv(
        ['collection_id', 'link', 'title', 'product_ids', 'last_day', 'views', 'added_to_bag', 'created_at', 'created_by', 'updated_at'],
        (getDb().prepare('SELECT id, slug, title, product_ids, expires_on, views, bag_adds, created_at, created_by, updated_at FROM collections ORDER BY created_at').all() as Array<Record<string, string | number | null>>).map((r) => [
          r.id, `/c/${r.slug}`, r.title, productIdsText(r.product_ids), r.expires_on ?? '', r.views, r.bag_adds, r.created_at, r.created_by, r.updated_at,
        ])
      )),
    },
    {
      name: 'products.csv',
      data: Buffer.from(toCsv(
        ['product_id', 'title', 'category', 'price_aed', 'stock_total', 'stock_by_size', 'visible', 'removed', 'sizes', 'product_type', 'sku'],
        listProducts({ includeHidden: true, includeArchived: true }).map((p) => [
          p.id, p.title, p.category, p.price, p.stockCount,
          p.profiles.map((x) => `${x.id}=${p.stockBySize[x.id] ?? 0}`).join('; '),
          p.active ? 'yes' : 'no', p.archived ? 'yes' : '',
          p.profiles.map((x) => `${x.name}${x.dimensions ? ` ${x.dimensions}` : ''} (+${x.priceDelta})`).join('; '),
          p.productType === 'simple' ? 'simple' : 'bedding', p.sku ?? '',
        ])
      )),
    },
  ];
}

/** A file to put in the backup: from disk (read a piece at a time when it is packed) or from memory. */
interface PackItem {
  name: string;
  size: number;
  file?: string;
  data?: Buffer;
}

function folderItems(folder: string, prefix: string): PackItem[] {
  const dir = path.join(dataDir(), folder);
  if (!fs.existsSync(dir)) return [];
  const out: PackItem[] = [];
  for (const f of fs.readdirSync(dir)) {
    // A file still being written (an upload in progress) is not part of the shop's data yet.
    if (f.endsWith('.tmp')) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.isFile()) out.push({ name: `${prefix}/${f}`, size: st.size, file: path.join(dir, f) });
    } catch {
      // removed meanwhile (an older screenshot pruned, a photo replaced)
    }
  }
  return out;
}

function auditItems(): PackItem[] {
  return fs
    .readdirSync(dataDir())
    .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
    .map((f) => ({ name: `audit/${f}`, size: fs.statSync(dataFile(f)).size, file: dataFile(f) }));
}

/** How much data a backup takes now (before compression), against the limit. */
export function backupDataSize(): { bytes: number; limit: number; ratio: number } {
  let bytes = 0;
  try {
    bytes += fs.statSync(dataFile('shop.db')).size;
  } catch {
    // no database yet
  }
  for (const i of [...folderItems('receipts', 'receipts'), ...folderItems('images', 'images'), ...folderItems('expenses', 'expenses'), ...auditItems()]) bytes += i.size;
  return { bytes, limit: BACKUP_LIMITS.totalBytes, ratio: bytes / BACKUP_LIMITS.totalBytes };
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n < 1024 ** 3 ? 2 : 1)} GB`;

/**
 * The tar, made as it is read: each file's header, its bytes (from disk, a piece at a time, exactly
 * the size it had when listed: a log appended to meanwhile is taken up to there), its padding; the
 * manifest of checksums last.
 */
async function* tarStream(items: PackItem[]): AsyncGenerator<Buffer> {
  const manifest: string[] = [];
  for (const item of items) {
    const hash = crypto.createHash('sha256');
    yield tarHeader(item.name, item.size);
    if (item.data) {
      hash.update(item.data);
      yield item.data;
    } else if (item.size) {
      let got = 0;
      for await (const chunk of fs.createReadStream(item.file!, { start: 0, end: item.size - 1, highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>) {
        got += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
      if (got !== item.size) throw new Error(`${item.name} changed while it was backed up.`);
    }
    yield tarPadding(item.size);
    manifest.push(`${hash.digest('hex')}  ${item.size}  ${item.name}`);
  }
  const text = Buffer.from(manifest.join('\n') + '\n');
  yield tarHeader('MANIFEST.sha256', text.length);
  yield text;
  yield tarPadding(text.length);
  yield TAR_END;
}

// ── Encryption ──────────────────────────────────────────────────────────────

// scrypt cost 2^17 (128 MB, about half a second): slow to guess offline.
const SCRYPT_N = 131072;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** Shorter passphrases are accepted but flagged in the admin hub and the log. */
export const MIN_PASSPHRASE_LENGTH = 12;

function sealHead(salt: Buffer, iv: Buffer, tag: Buffer): Buffer {
  // Every field has a fixed length, so the head can be written before the tag is known and again after.
  return Buffer.from(JSON.stringify({ kdf: 'scrypt', N: SCRYPT_N, r: 8, p: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64') }) + '\n');
}

export function seal(plain: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const head = JSON.stringify({ kdf: 'scrypt', N: SCRYPT_N, r: 8, p: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  return Buffer.concat([Buffer.from(BACKUP_MAGIC), Buffer.from(head + '\n'), data]);
}

export function unseal(sealed: Buffer, passphrase: string): Buffer {
  if (sealed.subarray(0, BACKUP_MAGIC.length).toString() !== BACKUP_MAGIC) throw new Error('Not an encrypted Beautiful UAE Home backup.');
  const rest = sealed.subarray(BACKUP_MAGIC.length);
  const nl = rest.indexOf(0x0a);
  const head = JSON.parse(rest.subarray(0, nl).toString());
  // Older backups used N=16384; refuse silly values from a tampered header.
  if (![16384, SCRYPT_N].includes(head.N) || head.r !== 8 || head.p !== 1) throw new Error('Unknown backup encryption settings.');
  const key = crypto.scryptSync(passphrase, Buffer.from(head.salt, 'base64'), 32, { N: head.N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(head.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(head.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(rest.subarray(nl + 1)), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase, or the backup is damaged.');
  }
}

// ── Taking a backup ─────────────────────────────────────────────────────────

export interface BackupResult {
  file: string;
  size: number;
  encrypted: boolean;
  summary: string;
  csv: TarEntry[];
}

export async function createBackup(now = new Date()): Promise<BackupResult> {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const dir = backupsDir();
  // Too much data to back up (and so to restore): refused, and the failure tells the owner.
  const size = backupDataSize();
  if (size.bytes > size.limit) {
    throw new Error(`The shop's data is ${gb(size.bytes)}, more than one backup can hold (${gb(size.limit)}): no backup was made. Remove old product photos or bills you no longer need, or ask for the limit to be raised.`);
  }
  const room = diskRoomProblem(dir, size.bytes, BACKUP_LIMITS.minFreeBytes);
  if (room) throw new Error(`There is no room for the backup: ${room}. Free some space on the server.`);
  const tmpDb = path.join(dir, `.snapshot-${process.pid}-${Date.now()}.db`);
  const partial = path.join(dir, `.partial-${process.pid}-${Date.now()}`);
  try {
    await backupTo(tmpDb);
    const Database = (await import('better-sqlite3')).default;
    // Courier and SMS keys stay on the server: blank them in the copy, and
    // VACUUM so the old values are not left behind in free pages.
    const copy = new Database(tmpDb);
    try {
      copy.pragma('journal_mode = DELETE');
      copy.pragma('secure_delete = ON');
      blankSecretsIn(copy);
      // Passkeys (public keys) and recovery codes (hashes) stay in (the restore script switches
      // them off until the owner reviews them); half-finished passkey sign-ins are left out.
      copy.exec('DELETE FROM webauthn_challenges');
      // The admin link's fingerprint stays in (a restored shop keeps the owner's bookmark); the copy
      // kept for showing a new link once to a signed-in owner never leaves the server.
      copy.exec("DELETE FROM kv WHERE key = 'admin:link-reveal'");
      copy.exec('VACUUM');
    } finally {
      copy.close();
    }
    // Prove the snapshot is readable before shipping it.
    const check = new Database(tmpDb, { readonly: true });
    const ok = check.pragma('integrity_check', { simple: true });
    check.close();
    if (ok !== 'ok') throw new Error(`Snapshot failed its integrity check: ${ok}`);

    const csv = csvFiles();
    const items: PackItem[] = [
      { name: 'shop.db', size: fs.statSync(tmpDb).size, file: tmpDb },
      ...csv.map((c) => ({ name: c.name, size: c.data.length, data: c.data })),
      ...folderItems('receipts', 'receipts'),
      ...folderItems('images', 'images'),
      ...folderItems('expenses', 'expenses'),
      ...auditItems(),
    ];

    // Streamed: read, compressed (level 6: photos and receipts are already compressed; level 9
    // only costs time) and encrypted a piece at a time, off the main thread where it counts.
    const passphrase = process.env.BACKUP_PASSPHRASE || '';
    const encrypted = passphrase.length > 0;
    const out = fs.createWriteStream(partial, { mode: 0o600, flags: 'wx' });
    let cipher: crypto.CipherGCM | null = null;
    let salt = Buffer.alloc(16);
    let iv = Buffer.alloc(12);
    let key: Buffer | null = null;
    if (encrypted) {
      salt = crypto.randomBytes(16);
      iv = crypto.randomBytes(12);
      key = await scrypt(passphrase, salt, 32, { N: SCRYPT_N, r: 8, p: 1, maxmem: SCRYPT_MAXMEM });
      cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      // The head with a blank tag; the real tag is written over it once everything is encrypted.
      out.write(Buffer.concat([Buffer.from(BACKUP_MAGIC), sealHead(salt, iv, Buffer.alloc(16))]));
    }
    await pipeline(Readable.from(tarStream(items)), zlib.createGzip({ level: 6 }), cipher ?? new PassThrough(), out);
    if (cipher) {
      const fd = fs.openSync(partial, 'r+');
      try {
        fs.writeSync(fd, sealHead(salt, iv, cipher.getAuthTag()), 0, undefined, Buffer.byteLength(BACKUP_MAGIC));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const file = path.join(dir, `buh-backup-${stamp}.tar.gz${encrypted ? '.enc' : ''}`);
    fs.renameSync(partial, file);
    const written = fs.statSync(file).size;

    const counts = (getDb().prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
    const expenses = (getDb().prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number }).n;
    const summary = `${counts} orders, ${listProducts({ includeHidden: true }).length} products, ${items.filter((e) => e.name.startsWith('receipts/')).length} receipts, ${expenses} expenses, ${items.filter((e) => e.name.startsWith('expenses/')).length} bills`;

    // Keep the newest KEEP backups.
    const all = fs.readdirSync(dir).filter((f) => f.startsWith('buh-backup-')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old), { force: true });

    return { file, size: written, encrypted, summary, csv };
  } finally {
    fs.rmSync(partial, { force: true });
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-wal`, { force: true });
    fs.rmSync(`${tmpDb}-shm`, { force: true });
    fs.rmSync(`${tmpDb}-journal`, { force: true });
  }
}

/**
 * A restore (scripts/restore-backup.mjs, run while the shop is stopped) leaves a note in the
 * database; the first start after it writes "backup.restored" to the audit log, once.
 */
export function auditRestoreOnce(): boolean {
  const restored = kvGet<{ at: string; backup: string }>('admin:restored')?.data;
  if (!restored?.at || kvGet<string>('audit:restore-noted')?.data === restored.at) return false;
  if (!audit('backup.restored', { restoredAt: restored.at, backup: String(restored.backup ?? '').slice(0, 120) })) return false;
  kvSet('audit:restore-noted', restored.at);
  return true;
}

/**
 * Read a small backup back into memory (tests, and looking inside one): the archive's files, after
 * checking every file against the manifest. A real restore streams instead (scripts/restore-backup.mjs).
 */
export function openBackup(payload: Buffer, passphrase = ''): TarEntry[] {
  const isSealed = payload.subarray(0, BACKUP_MAGIC.length).toString() === BACKUP_MAGIC;
  if (isSealed && !passphrase) throw new Error('This backup is encrypted: give its BACKUP_PASSPHRASE.');
  const archive = isSealed ? unseal(payload, passphrase) : payload;
  const entries = readTar(zlib.gunzipSync(archive, { maxOutputLength: BACKUP_LIMITS.totalBytes + 64 * 1024 ** 2 }));
  const manifest = entries.find((e) => e.name === 'MANIFEST.sha256');
  if (!manifest) throw new Error('The backup has no manifest.');
  for (const line of manifest.data.toString().trim().split('\n')) {
    const [hash, size, name] = line.split(/ {2}/);
    const entry = entries.find((e) => e.name === name);
    if (!entry || entry.data.length !== Number(size) || crypto.createHash('sha256').update(entry.data).digest('hex') !== hash) {
      throw new Error(`The backup is damaged: ${name} does not match its checksum.`);
    }
  }
  return entries;
}

// ── Email ───────────────────────────────────────────────────────────────────

export { emailConfigured, sender, transport } from './mail';

async function emailBackup(result: BackupResult) {
  const name = path.basename(result.file);
  const attachments: Array<{ filename: string; content: Buffer }> = [];
  const csvBytes = result.encrypted ? 0 : result.csv.reduce((n, c) => n + c.data.length, 0);
  const fits = result.size + csvBytes <= EMAIL_LIMIT_BYTES;
  if (fits) attachments.push({ filename: name, content: fs.readFileSync(result.file) });
  // Without encryption the flat files are attached too, readable straight from the email.
  if (!result.encrypted) for (const c of result.csv) attachments.push({ filename: c.name, content: c.data });

  const lines = [
    `Backup of Beautiful UAE Home taken ${new Date().toUTCString()}.`,
    `Contents: ${result.summary}.`,
    fits
      ? `Full backup attached: ${name} (${(result.size / 1024 / 1024).toFixed(1)} MB${result.encrypted ? ', encrypted with your BACKUP_PASSPHRASE' : ''}).`
      : `The full backup (${(result.size / 1024 / 1024).toFixed(1)} MB) is too large to email; it is on the server in the backups folder. ${result.encrypted ? '' : 'The CSV files are attached.'}`,
    result.encrypted ? '' : 'Note: these files contain customer names, phone numbers and addresses. Set BACKUP_PASSPHRASE to receive them encrypted instead.',
    '',
    'To restore: node scripts/restore-backup.mjs <backup file> <empty folder> (see HOSTINGER_DEPLOYMENT_GUIDE.md).',
  ].filter((l) => l !== undefined);

  await (await transport()).sendMail({
    from: sender(),
    to: ownerEmail(),
    subject: `[Backup] Beautiful UAE Home — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC — ${result.summary}`,
    text: lines.join('\n'),
    attachments,
  });
}

async function emailFailure(error: string) {
  if (!emailConfigured()) return;
  try {
    await (await transport()).sendMail({
      from: sender(),
      to: ownerEmail(),
      subject: '[Backup FAILED] Beautiful UAE Home',
      text: `The scheduled backup failed at ${new Date().toUTCString()}:\n\n${error}\n\nOpen the Admin Hub and press "Back up now" once fixed.`,
    });
  } catch {
    // Already failing; the admin hub shows the problem.
  }
}

// ── Running and scheduling ──────────────────────────────────────────────────

let running: Promise<BackupState> | null = null;

/** Take a backup and send it. Never throws: the outcome is in the returned state. */
export function runBackup(reason: 'scheduled' | 'manual' | 'startup'): Promise<BackupState> {
  if (running) return running;
  running = (async () => {
    const attemptAt = new Date().toISOString();
    try {
      const result = await createBackup();
      const patch: BackupState = {
        lastAttemptAt: attemptAt,
        lastSuccessAt: new Date().toISOString(),
        lastFile: path.basename(result.file),
        lastSize: result.size,
        lastSummary: result.summary,
        lastError: undefined,
        encrypted: result.encrypted,
      };
      if (emailConfigured()) {
        try {
          await emailBackup(result);
          patch.lastEmailedAt = new Date().toISOString();
          patch.lastEmailError = undefined;
        } catch (err) {
          patch.lastEmailError = err instanceof Error ? err.message : String(err);
        }
      } else {
        patch.lastEmailError = 'Backup email is not set up (Settings → Email, or SMTP_HOST and BACKUP_EMAIL): the backup is only on this server.';
      }
      writeBackupState(patch);
      audit('backup.taken', { reason, file: patch.lastFile, size: result.size, encrypted: result.encrypted, emailed: Boolean(patch.lastEmailedAt && !patch.lastEmailError), emailError: patch.lastEmailError });
      if (patch.lastEmailError) logEvent('warn', 'backup_not_emailed', { error: patch.lastEmailError });
      else logEvent('info', 'backup_done', { file: patch.lastFile, summary: result.summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const before = readBackupState();
      // Email when it starts failing, when the error changes, on "Back up now", and then at most daily.
      const lastMail = before.lastFailureEmailAt ? Date.parse(before.lastFailureEmailAt) : 0;
      const mail = reason === 'manual' || !before.lastError || before.lastError !== message || Date.now() - lastMail > 24 * 3600_000;
      writeBackupState({ lastAttemptAt: attemptAt, lastError: message, ...(mail ? { lastFailureEmailAt: new Date().toISOString() } : {}) });
      audit('backup.failed', { reason, error: message });
      logEvent('error', 'backup_failed', { error: message });
      if (mail) await emailFailure(message);
    }
    return readBackupState();
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Health of the backups, for the admin hub: ok, warning (not emailed / due soon) or failing. */
export function backupHealth(now = Date.now()) {
  const state = readBackupState();
  const hours = intervalHours();
  const last = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : 0;
  const overdue = !last || now - last > (hours + 1) * 3600_000;
  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  const notice = !passphrase
    ? emailConfigured()
      ? 'Backups are emailed unencrypted: set BACKUP_PASSPHRASE.'
      : undefined
    : passphrase.length < MIN_PASSPHRASE_LENGTH
    ? `BACKUP_PASSPHRASE is short: use at least ${MIN_PASSPHRASE_LENGTH} characters.`
    : undefined;
  const level: 'ok' | 'warning' | 'failing' =
    state.lastError && (!last || Date.parse(state.lastAttemptAt || '') > last)
      ? 'failing'
      : overdue
      ? 'failing'
      : state.lastEmailError || notice
      ? 'warning'
      : 'ok';
  return {
    level,
    notice,
    intervalHours: hours,
    emailConfigured: emailConfigured(),
    encrypted: Boolean(process.env.BACKUP_PASSPHRASE),
    nextDueAt: last ? new Date(last + hours * 3600_000).toISOString() : null,
    ...state,
  };
}

let timer: NodeJS.Timeout | null = null;

/** Check every 15 minutes; back up when the last success is older than the interval (catches up after a restart). */
export function startBackupSchedule() {
  if (timer || process.env.BACKUP_DISABLED === 'true') return;
  const tick = () => {
    const state = readBackupState();
    const last = state.lastSuccessAt;
    // After a failure, retry hourly rather than every 15 minutes.
    if (state.lastError && state.lastAttemptAt && Date.now() - Date.parse(state.lastAttemptAt) < 3600_000) return;
    if (!last || Date.now() - Date.parse(last) >= intervalHours() * 3600_000) void runBackup(last ? 'scheduled' : 'startup');
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 15 * 60_000);
  timer.unref();
}
