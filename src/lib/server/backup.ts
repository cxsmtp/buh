import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import { readTar, writeTar, type TarEntry } from './tar';

/**
 * Backups, every 12 hours (BACKUP_INTERVAL_HOURS), taken by the running shop:
 *
 *  - a consistent copy of the database (SQLite online backup, safe mid-sale),
 *    with the courier and SMS keys blanked (re-enter them after a restore);
 *  - flat files anyone can open in Excel: orders.csv, order_items.csv,
 *    customers.csv, products.csv;
 *  - the bank-transfer receipts, the product photos and the audit log.
 *
 * All packed in one .tar.gz; with BACKUP_PASSPHRASE set it is encrypted
 * (AES-256-GCM, key from scrypt) to .tar.gz.enc. It is emailed to
 * BACKUP_EMAIL through the SMTP server in SMTP_*, and the newest 14 are kept
 * in DATA_DIR/backups. Every run is recorded (backup-state.json and the audit
 * log) and shown in the admin hub; a failure is emailed when email works.
 *
 * Restore: node scripts/restore-backup.mjs <file> <empty folder>.
 */

const gzip = promisify(zlib.gzip);

export const BACKUP_MAGIC = 'BUHBK1\n';
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

function cell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  // A cell starting with = + - @ (or tab/CR) would run as a formula in Excel.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  // BOM so Excel reads Arabic names as UTF-8.
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function csvFiles(): TarEntry[] {
  const orders = allOrders();
  const o = (x: Order) => [
    x.id, x.createdAt, x.status, x.paymentMethod, x.paymentStatus, x.subtotal, x.deliveryFee, x.codFee, x.discount, x.total,
    x.customer.fullName, x.customer.phone, x.customer.email ?? '', x.customer.emirate, x.customer.area, x.customer.streetAddress,
    x.customer.buildingVilla, x.customer.flatVillaNo, x.customer.landmark ?? '', x.bankTransferRef ?? '',
    x.courier.provider, x.courier.awbNumber, x.courier.simulated ? 'yes' : '', x.courier.status, x.adminNotes ?? '',
    x.source?.source ?? '', x.source?.campaign ?? '',
  ];
  return [
    {
      name: 'orders.csv',
      data: Buffer.from(toCsv(
        ['order_id', 'created_at', 'status', 'payment_method', 'payment_status', 'subtotal_aed', 'delivery_fee_aed', 'cod_fee_aed', 'discount_aed', 'total_aed',
          'customer_name', 'phone', 'email', 'emirate', 'area', 'street', 'building_villa', 'flat_villa_no', 'landmark', 'bank_transfer_ref',
          'courier', 'awb', 'awb_simulated', 'courier_status', 'admin_notes', 'source', 'campaign'],
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
      name: 'products.csv',
      data: Buffer.from(toCsv(
        ['product_id', 'title', 'category', 'price_aed', 'stock_total', 'stock_by_size', 'visible', 'removed', 'sizes'],
        listProducts({ includeHidden: true, includeArchived: true }).map((p) => [
          p.id, p.title, p.category, p.price, p.stockCount,
          p.profiles.map((x) => `${x.id}=${p.stockBySize[x.id] ?? 0}`).join('; '),
          p.active ? 'yes' : 'no', p.archived ? 'yes' : '',
          p.profiles.map((x) => `${x.name} (+${x.priceDelta})`).join('; '),
        ])
      )),
    },
  ];
}

function folderEntries(folder: string, prefix: string): TarEntry[] {
  const dir = path.join(dataDir(), folder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile())
    .map((f) => ({ name: `${prefix}/${f}`, data: fs.readFileSync(path.join(dir, f)) }));
}

// ── Encryption ──────────────────────────────────────────────────────────────

// scrypt cost 2^17 (128 MB, about half a second): slow to guess offline.
const SCRYPT_N = 131072;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** Shorter passphrases are accepted but flagged in the admin hub and the log. */
export const MIN_PASSPHRASE_LENGTH = 12;

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
  const tmpDb = path.join(dir, `.snapshot-${process.pid}-${Date.now()}.db`);
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
    const entries: TarEntry[] = [
      { name: 'shop.db', data: fs.readFileSync(tmpDb) },
      ...csv,
      ...folderEntries('receipts', 'receipts'),
      ...folderEntries('images', 'images'),
      ...fs
        .readdirSync(dataDir())
        .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
        .map((f) => ({ name: `audit/${f}`, data: fs.readFileSync(dataFile(f)) })),
    ];
    const manifest = entries.map((e) => `${crypto.createHash('sha256').update(e.data).digest('hex')}  ${e.data.length}  ${e.name}`).join('\n') + '\n';
    entries.push({ name: 'MANIFEST.sha256', data: Buffer.from(manifest) });

    // Off the main thread, so checkout keeps answering while a big backup is packed.
    // Level 6: photos and receipts are already compressed; level 9 only costs time.
    const archive = await gzip(writeTar(entries), { level: 6 });
    const passphrase = process.env.BACKUP_PASSPHRASE || '';
    const encrypted = passphrase.length > 0;
    const payload = encrypted ? seal(archive, passphrase) : archive;
    const file = path.join(dir, `buh-backup-${stamp}.tar.gz${encrypted ? '.enc' : ''}`);
    fs.writeFileSync(file, payload, { mode: 0o600 });

    const counts = (getDb().prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
    const summary = `${counts} orders, ${listProducts({ includeHidden: true }).length} products, ${entries.filter((e) => e.name.startsWith('receipts/')).length} receipts`;

    // Keep the newest KEEP backups.
    const all = fs.readdirSync(dir).filter((f) => f.startsWith('buh-backup-')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) fs.rmSync(path.join(dir, old), { force: true });

    return { file, size: payload.length, encrypted, summary, csv };
  } finally {
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(`${tmpDb}-wal`, { force: true });
    fs.rmSync(`${tmpDb}-shm`, { force: true });
    fs.rmSync(`${tmpDb}-journal`, { force: true });
  }
}

/** Read a backup back: the archive's files, after checking every file against the manifest. */
export function openBackup(payload: Buffer, passphrase = ''): TarEntry[] {
  const isSealed = payload.subarray(0, BACKUP_MAGIC.length).toString() === BACKUP_MAGIC;
  if (isSealed && !passphrase) throw new Error('This backup is encrypted: give its BACKUP_PASSPHRASE.');
  const archive = isSealed ? unseal(payload, passphrase) : payload;
  const entries = readTar(zlib.gunzipSync(archive, { maxOutputLength: 2 * 1024 * 1024 * 1024 }));
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
