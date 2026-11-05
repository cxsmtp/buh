import type { Order } from '@/types';
import { uaeDate } from '@/lib/delivery';
import { audit } from './audit';
import { getDb } from './db';
import { createExpense, getExpense, parseAmountFils, updateExpense } from './expenses';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';

/**
 * Courier charges in Money (asked by the owner: "add the Jeebly courier charges in the money section
 * as courier expenses… pull that data from Jeebly… for the past too and keep it up to date").
 *
 * Every amount comes from Jeebly, never from a guess:
 *  - Jeebly's own replies (booking and tracking): when one carries what the shipment cost (a field
 *    named like shipping/delivery/freight charge), it is recorded. Jeebly's demo system sends none,
 *    so this is ready for the live system and sends nothing it doesn't know.
 *  - Jeebly's statement (the CSV the owner downloads from the Jeebly portal): every row with an AWB
 *    and a charge, for any period, past included. It is the bill, so it wins over a reply.
 *
 * One expense per shipment (category "Courier & delivery", paid to Jeebly), made once (idempotency
 * key per AWB) and corrected in place when Jeebly's figure changes (the earlier version is kept).
 * Each change is audited in the expense's own transaction before it is reported.
 */

export type ChargeSource = 'jeebly_reply' | 'statement';
const RANK: Record<ChargeSource, number> = { jeebly_reply: 1, statement: 2 };
const CATEGORY = 'courier';
const PAYEE = 'Jeebly';

export interface CourierCharge {
  carrier: string;
  awb: string;
  orderId: string | null;
  amountFils: number;
  source: ChargeSource;
  chargedOn: string;
  expenseId: string;
  recordedAt: string;
}

interface Row {
  carrier: string;
  awb: string;
  order_id: string | null;
  amount_fils: number;
  source: ChargeSource;
  charged_on: string;
  expense_id: string;
  recorded_at: string;
}
const fromRow = (r: Row): CourierCharge => ({ carrier: r.carrier, awb: r.awb, orderId: r.order_id, amountFils: r.amount_fils, source: r.source, chargedOn: r.charged_on, expenseId: r.expense_id, recordedAt: r.recorded_at });

const AWB = /^[A-Za-z0-9-]{4,40}$/;

/** The order a Jeebly AWB belongs to (booked through the shop or typed in from the portal). */
export function orderIdForAwb(awb: string): string | null {
  return (getDb().prepare("SELECT id FROM orders WHERE json_extract(data, '$.courier.awbNumber') = ? ORDER BY created_at DESC LIMIT 1").pluck().get(awb) as string | undefined) ?? null;
}

function existing(carrier: string, awb: string): CourierCharge | undefined {
  const r = getDb().prepare('SELECT * FROM courier_charges WHERE carrier = ? AND awb = ?').get(carrier, awb) as Row | undefined;
  return r ? fromRow(r) : undefined;
}

const aed = (fils: number) => `${Math.floor(fils / 100)}.${String(fils % 100).padStart(2, '0')}`;

/**
 * Record what Jeebly charged for one shipment. Safe to call again (same figure: nothing changes); a
 * statement replaces a reply's figure, never the other way. Returns what happened.
 */
export function recordCourierCharge(input: { awb: string; amountFils: number; source: ChargeSource; chargedOn: string; orderId?: string | null }, actor: string): { result: 'added' | 'updated' | 'same' | 'kept'; charge: CourierCharge } {
  const carrier = 'jeebly';
  const awb = input.awb.trim();
  if (!AWB.test(awb)) throw new HttpError(400, `"${awb.slice(0, 40)}" is not an AWB number.`);
  if (!Number.isInteger(input.amountFils) || input.amountFils < 1 || input.amountFils > 10_000_00) throw new HttpError(400, `The charge for ${awb} is not an amount between AED 0.01 and 10,000.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.chargedOn)) throw new HttpError(400, 'The charge date must be YYYY-MM-DD.');
  const orderId = input.orderId === undefined ? orderIdForAwb(awb) : input.orderId;
  const note = `Courier charge for AWB ${awb}${orderId ? ` (order ${orderId})` : ''}, from ${input.source === 'statement' ? "Jeebly's statement" : "Jeebly's reply"}.`;
  const before = existing(carrier, awb);
  const now = new Date().toISOString();
  if (!before) {
    const { expense } = createExpense({ date: input.chargedOn, amount: aed(input.amountFils), categoryId: CATEGORY, method: 'other', payee: PAYEE, note }, actor, `courier:${carrier}:${awb}`);
    getDb()
      .prepare('INSERT OR IGNORE INTO courier_charges (carrier, awb, order_id, amount_fils, source, charged_on, expense_id, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(carrier, awb, orderId, expense.amountFils, input.source, expense.date, expense.id, now, actor);
    return { result: 'added', charge: existing(carrier, awb)! };
  }
  if (RANK[input.source] < RANK[before.source]) return { result: 'kept', charge: before };
  if (before.amountFils === input.amountFils && before.chargedOn === input.chargedOn && before.source === input.source) return { result: 'same', charge: before };
  const expense = getExpense(before.expenseId);
  if (expense && !expense.removed && (expense.amountFils !== input.amountFils || expense.date !== input.chargedOn)) {
    updateExpense(expense.id, { version: expense.version, amount: aed(input.amountFils), date: input.chargedOn, note }, actor);
  }
  getDb().prepare('UPDATE courier_charges SET amount_fils = ?, source = ?, charged_on = ?, order_id = COALESCE(?, order_id), recorded_at = ?, recorded_by = ? WHERE carrier = ? AND awb = ?').run(input.amountFils, input.source, input.chargedOn, orderId, now, actor, carrier, awb);
  return { result: before.amountFils === input.amountFils && before.chargedOn === input.chargedOn ? 'same' : 'updated', charge: existing(carrier, awb)! };
}

// ── Jeebly's replies ─────────────────────────────────────────────────────────

const CHARGE_KEY = /^(total[ _]?)?(shipping|shipment|delivery|freight|courier|service)[ _]?(charges?|cost|fees?|amount|price)$/i;

/**
 * What a Jeebly reply says the shipment cost, in fils, when it says so: a field named like
 * "shipping_charges" or "Delivery Charge" (any depth up to 3), never the COD amount. Null otherwise.
 */
export function chargeInReply(data: unknown, depth = 0): number | null {
  if (!data || typeof data !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (CHARGE_KEY.test(k.trim()) && (typeof v === 'number' || typeof v === 'string')) {
      const text = String(v).trim().replace(/^AED\s*/i, '');
      if (!/^\d{1,5}(\.\d{1,2})?$/.test(text)) continue;
      const fils = Math.round(Number(text) * 100);
      if (fils > 0) return fils;
    }
  }
  for (const v of Object.values(data as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = chargeInReply(v, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

const bookedOn = (order: Order) => uaeDate(Date.parse(order.courier.dispatchedAt ?? order.createdAt) || Date.now());

/** A live Jeebly reply about this order's shipment: its charge, when it carries one, goes to Money. Never throws. */
export function noteJeeblyReply(order: Order, data: unknown): void {
  try {
    const c = order.courier;
    if (c.provider !== 'jeebly' || !c.awbNumber || c.simulated || c.testKind || (c.carrierEnv ?? 'live') !== 'live') return;
    const fils = chargeInReply(data);
    if (fils === null) return;
    recordCourierCharge({ awb: c.awbNumber, amountFils: fils, source: 'jeebly_reply', chargedOn: bookedOn(order), orderId: order.id }, 'jeebly');
  } catch (err) {
    logEvent('warn', 'courier_charge_reply_failed', { order: order.id, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Jeebly's statement (CSV from the portal) ─────────────────────────────────

/** One CSV line → cells (quotes, doubled quotes, commas or semicolons or tabs). */
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

const AWB_HEAD = /^(awb|awb[ _.-]?(no|number|#)|airway ?bill( no| number)?|tracking( no| number| id)?|shipment( no| number| id)?|reference[ _]?no|consignment( no| number)?)$/i;
const CHARGE_HEAD = /(shipping|delivery|freight|courier|service|total)[ _]?(charges?|cost|fees?|amount)|^charges?$|^(fee|cost)$/i;
const COD_HEAD = /cod|collect|remit|cash/i;
const DATE_HEAD = /date|booked|delivered|created/i;

export interface StatementRow {
  line: number;
  awb: string;
  amountFils: number;
  chargedOn: string;
  orderId: string | null;
  status: 'new' | 'same' | 'changed' | 'unmatched';
  wasFils?: number;
}

function dateOf(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t); // Jeebly and the UAE write day first
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? uaeDate(ms) : null;
}

/**
 * Read Jeebly's statement: the header row names the AWB column and the charge column (never a COD
 * column), and a date column when there is one. Rows without an AWB or a charge are skipped and
 * counted. Nothing is saved here.
 */
export function readStatement(csv: string, today = uaeDate(Date.now())): { rows: StatementRow[]; skipped: number; columns: { awb: string; charge: string; date?: string } } {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const headAt = lines.findIndex((l) => l.trim());
  if (headAt < 0) throw new HttpError(400, 'The file is empty.');
  const first = lines[headAt];
  const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const head = cells(first, sep).map((h) => h.replace(/\s+/g, ' ').trim());
  const awbCol = head.findIndex((h) => AWB_HEAD.test(h));
  const chargeCols = head.map((h, i) => [h, i] as const).filter(([h]) => CHARGE_HEAD.test(h) && !COD_HEAD.test(h));
  const chargeCol = (chargeCols.find(([h]) => /shipping|delivery|freight|courier/i.test(h)) ?? chargeCols.find(([h]) => /total/i.test(h)) ?? chargeCols[0])?.[1] ?? -1;
  if (awbCol < 0 || chargeCol < 0) throw new HttpError(400, "This doesn't look like Jeebly's statement: it needs an AWB column and a shipping charge column (the first row names the columns).");
  const dateCol = head.findIndex((h, i) => i !== awbCol && i !== chargeCol && DATE_HEAD.test(h));
  const rows: StatementRow[] = [];
  const seen = new Set<string>();
  // Every order's AWB, read once (not one scan of the orders per row of a 5,000-row statement).
  const orderOf = new Map<string, string>();
  for (const r of getDb().prepare("SELECT id, json_extract(data, '$.courier.awbNumber') AS awb FROM orders WHERE COALESCE(json_extract(data, '$.courier.awbNumber'), '') <> '' ORDER BY created_at ASC").iterate() as IterableIterator<{ id: string; awb: string }>) orderOf.set(String(r.awb), r.id);
  let skipped = 0;
  for (let i = headAt + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (rows.length >= 5000) throw new HttpError(413, 'At most 5,000 shipments per file: download a shorter period.');
    const c = cells(lines[i], sep);
    const awb = (c[awbCol] ?? '').trim();
    let fils = 0;
    try {
      const raw = (c[chargeCol] ?? '').replace(/^AED\s*/i, '').trim();
      // "12,50" (a decimal comma, as Excel writes it in some countries) is 12.50, never 1,250.
      fils = parseAmountFils(/^\d{1,6},\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw);
    } catch {
      fils = 0;
    }
    if (!AWB.test(awb) || fils < 1 || fils > 10_000_00 || seen.has(awb)) {
      skipped++;
      continue;
    }
    seen.add(awb);
    const date = (dateCol >= 0 && dateOf(c[dateCol] ?? '')) || today;
    const orderId = orderOf.get(awb) ?? null;
    const before = existing('jeebly', awb);
    const status: StatementRow['status'] = !orderId && !before ? 'unmatched' : !before ? 'new' : before.amountFils === fils && before.chargedOn === date ? 'same' : 'changed';
    rows.push({ line: i + 1, awb, amountFils: fils, chargedOn: date > today ? today : date, orderId, status, ...(before && before.amountFils !== fils ? { wasFils: before.amountFils } : {}) });
  }
  return { rows, skipped, columns: { awb: head[awbCol], charge: head[chargeCol], ...(dateCol >= 0 ? { date: head[dateCol] } : {}) } };
}

/** Save the statement's rows (the ones the owner saw in the preview). A shipment not in the shop is still Jeebly's charge, so it is kept. */
export function applyStatement(csv: string, actor: string): { added: number; updated: number; same: number; skipped: number; totalFils: number } {
  const { rows, skipped } = readStatement(csv);
  let added = 0;
  let updated = 0;
  let same = 0;
  let totalFils = 0;
  for (const r of rows) {
    const { result } = recordCourierCharge({ awb: r.awb, amountFils: r.amountFils, source: 'statement', chargedOn: r.chargedOn, orderId: r.orderId }, actor);
    if (result === 'added') added++;
    else if (result === 'updated') updated++;
    else same++;
    totalFils += r.amountFils;
  }
  audit('courier.statement_imported', { by: actor, rows: rows.length, added, updated, same, skipped, totalFils });
  return { added, updated, same, skipped, totalFils };
}

// ── Keeping it up to date ────────────────────────────────────────────────────

/** Live Jeebly shipments whose charge Jeebly hasn't given yet (newest first). */
export function shipmentsWithoutCharge(limit = 2000): Array<{ orderId: string; awb: string }> {
  return (
    getDb()
      .prepare(
        `SELECT o.id AS orderId, json_extract(o.data, '$.courier.awbNumber') AS awb FROM orders o
         WHERE json_extract(o.data, '$.courier.provider') = 'jeebly' AND COALESCE(json_extract(o.data, '$.courier.awbNumber'), '') <> ''
           AND COALESCE(json_extract(o.data, '$.courier.simulated'), 0) = 0 AND json_extract(o.data, '$.courier.testKind') IS NULL
           AND COALESCE(json_extract(o.data, '$.courier.carrierEnv'), 'live') = 'live'
           AND NOT EXISTS (SELECT 1 FROM courier_charges c WHERE c.carrier = 'jeebly' AND c.awb = json_extract(o.data, '$.courier.awbNumber'))
         ORDER BY o.created_at DESC LIMIT ?`
      )
      .all(limit) as Array<{ orderId: string; awb: string }>
  );
}

const SYNC_KEY = 'courier-charges:sync';
interface SyncState {
  at: string;
  checked: number;
  found: number;
  waiting: number;
  /** AWB → when it was last asked, so each is asked at most once a day. */
  asked: Record<string, string>;
}

export function syncState(): Omit<SyncState, 'asked'> | null {
  const s = kvGet<SyncState>(SYNC_KEY)?.data;
  return s ? { at: s.at, checked: s.checked, found: s.found, waiting: s.waiting } : null;
}

/**
 * Ask Jeebly about shipments with no charge yet (past ones included), a few at a time: each at most
 * once a day, at most `max` per run (every 15 minutes with the shop's checks, or "Check Jeebly now").
 */
export async function syncJeeblyCharges({ max = 20, force = false }: { max?: number; force?: boolean } = {}): Promise<{ checked: number; found: number; waiting: number }> {
  const { getSettings } = await import('./settings');
  const s = getSettings('courier').jeebly;
  const waiting = shipmentsWithoutCharge();
  const prev = kvGet<SyncState>(SYNC_KEY)?.data;
  const asked: Record<string, string> = {};
  const dayAgo = Date.now() - 24 * 3600_000;
  for (const [awb, at] of Object.entries(prev?.asked ?? {})) if (Date.parse(at) > dayAgo && waiting.some((w) => w.awb === awb)) asked[awb] = at;
  let checked = 0;
  let found = 0;
  if (s.liveBaseUrl && s.apiKey && s.clientKey) {
    const { getOrder } = await import('./orders');
    const { jeeblyTrackingFor } = await import('./jeeblyOps');
    for (const w of waiting) {
      if (checked >= max) break;
      if (!force && asked[w.awb]) continue;
      const order = getOrder(w.orderId);
      if (!order) continue;
      checked++;
      asked[w.awb] = new Date().toISOString();
      await jeeblyTrackingFor(order, { fresh: true });
      if (existing('jeebly', w.awb)) found++;
    }
  }
  const left = shipmentsWithoutCharge().length;
  kvSet(SYNC_KEY, { at: new Date().toISOString(), checked, found, waiting: left, asked } satisfies SyncState);
  return { checked, found, waiting: left };
}

/** Money → Courier charges: the totals, the newest charges and the sync state. */
export function courierChargesView({ from, to }: { from?: string; to?: string } = {}) {
  const where = from && to ? 'WHERE charged_on BETWEEN ? AND ?' : '';
  const args = from && to ? [from, to] : [];
  const sum = getDb().prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_fils), 0) AS fils FROM courier_charges ${where}`).get(...args) as { n: number; fils: number };
  const rows = (getDb().prepare(`SELECT * FROM courier_charges ${where} ORDER BY charged_on DESC, awb DESC LIMIT 200`).all(...args) as Row[]).map(fromRow);
  return { count: sum.n, totalFils: sum.fils, charges: rows, waiting: shipmentsWithoutCharge().length, sync: syncState() };
}
