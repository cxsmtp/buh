import type { Order } from '@/types';
import { uaeDate } from '@/lib/delivery';
import { dueOnDeliveryFils } from '@/lib/orderMoney';
import { audit } from './audit';
import { getDb } from './db';
import { createExpense, getExpense, parseAmountFils, updateExpense } from './expenses';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { getOrder } from './orders';

/**
 * Jeebly in Money (asked by the owner: "add the Jeebly courier charges in the money section as
 * courier expenses… pull that data from Jeebly… for the past too and keep it up to date", then
 * "also fetch all the COD payments and other details from Jeebly into the money section").
 *
 * For each Jeebly shipment: its status, the cash Jeebly collected on delivery (COD), what Jeebly paid
 * out of it (remittance: amount, date, reference) and what Jeebly charged. Every figure comes from
 * Jeebly, never from a guess:
 *  - Jeebly's own replies (booking and tracking): the status, the COD on the delivered event, and a
 *    charge or payout when the reply carries one. The shop asks about every live shipment that is
 *    not finished, past ones too, every 15 minutes, a few at a time.
 *  - Jeebly's statement (the CSV the owner downloads from the Jeebly portal: shipments, COD or
 *    remittance report): every column it has of those. It is Jeebly's own account, so it wins over
 *    a reply.
 *
 * A charge is also an expense (category "Courier & delivery", paid to Jeebly), made once per AWB
 * (idempotency key) and corrected in place when Jeebly's figure changes (the earlier version kept).
 * COD and payouts are shown against what the order expected to collect, so a shortfall stands out;
 * they never change an order or its payment by themselves.
 */

export type Source = 'jeebly_reply' | 'statement';
const RANK: Record<Source, number> = { jeebly_reply: 1, statement: 2 };
const CATEGORY = 'courier';
const PAYEE = 'Jeebly';
const CARRIER = 'jeebly';
const MAX_FILS = 1_000_000_00; // AED 1,000,000: a COD or payout above it is a typo

export interface CourierShipment {
  carrier: string;
  awb: string;
  orderId: string | null;
  status: string | null;
  statusAt: string | null;
  deliveredOn: string | null;
  chargeFils: number | null;
  chargeSource: Source | null;
  chargedOn: string | null;
  expenseId: string | null;
  codFils: number | null;
  codSource: Source | null;
  remittedFils: number | null;
  remittedOn: string | null;
  remittanceRef: string | null;
  updatedAt: string;
}

interface Row {
  carrier: string;
  awb: string;
  order_id: string | null;
  status: string | null;
  status_at: string | null;
  delivered_on: string | null;
  charge_fils: number | null;
  charge_source: Source | null;
  charged_on: string | null;
  expense_id: string | null;
  cod_fils: number | null;
  cod_source: Source | null;
  remitted_fils: number | null;
  remitted_on: string | null;
  remittance_ref: string | null;
  updated_at: string;
}
const fromRow = (r: Row): CourierShipment => ({
  carrier: r.carrier,
  awb: r.awb,
  orderId: r.order_id,
  status: r.status,
  statusAt: r.status_at,
  deliveredOn: r.delivered_on,
  chargeFils: r.charge_fils,
  chargeSource: r.charge_source,
  chargedOn: r.charged_on,
  expenseId: r.expense_id,
  codFils: r.cod_fils,
  codSource: r.cod_source,
  remittedFils: r.remitted_fils,
  remittedOn: r.remitted_on,
  remittanceRef: r.remittance_ref,
  updatedAt: r.updated_at,
});

const AWB = /^[A-Za-z0-9][A-Za-z0-9-]{3,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: string, max: number) => v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, max);

/** The order a Jeebly AWB belongs to (booked through the shop or typed in from the portal). */
export function orderIdForAwb(awb: string): string | null {
  return (getDb().prepare("SELECT id FROM orders WHERE json_extract(data, '$.courier.awbNumber') = ? ORDER BY created_at DESC LIMIT 1").pluck().get(awb) as string | undefined) ?? null;
}

export function shipmentOf(awb: string): CourierShipment | undefined {
  const r = getDb().prepare('SELECT * FROM courier_shipments WHERE carrier = ? AND awb = ?').get(CARRIER, awb) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

function ensureRow(awb: string, orderId: string | null, actor: string): CourierShipment {
  const now = new Date().toISOString();
  getDb().prepare('INSERT OR IGNORE INTO courier_shipments (carrier, awb, order_id, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)').run(CARRIER, awb, orderId, now, actor);
  if (orderId) getDb().prepare('UPDATE courier_shipments SET order_id = ? WHERE carrier = ? AND awb = ? AND order_id IS NULL').run(orderId, CARRIER, awb);
  return shipmentOf(awb)!;
}

const aed = (fils: number) => `${Math.floor(fils / 100)}.${String(fils % 100).padStart(2, '0')}`;
const checkAwb = (awb: string) => {
  if (!AWB.test(awb)) throw new HttpError(400, `"${awb.slice(0, 40)}" is not an AWB number.`);
};

/**
 * Record what Jeebly charged for one shipment: its expense, once. Safe to call again (same figure:
 * nothing changes); a statement replaces a reply's figure, never the other way.
 */
export function recordCourierCharge(input: { awb: string; amountFils: number; source: Source; chargedOn: string; orderId?: string | null }, actor: string): { result: 'added' | 'updated' | 'same' | 'kept'; shipment: CourierShipment } {
  const awb = input.awb.trim();
  checkAwb(awb);
  if (!Number.isInteger(input.amountFils) || input.amountFils < 1 || input.amountFils > 10_000_00) throw new HttpError(400, `The charge for ${awb} is not an amount between AED 0.01 and 10,000.`);
  if (!DATE.test(input.chargedOn)) throw new HttpError(400, 'The charge date must be YYYY-MM-DD.');
  const orderId = input.orderId === undefined ? orderIdForAwb(awb) : input.orderId;
  const before = ensureRow(awb, orderId, actor);
  const note = `Courier charge for AWB ${awb}${orderId ? ` (order ${orderId})` : ''}, from ${input.source === 'statement' ? "Jeebly's statement" : "Jeebly's reply"}.`;
  const now = new Date().toISOString();
  if (before.chargeFils === null || !before.expenseId) {
    const { expense } = createExpense({ date: input.chargedOn, amount: aed(input.amountFils), categoryId: CATEGORY, method: 'other', payee: PAYEE, note }, actor, `courier:${CARRIER}:${awb}`);
    getDb().prepare('UPDATE courier_shipments SET charge_fils = ?, charge_source = ?, charged_on = ?, expense_id = ?, updated_at = ?, updated_by = ? WHERE carrier = ? AND awb = ?').run(expense.amountFils, input.source, expense.date, expense.id, now, actor, CARRIER, awb);
    return { result: 'added', shipment: shipmentOf(awb)! };
  }
  if (RANK[input.source] < RANK[before.chargeSource ?? 'jeebly_reply']) return { result: 'kept', shipment: before };
  const sameFigure = before.chargeFils === input.amountFils && before.chargedOn === input.chargedOn;
  if (sameFigure && before.chargeSource === input.source) return { result: 'same', shipment: before };
  const expense = getExpense(before.expenseId);
  if (expense && !expense.removed && (expense.amountFils !== input.amountFils || expense.date !== input.chargedOn)) {
    updateExpense(expense.id, { version: expense.version, amount: aed(input.amountFils), date: input.chargedOn, note }, actor);
  }
  getDb().prepare('UPDATE courier_shipments SET charge_fils = ?, charge_source = ?, charged_on = ?, updated_at = ?, updated_by = ? WHERE carrier = ? AND awb = ?').run(input.amountFils, input.source, input.chargedOn, now, actor, CARRIER, awb);
  return { result: sameFigure ? 'same' : 'updated', shipment: shipmentOf(awb)! };
}

export interface ShipmentFacts {
  awb: string;
  orderId?: string | null;
  status?: string;
  statusAt?: string;
  deliveredOn?: string;
  codFils?: number;
  remittedFils?: number;
  remittedOn?: string;
  remittanceRef?: string;
  source: Source;
}

/**
 * Record what Jeebly says about a shipment apart from its charge: status, COD collected, payout.
 * Only fields Jeebly gave are written; a reply never overwrites a statement's COD or payout.
 * Audited when something changed. Returns whether it did.
 */
export function recordShipmentFacts(f: ShipmentFacts, actor: string): boolean {
  const awb = f.awb.trim();
  checkAwb(awb);
  const money = (v: number | undefined, what: string) => {
    if (v === undefined) return undefined;
    if (!Number.isInteger(v) || v < 0 || v > MAX_FILS) throw new HttpError(400, `The ${what} for ${awb} is not an amount Jeebly would send.`);
    return v;
  };
  const date = (v: string | undefined) => (v !== undefined && DATE.test(v) ? v : undefined);
  const codFils = money(f.codFils, 'COD amount');
  const remittedFils = money(f.remittedFils, 'payout');
  const orderId = f.orderId === undefined ? orderIdForAwb(awb) : f.orderId;
  const before = ensureRow(awb, orderId, actor);
  const next = { ...before };
  if (f.status) {
    next.status = clean(f.status, 60);
    next.statusAt = f.statusAt && Number.isFinite(Date.parse(f.statusAt)) ? new Date(f.statusAt).toISOString() : new Date().toISOString();
  }
  if (date(f.deliveredOn)) next.deliveredOn = date(f.deliveredOn)!;
  const may = (src: Source | null) => src === null || RANK[f.source] >= RANK[src];
  if (codFils !== undefined && may(before.codSource)) {
    next.codFils = codFils;
    next.codSource = f.source;
  }
  if (remittedFils !== undefined && (f.source === 'statement' || before.remittedFils === null)) next.remittedFils = remittedFils;
  if (date(f.remittedOn) && (f.source === 'statement' || !before.remittedOn)) next.remittedOn = date(f.remittedOn)!;
  if (f.remittanceRef && (f.source === 'statement' || !before.remittanceRef)) next.remittanceRef = clean(f.remittanceRef, 60);
  const keys = ['status', 'deliveredOn', 'codFils', 'codSource', 'remittedFils', 'remittedOn', 'remittanceRef'] as const;
  const changed = keys.filter((k) => next[k] !== before[k]);
  if (!changed.length && next.statusAt === before.statusAt) return false;
  if (!changed.length) {
    // Only the time of a status seen again: kept, not audited.
    getDb().prepare('UPDATE courier_shipments SET status_at = ? WHERE carrier = ? AND awb = ?').run(next.statusAt, CARRIER, awb);
    return false;
  }
  const now = new Date().toISOString();
  getDb()
    .prepare('UPDATE courier_shipments SET status = ?, status_at = ?, delivered_on = ?, cod_fils = ?, cod_source = ?, remitted_fils = ?, remitted_on = ?, remittance_ref = ?, updated_at = ?, updated_by = ? WHERE carrier = ? AND awb = ?')
    .run(next.status, next.statusAt, next.deliveredOn, next.codFils, next.codSource, next.remittedFils, next.remittedOn, next.remittanceRef, now, actor, CARRIER, awb);
  audit('courier.shipment_updated', { by: actor, awb, orderId: next.orderId, source: f.source, changes: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: next[k] }])) });
  return true;
}

// ── Jeebly's replies ─────────────────────────────────────────────────────────

const CHARGE_KEY = /^(total[ _]?)?(shipping|shipment|delivery|freight|courier|service)[ _]?(charges?|cost|fees?|amount|price)$/i;
const REMIT_KEY = /^(cod[ _]?)?(remitted|remittance|settled|settlement|payout|paid[ _]?out)([ _]?amount)?$/i;
const REMIT_DATE_KEY = /^(cod[ _]?)?(remitted|remittance|settlement|settled|payout)[ _]?(date|on|at)$/i;
const REMIT_REF_KEY = /^(cod[ _]?)?(remittance|settlement|payout)[ _]?(ref|reference|no|number|id)$/i;

const amountOf = (v: unknown): number | null => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const text = String(v).trim().replace(/^AED\s*/i, '').replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(Number(text) * 100);
};

/** The first value (depth ≤ 3, objects only) whose key matches. */
function find(data: unknown, key: RegExp, depth = 0): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data) || depth > 3) return undefined;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) if (key.test(k.trim()) && (typeof v === 'string' || typeof v === 'number')) return v;
  for (const v of Object.values(data as Record<string, unknown>)) {
    const found = find(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * What a Jeebly reply says the shipment cost, in fils, when it says so: a field named like
 * "shipping_charges" or "Delivery Charge" (any depth up to 3), never the COD amount. Null otherwise.
 */
export function chargeInReply(data: unknown): number | null {
  const fils = amountOf(find(data, CHARGE_KEY));
  return fils && fils > 0 && fils <= 10_000_00 ? fils : null;
}

const DELIVERED = /^delivered$|^shipment delivered$|^delivered to (consignee|customer)/i;

/** What a tracking reply says beyond its charge: the status, and on delivery the COD collected. */
export function factsInReply(data: unknown): Omit<ShipmentFacts, 'awb' | 'source'> {
  const out: Omit<ShipmentFacts, 'awb' | 'source'> = {};
  const t = data && typeof data === 'object' ? (data as Record<string, unknown>).Tracking : undefined;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const tr = t as Record<string, unknown>;
    if (typeof tr.last_status === 'string' && tr.last_status.trim()) out.status = tr.last_status;
    const events = Array.isArray(tr.events) ? (tr.events as Array<Record<string, unknown>>) : [];
    const newest = events.find((e) => e && typeof e === 'object');
    if (newest && typeof newest.event_date_time === 'string') out.statusAt = newest.event_date_time;
    const delivered = events.find((e) => e && typeof e === 'object' && typeof e.status === 'string' && DELIVERED.test(e.status.trim()));
    if (delivered) {
      const at = typeof delivered.event_date_time === 'string' ? Date.parse(delivered.event_date_time) : NaN;
      if (Number.isFinite(at)) out.deliveredOn = uaeDate(at);
      const cod = amountOf(delivered.cod_amount);
      if (cod !== null) out.codFils = cod;
    }
  }
  const remitted = amountOf(find(data, REMIT_KEY));
  if (remitted !== null) out.remittedFils = remitted;
  const on = find(data, REMIT_DATE_KEY);
  if (typeof on === 'string' && dateOf(on)) out.remittedOn = dateOf(on)!;
  const ref = find(data, REMIT_REF_KEY);
  if (ref !== undefined && String(ref).trim()) out.remittanceRef = String(ref);
  return out;
}

const bookedOn = (order: Order) => uaeDate(Date.parse(order.courier.dispatchedAt ?? order.createdAt) || Date.now());

/** A live Jeebly reply about this order's shipment: what it says goes to Money. Never throws. */
export function noteJeeblyReply(order: Order, data: unknown): void {
  try {
    const c = order.courier;
    if (c.provider !== 'jeebly' || !c.awbNumber || c.simulated || c.testKind || (c.carrierEnv ?? 'live') !== 'live') return;
    const fils = chargeInReply(data);
    if (fils !== null) recordCourierCharge({ awb: c.awbNumber, amountFils: fils, source: 'jeebly_reply', chargedOn: bookedOn(order), orderId: order.id }, 'jeebly');
    const facts = factsInReply(data);
    if (Object.keys(facts).length) recordShipmentFacts({ awb: c.awbNumber, orderId: order.id, source: 'jeebly_reply', ...facts }, 'jeebly');
  } catch (err) {
    logEvent('warn', 'courier_reply_record_failed', { order: order.id, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Jeebly's statement (CSV from the portal) ─────────────────────────────────

/** One CSV line → cells (quotes, doubled quotes; commas, semicolons or tabs). */
function cells(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const HEAD = {
  awb: /^(awb|awb[ _.-]?(no|number|#)|airway ?bill( no| number)?|tracking( no| number| id)?|shipment( no| number| id)?|reference[ _]?no|consignment( no| number)?)$/i,
  charge: /(shipping|delivery|freight|courier|service|total)[ _]?(charges?|cost|fees?)|^(shipping|delivery) amount$|^charges?$|^(fee|cost)$/i,
  cod: /^cod$|^cod[ _]?(amount|value|collected|collection)|^(collected|collection)[ _]?(amount)?$|^cash[ _]?(on[ _]?delivery|collected)/i,
  remitted: /(remitted|remittance|settled|settlement|payout|paid[ _]?out)([ _]?(amount|value))?$/i,
  remitDate: /(remitted|remittance|settlement|settled|payout|paid[ _]?out)[ _]?(date|on)$/i,
  remitRef: /(remittance|settlement|payout|utr|transfer)[ _]?(ref|reference|no|number|id)$/i,
  status: /^((shipment|delivery|current|last|order)[ _])?status$/i,
  delivered: /^(delivered|delivery)[ _]?(date|on)$|^date[ _]?(of )?delivery$/i,
  date: /^(date|booked|booked[ _]?on|booking[ _]?date|created|created[ _]?(at|on)|pickup[ _]?date|shipment[ _]?date)$/i,
};
const NOT_MONEY = /cod|collect|remit|cash|settle|payout/i;

export interface StatementRow {
  line: number;
  awb: string;
  orderId: string | null;
  chargeFils?: number;
  chargedOn: string;
  codFils?: number;
  remittedFils?: number;
  remittedOn?: string;
  remittanceRef?: string;
  status?: string;
  deliveredOn?: string;
  /** What saving it does: new, the same, changes something, or a shipment not in the shop. */
  what: 'new' | 'same' | 'changed' | 'unmatched';
  wasChargeFils?: number;
}

function dateOf(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t); // Jeebly and the UAE write day first
  if (m) {
    const [d, mo] = [Number(m[1]), Number(m[2])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) && /\d{4}/.test(t) ? uaeDate(ms) : null;
}

/** "12,50" (a decimal comma, as Excel writes it in some countries) is 12.50, never 1,250. */
function filsOf(text: string | undefined): number | undefined {
  const raw = (text ?? '').replace(/^AED\s*/i, '').trim();
  if (!raw) return undefined;
  try {
    return parseAmountFils(/^\d{1,6},\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw);
  } catch {
    return /^0+([.,]0+)?$/.test(raw) ? 0 : undefined;
  }
}

/**
 * Read Jeebly's statement (shipments, COD or payout report): the header row names the columns. It
 * needs an AWB column and at least one of: shipping charge, COD, payout, status. Rows without an
 * AWB, or with nothing to read, are skipped and counted. Nothing is saved here.
 */
export function readStatement(csv: string, today = uaeDate(Date.now())): { rows: StatementRow[]; skipped: number; columns: Partial<Record<keyof typeof HEAD, string>> } {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const headAt = lines.findIndex((l) => l.trim());
  if (headAt < 0) throw new HttpError(400, 'The file is empty.');
  const first = lines[headAt];
  const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const head = cells(first, sep).map((h) => h.replace(/\s+/g, ' ').trim());
  const used = new Set<number>();
  const col = (re: RegExp, ok: (h: string) => boolean = () => true) => {
    const i = head.findIndex((h, n) => !used.has(n) && re.test(h) && ok(h));
    if (i >= 0) used.add(i);
    return i;
  };
  // Most specific first, so "COD Remitted Date" is the payout date, not the COD amount.
  const at = {
    awb: col(HEAD.awb),
    remitDate: col(HEAD.remitDate),
    remitRef: col(HEAD.remitRef),
    remitted: col(HEAD.remitted),
    delivered: col(HEAD.delivered),
    charge: col(HEAD.charge, (h) => !NOT_MONEY.test(h)),
    cod: col(HEAD.cod),
    status: col(HEAD.status),
    date: col(HEAD.date),
  };
  if (at.awb < 0 || (at.charge < 0 && at.cod < 0 && at.remitted < 0 && at.status < 0)) {
    throw new HttpError(400, "This doesn't look like a Jeebly statement: it needs an AWB column and a shipping charge, COD, payout or status column (the first row names the columns).");
  }
  // Every order's AWB, read once (not one scan of the orders per row of a 5,000-row statement).
  const orderOf = new Map<string, string>();
  for (const r of getDb().prepare("SELECT id, json_extract(data, '$.courier.awbNumber') AS awb FROM orders WHERE COALESCE(json_extract(data, '$.courier.awbNumber'), '') <> '' ORDER BY created_at ASC").iterate() as IterableIterator<{ id: string; awb: string }>) orderOf.set(String(r.awb), r.id);
  const rows: StatementRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const cap = (d: string | null | undefined) => (d ? (d > today ? today : d) : undefined);
  for (let i = headAt + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (rows.length >= 5000) throw new HttpError(413, 'At most 5,000 shipments per file: download a shorter period.');
    const c = cells(lines[i], sep);
    const get = (n: number) => (n >= 0 ? c[n] : undefined);
    const awb = (get(at.awb) ?? '').trim();
    const charge = filsOf(get(at.charge));
    const cod = filsOf(get(at.cod));
    const remitted = filsOf(get(at.remitted));
    const status = clean(get(at.status) ?? '', 60);
    const row: StatementRow = {
      line: i + 1,
      awb,
      orderId: orderOf.get(awb) ?? null,
      chargedOn: cap(dateOf(get(at.date) ?? '')) ?? today,
      what: 'new',
      ...(charge && charge <= 10_000_00 ? { chargeFils: charge } : {}),
      ...(cod !== undefined && cod <= MAX_FILS ? { codFils: cod } : {}),
      ...(remitted !== undefined && remitted <= MAX_FILS ? { remittedFils: remitted } : {}),
      ...(cap(dateOf(get(at.remitDate) ?? '')) ? { remittedOn: cap(dateOf(get(at.remitDate) ?? '')) } : {}),
      ...(clean(get(at.remitRef) ?? '', 60) ? { remittanceRef: clean(get(at.remitRef) ?? '', 60) } : {}),
      ...(status ? { status } : {}),
      ...(cap(dateOf(get(at.delivered) ?? '')) ? { deliveredOn: cap(dateOf(get(at.delivered) ?? '')) } : {}),
    };
    const hasData = row.chargeFils !== undefined || row.codFils !== undefined || row.remittedFils !== undefined || row.status !== undefined;
    if (!AWB.test(awb) || !hasData || seen.has(awb)) {
      skipped++;
      continue;
    }
    seen.add(awb);
    const before = shipmentOf(awb);
    if (!row.orderId && !before) row.what = 'unmatched';
    else if (!before) row.what = 'new';
    else {
      const same =
        (row.chargeFils === undefined || (before.chargeFils === row.chargeFils && before.chargedOn === row.chargedOn)) &&
        (row.codFils === undefined || before.codFils === row.codFils) &&
        (row.remittedFils === undefined || before.remittedFils === row.remittedFils) &&
        (row.remittedOn === undefined || before.remittedOn === row.remittedOn) &&
        (row.remittanceRef === undefined || before.remittanceRef === row.remittanceRef) &&
        (row.status === undefined || before.status === row.status);
      row.what = same ? 'same' : 'changed';
      if (row.chargeFils !== undefined && before.chargeFils !== null && before.chargeFils !== row.chargeFils) row.wasChargeFils = before.chargeFils;
    }
    rows.push(row);
  }
  const columns = Object.fromEntries(Object.entries(at).filter(([, n]) => n >= 0).map(([k, n]) => [k, head[n]])) as Partial<Record<keyof typeof HEAD, string>>;
  return { rows, skipped, columns };
}

/** Save the statement's rows (the ones the owner saw in the preview). A shipment not in the shop is still Jeebly's, so it is kept. */
export function applyStatement(csv: string, actor: string): { added: number; updated: number; same: number; skipped: number; chargeFils: number; codFils: number; remittedFils: number } {
  const { rows, skipped } = readStatement(csv);
  let added = 0;
  let updated = 0;
  let same = 0;
  let chargeFils = 0;
  let codFils = 0;
  let remittedFils = 0;
  for (const r of rows) {
    const existed = Boolean(shipmentOf(r.awb));
    let changed = false;
    if (r.chargeFils !== undefined) {
      const { result } = recordCourierCharge({ awb: r.awb, amountFils: r.chargeFils, source: 'statement', chargedOn: r.chargedOn, orderId: r.orderId }, actor);
      changed = result === 'added' || result === 'updated';
      chargeFils += r.chargeFils;
    }
    const facts = recordShipmentFacts({ awb: r.awb, orderId: r.orderId, status: r.status, deliveredOn: r.deliveredOn, codFils: r.codFils, remittedFils: r.remittedFils, remittedOn: r.remittedOn, remittanceRef: r.remittanceRef, source: 'statement' }, actor);
    codFils += r.codFils ?? 0;
    remittedFils += r.remittedFils ?? 0;
    if (!existed) added++;
    else if (changed || facts) updated++;
    else same++;
  }
  audit('courier.statement_imported', { by: actor, rows: rows.length, added, updated, same, skipped, chargeFils, codFils, remittedFils });
  return { added, updated, same, skipped, chargeFils, codFils, remittedFils };
}

// ── Keeping it up to date ────────────────────────────────────────────────────

const FINAL = /^(delivered|cancelled|canceled|returned|rto delivered|return(ed)? to (origin|shipper)|lost)/i;

/** Live Jeebly shipments Jeebly may still have news about (no charge yet, or not finished), newest first. */
export function shipmentsToAsk(limit = 2000): Array<{ orderId: string; awb: string }> {
  const rows = getDb()
    .prepare(
      `SELECT o.id AS orderId, json_extract(o.data, '$.courier.awbNumber') AS awb, s.charge_fils AS charge, s.status AS status FROM orders o
       LEFT JOIN courier_shipments s ON s.carrier = 'jeebly' AND s.awb = json_extract(o.data, '$.courier.awbNumber')
       WHERE json_extract(o.data, '$.courier.provider') = 'jeebly' AND COALESCE(json_extract(o.data, '$.courier.awbNumber'), '') <> ''
         AND COALESCE(json_extract(o.data, '$.courier.simulated'), 0) = 0 AND json_extract(o.data, '$.courier.testKind') IS NULL
         AND COALESCE(json_extract(o.data, '$.courier.carrierEnv'), 'live') = 'live'
       ORDER BY o.created_at DESC LIMIT ?`
    )
    .all(limit * 4) as Array<{ orderId: string; awb: string; charge: number | null; status: string | null }>;
  return rows.filter((r) => r.charge === null || !r.status || !FINAL.test(r.status)).slice(0, limit).map(({ orderId, awb }) => ({ orderId, awb }));
}

const SYNC_KEY = 'courier-charges:sync';
interface SyncState {
  at: string;
  checked: number;
  waiting: number;
  /** AWB → when it was last asked: a finished shipment with no charge yet at most once a day, others every hour. */
  asked: Record<string, string>;
}

export function syncState(): Omit<SyncState, 'asked'> | null {
  const s = kvGet<SyncState>(SYNC_KEY)?.data;
  return s ? { at: s.at, checked: s.checked, waiting: s.waiting } : null;
}

/**
 * Ask Jeebly about live shipments it may still have news about (past ones included), a few at a
 * time: at most `max` per run (every 15 minutes with the shop's checks, or "Check Jeebly now").
 */
export async function syncJeeblyCharges({ max = 20, force = false }: { max?: number; force?: boolean } = {}): Promise<{ checked: number; waiting: number }> {
  const { getSettings } = await import('./settings');
  const s = getSettings('courier').jeebly;
  const waiting = shipmentsToAsk();
  const prev = kvGet<SyncState>(SYNC_KEY)?.data;
  const asked: Record<string, string> = {};
  const want = new Set(waiting.map((w) => w.awb));
  for (const [awb, at] of Object.entries(prev?.asked ?? {})) if (want.has(awb) && Date.parse(at) > Date.now() - 24 * 3600_000) asked[awb] = at;
  const due = (awb: string) => {
    const last = Date.parse(asked[awb] ?? '');
    if (!Number.isFinite(last)) return true;
    const sh = shipmentOf(awb);
    const finished = Boolean(sh?.status && FINAL.test(sh.status));
    return Date.now() - last > (finished ? 24 : 1) * 3600_000;
  };
  let checked = 0;
  if (s.liveBaseUrl && s.apiKey && s.clientKey) {
    const { jeeblyTrackingFor } = await import('./jeeblyOps');
    for (const w of waiting) {
      if (checked >= max) break;
      if (!force && !due(w.awb)) continue;
      const order = getOrder(w.orderId);
      if (!order) continue;
      checked++;
      asked[w.awb] = new Date().toISOString();
      await jeeblyTrackingFor(order, { fresh: true });
    }
  }
  const left = shipmentsToAsk().length;
  kvSet(SYNC_KEY, { at: new Date().toISOString(), checked, waiting: left, asked } satisfies SyncState);
  return { checked, waiting: left };
}

/** Money → Courier: the totals, the shipments (newest first) and the sync state. */
export function courierView({ from, to }: { from?: string; to?: string } = {}) {
  const where = from && to ? 'WHERE COALESCE(delivered_on, charged_on, substr(updated_at, 1, 10)) BETWEEN ? AND ?' : '';
  const args = from && to ? [from, to] : [];
  const sum = getDb()
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(charge_fils), 0) AS charge, COUNT(charge_fils) AS charged, COALESCE(SUM(cod_fils), 0) AS cod, COALESCE(SUM(remitted_fils), 0) AS remitted,
              COALESCE(SUM(CASE WHEN cod_fils > COALESCE(remitted_fils, 0) THEN cod_fils - COALESCE(remitted_fils, 0) ELSE 0 END), 0) AS pending
       FROM courier_shipments ${where}`
    )
    .get(...args) as { n: number; charge: number; charged: number; cod: number; remitted: number; pending: number };
  const rows = (getDb().prepare(`SELECT * FROM courier_shipments ${where} ORDER BY COALESCE(delivered_on, charged_on, substr(updated_at, 1, 10)) DESC, awb DESC LIMIT 300`).all(...args) as Row[]).map(fromRow);
  const shipments = rows.map((s) => {
    const order = s.orderId ? getOrder(s.orderId) : undefined;
    // What the shop told the courier to collect; a delivered shipment whose COD differs is flagged.
    const expectedCodFils = order && order.status !== 'cancelled' ? dueOnDeliveryFils(order) : null;
    const codMismatch = s.codFils !== null && expectedCodFils !== null && s.status !== null && DELIVERED.test(s.status) && s.codFils !== expectedCodFils;
    return { ...s, expectedCodFils, codMismatch };
  });
  return {
    count: sum.n,
    charged: sum.charged,
    totalFils: sum.charge,
    codFils: sum.cod,
    remittedFils: sum.remitted,
    pendingFils: sum.pending,
    shipments,
    waiting: shipmentsToAsk().length,
    sync: syncState(),
  };
}
