import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Order } from '@/types';
import { audit } from './audit';
import { dataDir, dataFile, writePrivateFile } from './dataDir';
import { backupTo, getDb } from './db';
import { logEvent } from './log';
import { listCustomers, listOrders } from './orders';
import { listProducts } from './products';
import { readTar, writeTar, type TarEntry } from './tar';

/**
 * Backups, every 12 hours (BACKUP_INTERVAL_HOURS), taken by the running shop:
 *
 *  - a consistent copy of the database (SQLite online backup, safe mid-sale);
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

export const BACKUP_MAGIC = 'BUHBK1\n';
const KEEP = 14;
const EMAIL_LIMIT_BYTES = 20 * 1024 * 1024; // most mail servers accept 25 MB

export interface BackupState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastSummary?: string;
  lastError?: string;
  lastEmailedAt?: string;
  lastEmailError?: string;
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
  const orders = listOrders({ limit: 1_000_000 });
  const o = (x: Order) => [
    x.id, x.createdAt, x.status, x.paymentMethod, x.paymentStatus, x.subtotal, x.deliveryFee, x.codFee, x.discount, x.total,
    x.customer.fullName, x.customer.phone, x.customer.email ?? '', x.customer.emirate, x.customer.area, x.customer.streetAddress,
    x.customer.buildingVilla, x.customer.flatVillaNo, x.customer.landmark ?? '', x.bankTransferRef ?? '',
    x.courier.provider, x.courier.awbNumber, x.courier.simulated ? 'yes' : '', x.courier.status, x.adminNotes ?? '',
  ];
  return [
    {
      name: 'orders.csv',
      data: Buffer.from(toCsv(
        ['order_id', 'created_at', 'status', 'payment_method', 'payment_status', 'subtotal_aed', 'delivery_fee_aed', 'cod_fee_aed', 'discount_aed', 'total_aed',
          'customer_name', 'phone', 'email', 'emirate', 'area', 'street', 'building_villa', 'flat_villa_no', 'landmark', 'bank_transfer_ref',
          'courier', 'awb', 'awb_simulated', 'courier_status', 'admin_notes'],
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
        ['product_id', 'title', 'category', 'price_aed', 'stock', 'visible', 'sizes'],
        listProducts({ includeHidden: true }).map((p) => [p.id, p.title, p.category, p.price, p.stockCount, p.active ? 'yes' : 'no', p.profiles.map((x) => `${x.name} (+${x.priceDelta})`).join('; ')])
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

export function seal(plain: Buffer, passphrase: string): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const head = JSON.stringify({ kdf: 'scrypt', N: 16384, r: 8, p: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  return Buffer.concat([Buffer.from(BACKUP_MAGIC), Buffer.from(head + '\n'), data]);
}

export function unseal(sealed: Buffer, passphrase: string): Buffer {
  if (sealed.subarray(0, BACKUP_MAGIC.length).toString() !== BACKUP_MAGIC) throw new Error('Not an encrypted Beautiful UAE Home backup.');
  const rest = sealed.subarray(BACKUP_MAGIC.length);
  const nl = rest.indexOf(0x0a);
  const head = JSON.parse(rest.subarray(0, nl).toString());
  const key = crypto.scryptSync(passphrase, Buffer.from(head.salt, 'base64'), 32, { N: head.N, r: head.r, p: head.p });
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
    // Prove the snapshot is readable before shipping it.
    const Database = (await import('better-sqlite3')).default;
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

    const archive = zlib.gzipSync(writeTar(entries), { level: 9 });
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

export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.BACKUP_EMAIL);
}

async function transport() {
  const nodemailer = (await import('nodemailer')).default;
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    // Encrypt the connection (and so the SMTP password). SMTP_REQUIRE_TLS=false is for local testing only.
    requireTLS: port !== 465 && process.env.SMTP_REQUIRE_TLS !== 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' },
    connectionTimeout: 20_000,
    socketTimeout: 60_000,
  });
}

function sender(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || 'backups@localhost';
}

async function emailBackup(result: BackupResult) {
  const name = path.basename(result.file);
  const attachments: Array<{ filename: string; content: Buffer }> = [];
  if (result.size <= EMAIL_LIMIT_BYTES) attachments.push({ filename: name, content: fs.readFileSync(result.file) });
  // Without encryption the flat files are attached too, readable straight from the email.
  if (!result.encrypted) for (const c of result.csv) attachments.push({ filename: c.name, content: c.data });

  const lines = [
    `Backup of Beautiful UAE Home taken ${new Date().toUTCString()}.`,
    `Contents: ${result.summary}.`,
    result.size <= EMAIL_LIMIT_BYTES
      ? `Full backup attached: ${name} (${(result.size / 1024 / 1024).toFixed(1)} MB${result.encrypted ? ', encrypted with your BACKUP_PASSPHRASE' : ''}).`
      : `The full backup (${(result.size / 1024 / 1024).toFixed(1)} MB) is too large to email; it is on the server in the backups folder. ${result.encrypted ? '' : 'The CSV files are attached.'}`,
    result.encrypted ? '' : 'Note: these files contain customer names, phone numbers and addresses. Set BACKUP_PASSPHRASE to receive them encrypted instead.',
    '',
    'To restore: node scripts/restore-backup.mjs <backup file> <empty folder> (see HOSTINGER_DEPLOYMENT_GUIDE.md).',
  ].filter((l) => l !== undefined);

  await (await transport()).sendMail({
    from: sender(),
    to: process.env.BACKUP_EMAIL,
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
      to: process.env.BACKUP_EMAIL,
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
        patch.lastEmailError = 'Backup email is not set up (SMTP_HOST and BACKUP_EMAIL): the backup is only on this server.';
      }
      writeBackupState(patch);
      audit('backup.taken', { reason, file: patch.lastFile, size: result.size, encrypted: result.encrypted, emailed: Boolean(patch.lastEmailedAt && !patch.lastEmailError), emailError: patch.lastEmailError });
      if (patch.lastEmailError) logEvent('warn', 'backup_not_emailed', { error: patch.lastEmailError });
      else logEvent('info', 'backup_done', { file: patch.lastFile, summary: result.summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeBackupState({ lastAttemptAt: attemptAt, lastError: message });
      audit('backup.failed', { reason, error: message });
      logEvent('error', 'backup_failed', { error: message });
      await emailFailure(message);
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
  const level: 'ok' | 'warning' | 'failing' =
    state.lastError && (!last || Date.parse(state.lastAttemptAt || '') > last) ? 'failing' : overdue ? 'failing' : state.lastEmailError ? 'warning' : 'ok';
  return {
    level,
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
    const last = readBackupState().lastSuccessAt;
    if (!last || Date.now() - Date.parse(last) >= intervalHours() * 3600_000) void runBackup(last ? 'scheduled' : 'startup');
  };
  setTimeout(tick, 60_000).unref();
  timer = setInterval(tick, 15 * 60_000);
  timer.unref();
}
