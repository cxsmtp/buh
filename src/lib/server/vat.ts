import { dubaiDateOf, dubaiToday } from '@/lib/reportPeriods';
import { UAE_VAT_PERCENT, vatInsideFils, vatOnTopFils } from '@/lib/money';
import type { Order } from '@/types';
import { audit, auditOrThrow } from './audit';
import { aedText, toCsv } from './csv';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { getSettings } from './settings';

/**
 * UAE VAT: opt-in, off by default (the shop is not VAT-registered; the 12-month sales are watched
 * against the AED 375,000 threshold in reports.ts). Switched on in Settings → Payments → VAT with
 * the TRN, an effective date and a typed confirmation (audited).
 *
 *  - From the effective date (UAE date), each order placed stores its VAT breakdown in fils, worked
 *    out here on the server (order_vat): prices include VAT by default, so VAT = round(total × 5/105);
 *    with "prices exclude VAT" the 5% is added on top at checkout. Delivery, the cash-on-delivery fee
 *    and the card fee are part of the same supply: the same rate, the same rounding. The VAT is
 *    worked out once on the total and shared across the lines so they add up exactly.
 *  - Orders from before the date (or placed while VAT was off) never get VAT: nothing is rewritten.
 *  - A tax invoice number is issued from one gap-free series (INV-000001, …) when the order becomes
 *    a supply: a card payment taken (live mode), or any other order confirmed, paid or sent. The
 *    number is the next one, taken inside an IMMEDIATE transaction (one writer at a time across
 *    every running copy of the shop), so there are no gaps and no doubles.
 *  - Refunds after an invoice (the card refunds ledger) and cancelling an invoiced order give credit
 *    notes (CN-000001, …) linked to the invoice, also gap-free; a refund that failed afterwards gives
 *    a negative one. syncVatDocuments() brings an order's documents in line with its state, and is
 *    idempotent: run on every order change, and again before any VAT figure is shown.
 *  - The VAT return helper sums a period: standard-rated sales and output VAT (invoices), the credit
 *    notes, and input VAT from expenses that carry a VAT amount; CSV for the accountant.
 */

export interface VatSettings {
  enabled: boolean;
  /** Tax Registration Number: 15 digits. */
  trn: string;
  ratePercent: number;
  /** UAE consumer prices are shown including VAT: true by default. */
  pricesIncludeVat: boolean;
  /** UAE date (YYYY-MM-DD) from which orders carry VAT. */
  effectiveFrom: string;
  /** The supplier's name on tax invoices (the registered legal name); the shop's name when empty. */
  legalName: string;
  /** The supplier's address on tax invoices; Settings → Store's address when empty. */
  address: string;
  changedAt?: string;
  changedBy?: string;
}

export const DEFAULT_VAT: VatSettings = { enabled: false, trn: '', ratePercent: UAE_VAT_PERCENT, pricesIncludeVat: true, effectiveFrom: '', legalName: '', address: '' };
export const VAT_CONFIRM_PHRASE = 'TURN ON VAT';
const KEY = 'vat:settings';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function vatSettings(): VatSettings {
  const raw = kvGet<Partial<VatSettings>>(KEY)?.data;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_VAT };
  return {
    enabled: raw.enabled === true,
    trn: typeof raw.trn === 'string' ? raw.trn : '',
    ratePercent: UAE_VAT_PERCENT,
    pricesIncludeVat: raw.pricesIncludeVat !== false,
    effectiveFrom: typeof raw.effectiveFrom === 'string' && DATE.test(raw.effectiveFrom) ? raw.effectiveFrom : '',
    legalName: typeof raw.legalName === 'string' ? raw.legalName : '',
    address: typeof raw.address === 'string' ? raw.address : '',
    ...(raw.changedAt ? { changedAt: String(raw.changedAt) } : {}),
    ...(raw.changedBy ? { changedBy: String(raw.changedBy) } : {}),
  };
}

/** A TRN: exactly 15 digits (spaces and dashes typed between groups are dropped). */
export function cleanTrn(value: unknown, field = 'TRN'): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const digits = value.replace(/[\s-]/g, '');
  if (!/^\d{15}$/.test(digits)) throw new HttpError(400, `${field} must be 15 digits (the Tax Registration Number on the FTA certificate).`);
  if (/^(\d)\1{14}$/.test(digits)) throw new HttpError(400, `${field} is not a real TRN.`);
  return digits;
}

function plainText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be text.`);
  const s = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, `${field} is too long (at most ${max} characters).`);
  return s;
}

const FIELDS = ['enabled', 'trn', 'pricesIncludeVat', 'effectiveFrom', 'legalName', 'address', 'confirm', 'ratePercent'];

/**
 * Save Settings → Payments → VAT. Turning it on needs the TRN, the effective date (today or later:
 * orders already placed are never changed) and the typed confirmation "TURN ON VAT". While it is on,
 * the TRN and the date can't be changed (turn it off first); the name, address and the price mode can.
 * Every change is audited before it counts.
 */
export function saveVatSettings(body: Record<string, unknown>, by: string, now = Date.now()): VatSettings {
  const extra = Object.keys(body).filter((k) => !FIELDS.includes(k));
  if (extra.length) throw new HttpError(400, `Unexpected field: ${extra[0].slice(0, 40)}.`);
  if (body.ratePercent !== undefined && body.ratePercent !== UAE_VAT_PERCENT) throw new HttpError(400, 'The UAE VAT rate is 5%.');
  const before = vatSettings();
  const enabled = body.enabled === undefined ? before.enabled : body.enabled === true ? true : body.enabled === false ? false : (() => { throw new HttpError(400, 'enabled must be true or false.'); })();
  const next: VatSettings = {
    ...before,
    enabled,
    pricesIncludeVat: body.pricesIncludeVat === undefined ? before.pricesIncludeVat : body.pricesIncludeVat !== false,
    legalName: body.legalName === undefined ? before.legalName : plainText(body.legalName, 'Legal name', 120),
    address: body.address === undefined ? before.address : plainText(body.address, 'Address', 300),
    trn: body.trn === undefined ? before.trn : body.trn === '' ? '' : cleanTrn(body.trn),
    effectiveFrom: body.effectiveFrom === undefined ? before.effectiveFrom : body.effectiveFrom === '' ? '' : String(body.effectiveFrom),
  };
  if (typeof body.pricesIncludeVat !== 'undefined' && typeof body.pricesIncludeVat !== 'boolean') throw new HttpError(400, 'pricesIncludeVat must be true or false.');
  if (next.effectiveFrom && (!DATE.test(next.effectiveFrom) || new Date(`${next.effectiveFrom}T00:00:00Z`).toISOString().slice(0, 10) !== next.effectiveFrom)) throw new HttpError(400, 'The effective date must be a date (YYYY-MM-DD).');
  const today = dubaiToday(now);
  const turningOn = enabled && !before.enabled;
  if (enabled) {
    if (!next.trn) throw new HttpError(400, 'Type the TRN (15 digits) from your VAT registration certificate.');
    if (!next.effectiveFrom) throw new HttpError(400, 'Choose the date VAT starts (the effective date of your registration, or later).');
    if (!(next.address || getSettings('store').storeAddress)) throw new HttpError(400, 'Type the address for your tax invoices (or set it in Settings → Store & contact).');
    if (turningOn) {
      if (next.effectiveFrom < today) throw new HttpError(400, 'The effective date can’t be in the past: orders already placed are never changed. Talk to your accountant about earlier sales.');
      if (typeof body.confirm !== 'string' || body.confirm.trim().toUpperCase() !== VAT_CONFIRM_PHRASE) throw new HttpError(400, `To turn VAT on, type ${VAT_CONFIRM_PHRASE}.`, {}, { code: 'confirm_needed' });
    } else if (before.enabled && (next.trn !== before.trn || next.effectiveFrom !== before.effectiveFrom)) {
      throw new HttpError(409, 'Turn VAT off before changing the TRN or the effective date.');
    }
  }
  const changes = Object.fromEntries(
    (['enabled', 'trn', 'pricesIncludeVat', 'effectiveFrom', 'legalName', 'address'] as const).filter((k) => before[k] !== next[k]).map((k) => [k, { from: before[k], to: next[k] }])
  );
  if (!Object.keys(changes).length) return before;
  auditOrThrow(turningOn ? 'vat.enabled' : !enabled && before.enabled ? 'vat.disabled' : 'vat.settings_changed', { by, changes });
  const saved = { ...next, ratePercent: UAE_VAT_PERCENT, changedAt: new Date(now).toISOString(), changedBy: by };
  kvSet(KEY, saved);
  return saved;
}

/** VAT is on, and today (UAE) is on or after its effective date: a new order carries VAT. */
export interface VatPlan {
  rateBp: number;
  inclusive: boolean;
  supplier: { name: string; address: string; trn: string };
}

export function checkoutVat(now = Date.now()): VatPlan | null {
  const s = vatSettings();
  if (!s.enabled || !s.trn || !s.effectiveFrom || dubaiToday(now) < s.effectiveFrom) return null;
  return {
    rateBp: s.ratePercent * 100,
    inclusive: s.pricesIncludeVat,
    supplier: { name: s.legalName || getSettings('brand').storeName || 'Beautiful UAE Home', address: s.address || getSettings('store').storeAddress || '', trn: s.trn },
  };
}

/** For the storefront: the percent added on top at checkout (only with VAT on and prices excluding VAT). */
export function vatAddedPercent(now = Date.now()): number | null {
  const p = checkoutVat(now);
  return p && !p.inclusive ? p.rateBp / 100 : null;
}

// ── An order's breakdown ────────────────────────────────────────────────────

export interface VatLine {
  kind: 'item' | 'delivery' | 'cod_fee' | 'card_fee';
  label: string;
  quantity: number;
  /** The line as charged, VAT included. */
  totalFils: number;
  netFils: number;
  vatFils: number;
}

export interface VatBreakdown {
  rateBp: number;
  inclusive: boolean;
  netFils: number;
  vatFils: number;
  totalFils: number;
  lines: VatLine[];
}

/**
 * Share a VAT amount across lines in proportion to their amounts, so the shares add up exactly:
 * each gets its share rounded down, then the fils left go to the largest remainders (BigInt: no
 * float drift on large amounts).
 */
export function allocate(amounts: number[], vatFils: number): number[] {
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (!sum || !vatFils) return amounts.map(() => 0);
  const S = BigInt(sum);
  const V = BigInt(vatFils);
  const parts = amounts.map((a, i) => ({ i, q: (BigInt(a) * V) / S, r: (BigInt(a) * V) % S }));
  let left = vatFils - parts.reduce((n, p) => n + Number(p.q), 0);
  const out = parts.map((p) => Number(p.q));
  for (const p of [...parts].sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i))) {
    if (left <= 0) break;
    out[p.i]++;
    left--;
  }
  return out;
}

/**
 * The breakdown of an order's lines (amounts in fils as charged when inclusive, before VAT when
 * exclusive): VAT worked out once on the whole (round(total × 5/105), or round(net × 5%) added on
 * top), then shared across the lines.
 */
export function computeVat(lines: Array<Omit<VatLine, 'netFils' | 'vatFils' | 'totalFils'> & { amountFils: number }>, plan: Pick<VatPlan, 'rateBp' | 'inclusive'>): VatBreakdown {
  const rate = plan.rateBp / 100;
  const amounts = lines.map((l) => Math.round(l.amountFils));
  const sum = amounts.reduce((a, b) => a + b, 0);
  const vatFils = plan.inclusive ? vatInsideFils(sum, rate) : vatOnTopFils(sum, rate);
  const shares = allocate(amounts, vatFils);
  const out: VatLine[] = lines.map((l, i) => ({
    kind: l.kind,
    label: l.label,
    quantity: l.quantity,
    totalFils: plan.inclusive ? amounts[i] : amounts[i] + shares[i],
    netFils: plan.inclusive ? amounts[i] - shares[i] : amounts[i],
    vatFils: shares[i],
  }));
  const totalFils = plan.inclusive ? sum : sum + vatFils;
  return { rateBp: plan.rateBp, inclusive: plan.inclusive, netFils: totalFils - vatFils, vatFils, totalFils, lines: out };
}

const fils = (aed: number | undefined) => Math.round((aed ?? 0) * 100);

/** The VAT lines of an order as the server priced it (items, delivery, cash-on-delivery fee, card fee). */
export function orderVatLines(o: Pick<Order, 'items' | 'deliveryFee' | 'codFee' | 'cardFee' | 'cardFeePercent'>) {
  return [
    ...o.items.map((i) => ({ kind: 'item' as const, label: `${i.title} (${i.profileName}${i.color ? `, ${i.color}` : ''})`, quantity: i.quantity, amountFils: fils(i.totalPrice) })),
    ...(fils(o.deliveryFee) > 0 ? [{ kind: 'delivery' as const, label: 'Delivery', quantity: 1, amountFils: fils(o.deliveryFee) }] : []),
    ...(fils(o.codFee) > 0 ? [{ kind: 'cod_fee' as const, label: 'Cash-on-delivery fee', quantity: 1, amountFils: fils(o.codFee) }] : []),
    ...(fils(o.cardFee) > 0 ? [{ kind: 'card_fee' as const, label: `Card payment fee${o.cardFeePercent ? ` (${o.cardFeePercent}%)` : ''}`, quantity: 1, amountFils: fils(o.cardFee) }] : []),
  ];
}

/**
 * Store an order's breakdown when it is placed (in the placing transaction). Written once: an
 * order that has one keeps it. Then its documents are brought in line (an invoice if already due).
 */
export function recordOrderVat(order: Order, plan: VatPlan): VatBreakdown {
  const b = computeVat(orderVatLines(order), plan);
  if (b.totalFils !== fils(order.total)) throw new Error(`VAT breakdown ${b.totalFils} does not match the order total ${fils(order.total)}`);
  getDb()
    .prepare('INSERT INTO order_vat (order_id, rate_bp, inclusive, net_fils, vat_fils, total_fils, lines, supplier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING')
    .run(order.id, b.rateBp, b.inclusive ? 1 : 0, b.netFils, b.vatFils, b.totalFils, JSON.stringify(b.lines), JSON.stringify(plan.supplier), order.createdAt);
  syncVatDocuments(order.id);
  return b;
}

export interface OrderVat extends VatBreakdown {
  orderId: string;
  supplier: VatPlan['supplier'];
  createdAt: string;
}

interface VatRow {
  order_id: string;
  rate_bp: number;
  inclusive: number;
  net_fils: number;
  vat_fils: number;
  total_fils: number;
  lines: string;
  supplier: string;
  created_at: string;
}

export function orderVat(orderId: string): OrderVat | null {
  const r = getDb().prepare('SELECT * FROM order_vat WHERE order_id = ?').get(orderId) as VatRow | undefined;
  if (!r) return null;
  return { orderId: r.order_id, rateBp: r.rate_bp, inclusive: r.inclusive === 1, netFils: r.net_fils, vatFils: r.vat_fils, totalFils: r.total_fils, lines: JSON.parse(r.lines) as VatLine[], supplier: JSON.parse(r.supplier), createdAt: r.created_at };
}

// ── Invoices and credit notes ───────────────────────────────────────────────

export interface TaxInvoice {
  seq: number;
  number: string;
  orderId: string;
  issuedAt: string;
  issuedOn: string;
  netFils: number;
  vatFils: number;
  totalFils: number;
}

export interface CreditNote extends TaxInvoice {
  invoiceSeq: number;
  invoiceNumber: string;
  reason: 'refund' | 'cancelled' | 'refund_reversed' | 'reinstated';
}

const invoiceNumber = (seq: number) => `INV-${String(seq).padStart(6, '0')}`;
const creditNumber = (seq: number) => `CN-${String(seq).padStart(6, '0')}`;

function invoiceOf(r: { seq: number; number: string; order_id: string; issued_at: string; issued_on: string; net_fils: number; vat_fils: number; total_fils: number }): TaxInvoice {
  return { seq: r.seq, number: r.number, orderId: r.order_id, issuedAt: r.issued_at, issuedOn: r.issued_on, netFils: r.net_fils, vatFils: r.vat_fils, totalFils: r.total_fils };
}

export function invoiceFor(orderId: string): TaxInvoice | null {
  const r = getDb().prepare('SELECT * FROM vat_invoices WHERE order_id = ?').get(orderId) as Parameters<typeof invoiceOf>[0] | undefined;
  return r ? invoiceOf(r) : null;
}

export function creditNotesFor(orderId: string): CreditNote[] {
  return (getDb().prepare('SELECT c.*, i.number AS invoice_number FROM vat_credit_notes c JOIN vat_invoices i ON i.seq = c.invoice_seq WHERE c.order_id = ? ORDER BY c.seq').all(orderId) as Array<Parameters<typeof invoiceOf>[0] & { invoice_seq: number; invoice_number: string; reason: CreditNote['reason'] }>).map((r) => ({
    ...invoiceOf(r),
    invoiceSeq: r.invoice_seq,
    invoiceNumber: r.invoice_number,
    reason: r.reason,
  }));
}

/**
 * Take the next number of a series and write the document, in one IMMEDIATE transaction (nested in
 * a caller's: a savepoint of theirs). MAX(seq) + 1 under the write lock: no gaps, no doubles.
 */
export function issueInvoice(orderId: string, now = Date.now()): TaxInvoice {
  return inTransaction(() => {
    const have = invoiceFor(orderId);
    if (have) return have;
    const v = orderVat(orderId);
    if (!v) throw new Error(`order ${orderId} has no VAT breakdown`);
    const seq = (getDb().prepare('SELECT COALESCE(MAX(seq), 0) + 1 FROM vat_invoices').pluck().get() as number);
    const at = new Date(now).toISOString();
    getDb().prepare('INSERT INTO vat_invoices (seq, number, order_id, issued_at, issued_on, net_fils, vat_fils, total_fils) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(seq, invoiceNumber(seq), orderId, at, dubaiDateOf(at), v.netFils, v.vatFils, v.totalFils);
    audit('vat.invoice_issued', { orderId, number: invoiceNumber(seq), totalFils: v.totalFils, vatFils: v.vatFils });
    return invoiceFor(orderId)!;
  });
}

function issueCreditNote(inv: TaxInvoice, totalFils: number, vatFils: number, reason: CreditNote['reason'], now: number): void {
  const seq = getDb().prepare('SELECT COALESCE(MAX(seq), 0) + 1 FROM vat_credit_notes').pluck().get() as number;
  const at = new Date(now).toISOString();
  getDb()
    .prepare('INSERT INTO vat_credit_notes (seq, number, invoice_seq, order_id, reason, issued_at, issued_on, net_fils, vat_fils, total_fils) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(seq, creditNumber(seq), inv.seq, inv.orderId, reason, at, dubaiDateOf(at), totalFils - vatFils, vatFils, totalFils);
  audit('vat.credit_note_issued', { orderId: inv.orderId, number: creditNumber(seq), invoice: inv.number, reason, totalFils, vatFils });
}

interface StateRow {
  status: string;
  payment_method: string;
  payment_status: string;
  card_state: string;
  card_livemode: number | null;
  bank_state: string;
}

const SUPPLIED = new Set(['confirmed', 'dispatched', 'out_for_delivery', 'delivered']);

/** Is the order a supply now (its tax invoice due)? A live card payment taken; otherwise confirmed, paid or sent. */
function invoiceDue(s: StateRow): boolean {
  if (s.payment_method === 'online_card') return ['paid', 'refund_pending', 'refunded'].includes(s.card_state) && s.card_livemode !== 0;
  if (s.status === 'cancelled') return false;
  return SUPPLIED.has(s.status) || s.payment_status === 'paid' || s.payment_status === 'verified' || s.bank_state === 'paid';
}

/** What should have been credited so far: a card order's refunds (from the ledger); any other order, all of it once cancelled. */
function creditWanted(orderId: string, s: StateRow, inv: TaxInvoice): number {
  if (s.payment_method === 'online_card') {
    const refunded = getDb().prepare('SELECT COALESCE(SUM(amount_fils), 0) FROM card_refunds WHERE order_id = ?').pluck().get(orderId) as number;
    return Math.max(0, Math.min(inv.totalFils, refunded));
  }
  return s.status === 'cancelled' ? inv.totalFils : 0;
}

/** VAT of a credited amount: the invoice's own VAT when all of it, else in proportion (rounded half up). */
function vatOfCredited(credited: number, inv: TaxInvoice): number {
  if (credited === inv.totalFils) return inv.vatFils;
  if (!credited || !inv.totalFils) return 0;
  const sign = credited < 0 ? -1 : 1;
  const n = BigInt(Math.abs(credited)) * BigInt(inv.vatFils) * BigInt(2) + BigInt(inv.totalFils);
  return sign * Number(n / (BigInt(inv.totalFils) * BigInt(2)));
}

/**
 * Bring an order's tax documents in line with its state (idempotent): its invoice once due, and
 * credit notes for whatever was refunded or cancelled since (or a negative one when a refund failed
 * afterwards or a cancelled order was reinstated). Only for orders with a VAT breakdown.
 */
export function syncVatDocuments(orderId: string, now = Date.now()): void {
  // Most orders have no VAT (VAT off): no write lock for them.
  if (!getDb().prepare('SELECT 1 FROM order_vat WHERE order_id = ?').get(orderId)) return;
  inTransaction(() => {
    const s = getDb()
      .prepare('SELECT o.status, o.payment_method, o.payment_status, o.card_state, o.card_livemode, o.bank_state FROM orders o JOIN order_vat v ON v.order_id = o.id WHERE o.id = ?')
      .get(orderId) as StateRow | undefined;
    if (!s) return;
    let inv = invoiceFor(orderId);
    if (!inv && invoiceDue(s)) inv = issueInvoice(orderId, now);
    if (!inv) return;
    const credited = getDb().prepare('SELECT COALESCE(SUM(total_fils), 0) FROM vat_credit_notes WHERE order_id = ?').pluck().get(orderId) as number;
    const wanted = creditWanted(orderId, s, inv);
    const delta = wanted - credited;
    if (!delta) return;
    const vat = vatOfCredited(wanted, inv) - vatOfCredited(credited, inv);
    const reason: CreditNote['reason'] = delta > 0 ? (s.payment_method === 'online_card' ? 'refund' : 'cancelled') : s.payment_method === 'online_card' ? 'refund_reversed' : 'reinstated';
    issueCreditNote(inv, delta, vat, reason, now);
  });
}

/** syncVatDocuments, never throwing (called after order changes: a problem is logged and caught up later). */
export function syncVatDocumentsQuietly(orderId: string): void {
  try {
    syncVatDocuments(orderId);
  } catch (err) {
    logEvent('error', 'vat_documents_sync_failed', { orderId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Every order with a VAT breakdown, in line (before any VAT figure is shown). */
export function syncAllVatDocuments(): void {
  const ids = getDb().prepare('SELECT order_id FROM order_vat').pluck().all() as string[];
  for (const id of ids) syncVatDocumentsQuietly(id);
}

// ── The VAT return helper ───────────────────────────────────────────────────

export interface VatReturn {
  from: string;
  to: string;
  registered: boolean;
  trn: string;
  sales: { count: number; netFils: number; vatFils: number; totalFils: number };
  credits: { count: number; netFils: number; vatFils: number; totalFils: number };
  /** Standard-rated supplies after credit notes (box 1 of the return) and the output VAT. */
  output: { netFils: number; vatFils: number };
  /** Expenses dated in the period with a VAT amount (input VAT); those without a supplier TRN are counted apart. */
  input: { count: number; amountFils: number; vatFils: number; withoutTrn: number; withoutTrnVatFils: number };
  /** Output VAT less input VAT: payable when positive, refundable when negative. */
  netVatFils: number;
  notes: string[];
}

interface DocRow {
  number: string;
  order_id: string;
  issued_on: string;
  net_fils: number;
  vat_fils: number;
  total_fils: number;
  customer: string | null;
  invoice_number?: string;
  reason?: string;
}

interface ExpenseVatRow {
  id: string;
  spent_on: string;
  payee: string;
  amount_fils: number;
  vat_fils: number;
  supplier_trn: string | null;
  category: string;
}

function periodRows(from: string, to: string) {
  syncAllVatDocuments();
  const db = getDb();
  const invoices = db.prepare("SELECT i.number, i.order_id, i.issued_on, i.net_fils, i.vat_fils, i.total_fils, json_extract(o.data, '$.customer.fullName') AS customer FROM vat_invoices i JOIN orders o ON o.id = i.order_id WHERE i.issued_on >= ? AND i.issued_on <= ? ORDER BY i.seq").all(from, to) as DocRow[];
  const credits = db.prepare("SELECT c.number, c.order_id, c.issued_on, c.net_fils, c.vat_fils, c.total_fils, c.reason, i.number AS invoice_number, json_extract(o.data, '$.customer.fullName') AS customer FROM vat_credit_notes c JOIN vat_invoices i ON i.seq = c.invoice_seq JOIN orders o ON o.id = c.order_id WHERE c.issued_on >= ? AND c.issued_on <= ? ORDER BY c.seq").all(from, to) as DocRow[];
  const expenses = db.prepare('SELECT e.id, e.spent_on, e.payee, e.amount_fils, e.vat_fils, e.supplier_trn, c.name AS category FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.removed_at IS NULL AND e.vat_fils > 0 AND e.spent_on >= ? AND e.spent_on <= ? ORDER BY e.spent_on, e.id').all(from, to) as ExpenseVatRow[];
  return { invoices, credits, expenses };
}

const sumOf = (rows: Array<{ net_fils: number; vat_fils: number; total_fils: number }>) => rows.reduce((t, r) => ({ count: t.count + 1, netFils: t.netFils + r.net_fils, vatFils: t.vatFils + r.vat_fils, totalFils: t.totalFils + r.total_fils }), { count: 0, netFils: 0, vatFils: 0, totalFils: 0 });

export function vatReturn(from: string, to: string): VatReturn {
  const { invoices, credits, expenses } = periodRows(from, to);
  const s = vatSettings();
  const sales = sumOf(invoices);
  const cr = sumOf(credits);
  const input = expenses.reduce(
    (t, e) => ({ count: t.count + 1, amountFils: t.amountFils + e.amount_fils, vatFils: t.vatFils + e.vat_fils, withoutTrn: t.withoutTrn + (e.supplier_trn ? 0 : 1), withoutTrnVatFils: t.withoutTrnVatFils + (e.supplier_trn ? 0 : e.vat_fils) }),
    { count: 0, amountFils: 0, vatFils: 0, withoutTrn: 0, withoutTrnVatFils: 0 }
  );
  const output = { netFils: sales.netFils - cr.netFils, vatFils: sales.vatFils - cr.vatFils };
  const notes: string[] = [];
  if (input.withoutTrn) notes.push(`${input.withoutTrn} expense${input.withoutTrn === 1 ? ' has' : 's have'} VAT but no supplier TRN (AED ${aedText(input.withoutTrnVatFils)} of VAT): input VAT can usually only be recovered with the supplier’s tax invoice. Ask your accountant.`);
  if (!s.enabled && !sales.count && !cr.count) notes.push('VAT is off: the shop has issued no tax invoices in this period.');
  notes.push('A helper for your accountant, not a filed return: check it against the FTA’s return form (EmaraTax) before filing.');
  return { from, to, registered: s.enabled, trn: s.trn, sales, credits: cr, output, input, netVatFils: output.vatFils - input.vatFils, notes };
}

/** The VAT return helper as CSV: the totals, then every invoice, credit note and expense behind them. */
export function vatReturnCsv(from: string, to: string): string {
  const r = vatReturn(from, to);
  const { invoices, credits, expenses } = periodRows(from, to);
  const a = aedText;
  const rows: unknown[][] = [
    ['summary', 'Period', `${from} to ${to}`, '', '', r.trn, '', '', '', 'UAE dates'],
    ['summary', 'Standard-rated sales (tax invoices)', '', '', r.sales.count, '', a(r.sales.netFils), a(r.sales.vatFils), a(r.sales.totalFils), ''],
    ['summary', 'Credit notes (refunds and cancellations)', '', '', r.credits.count, '', a(-r.credits.netFils), a(-r.credits.vatFils), a(-r.credits.totalFils), ''],
    ['summary', 'Standard-rated supplies after adjustments / output VAT', '', '', '', '', a(r.output.netFils), a(r.output.vatFils), '', ''],
    ['summary', 'Expenses with VAT (input VAT)', '', '', r.input.count, '', a(r.input.amountFils - r.input.vatFils), a(r.input.vatFils), a(r.input.amountFils), r.input.withoutTrn ? `${r.input.withoutTrn} without a supplier TRN` : ''],
    ['summary', 'Net VAT (output less input)', '', '', '', '', '', a(r.netVatFils), '', r.netVatFils >= 0 ? 'payable' : 'refundable'],
    ...invoices.map((i) => ['tax_invoice', i.number, i.issued_on, i.order_id, i.customer ?? '', '', a(i.net_fils), a(i.vat_fils), a(i.total_fils), '']),
    ...credits.map((c) => ['credit_note', c.number, c.issued_on, c.order_id, c.customer ?? '', '', a(-c.net_fils), a(-c.vat_fils), a(-c.total_fils), `${c.reason} · invoice ${c.invoice_number}`]),
    ...expenses.map((e) => ['expense', e.id, e.spent_on, e.category, e.payee, e.supplier_trn ?? '', a(e.amount_fils - e.vat_fils), a(e.vat_fils), a(e.amount_fils), e.supplier_trn ? '' : 'no supplier TRN']),
  ];
  return toCsv(['section', 'document', 'date', 'reference', 'customer_or_supplier', 'trn', 'net_aed', 'vat_aed', 'total_aed', 'note'], rows);
}

/** Whether anything about VAT exists (switched on now, or documents issued before). */
export function vatInUse(): boolean {
  return vatSettings().enabled || Boolean(getDb().prepare('SELECT 1 FROM vat_invoices LIMIT 1').get());
}
