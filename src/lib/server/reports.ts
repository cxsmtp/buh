import fs from 'node:fs';
import path from 'node:path';
import type { Order, PaymentMethod } from '@/types';
import { dubaiDateOf, dubaiToday, twelveMonthsTo } from '@/lib/reportPeriods';
import { auditExportChunks, iterAuditEntries, verificationText } from './auditView';
import { audit, auditFiles, auditOrThrow, verifyAllAuditLogs } from './audit';
import { takeExportLock } from './exportLock';
import { aedText, csvHead, csvRow, toCsv } from './csv';
import { dataDir, dataFile } from './dataDir';
import { diskRoomProblem } from './diskRoom';
import { activeBillBytes, activeBillCount, billFile, EXPENSE_CSV_HEADERS, expenseCsvRow, expenseTotals, iterExpenses, type Expense } from './expenses';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { allOrders, backfillRefundLedger, refundLedger, type RefundRow } from './orders';
import { PALETTE } from '@/lib/design/tokens';
import { ZipWriter } from './zip';
import { vatInUse, vatReturnCsv, vatSettings } from './vat';

/**
 * Money → Reports: sales, refunds, expenses and profit for a period (UAE dates), and the ZIP for
 * the accountant. All sums are whole fils from the server's own records (an order's total as the
 * server computed it, Stripe's word for card payments and refunds, the expenses as entered).
 *
 * What counts as a sale: an order placed in the period, unless it was cancelled before any money
 * was taken, is still waiting for its card payment, or was paid in Stripe's test mode. A card order
 * paid and later refunded counts as a sale (when placed) and as a refund (on the day each refund
 * was made, from the refunds ledger: a partial refund in one month and the rest in another are
 * booked in each; a refund that failed afterwards comes off on the day it failed). Cancelled
 * orders are in sales.csv, marked as not counted, with the reason.
 *
 * The shop is not VAT-registered: no VAT is added or reported. The 12-month sales are shown
 * against the AED 375,000 mandatory registration threshold, with a warning from 80%.
 */

export const VAT_THRESHOLD_FILS = 375_000 * 100;
export const VAT_WARN_RATIO = 0.8;

const fils = (aed: number | undefined) => Math.round((aed ?? 0) * 100);

export interface OrderClass {
  counted: boolean;
  /** Why not counted ('' when counted). */
  reason: string;
  paid: boolean;
}

/** How an order counts in the books (see the comment at the top). */
export function classifyOrder(o: Order): OrderClass {
  const card = o.paymentMethod === 'online_card' ? o.card : undefined;
  const cardTaken = card ? fils(card.paidAmount) > 0 && ['paid', 'refund_pending', 'refunded'].includes(card.state) : false;
  const paid =
    o.paymentMethod === 'online_card'
      ? cardTaken
      : o.paymentMethod === 'bank_transfer'
      ? o.bankTransfer?.state === 'paid' || o.paymentStatus === 'verified' || o.paymentStatus === 'paid'
      : o.paymentStatus === 'paid' || o.paymentStatus === 'verified';
  let reason = '';
  if (card?.mode === 'test') reason = 'Stripe test mode (not real money)';
  else if (o.status === 'pending_payment') reason = 'waiting for the card payment';
  else if (o.status === 'cancelled' && !cardTaken) reason = 'cancelled';
  return { counted: !reason, reason, paid };
}

/** A refund from the ledger, with its UAE date and whether it counts (not a Stripe test payment). */
export interface BookedRefund extends RefundRow {
  date: string;
  counted: boolean;
  /** Why not counted ('' when counted). */
  reason: string;
}

/**
 * The refunds of these orders, from the ledger, by the day each was made. Orders refunded before
 * the ledger existed are filled in first (once; their dates are the best known ones, marked
 * approximate). A refund is never dated by the day its order was placed.
 */
export function bookedRefunds(orders: Order[]): BookedRefund[] {
  try {
    backfillRefundLedger();
  } catch (err) {
    // The report still shows what the ledger has; the upkeep tries again every minute.
    logEvent('warn', 'refund_ledger_fill_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const byId = new Map(orders.map((o) => [o.id, o]));
  const out: BookedRefund[] = [];
  for (const r of refundLedger()) {
    const o = byId.get(r.orderId);
    if (!o) continue;
    const reason = o.card?.mode === 'test' ? 'Stripe test mode (not real money)' : '';
    out.push({ ...r, date: dubaiDateOf(r.at), counted: !reason, reason });
  }
  return out;
}

export interface MethodTotals {
  orders: number;
  fils: number;
  paidOrders: number;
  paidFils: number;
}

export interface VatStatus {
  /** Settings → Payments → VAT is on (the shop says it is VAT-registered). */
  registered: boolean;
  from: string;
  to: string;
  salesFils: number;
  thresholdFils: number;
  ratio: number;
  level: 'ok' | 'near' | 'over';
  text: string;
}

export interface Report {
  from: string;
  to: string;
  generatedAt: string;
  sales: { orders: number; itemsFils: number; deliveryFils: number; codFeeFils: number; cardFeeFils: number; discountFils: number; grossFils: number; paidFils: number; unpaidFils: number };
  refunds: { count: number; fils: number };
  netSalesFils: number;
  byMethod: Record<PaymentMethod, MethodTotals>;
  card: { paidCount: number; paidFils: number; refundedFils: number };
  expenses: { count: number; fils: number; byCategory: Array<{ id: string; name: string; count: number; fils: number }>; byMethod: Record<string, { count: number; fils: number }> };
  profitFils: number;
  excluded: { cancelled: number; awaitingCard: number; testMode: number };
  notes: string[];
  vat: VatStatus;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A period from the query (UAE dates, from ≤ to, at most 3 years), or 400. */
export function parsePeriod(from: unknown, to: unknown): { from: string; to: string } {
  const ok = (d: unknown) => typeof d === 'string' && DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!ok(from) || !ok(to)) throw new HttpError(400, 'Choose the dates of the report (YYYY-MM-DD).');
  if ((from as string) > (to as string)) throw new HttpError(400, 'The report starts after it ends.');
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 3 * 366 * 86_400_000) throw new HttpError(400, 'A report covers at most 3 years.');
  if ((from as string) < '2015-01-01') throw new HttpError(400, 'The report starts too early.');
  return { from: from as string, to: to as string };
}

const inPeriod = (date: string, from: string, to: string) => date >= from && date <= to;

/** Net sales (counted orders placed, less refunds made) in a period: for the VAT threshold. */
function netSales(orders: Order[], refunds: BookedRefund[], from: string, to: string): number {
  let n = 0;
  for (const o of orders) if (classifyOrder(o).counted && inPeriod(dubaiDateOf(o.createdAt), from, to)) n += fils(o.total);
  for (const r of refunds) if (r.counted && inPeriod(r.date, from, to)) n -= r.amountFils;
  return n;
}

/** The last 12 months' sales against the mandatory VAT registration threshold. */
export function vatStatus(now = Date.now(), orders: Order[] = allOrders(), refunds: BookedRefund[] = bookedRefunds(orders)): VatStatus {
  const { from, to } = twelveMonthsTo(dubaiToday(now));
  const salesFils = netSales(orders, refunds, from, to);
  const ratio = salesFils / VAT_THRESHOLD_FILS;
  const level = ratio >= 1 ? 'over' : ratio >= VAT_WARN_RATIO ? 'near' : 'ok';
  const pct = Math.floor(ratio * 100);
  const vat = vatSettings();
  if (vat.enabled) {
    const text = `VAT-registered (TRN ${vat.trn}) from ${vat.effectiveFrom}: orders from then carry 5% VAT (Money → VAT return). Sales in the last 12 months: AED ${aedText(salesFils)}.`;
    return { registered: true, from, to, salesFils, thresholdFils: VAT_THRESHOLD_FILS, ratio, level: 'ok', text };
  }
  const text =
    level === 'over'
      ? `Sales in the last 12 months (AED ${aedText(salesFils)}) are over AED 375,000: VAT registration is mandatory. Talk to your accountant now (registration is due within 30 days).`
      : level === 'near'
      ? `Sales in the last 12 months are AED ${aedText(salesFils)}, ${pct}% of the AED 375,000 VAT registration threshold. Talk to your accountant about registering.`
      : `Not VAT-registered. Sales in the last 12 months: AED ${aedText(salesFils)} (${pct}% of the AED 375,000 registration threshold).`;
  return { registered: false, from, to, salesFils, thresholdFils: VAT_THRESHOLD_FILS, ratio, level, text };
}

export function buildReport(from: string, to: string, now = Date.now()): Report {
  const orders = allOrders();
  const booked = bookedRefunds(orders);
  const methods: PaymentMethod[] = ['cod', 'bank_transfer', 'online_card'];
  const byMethod = Object.fromEntries(methods.map((m) => [m, { orders: 0, fils: 0, paidOrders: 0, paidFils: 0 }])) as Record<PaymentMethod, MethodTotals>;
  const sales = { orders: 0, itemsFils: 0, deliveryFils: 0, codFeeFils: 0, cardFeeFils: 0, discountFils: 0, grossFils: 0, paidFils: 0, unpaidFils: 0 };
  const refunds = { count: 0, fils: 0 };
  const card = { paidCount: 0, paidFils: 0, refundedFils: 0 };
  const excluded = { cancelled: 0, awaitingCard: 0, testMode: 0 };
  const notes: string[] = [];
  let outside = 0;
  for (const o of orders) {
    const c = classifyOrder(o);
    const placedIn = inPeriod(dubaiDateOf(o.createdAt), from, to);
    if (placedIn && !c.counted) {
      if (c.reason === 'cancelled') excluded.cancelled++;
      else if (c.reason.startsWith('waiting')) excluded.awaitingCard++;
      else excluded.testMode++;
    }
    if (placedIn && c.counted) {
      const total = fils(o.total);
      sales.orders++;
      sales.itemsFils += fils(o.subtotal);
      sales.deliveryFils += fils(o.deliveryFee);
      sales.codFeeFils += fils(o.codFee);
      // The card payment fee is the shop's income (part of the total the customer paid).
      sales.cardFeeFils += fils(o.cardFee ?? 0);
      sales.discountFils += fils(o.discount);
      sales.grossFils += total;
      if (c.paid) sales.paidFils += total;
      else sales.unpaidFils += total;
      const m = byMethod[o.paymentMethod] ?? (byMethod[o.paymentMethod] = { orders: 0, fils: 0, paidOrders: 0, paidFils: 0 });
      m.orders++;
      m.fils += total;
      if (c.paid) {
        m.paidOrders++;
        m.paidFils += total;
      }
      if (o.paymentMethod === 'online_card' && c.paid) {
        card.paidCount++;
        card.paidFils += fils(o.card?.paidAmount);
      }
      if (o.card?.refundOutsideAt) outside++;
    }
  }
  // Refunds by the day the money went back (a failed one comes off on the day it failed).
  let reversed = 0;
  let reversedFils = 0;
  let approx = 0;
  for (const r of booked) {
    if (!r.counted || !inPeriod(r.date, from, to)) continue;
    if (r.amountFils > 0) refunds.count++;
    else {
      reversed++;
      reversedFils -= r.amountFils;
    }
    if (r.dateApprox) approx++;
    refunds.fils += r.amountFils;
    card.refundedFils += r.amountFils;
  }
  if (reversed) notes.push(`${reversed} card refund${reversed === 1 ? '' : 's'} failed after being made: AED ${aedText(reversedFils)} came back to the shop and is taken off the refunds.`);
  if (approx) notes.push(`${approx} refund${approx === 1 ? ' was' : 's were'} made before refunds were recorded one by one: ${approx === 1 ? 'its date is' : 'their dates are'} the best known (refunds.csv says "approximate").`);
  if (outside) notes.push(`${outside} card order${outside === 1 ? ' was' : 's were'} cancelled with the refund to be made in the Stripe dashboard: check those refunds there.`);
  if (card.paidCount) notes.push('Card payments: Stripe’s fees and payouts to your bank are in your Stripe dashboard (Balance → Payouts); add the fees here as an expense (Bank & card charges) from Stripe’s monthly statement.');
  if (sales.unpaidFils) notes.push(`AED ${aedText(sales.unpaidFils)} of these sales is not marked as paid yet (cash on delivery not collected, or a transfer not yet checked).`);

  // Summed by the database: every expense of the period, however many.
  const expenses = expenseTotals({ from, to });
  const netSalesFils = sales.grossFils - refunds.fils;
  return {
    from,
    to,
    generatedAt: new Date(now).toISOString(),
    sales,
    refunds,
    netSalesFils,
    byMethod,
    card,
    expenses,
    profitFils: netSalesFils - expenses.fils,
    excluded,
    notes,
    vat: vatStatus(now, orders, booked),
  };
}

// ── The financial year's start ──────────────────────────────────────────────

/** The month (1–12) the financial year starts in: January (the calendar year) unless the owner chose another. */
export function yearStartMonth(): number {
  const m = kvGet<{ yearStartMonth?: number }>('reports:settings')?.data?.yearStartMonth;
  return Number.isInteger(m) && (m as number) >= 1 && (m as number) <= 12 ? (m as number) : 1;
}

export function setYearStartMonth(month: unknown): number {
  if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12) throw new HttpError(400, 'The financial year starts in a month from 1 (January) to 12 (December).');
  kvSet('reports:settings', { yearStartMonth: month });
  return month as number;
}

// ── The accountant's ZIP ────────────────────────────────────────────────────

const METHOD: Record<string, string> = { cod: 'Cash on delivery', bank_transfer: 'Bank transfer', online_card: 'Card (Stripe)' };
const EXPENSE_METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', other: 'Other' };

const slug = (s: string) => s.normalize('NFKD').replace(/&/g, 'and').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 30) || 'other';

/** bills/<date>_<category>_<amount>_<id>.<ext> (and -2, -3… for an expense's further bills). */
export function billZipNames(e: Expense): string[] {
  return e.bills.filter((b) => !b.removed).map((b, i) => `bills/${e.date}_${slug(e.category)}_${aedText(e.amountFils)}_${e.id}${i ? `-${i + 1}` : ''}.${b.ext}`);
}

function paymentRef(o: Order): string {
  return o.card?.ref || o.bankTransferRef || '';
}

function paymentStatusText(o: Order): string {
  if (o.paymentMethod === 'online_card') return o.card?.state ?? o.paymentStatus;
  if (o.paymentMethod === 'bank_transfer') return o.bankTransfer?.state ?? o.paymentStatus;
  return o.paymentStatus;
}

function salesCsv(orders: Order[], refunds: BookedRefund[]): string {
  // Each order's refunds so far (all of them, whenever made), the last one's date.
  const refundOf = new Map<string, { fils: number; date: string; approx: boolean }>();
  for (const r of refunds) {
    if (!r.counted) continue;
    const t = refundOf.get(r.orderId) ?? { fils: 0, date: '', approx: false };
    t.fils += r.amountFils;
    if (r.amountFils > 0) t.date = r.date;
    t.approx ||= r.dateApprox;
    refundOf.set(r.orderId, t);
  }
  return toCsv(
    ['date', 'order_number', 'customer_name', 'emirate', 'items', 'quantity', 'items_aed', 'delivery_fee_aed', 'cod_fee_aed', 'discount_aed', 'total_aed', 'payment_method', 'payment_status', 'payment_ref', 'paid', 'refund_aed', 'refund_date', 'order_status', 'courier', 'awb', 'counted_in_sales', 'not_counted_because', 'placed_at_utc', 'refund_date_approximate', 'card_fee_aed'],
    orders.map((o) => {
      const c = classifyOrder(o);
      const refund = refundOf.get(o.id);
      return [
        dubaiDateOf(o.createdAt), o.id, o.customer.fullName, o.customer.emirate,
        o.items.map((i) => `${i.title} (${i.profileName}${i.color ? `, ${i.color}` : ''}) x${i.quantity}`).join('; '),
        o.items.reduce((n, i) => n + i.quantity, 0),
        aedText(fils(o.subtotal)), aedText(fils(o.deliveryFee)), aedText(fils(o.codFee)), aedText(fils(o.discount)), aedText(fils(o.total)),
        METHOD[o.paymentMethod] ?? o.paymentMethod, paymentStatusText(o), paymentRef(o), c.paid ? 'yes' : 'no',
        refund?.fils ? aedText(refund.fils) : '', refund?.fils ? refund.date : '', o.status,
        o.courier?.provider ?? '', o.courier?.simulated ? '' : (o.courier?.awbNumber ?? ''),
        c.counted ? 'yes' : 'no', c.reason, o.createdAt, refund?.fils && refund.approx ? 'yes' : '', aedText(fils(o.cardFee ?? 0)),
      ];
    })
  );
}

const SOURCE: Record<RefundRow['source'], string> = { hub: 'Admin Hub', stripe: 'Stripe' };

/** One row per refund (and per refund that failed afterwards) made in the period. */
function refundsCsv(refunds: BookedRefund[]): string {
  return toCsv(
    ['date', 'order_number', 'amount_aed', 'kind', 'made_in', 'stripe_refund_id', 'at_utc', 'date_approximate', 'counted_in_refunds', 'not_counted_because'],
    refunds.map((r) => [r.date, r.orderId, aedText(r.amountFils), r.amountFils > 0 ? 'refund' : 'refund failed (money back to the shop)', SOURCE[r.source] ?? r.source, r.stripeRefundId ?? '', r.at, r.dateApprox ? 'approximate' : '', r.counted ? 'yes' : 'no', r.reason])
  );
}

function orderItemsCsv(orders: Order[]): string {
  return toCsv(
    ['date', 'order_number', 'product_id', 'item', 'size', 'colour', 'unit_price_aed', 'quantity', 'line_total_aed', 'counted_in_sales'],
    orders.flatMap((o) => {
      const counted = classifyOrder(o).counted ? 'yes' : 'no';
      return o.items.map((i) => [dubaiDateOf(o.createdAt), o.id, i.productId, i.title, i.profileName, i.color ?? '', aedText(fils(i.unitPrice)), i.quantity, aedText(fils(i.totalPrice)), counted]);
    })
  );
}

function summaryRows(r: Report): Array<[string, string, string | number, string]> {
  const rows: Array<[string, string, string | number, string]> = [
    ['Period', `${r.from} to ${r.to} (UAE dates)`, '', ''],
    ['Sales', 'Orders counted', r.sales.orders, ''],
    ['Sales', 'Items', '', aedText(r.sales.itemsFils)],
    ['Sales', 'Delivery charges', '', aedText(r.sales.deliveryFils)],
    ['Sales', 'Cash-on-delivery fees', '', aedText(r.sales.codFeeFils)],
    ['Sales', 'Card fees (card payment fee charged to customers)', '', aedText(r.sales.cardFeeFils)],
    ['Sales', 'Discounts', '', aedText(-r.sales.discountFils)],
    ['Sales', 'Gross sales', r.sales.orders, aedText(r.sales.grossFils)],
    ['Sales', 'Refunds', r.refunds.count, aedText(-r.refunds.fils)],
    ['Sales', 'Net sales', '', aedText(r.netSalesFils)],
    ['Sales', 'of which not marked paid yet', '', aedText(r.sales.unpaidFils)],
  ];
  for (const [m, t] of Object.entries(r.byMethod)) rows.push(['Payment method', `${METHOD[m] ?? m} (paid: ${t.paidOrders}, AED ${aedText(t.paidFils)})`, t.orders, aedText(t.fils)]);
  rows.push(['Card (Stripe)', 'Payments taken', r.card.paidCount, aedText(r.card.paidFils)], ['Card (Stripe)', 'Refunded', '', aedText(r.card.refundedFils)]);
  for (const c of r.expenses.byCategory) rows.push(['Expenses', c.name, c.count, aedText(c.fils)]);
  for (const [m, t] of Object.entries(r.expenses.byMethod)) rows.push(['Expenses paid by', EXPENSE_METHOD[m] ?? m, t.count, aedText(t.fils)]);
  rows.push(
    ['Expenses', 'Total expenses', r.expenses.count, aedText(r.expenses.fils)],
    ['Result', 'Profit (net sales less expenses)', '', aedText(r.profitFils)],
    ['Not counted', 'Cancelled orders', r.excluded.cancelled, ''],
    ['Not counted', 'Waiting for card payment', r.excluded.awaitingCard, ''],
    ['Not counted', 'Stripe test mode', r.excluded.testMode, ''],
    r.vat.registered
      ? ['VAT', `VAT-registered. Sales ${r.vat.from} to ${r.vat.to}`, '', aedText(r.vat.salesFils)]
      : ['VAT', `Not VAT-registered. Sales ${r.vat.from} to ${r.vat.to}`, `${Math.floor(r.vat.ratio * 100)}% of AED 375,000`, aedText(r.vat.salesFils)],
  );
  for (const n of r.notes) rows.push(['Note', n, '', '']);
  return rows;
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function summaryHtml(r: Report, shop: string): string {
  const rows = summaryRows(r)
    .map(([section, item, count, amount]) => `<tr><td>${esc(section)}</td><td>${esc(item)}</td><td class="n">${esc(count)}</td><td class="n">${esc(amount)}</td></tr>`)
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(shop)} — accounts ${esc(r.from)} to ${esc(r.to)}</title>
<style>
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:${PALETTE.ink};margin:24px;max-width:860px}
h1{font-size:20px;margin:0 0 4px}p{margin:4px 0 12px;color:${PALETTE['ink-soft']}}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid ${PALETTE.line};padding:6px 8px;text-align:left;vertical-align:top}
th{background:${PALETTE.sand}}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
@media print{body{margin:0}}
</style></head><body>
<h1>${esc(shop)}: sales and expenses</h1>
<p>${esc(r.from)} to ${esc(r.to)} (UAE dates). Amounts in AED. Made ${esc(r.generatedAt.slice(0, 16).replace('T', ' '))} UTC. To save as PDF: Print → Save as PDF.</p>
<p><strong>${esc(r.vat.text)}</strong></p>
<table><thead><tr><th>Section</th><th>Item</th><th class="n">Count</th><th class="n">AED</th></tr></thead><tbody>
${rows}
</tbody></table>
</body></html>
`;
}

function readme(r: Report, shop: string, bills: number, auditCount: number, verification: string[]): string {
  return [
    `${shop}: accounts for ${r.from} to ${r.to} (UAE dates, Asia/Dubai)`,
    `Made ${r.generatedAt} (UTC) from the shop's own records. Amounts are in AED with 2 decimals.`,
    '',
    'Files',
    '  summary.html     The totals, printable (open it, then Print → Save as PDF).',
    '  summary.csv      The same totals, for Excel.',
    '  sales.csv        One row per order placed in the period, cancelled ones too ("counted_in_sales" says',
    '                   whether it is in the totals, and why not). Customer name and emirate only.',
    '  order-items.csv  One row per item of those orders.',
    '  refunds.csv      One row per refund to a card made in the period (by the day it was made), and per',
    '                   refund that failed afterwards (a negative amount). "approximate": refunded before',
    '                   refunds were recorded one by one, so the date is the best known.',
    '  expenses.csv     Every expense dated in the period. Removed ones are listed with who removed them,',
    '                   when and why, and are not in the totals. "bills" names the files in bills/.',
    `  bills/           ${bills} photo${bills === 1 ? '' : 's'} or PDF${bills === 1 ? '' : 's'} of the bills, named date_category_amount_expense.ext.`,
    `  audit-log.jsonl  The shop's audit log for the period (${auditCount} entries): every sale, payment, refund,`,
    '                   stock move, price change, expense, sign-in and export, one JSON object per line.',
    '                   Each entry is signed (HMAC-SHA256) and linked to the one before it, so a changed,',
    '                   removed or reordered entry shows. Customer phone numbers and emails are masked.',
    '  audit-check.txt  The result of checking those signatures and links on the shop\'s server.',
    '',
    'How sales are counted',
    '  An order counts when it is placed, unless it was cancelled before any money was taken, is still',
    '  waiting for its card payment, or was a Stripe test payment. A card payment refunded later counts as a',
    '  sale (when placed) and as a refund (on the day each refund was made). Cash on delivery and bank transfers not yet marked',
    '  as received are in the totals and shown as "not marked paid yet".',
    '  The card payment fee customers pay on card orders is part of each order\'s total and is the shop\'s',
    '  income: card_fee_aed in sales.csv, "Card fees" in the summary (Stripe\'s own fees are in Stripe).',
    '',
    'VAT',
    `  ${r.vat.text}`,
    ...(r.vat.registered
      ? ['  Order totals include VAT. vat-return.csv: tax invoices, credit notes and expenses with VAT for the period, with the totals.']
      : ['  No VAT is charged or included in these figures.']),
    '',
    'Audit log check',
    ...verification.map((l) => `  ${l}`),
    '',
  ].join('\r\n');
}

export interface ExportResult {
  file: string;
  name: string;
  orders: number;
  expenses: number;
  bills: number;
  auditEntries: number;
}

/** The export's disk guard: it is made only if the disk keeps this much free after it. (Changeable by tests only.) */
export const EXPORT_LIMITS = { minFreeBytes: 1024 ** 3 };

function exportsDir(): string {
  const dir = path.join(dataDir(), 'exports');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A download that never finished leaves its file: anything older than an hour goes.
  for (const f of fs.readdirSync(dir)) {
    try {
      if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 3600_000) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      // removed meanwhile
    }
  }
  return dir;
}

/** About how big the ZIP will be: the bills as they are, the audit months it reads, and the rest. */
function estimatedSize(from: string, to: string, orders: number): number {
  let audit = 0;
  const first = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 7);
  for (const f of auditFiles()) {
    const month = f.slice(6, 13);
    if (month < first || month > to.slice(0, 7)) continue;
    try {
      audit += fs.statSync(dataFile(f)).size;
    } catch {
      // removed meanwhile
    }
  }
  return activeBillBytes({ from, to }) + audit + orders * 2048 + 4 * 1024 ** 2;
}

/**
 * Write the accountant's ZIP for a period to a private temporary file (DATA_DIR/exports/, never in
 * backups), one entry at a time and asynchronously: bills are copied a piece at a time, the
 * expenses and the audit log are streamed (all of them, however many), and the shop keeps
 * answering in between. Refused (507) when the disk would be left with too little room. The caller
 * streams the file and removes it.
 */
export async function writeAccountantZip(from: string, to: string, shop = 'Beautiful UAE Home', now = Date.now()): Promise<ExportResult> {
  const report = buildReport(from, to, now);
  const all = allOrders();
  const orders = all.filter((o) => inPeriod(dubaiDateOf(o.createdAt), from, to)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const refunds = bookedRefunds(all).filter((r) => inPeriod(r.date, from, to));
  const dir = exportsDir();
  const room = diskRoomProblem(dir, estimatedSize(from, to, orders.length), EXPORT_LIMITS.minFreeBytes);
  if (room) {
    logEvent('warn', 'export_refused_no_room', { from, to, why: room });
    throw new HttpError(507, `The export can't be made right now: ${room}. Free some space on the server and try again.`, {}, { code: 'no_room' });
  }
  const billCount = activeBillCount({ from, to });
  let auditCount = 0;
  for (const _ of iterAuditEntries({ from, to })) {
    void _;
    auditCount++;
  }
  const verification = verifyAllAuditLogs();
  const name = `accounts_${from}_to_${to}.zip`;
  const file = path.join(dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  const zip = await ZipWriter.create(file);
  let bills = 0;
  let expenses = 0;
  try {
    await zip.add('README.txt', Buffer.from(readme(report, shop, billCount, auditCount, verificationText(verification))));
    await zip.add('summary.html', Buffer.from(summaryHtml(report, shop)));
    await zip.add('summary.csv', Buffer.from(toCsv(['section', 'item', 'count', 'amount_aed'], summaryRows(report))));
    await zip.add('sales.csv', Buffer.from(salesCsv(orders, bookedRefunds(all))));
    await zip.add('order-items.csv', Buffer.from(orderItemsCsv(orders)));
    await zip.add('refunds.csv', Buffer.from(refundsCsv(refunds)));
    // With VAT on (or tax invoices issued before): the VAT return helper for the period.
    if (vatInUse()) await zip.add('vat-return.csv', Buffer.from(vatReturnCsv(from, to)));
    await zip.addStream(
      'expenses.csv',
      (function* () {
        yield csvHead(EXPENSE_CSV_HEADERS);
        let chunk = '';
        for (const e of iterExpenses({ from, to, includeRemoved: true })) {
          expenses++;
          chunk += csvRow(expenseCsvRow(e, e.removed ? [] : billZipNames(e).map((n) => n.slice('bills/'.length))));
          if (chunk.length > 64 * 1024) {
            yield chunk;
            chunk = '';
          }
        }
        if (chunk) yield chunk;
      })()
    );
    for (const e of iterExpenses({ from, to })) {
      const names = billZipNames(e);
      const active = e.bills.filter((b) => !b.removed);
      for (let i = 0; i < active.length; i++) {
        let source: string;
        try {
          source = billFile(active[i]);
          fs.accessSync(source, fs.constants.R_OK);
        } catch {
          continue; // missing on disk: the expense row still names it
        }
        await zip.addFile(names[i], source, { mtime: new Date(active[i].addedAt) });
        bills++;
      }
    }
    await zip.addStream('audit-log.jsonl', auditExportChunks(iterAuditEntries({ from, to }), 'jsonl'));
    await zip.add(
      'audit-check.txt',
      Buffer.from(
        [
          `Checked ${new Date(now).toISOString()} on the shop's server (every month of the log, not only this period). This server's key id: ${verification.keyId}.`,
          ...verificationText(verification),
          '',
          ...verification.months.map((m) => `${m.file}: ${m.entries} entries, ${MONTH_STATUS[m.status]}${m.status === 'broken' ? `: ${m.problems.join('; ')}` : m.otherKeys.length ? ` (key ${m.otherKeys.join(', ')})` : ''}`),
          '',
        ].join('\r\n')
      )
    );
    await zip.close();
  } catch (err) {
    await zip.abort();
    fs.rmSync(file, { force: true });
    throw err;
  }
  return { file, name, orders: orders.length, expenses, bills, auditEntries: auditCount };
}

const MONTH_STATUS: Record<string, string> = { intact: 'ok', other_key: "signed by another server's key (restored from a backup)", unverified: 'unverified (made before key ids)', broken: 'BROKEN' };

/**
 * The export as the hub asks for it: one at a time (429 otherwise), who exported which period
 * written to the audit log first (no entry, no export), and a build that then fails written too
 * (report.export_failed). The caller streams the file, then calls release() and removes it.
 */
export async function prepareAccountantExport(by: string, from: string, to: string, shop = 'Beautiful UAE Home'): Promise<ExportResult & { release: () => void }> {
  const release = takeExportLock();
  try {
    auditOrThrow('report.exported', { by, from, to, what: 'accountant zip' });
    try {
      return { ...(await writeAccountantZip(from, to, shop)), release };
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      audit('report.export_failed', { by, from, to, error });
      logEvent('error', 'report_export_failed', { from, to, error });
      throw err;
    }
  } catch (err) {
    release();
    throw err;
  }
}
