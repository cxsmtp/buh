import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { uaeDate } from '@/lib/delivery';
import { auditedTransaction } from './audit';
import { aedText, csvHead, csvRow, toCsv } from './csv';
import { dataDir } from './dataDir';
import { getDb } from './db';
import { folderRoomProblem } from './diskRoom';
import { HttpError } from './http';
import { logEvent } from './log';
import type { TarEntry } from './tar';

/**
 * The shop's expenses, with photos or PDFs of the bills, for the accountant (src/lib/server/reports.ts).
 *
 *  - Amounts are whole fils (AED × 100), parsed from what the owner typed without floating point.
 *  - Nothing is overwritten or deleted. Every state of an expense is kept in expense_versions
 *    (made, each edit, removed); "Remove" marks it removed with who, when and why (it leaves the
 *    totals, never the books); a bill taken off keeps its file.
 *  - Every change is written to the audit log (with before → after) inside its transaction: if the
 *    log can't be written, nothing is saved (503).
 *  - Bills are checked by their bytes (JPEG, PNG, WebP, HEIC or PDF; 10 MB each), photos lose their
 *    EXIF/GPS and other metadata (HEIC is kept as it is: there is no safe decoder here), and they are
 *    stored in DATA_DIR/expenses/ under a random name, never served to anyone but the signed-in hub.
 *    The disk guard of the bank-transfer screenshots applies (src/lib/server/diskRoom.ts).
 */

export const EXPENSE_METHODS = ['cash', 'card', 'bank_transfer', 'other'] as const;
export type ExpenseMethod = (typeof EXPENSE_METHODS)[number];
export const METHOD_LABELS: Record<ExpenseMethod, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other' };

/** Bills: 10 MB each, 20 per expense, the folder stops at 2 GB, and 1 GB of disk stays free. (Changeable by tests only.) */
export const BILL_LIMITS = { fileBytes: 10 * 1024 * 1024, perExpense: 20, folderBytes: 2 * 1024 ** 3, minFreeBytes: 1024 ** 3 };
/** AED 10,000,000: anything bigger is a typo. */
const MAX_FILS = 1_000_000_000;

export interface ExpenseBill {
  id: string;
  expenseId: string;
  ext: BillExt;
  mime: string;
  size: number;
  sha256: string;
  name: string;
  addedAt: string;
  addedBy: string;
  removed?: { at: string; by: string; why: string };
  /** The hub's own address for it (signed-in only). */
  url: string;
}

export interface Expense {
  id: string;
  date: string;
  amountFils: number;
  categoryId: string;
  category: string;
  payee: string;
  method: ExpenseMethod;
  note: string;
  /** The VAT on the bill (input VAT, for the VAT return), when the owner typed it. */
  vatFils?: number;
  /** The supplier's TRN from their tax invoice. */
  supplierTrn?: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  removed?: { at: string; by: string; why: string };
  bills: ExpenseBill[];
}

export interface ExpenseVersion {
  version: number;
  change: 'created' | 'edited' | 'removed';
  at: string;
  by: string;
  data: Snapshot;
}

/** What an expense says, as kept in each version and in the audit log. */
interface Snapshot {
  date: string;
  amountFils: number;
  categoryId: string;
  category: string;
  payee: string;
  method: ExpenseMethod;
  note: string;
  vatFils?: number;
  supplierTrn?: string;
  removed?: { at: string; by: string; why: string };
}

// ── Checking what the owner typed ───────────────────────────────────────────

/**
 * An amount in AED ("1,250.5", "99.99" or a number) as whole fils, exactly: the digits are read as
 * text, so 0.1 + 0.2 never becomes 0.30000000000000004. More than two decimals, zero, negative or
 * over AED 10,000,000: refused.
 */
export function parseAmountFils(value: unknown): number {
  let fils: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new HttpError(400, 'Amount must be a number.');
    fils = Math.round(value * 100);
    if (Math.abs(value * 100 - fils) > 1e-6) throw new HttpError(400, 'Amount can have at most 2 decimals.');
  } else if (typeof value === 'string') {
    const m = /^(\d{1,8})(?:\.(\d{0,2}))?$/.exec(value.trim().replace(/[,\s]/g, ''));
    if (!m) throw new HttpError(400, 'Amount must be a number in AED, like 125 or 99.50 (at most 2 decimals).');
    fils = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  } else {
    throw new HttpError(400, 'Amount is required.');
  }
  if (fils < 1) throw new HttpError(400, 'Amount must be more than zero.');
  if (fils > MAX_FILS) throw new HttpError(400, 'Amount is too large.');
  return fils;
}

/** A calendar date (YYYY-MM-DD), from 2015 to tomorrow in the UAE. */
export function parseDate(value: unknown, field = 'Date'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, `${field} must be a date (YYYY-MM-DD).`);
  const t = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== value) throw new HttpError(400, `${field} is not a real date.`);
  if (value < '2015-01-01' || value > uaeDate(Date.now(), 1)) throw new HttpError(400, `${field} must be between 2015 and today.`);
  return value;
}

/** A name as stored and compared: NFKC (full-width and look-alike forms folded), no invisible format characters, single spaces. */
export function normalName(s: string): string {
  return s.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

function plain(value: unknown, field: string, max: number, { required = false } = {}): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const s = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long (at most ${max} characters).`);
  return s;
}

// ── Categories ──────────────────────────────────────────────────────────────

export interface ExpenseCategory {
  id: string;
  name: string;
}

export function listCategories(): ExpenseCategory[] {
  return getDb().prepare('SELECT id, name FROM expense_categories ORDER BY position, name').all() as ExpenseCategory[];
}

function categoryName(id: unknown): { id: string; name: string } {
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(id)) throw new HttpError(400, 'Choose a category from the list.');
  const row = getDb().prepare('SELECT id, name FROM expense_categories WHERE id = ?').get(id) as ExpenseCategory | undefined;
  if (!row) throw new HttpError(400, 'Choose a category from the list.');
  return row;
}

/** The owner's own category ("Photography"): added to the list (a name already there is that one). */
export function addCategory(name: unknown, actor: string): ExpenseCategory {
  const clean = normalName(plain(name, 'Category', 40, { required: true }));
  if (!clean) throw new HttpError(400, 'Category is required.');
  const same = (a: string) => normalName(a).toLowerCase() === clean.toLowerCase();
  return auditedTransaction((auditOrThrow) => {
    // "Packaging", "PACKAGING", "Ｐａｃｋａｇｉｎｇ" and "Pack\u200baging" are the same category.
    const existing = (getDb().prepare('SELECT id, name FROM expense_categories').all() as ExpenseCategory[]).find((c) => same(c.name));
    if (existing) return existing;
    const count = getDb().prepare('SELECT COUNT(*) FROM expense_categories').pluck().get() as number;
    if (count >= 60) throw new HttpError(409, 'There are already 60 categories.');
    const slug = clean.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'cat';
    const id = `${slug}_${crypto.randomBytes(3).toString('hex')}`;
    getDb().prepare('INSERT INTO expense_categories (id, name, position, created_at, created_by) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM expense_categories), ?, ?)').run(id, clean, new Date().toISOString(), actor);
    auditOrThrow('expense.category_added', { by: actor, categoryId: id, name: clean });
    return { id, name: clean };
  });
}

// ── Expenses ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  spent_on: string;
  amount_fils: number;
  category_id: string;
  category: string;
  payee: string;
  method: string;
  note: string;
  vat_fils: number | null;
  supplier_trn: string | null;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  removed_at: string | null;
  removed_by: string | null;
  removed_why: string | null;
}

interface BillRow {
  id: string;
  expense_id: string;
  ext: BillExt;
  mime: string;
  size: number;
  sha256: string;
  original_name: string;
  added_at: string;
  added_by: string;
  removed_at: string | null;
  removed_by: string | null;
  removed_why: string | null;
}

const SELECT = 'SELECT e.*, c.name AS category FROM expenses e JOIN expense_categories c ON c.id = e.category_id';

function billOf(r: BillRow): ExpenseBill {
  return {
    id: r.id,
    expenseId: r.expense_id,
    ext: r.ext,
    mime: isBillExt(r.ext) ? MIME[r.ext] : 'application/octet-stream',
    size: r.size,
    sha256: r.sha256,
    name: r.original_name,
    addedAt: r.added_at,
    addedBy: r.added_by,
    ...(r.removed_at ? { removed: { at: r.removed_at, by: r.removed_by ?? '', why: r.removed_why ?? '' } } : {}),
    url: `/api/admin/expenses/${r.expense_id}/bills/${r.id}`,
  };
}

function fromRow(r: Row, bills: BillRow[]): Expense {
  return {
    id: r.id,
    date: r.spent_on,
    amountFils: r.amount_fils,
    categoryId: r.category_id,
    category: r.category,
    payee: r.payee,
    method: r.method as ExpenseMethod,
    note: r.note,
    ...(r.vat_fils ? { vatFils: r.vat_fils } : {}),
    ...(r.supplier_trn ? { supplierTrn: r.supplier_trn } : {}),
    version: r.version,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    ...(r.removed_at ? { removed: { at: r.removed_at, by: r.removed_by ?? '', why: r.removed_why ?? '' } } : {}),
    bills: bills.map(billOf),
  };
}

function snapshot(e: Expense): Snapshot {
  return { date: e.date, amountFils: e.amountFils, categoryId: e.categoryId, category: e.category, payee: e.payee, method: e.method, note: e.note, ...(e.vatFils ? { vatFils: e.vatFils } : {}), ...(e.supplierTrn ? { supplierTrn: e.supplierTrn } : {}), ...(e.removed ? { removed: e.removed } : {}) };
}

export function getExpense(id: string): Expense | undefined {
  if (typeof id !== 'string' || !/^EXP-[A-Z0-9-]{4,30}$/.test(id)) return undefined;
  const row = getDb().prepare(`${SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
  if (!row) return undefined;
  return fromRow(row, getDb().prepare('SELECT * FROM expense_bills WHERE expense_id = ? ORDER BY added_at, id').all(id) as BillRow[]);
}

/** Expenses dated from..to (inclusive, UAE dates), newest first; removed ones only when asked. */
export function listExpenses({ from, to, includeRemoved = false, limit = 2000 }: { from?: string; to?: string; includeRemoved?: boolean; limit?: number } = {}): Expense[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (from) {
    where.push('e.spent_on >= ?');
    args.push(from);
  }
  if (to) {
    where.push('e.spent_on <= ?');
    args.push(to);
  }
  if (!includeRemoved) where.push('e.removed_at IS NULL');
  const rows = getDb()
    .prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.spent_on DESC, e.created_at DESC LIMIT ?`)
    .all(...args, Math.min(Math.max(1, limit), 1_000_000)) as Row[];
  if (!rows.length) return [];
  const bills = new Map<string, BillRow[]>();
  const stmt = getDb().prepare('SELECT * FROM expense_bills WHERE expense_id = ? ORDER BY added_at, id');
  for (const r of rows) bills.set(r.id, stmt.all(r.id) as BillRow[]);
  return rows.map((r) => fromRow(r, bills.get(r.id) ?? []));
}

export interface ExpenseTotals {
  count: number;
  fils: number;
  byCategory: Array<{ id: string; name: string; count: number; fils: number }>;
  byMethod: Record<string, { count: number; fils: number }>;
}

/** The totals of the expenses dated from..to (removed ones left out), summed by the database: every one of them, however many. */
export function expenseTotals({ from, to }: { from: string; to: string }): ExpenseTotals {
  const rows = getDb()
    .prepare('SELECT e.category_id AS id, c.name AS name, e.method AS method, COUNT(*) AS n, SUM(e.amount_fils) AS f FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.removed_at IS NULL AND e.spent_on >= ? AND e.spent_on <= ? GROUP BY e.category_id, e.method')
    .all(from, to) as Array<{ id: string; name: string; method: string; n: number; f: number }>;
  const cats = new Map<string, { id: string; name: string; count: number; fils: number }>();
  const byMethod: Record<string, { count: number; fils: number }> = {};
  let count = 0;
  let fils = 0;
  for (const r of rows) {
    count += r.n;
    fils += r.f;
    const c = cats.get(r.id) ?? { id: r.id, name: r.name, count: 0, fils: 0 };
    c.count += r.n;
    c.fils += r.f;
    cats.set(r.id, c);
    const m = (byMethod[r.method] ??= { count: 0, fils: 0 });
    m.count += r.n;
    m.fils += r.f;
  }
  return { count, fils, byCategory: [...cats.values()].sort((a, b) => b.fils - a.fils || a.name.localeCompare(b.name)), byMethod };
}

/** How many bills (not taken off) the expenses dated from..to (not removed) have. */
export function activeBillCount({ from, to }: { from: string; to: string }): number {
  return getDb()
    .prepare('SELECT COUNT(*) FROM expense_bills b JOIN expenses e ON e.id = b.expense_id WHERE b.removed_at IS NULL AND e.removed_at IS NULL AND e.spent_on >= ? AND e.spent_on <= ?')
    .pluck()
    .get(from, to) as number;
}

/** The bytes of those bills (to know the export's size before making it). */
export function activeBillBytes({ from, to }: { from: string; to: string }): number {
  return getDb()
    .prepare('SELECT COALESCE(SUM(b.size), 0) FROM expense_bills b JOIN expenses e ON e.id = b.expense_id WHERE b.removed_at IS NULL AND e.removed_at IS NULL AND e.spent_on >= ? AND e.spent_on <= ?')
    .pluck()
    .get(from, to) as number;
}

/**
 * Every expense (dated from..to when given), oldest first, a page of `pageSize` at a time from the
 * database (for the accountant's ZIP and the backups: all of them, never a capped list in memory).
 */
export function* iterExpenses({ from, to, includeRemoved = false, pageSize = 500 }: { from?: string; to?: string; includeRemoved?: boolean; pageSize?: number } = {}): Generator<Expense> {
  const where: string[] = ['(e.spent_on, e.created_at, e.id) > (?, ?, ?)'];
  const args: unknown[] = [];
  if (from) {
    where.push('e.spent_on >= ?');
    args.push(from);
  }
  if (to) {
    where.push('e.spent_on <= ?');
    args.push(to);
  }
  if (!includeRemoved) where.push('e.removed_at IS NULL');
  const page = getDb().prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY e.spent_on, e.created_at, e.id LIMIT ?`);
  const billsOf = getDb().prepare('SELECT * FROM expense_bills WHERE expense_id IN (SELECT value FROM json_each(?)) ORDER BY added_at, id');
  let after: [string, string, string] = ['', '', ''];
  for (;;) {
    const rows = page.all(...after, ...args, pageSize) as Row[];
    if (!rows.length) return;
    const bills = new Map<string, BillRow[]>();
    for (const b of billsOf.all(JSON.stringify(rows.map((r) => r.id))) as BillRow[]) bills.set(b.expense_id, [...(bills.get(b.expense_id) ?? []), b]);
    for (const r of rows) yield fromRow(r, bills.get(r.id) ?? []);
    const last = rows[rows.length - 1];
    after = [last.spent_on, last.created_at, last.id];
    if (rows.length < pageSize) return;
  }
}

export function expenseVersions(id: string): ExpenseVersion[] {
  return (getDb().prepare('SELECT version, change, at, by, data FROM expense_versions WHERE expense_id = ? ORDER BY version').all(id) as Array<Omit<ExpenseVersion, 'data'> & { data: string }>).map((v) => ({ ...v, data: JSON.parse(v.data) as Snapshot }));
}

function keepVersion(e: Expense, change: ExpenseVersion['change'], actor: string): void {
  getDb().prepare('INSERT INTO expense_versions (expense_id, version, change, data, at, by) VALUES (?, ?, ?, ?, ?, ?)').run(e.id, e.version, change, JSON.stringify(snapshot(e)), e.updatedAt, actor);
}

const FIELDS = ['date', 'amount', 'categoryId', 'payee', 'method', 'note', 'vat', 'supplierTrn'] as const;

function readFields(body: Record<string, unknown>, base?: Expense) {
  const has = (k: string) => body[k] !== undefined;
  const method = has('method') ? body.method : base?.method;
  if (!EXPENSE_METHODS.includes(method as ExpenseMethod)) throw new HttpError(400, 'Payment method must be cash, card, bank transfer or other.');
  const category = categoryName(has('categoryId') ? body.categoryId : base?.categoryId);
  const amountFils = has('amount') || !base ? parseAmountFils(body.amount) : base.amountFils;
  // The VAT on the bill (optional; empty clears it): at most the amount itself.
  const vatFils = has('vat') ? (body.vat === '' || body.vat === null ? 0 : parseAmountFils(body.vat)) : (base?.vatFils ?? 0);
  if (vatFils > amountFils) throw new HttpError(400, 'The VAT can’t be more than the amount.');
  const supplierTrn = has('supplierTrn') ? (body.supplierTrn === '' || body.supplierTrn === null ? '' : supplierTrnOf(body.supplierTrn)) : (base?.supplierTrn ?? '');
  return {
    date: has('date') || !base ? parseDate(body.date) : base.date,
    amountFils,
    categoryId: category.id,
    category: category.name,
    payee: has('payee') ? plain(body.payee, 'Paid to', 120) : (base?.payee ?? ''),
    method: method as ExpenseMethod,
    note: has('note') ? plain(body.note, 'Note', 1000) : (base?.note ?? ''),
    vatFils,
    supplierTrn,
  };
}

/** A supplier's TRN: 15 digits (spaces and dashes between groups dropped). */
function supplierTrnOf(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Supplier TRN must be text.');
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{15}$/.test(digits)) throw new HttpError(400, 'Supplier TRN must be 15 digits (from their tax invoice).');
  return digits;
}

function newExpenseId(date: string): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  return `EXP-${date.slice(2).replace(/-/g, '')}-${random}`;
}

/**
 * A new expense: { date, amount, categoryId, payee?, method, note? }. One idempotency key makes at
 * most one expense (a double tap, or a retry after a lost answer, returns the first).
 */
export function createExpense(body: Record<string, unknown>, actor: string, idempotencyKey?: string): { expense: Expense; created: boolean } {
  const key = idempotencyKey === undefined ? null : plain(idempotencyKey, 'Key', 80, { required: true });
  const f = readFields(body);
  return auditedTransaction((auditOrThrow) => {
    if (key) {
      const prior = getDb().prepare('SELECT id FROM expenses WHERE idempotency_key = ?').pluck().get(key) as string | undefined;
      if (prior) return { expense: getExpense(prior)!, created: false };
    }
    const id = newExpenseId(f.date);
    const now = new Date().toISOString();
    getDb()
      .prepare('INSERT INTO expenses (id, spent_on, amount_fils, category_id, payee, method, note, vat_fils, supplier_trn, version, idempotency_key, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
      .run(id, f.date, f.amountFils, f.categoryId, f.payee, f.method, f.note, f.vatFils || null, f.supplierTrn || null, key, now, actor, now, actor);
    const expense = getExpense(id)!;
    keepVersion(expense, 'created', actor);
    auditOrThrow('expense.created', { by: actor, expenseId: id, after: snapshot(expense) });
    return { expense, created: true };
  });
}

/**
 * Change an expense. `version` must be the one the owner saw (two phones editing at once: the second
 * is told to refresh, nothing is lost). The earlier state stays in expense_versions.
 */
export function updateExpense(id: string, body: Record<string, unknown>, actor: string): Expense {
  if (!Number.isInteger(body.version)) throw new HttpError(400, 'version is required (the one you saw).');
  const changes = Object.fromEntries(Object.entries(body).filter(([k]) => (FIELDS as readonly string[]).includes(k)));
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
  return auditedTransaction((auditOrThrow) => {
    const before = getExpense(id);
    if (!before) throw new HttpError(404, 'Expense not found.');
    if (before.removed) throw new HttpError(409, 'This expense was removed: it can no longer be changed.');
    if (before.version !== body.version) throw new HttpError(409, 'This expense was changed meanwhile (on another device?): refresh and try again.', {}, { code: 'expense_changed' });
    const f = readFields(changes, before);
    const was = snapshot(before);
    const now_ = { ...f, vatFils: f.vatFils || undefined, supplierTrn: f.supplierTrn || undefined };
    const diff = Object.fromEntries(
      (['date', 'amountFils', 'categoryId', 'payee', 'method', 'note', 'vatFils', 'supplierTrn'] as const).filter((k) => was[k] !== now_[k]).map((k) => [k, { from: was[k] ?? '', to: now_[k] ?? '' }])
    );
    if (!Object.keys(diff).length) return before;
    const now = new Date().toISOString();
    getDb()
      .prepare('UPDATE expenses SET spent_on = ?, amount_fils = ?, category_id = ?, payee = ?, method = ?, note = ?, vat_fils = ?, supplier_trn = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
      .run(f.date, f.amountFils, f.categoryId, f.payee, f.method, f.note, f.vatFils || null, f.supplierTrn || null, now, actor, id, before.version);
    const after = getExpense(id)!;
    keepVersion(after, 'edited', actor);
    auditOrThrow('expense.edited', { by: actor, expenseId: id, version: after.version, changes: diff, before: was, after: snapshot(after) });
    return after;
  });
}

/** "Remove": out of the totals, kept in the books (who, when, why; every version and bill kept). */
export function removeExpense(id: string, why: unknown, actor: string): Expense {
  const reason = plain(why, 'Reason', 300, { required: true });
  return auditedTransaction((auditOrThrow) => {
    const before = getExpense(id);
    if (!before) throw new HttpError(404, 'Expense not found.');
    if (before.removed) return before;
    const now = new Date().toISOString();
    getDb().prepare('UPDATE expenses SET removed_at = ?, removed_by = ?, removed_why = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND removed_at IS NULL').run(now, actor, reason, now, actor, id);
    const after = getExpense(id)!;
    keepVersion(after, 'removed', actor);
    auditOrThrow('expense.removed', { by: actor, expenseId: id, why: reason, before: snapshot(before) });
    return after;
  });
}

// ── Bills ───────────────────────────────────────────────────────────────────

export const BILL_EXTS = ['jpg', 'png', 'webp', 'heic', 'pdf'] as const;
export type BillExt = (typeof BILL_EXTS)[number];
/** The type each kind of bill is served as: fixed here, never what the database or the browser says. */
export const BILL_MIME: Readonly<Record<BillExt, string>> = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' });
const MIME = BILL_MIME;
const isBillExt = (ext: unknown): ext is BillExt => typeof ext === 'string' && (BILL_EXTS as readonly string[]).includes(ext);
/** A bill's id: 24 hex characters (also its file's name, with its extension). */
const BILL_ID = /^[a-f0-9]{24}$/;
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);

export function expensesDir(): string {
  const dir = path.join(dataDir(), 'expenses');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** What a bill really is, from its first bytes (never its name or the type the browser said), or null. */
export function sniffBill(bytes: Buffer): { ext: BillExt; mime: string } | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: MIME.jpg };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: MIME.png };
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: MIME.webp };
  if (bytes.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(bytes.toString('latin1', 8, 12))) return { ext: 'heic', mime: MIME.heic };
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: MIME.pdf };
  return null;
}

/**
 * A photo without its metadata (EXIF with GPS and the camera, XMP, IPTC, comments, text chunks),
 * pixels untouched. JPEG keeps JFIF, the colour profile and Adobe's colour marker; PNG keeps
 * everything but text, EXIF and time; WebP loses its EXIF and XMP chunks. Throws 400 if the file's
 * structure can't be read (a damaged or disguised file is refused, not stored).
 */
export function stripImageMetadata(bytes: Buffer, ext: BillExt): Buffer {
  const bad = () => new HttpError(400, 'This photo could not be read. Please take it again or upload a JPEG, PNG or PDF.');
  if (ext === 'jpg') {
    const parts: Buffer[] = [bytes.subarray(0, 2)];
    let i = 2;
    for (;;) {
      if (i + 2 > bytes.length || bytes[i] !== 0xff) throw bad();
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd9) {
        // The end of the image: anything after it (a second picture, a depth map, hidden data) goes.
        parts.push(bytes.subarray(i, i + 2));
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        parts.push(bytes.subarray(i, i + 2));
        i += 2;
        continue;
      }
      if (i + 4 > bytes.length) throw bad();
      const len = bytes.readUInt16BE(i + 2);
      if (len < 2 || i + 2 + len > bytes.length) throw bad();
      // APP1 (EXIF, XMP), APP2's MPF (the extra pictures; the colour profile stays), APP3–APP13
      // (IPTC and makers' notes), APP15 and comments go.
      const mpf = marker === 0xe2 && bytes.toString('latin1', i + 4, i + 8) === 'MPF\0';
      const drop = marker === 0xe1 || mpf || (marker >= 0xe3 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
      if (!drop) parts.push(bytes.subarray(i, i + 2 + len));
      i += 2 + len;
      if (marker === 0xda) {
        // The scan's data, up to the next marker (0xFF00 is a stuffed byte, 0xFFD0–D7 restarts).
        const from = i;
        while (i + 1 < bytes.length && !(bytes[i] === 0xff && bytes[i + 1] !== 0x00 && !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7))) i++;
        if (i + 1 >= bytes.length) throw bad();
        parts.push(bytes.subarray(from, i));
      }
    }
    return Buffer.concat(parts);
  }
  if (ext === 'png') {
    const parts: Buffer[] = [bytes.subarray(0, 8)];
    let i = 8;
    for (;;) {
      if (i + 12 > bytes.length) throw bad();
      const len = bytes.readUInt32BE(i);
      const type = bytes.toString('latin1', i + 4, i + 8);
      const end = i + 12 + len;
      if (end > bytes.length) throw bad();
      if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) parts.push(bytes.subarray(i, end));
      i = end;
      if (type === 'IEND') break;
    }
    return Buffer.concat(parts);
  }
  if (ext === 'webp') {
    const parts: Buffer[] = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
      const fourcc = bytes.toString('latin1', i, i + 4);
      const size = bytes.readUInt32LE(i + 4);
      const end = i + 8 + size + (size % 2);
      if (i + 8 + size > bytes.length) throw bad();
      if (fourcc === 'VP8X') {
        const chunk = Buffer.from(bytes.subarray(i, Math.min(end, bytes.length)));
        chunk[8] &= ~(0x08 | 0x04); // no EXIF, no XMP
        parts.push(chunk);
      } else if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
        parts.push(bytes.subarray(i, Math.min(end, bytes.length)));
      }
      i = end;
    }
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length + 4, 4);
    head.write('WEBP', 8, 'latin1');
    return Buffer.concat([head, body]);
  }
  return bytes;
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+)?;base64,([A-Za-z0-9+/]+={0,2})$/;

/** A bill sent by the hub (a data URL), checked: real type by its bytes, under the size cap, photos without metadata. */
export function parseBill(file: unknown): { ext: BillExt; mime: string; bytes: Buffer } {
  const m = typeof file === 'string' ? DATA_URL.exec(file) : null;
  if (!m) throw new HttpError(400, 'Attach a photo (JPEG, PNG, WebP or HEIC) or a PDF of the bill.');
  if (m[2].length * 0.75 > BILL_LIMITS.fileBytes + 3) throw new HttpError(413, `The bill is too large (at most ${BILL_LIMITS.fileBytes / 1024 ** 2} MB).`);
  const raw = Buffer.from(m[2], 'base64');
  if (raw.length > BILL_LIMITS.fileBytes) throw new HttpError(413, `The bill is too large (at most ${BILL_LIMITS.fileBytes / 1024 ** 2} MB).`);
  const kind = sniffBill(raw);
  if (!kind) throw new HttpError(400, 'This file is not a photo (JPEG, PNG, WebP or HEIC) or a PDF.');
  return { ...kind, bytes: stripImageMetadata(raw, kind.ext) };
}

/** Attach a bill to an expense (kept even if the expense is later removed). Audited before it counts. */
export function attachBill(expenseId: string, file: unknown, name: unknown, actor: string): ExpenseBill {
  const bill = parseBill(file);
  const original = normalName(plain(name, 'File name', 120)).replace(/[\\/]/g, '_');
  const expense = getExpense(expenseId);
  if (!expense) throw new HttpError(404, 'Expense not found.');
  if (expense.removed) throw new HttpError(409, 'This expense was removed: no more bills can be added.');
  const sha256 = crypto.createHash('sha256').update(bill.bytes).digest('hex');
  // The same file again (a retry after a lost answer, a double tap): the bill already there.
  const same = sameBill(expenseId, sha256);
  if (same) return billOf(same);
  if (expense.bills.filter((b) => !b.removed).length >= BILL_LIMITS.perExpense) throw new HttpError(409, `An expense can have at most ${BILL_LIMITS.perExpense} bills.`);
  const dir = expensesDir();
  const room = folderRoomProblem(dir, bill.bytes.length, BILL_LIMITS, 'bills');
  if (room) {
    logEvent('warn', 'bill_refused_no_room', { expenseId, why: room });
    throw new HttpError(507, `The bill can't be stored right now: ${room}. Free some space on the server and try again.`, {}, { code: 'no_room' });
  }
  const id = crypto.randomBytes(12).toString('hex');
  const fresh = path.join(dir, `${id}.${bill.ext}.${process.pid}.tmp`);
  const final = path.join(dir, `${id}.${bill.ext}`);
  fs.writeFileSync(fresh, bill.bytes, { mode: 0o600 });
  let placed = false;
  try {
    // The file is put in place inside the transaction, before COMMIT: a row is never without its
    // file, and if the commit fails the file goes again (no file without a row either).
    const kept = auditedTransaction((auditOrThrow) => {
      const now = getExpense(expenseId);
      if (!now || now.removed) throw new HttpError(409, 'This expense was removed: no more bills can be added.');
      const twin = sameBill(expenseId, sha256);
      if (twin) return twin;
      if (now.bills.filter((b) => !b.removed).length >= BILL_LIMITS.perExpense) throw new HttpError(409, `An expense can have at most ${BILL_LIMITS.perExpense} bills.`);
      getDb()
        .prepare('INSERT INTO expense_bills (id, expense_id, ext, mime, size, sha256, original_name, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, expenseId, bill.ext, MIME[bill.ext], bill.bytes.length, sha256, original, new Date().toISOString(), actor);
      auditOrThrow('expense.bill_added', { by: actor, expenseId, billId: id, type: bill.ext, size: bill.bytes.length, sha256 });
      fs.renameSync(fresh, final);
      placed = true;
      return null;
    });
    if (kept) {
      fs.rmSync(fresh, { force: true });
      return billOf(kept);
    }
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    if (placed) fs.rmSync(final, { force: true });
    throw err;
  }
  return billOf(getDb().prepare('SELECT * FROM expense_bills WHERE id = ?').get(id) as BillRow);
}

/** A bill of this expense (not taken off) with exactly these bytes, if there is one. */
function sameBill(expenseId: string, sha256: string): BillRow | undefined {
  return getDb().prepare('SELECT * FROM expense_bills WHERE expense_id = ? AND sha256 = ? AND removed_at IS NULL ORDER BY added_at, id LIMIT 1').get(expenseId, sha256) as BillRow | undefined;
}

/** Take a bill off an expense (a wrong photo): marked removed, its file kept. */
export function removeBill(expenseId: string, billId: string, why: unknown, actor: string): ExpenseBill {
  const reason = plain(why, 'Reason', 300, { required: true });
  return auditedTransaction((auditOrThrow) => {
    const row = getDb().prepare('SELECT * FROM expense_bills WHERE id = ? AND expense_id = ?').get(billId, expenseId) as BillRow | undefined;
    if (!row) throw new HttpError(404, 'Bill not found.');
    if (!row.removed_at) {
      getDb().prepare('UPDATE expense_bills SET removed_at = ?, removed_by = ?, removed_why = ? WHERE id = ? AND removed_at IS NULL').run(new Date().toISOString(), actor, reason, billId);
      auditOrThrow('expense.bill_removed', { by: actor, expenseId, billId, why: reason, sha256: row.sha256 });
    }
    return billOf(getDb().prepare('SELECT * FROM expense_bills WHERE id = ?').get(billId) as BillRow);
  });
}

/** A bill's bytes (removed ones too: the books keep them), or null. */
export function readBill(expenseId: string, billId: string): { bytes: Buffer; mime: string; ext: BillExt } | null {
  if (!BILL_ID.test(billId)) return null;
  const row = getDb().prepare('SELECT ext FROM expense_bills WHERE id = ? AND expense_id = ?').get(billId, expenseId) as { ext: string } | undefined;
  // Only the five kinds of bill, served as the type that kind always has (never the stored one).
  if (!row || !isBillExt(row.ext)) return null;
  try {
    return { bytes: fs.readFileSync(path.join(expensesDir(), `${billId}.${row.ext}`)), mime: MIME[row.ext], ext: row.ext };
  } catch {
    return null;
  }
}

/** The bill's file on disk (for the accountant's ZIP, read one at a time); refuses an id or extension that isn't a bill's. */
export function billFile(bill: { id: string; ext: string }): string {
  if (!BILL_ID.test(bill.id) || !isBillExt(bill.ext)) throw new Error('Not a bill.');
  return path.join(expensesDir(), `${bill.id}.${bill.ext}`);
}

// ── Flat files ──────────────────────────────────────────────────────────────

export const EXPENSE_CSV_HEADERS = ['expense_id', 'date', 'category', 'paid_to', 'method', 'amount_aed', 'note', 'bills', 'status', 'removed_at', 'removed_by', 'removed_reason', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by', 'vat_aed', 'supplier_trn'];

export function expenseCsvRow(e: Expense, billNames: string[] = e.bills.filter((b) => !b.removed).map((b) => `${b.id}.${b.ext}`)): unknown[] {
  return [
    e.id, e.date, e.category, e.payee, METHOD_LABELS[e.method], aedText(e.amountFils), e.note, billNames.join('; '),
    e.removed ? 'removed' : 'active', e.removed?.at ?? '', e.removed?.by ?? '', e.removed?.why ?? '',
    e.version, e.createdAt, e.createdBy, e.updatedAt, e.updatedBy,
    e.vatFils ? aedText(e.vatFils) : '', e.supplierTrn ?? '',
  ];
}

/** For backups: every expense (removed ones too) and every bill, as Excel-safe CSV. */
export function expenseCsvFiles(): TarEntry[] {
  const bills = getDb().prepare('SELECT * FROM expense_bills ORDER BY added_at, id').all() as BillRow[];
  let expenses = csvHead(EXPENSE_CSV_HEADERS);
  for (const e of iterExpenses({ includeRemoved: true })) expenses += csvRow(expenseCsvRow(e));
  return [
    { name: 'expenses.csv', data: Buffer.from(expenses) },
    {
      name: 'expense_bills.csv',
      data: Buffer.from(toCsv(
        ['bill_id', 'expense_id', 'file', 'type', 'bytes', 'sha256', 'original_name', 'added_at', 'added_by', 'removed_at', 'removed_by', 'removed_reason'],
        bills.map((b) => [b.id, b.expense_id, `expenses/${b.id}.${b.ext}`, b.mime, b.size, b.sha256, b.original_name, b.added_at, b.added_by, b.removed_at ?? '', b.removed_by ?? '', b.removed_why ?? ''])
      )),
    },
  ];
}
