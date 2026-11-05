import { dubaiDateOf } from '@/lib/reportPeriods';
import type { Order } from '@/types';
import { auditedTransaction } from './audit';
import { getDb } from './db';
import { HttpError } from './http';
import { bump } from './live';
import { logEvent } from './log';
import { emailConfigured, mailConfig, sender, transport } from './mail';
import { creditInFils, dueOnDeliveryFils } from '@/lib/orderMoney';
import { getOrder, isCustomerEmail } from './orders';
import { PdfDoc, type RGB } from './pdf/pdf';
import { mac } from './secrets';
import { contactEmail, getSettings } from './settings';
import { customerLink } from './runtimeConfig';
import { invoiceFor, orderVat, syncVatDocuments } from './vat';

/**
 * The customer's PDF invoice (asked by the owner: "once the confirmation is done and the order is
 * dispatched, give me the option to send the invoice to the customer… as per the UAE law… an
 * electronic invoice").
 *
 * - One invoice per order, issued by the owner's tap once the order is confirmed (on WhatsApp, by
 *   call, or moved on) and not cancelled. Numbered INV-<year>-<6 digits> in order of issue, never
 *   reused, taken under the database's write lock (no gaps, no doubles) and audited in the same
 *   transaction. Tapping again gives the same invoice.
 * - The shop is not VAT-registered by default: the invoice says so ("not a tax invoice", VAT not
 *   applicable), as a non-registered seller must not issue a tax invoice. With VAT on, the order's
 *   own tax invoice (its number and VAT breakdown from vat.ts) is the PDF instead.
 * - Its content (seller, customer, lines, totals) is kept as issued, so editing the order or the
 *   settings later never changes an invoice already sent. A cancelled order's invoice says so.
 * - The PDF is made on demand from that record (src/lib/server/pdf: no browser, no dependency),
 *   for the hub, the customer's private link (/invoice/<order>.<mac>/pdf) and the email.
 */

type Kind = 'invoice' | 'tax_invoice';

interface Line {
  label: string;
  sku?: string;
  quantity: number;
  unitFils: number;
  totalFils: number;
  vatFils?: number;
}

export interface InvoiceData {
  kind: Kind;
  number: string;
  issuedOn: string;
  supplyOn: string;
  orderId: string;
  seller: { name: string; tradeLicence?: string; authority?: string; address?: string; phone?: string; email?: string; trn?: string };
  buyer: { name: string; phone: string; email?: string; address: string; company?: string; trn?: string };
  lines: Line[];
  subtotalFils: number;
  vat?: { rateBp: number; netFils: number; vatFils: number };
  totalFils: number;
  /**
   * paidFils: what was paid before delivery (card, transfer, or moved from another order);
   * dueFils: what the courier collects on delivery. Absent on invoices issued before BUH-02.36.00.
   */
  payment: { method: Order['paymentMethod']; paid: boolean; paidFils?: number; dueFils?: number; movedInFils?: number; label?: string; reference?: string };
  /** Regenerated ("Regenerate invoice"): the version and the day; the number and issue date stay. */
  revision?: number;
  revisedOn?: string;
}

export interface InvoiceRecord {
  number: string;
  orderId: string;
  kind: Kind;
  issuedAt: string;
  issuedBy: string;
  total: number;
  emailedAt?: string;
  emailedTo?: string;
  sentCount: number;
  /** The customer's private PDF link (path), and its full address when the shop's is set. */
  pdfPath: string;
  pdfUrl?: string;
}

interface Row {
  number: string;
  order_id: string;
  kind: Kind;
  year: number;
  seq: number | null;
  issued_at: string;
  issued_by: string;
  total_fils: number;
  data: string;
  emailed_at: string | null;
  emailed_to: string | null;
  sent_count: number;
}

const fils = (aed: number | undefined) => Math.round((aed ?? 0) * 100);
const money = (f: number) => `${f < 0 ? '-' : ''}${(Math.abs(f) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const BULK_PAY: Record<NonNullable<Order['bulk']>['paidWith'], string> = { cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', cheque: 'Cheque', unpaid: 'Not paid yet' };
const PAY: Record<Order['paymentMethod'], string> = { cod: 'Cash on delivery', bank_transfer: 'Bank transfer', online_card: 'Card' };

/** The customer's private address of an order's PDF invoice (from the server's key, never stored). */
export function invoicePdfPath(orderId: string): string {
  return `/invoice/${orderId}.${mac('order-document', orderId)}/pdf`;
}

function toRecord(r: Row): InvoiceRecord {
  const pdfPath = invoicePdfPath(r.order_id);
  const pdfUrl = customerLink(pdfPath);
  return {
    number: r.number,
    orderId: r.order_id,
    kind: r.kind,
    issuedAt: r.issued_at,
    issuedBy: r.issued_by,
    total: r.total_fils / 100,
    ...(r.emailed_at ? { emailedAt: r.emailed_at } : {}),
    ...(r.emailed_to ? { emailedTo: r.emailed_to } : {}),
    sentCount: r.sent_count,
    pdfPath,
    ...(pdfUrl ? { pdfUrl } : {}),
  };
}

const rowOf = (orderId: string) => getDb().prepare('SELECT * FROM invoices WHERE order_id = ?').get(orderId) as Row | undefined;

/** The invoices of these orders (the hub's list), by order. */
export function invoicesOf(orderIds: string[]): Map<string, InvoiceRecord> {
  const out = new Map<string, InvoiceRecord>();
  if (!orderIds.length) return out;
  const want = new Set(orderIds);
  for (const r of getDb().prepare('SELECT * FROM invoices ORDER BY issued_at DESC LIMIT 5000').all() as Row[]) if (want.has(r.order_id)) out.set(r.order_id, toRecord(r));
  return out;
}

export function invoiceOfOrder(orderId: string): InvoiceRecord | null {
  const r = rowOf(orderId);
  return r ? toRecord(r) : null;
}

/** Why an order can't have its invoice yet, or null. */
export function invoiceBlocker(order: Order): string | null {
  if (order.status === 'cancelled') return 'This order is cancelled: no invoice.';
  const confirmed = ['confirmed', 'dispatched', 'out_for_delivery', 'delivered'].includes(order.status) || order.whatsappCheck?.status === 'confirmed';
  if (!confirmed) return 'Confirm the order first (on WhatsApp, by phone, or move it on): the invoice comes after.';
  if (order.photoOrder && !order.photoOrder.confirmedAt) return 'Confirm the amount of this order from a photo first.';
  return null;
}

/** The seller as the settings say now (frozen into the invoice when it is issued). */
function sellerNow(): InvoiceData['seller'] {
  const store = getSettings('store');
  const brand = getSettings('brand');
  const courier = getSettings('courier');
  const name = store.legalName?.trim() || courier.jeebly?.pickupLocationName?.trim() || brand.storeName || 'Beautiful UAE Home';
  return {
    name,
    ...(store.tradeLicenceNumber?.trim() ? { tradeLicence: store.tradeLicenceNumber.trim() } : {}),
    ...(store.tradeLicenceAuthority?.trim() ? { authority: store.tradeLicenceAuthority.trim() } : {}),
    ...(store.storeAddress?.trim() ? { address: store.storeAddress.trim() } : {}),
    ...(store.whatsappNumber ? { phone: store.whatsappNumber } : {}),
    ...(contactEmail() ? { email: contactEmail() } : {}),
  };
}

function linesOf(order: Order): Line[] {
  const lines: Line[] = order.items.map((i) => ({
    label: `${i.title}${i.profileName ? ` (${i.profileName}${i.color ? `, ${i.color}` : ''})` : ''}`,
    ...(i.sku ? { sku: i.sku } : {}),
    quantity: i.quantity,
    unitFils: fils(i.unitPrice),
    totalFils: fils(i.totalPrice),
  }));
  const extra = (label: string, f: number) => f && lines.push({ label, quantity: 1, unitFils: f, totalFils: f });
  extra(order.deliveryOption === 'same_day' ? 'Delivery (same day)' : 'Delivery', fils(order.deliveryFee));
  extra('Cash-on-delivery fee', fils(order.codFee));
  extra(`Card payment fee${order.cardFeePercent ? ` (${order.cardFeePercent}%)` : ''}`, fils(order.cardFee));
  if (fils(order.discount)) lines.push({ label: 'Discount', quantity: 1, unitFils: -fils(order.discount), totalFils: -fils(order.discount) });
  // The extra the owner added when booking the courier (it is in the total, so it is a line too).
  extra(`Extra charge${order.extraCharge?.note ? ` (${order.extraCharge.note})` : ''}`, fils(order.extraCharge?.amount));
  return lines;
}

/** What was paid before delivery and what is collected on it (src/lib/orderMoney.ts, as the courier is told). */
function paymentOf(order: Order, paid: boolean): InvoiceData['payment'] {
  if (order.bulk) {
    // A bulk order: paid as the owner said (or due), never "on delivery".
    const p = order.bulk.paidWith;
    return { method: order.paymentMethod, paid: p !== 'unpaid', label: BULK_PAY[p], ...(order.bulk.reference ? { reference: order.bulk.reference } : {}), paidFils: p === 'unpaid' ? 0 : fils(order.total), dueFils: 0 };
  }
  const totalFils = fils(order.total);
  const dueFils = order.status === 'delivered' ? 0 : dueOnDeliveryFils(order);
  const movedInFils = creditInFils(order);
  return { method: order.paymentMethod, paid, paidFils: Math.max(0, totalFils - dueFils), dueFils, ...(movedInFils ? { movedInFils } : {}) };
}

function dataFor(order: Order, kind: Kind, number: string, issuedOn: string): InvoiceData {
  const c = order.customer;
  const address = [[c.flatVillaNo, c.buildingVilla].filter(Boolean).join(', '), c.streetAddress, [c.area, c.emirate].filter(Boolean).join(', '), c.landmark ? `Landmark: ${c.landmark}` : ''].filter(Boolean).join('\n');
  const paid = order.paymentStatus === 'paid' || order.paymentStatus === 'verified' || order.card?.state === 'paid' || order.bankTransfer?.state === 'paid' || order.status === 'delivered';
  const base: InvoiceData = {
    kind,
    number,
    issuedOn,
    supplyOn: dubaiDateOf(order.courier.pickupDate ? `${order.courier.pickupDate}T08:00:00Z` : order.createdAt),
    orderId: order.id,
    seller: sellerNow(),
    buyer: { name: c.fullName, phone: c.phone, ...(c.email ? { email: c.email } : {}), address, ...(c.company ? { company: c.company } : {}), ...(c.trn ? { trn: c.trn } : {}) },
    lines: linesOf(order),
    subtotalFils: fils(order.total) - fils(order.vatAdded),
    totalFils: fils(order.total),
    payment: paymentOf(order, paid),
  };
  if (kind === 'tax_invoice') {
    const v = orderVat(order.id)!;
    base.seller = { ...base.seller, name: v.supplier.name || base.seller.name, ...(v.supplier.address ? { address: v.supplier.address } : {}), trn: v.supplier.trn };
    base.vat = { rateBp: v.rateBp, netFils: v.netFils, vatFils: v.vatFils };
    base.totalFils = v.totalFils;
  }
  return base;
}

/**
 * Issue the order's invoice (or give the one already issued). Checked against the order here,
 * numbered under the write lock and audited before it is reported done.
 */
export function issueOrderInvoice(orderId: string, actor: string): { invoice: InvoiceRecord; created: boolean } {
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Order not found.');
  const had = rowOf(orderId);
  if (had) return { invoice: toRecord(had), created: false };
  const blocker = invoiceBlocker(order);
  if (blocker) throw new HttpError(409, blocker, {}, { code: 'invoice_not_yet' });
  if (orderVat(orderId)) {
    try {
      syncVatDocuments(orderId);
    } catch {
      // checked just below
    }
    if (!invoiceFor(orderId)) throw new HttpError(409, 'The tax invoice for this order is not issued yet (it comes once the order is confirmed or paid).', {}, { code: 'tax_invoice_pending' });
  }
  const result = auditedTransaction((auditOrThrow) => {
    const again = rowOf(orderId);
    if (again) return { invoice: toRecord(again), created: false };
    const now = new Date();
    const issuedOn = dubaiDateOf(now.toISOString());
    const year = Number(issuedOn.slice(0, 4));
    const tax = orderVat(orderId) ? invoiceFor(orderId) : null;
    let number: string;
    let seq: number | null = null;
    if (tax) number = tax.number;
    else {
      seq = ((getDb().prepare('SELECT MAX(seq) FROM invoices WHERE year = ?').pluck().get(year) as number | null) ?? 0) + 1;
      number = `INV-${year}-${String(seq).padStart(6, '0')}`;
    }
    const kind: Kind = tax ? 'tax_invoice' : 'invoice';
    const data = dataFor(getOrder(orderId)!, kind, number, tax ? tax.issuedOn : issuedOn);
    getDb()
      .prepare('INSERT INTO invoices (number, order_id, kind, year, seq, issued_at, issued_by, total_fils, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(number, orderId, kind, year, seq, now.toISOString(), actor, data.totalFils, JSON.stringify(data));
    auditOrThrow('invoice.issued', { by: actor, orderId, number, kind, totalFils: data.totalFils });
    return { invoice: toRecord(rowOf(orderId)!), created: true };
  });
  if (result.created) bump('orders');
  return result;
}

/**
 * "Regenerate invoice": the same number and issue date, its content made again from the order and
 * the settings as they are now (after a correction to the order, the address, the legal name…).
 * The earlier version is kept in invoice_revisions as it was sent; the PDF says "Revised". Audited
 * in the same transaction. Not for a tax invoice (VAT: a correction needs a credit note) or a
 * cancelled order. Nothing changed: the invoice stays as it is.
 */
export function regenerateOrderInvoice(orderId: string, actor: string): { invoice: InvoiceRecord; changed: boolean } {
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Order not found.');
  const had = rowOf(orderId);
  if (!had) throw new HttpError(409, 'This order has no invoice yet: make it first.', {}, { code: 'no_invoice' });
  if (had.kind === 'tax_invoice') throw new HttpError(409, 'A tax invoice can’t be regenerated: a correction to it is a credit note (Money → VAT).', {}, { code: 'tax_invoice' });
  if (order.status === 'cancelled') throw new HttpError(409, 'This order is cancelled: its invoice stays as it was.', {}, { code: 'cancelled' });
  const result = auditedTransaction((auditOrThrow) => {
    const before = rowOf(orderId)!;
    const old = JSON.parse(before.data) as InvoiceData;
    const fresh = dataFor(getOrder(orderId)!, 'invoice', before.number, old.issuedOn);
    const same = (d: InvoiceData) => JSON.stringify({ ...d, revision: undefined, revisedOn: undefined, supplyOn: undefined });
    if (same(fresh) === same({ ...old, supplyOn: fresh.supplyOn })) return { invoice: toRecord(before), changed: false };
    const revision = ((getDb().prepare('SELECT MAX(revision) FROM invoice_revisions WHERE number = ?').pluck().get(before.number) as number | null) ?? 0) + 1;
    const now = new Date();
    getDb().prepare('INSERT INTO invoice_revisions (number, revision, replaced_at, replaced_by, total_fils, data) VALUES (?, ?, ?, ?, ?, ?)').run(before.number, revision, now.toISOString(), actor, before.total_fils, before.data);
    const data: InvoiceData = { ...fresh, revision: revision + 1, revisedOn: dubaiDateOf(now.toISOString()) };
    getDb().prepare('UPDATE invoices SET data = ?, total_fils = ? WHERE number = ?').run(JSON.stringify(data), data.totalFils, before.number);
    auditOrThrow('invoice.regenerated', { by: actor, orderId, number: before.number, version: revision + 1, fromTotalFils: before.total_fils, toTotalFils: data.totalFils });
    return { invoice: toRecord(rowOf(orderId)!), changed: true };
  });
  if (result.changed) bump('orders');
  return result;
}

/** The earlier versions of an order's invoice (newest first), for the hub. */
export function invoiceRevisions(orderId: string): Array<{ revision: number; replacedAt: string; replacedBy: string; total: number }> {
  const r = rowOf(orderId);
  if (!r) return [];
  return (getDb().prepare('SELECT revision, replaced_at, replaced_by, total_fils FROM invoice_revisions WHERE number = ? ORDER BY revision DESC').all(r.number) as Array<{ revision: number; replaced_at: string; replaced_by: string; total_fils: number }>).map((x) => ({ revision: x.revision, replacedAt: x.replaced_at, replacedBy: x.replaced_by, total: x.total_fils / 100 }));
}

const INK: RGB = [0.14, 0.11, 0.1];
const SOFT: RGB = [0.42, 0.38, 0.35];
const GOLD: RGB = [0.62, 0.47, 0.2];
const SAND: RGB = [0.965, 0.95, 0.925];
const LINE: RGB = [0.86, 0.83, 0.78];
const PAPER: RGB = [1, 1, 1];
const IVORY: RGB = [0.985, 0.975, 0.955];
const STRIPE: RGB = [0.975, 0.965, 0.945];
const MIST: RGB = [0.78, 0.74, 0.7];
const GOLD_LIGHT: RGB = [0.86, 0.72, 0.45];
const GREEN: RGB = [0.13, 0.5, 0.3];
const AMBER: RGB = [0.75, 0.48, 0.08];
const RED: RGB = [0.7, 0.15, 0.12];

const niceDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return y && m && day ? `${day} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}` : d;
};

/** The invoice as a PDF (A4), from its record; a cancelled order's says so. */
export function invoicePdf(orderId: string): { pdf: Buffer; number: string } | null {
  const r = rowOf(orderId);
  if (!r) return null;
  const d = repaired(JSON.parse(r.data) as InvoiceData, getOrder(orderId));
  const order = getOrder(orderId);
  const tax = d.kind === 'tax_invoice';
  const doc = new PdfDoc({ title: `${tax ? 'Tax Invoice' : 'Invoice'} ${d.number}`, author: d.seller.name, subject: `Order ${d.orderId}` });
  const L = 40;
  const R = doc.width - 40;
  const W = R - L;
  let y = 0;
  const footer = () => {
    const n = doc.pageCount;
    doc.box(0, doc.height - 40, doc.width, 40, IVORY);
    doc.line(0, doc.height - 40, doc.width, doc.height - 40, GOLD, 1.2);
    doc.text('This electronic invoice was issued by the seller and is valid without a signature or stamp.', L, doc.height - 17, { size: 7.5, color: SOFT });
    doc.text(`${d.number} · page ${n}`, R, doc.height - 17, { size: 7.5, color: SOFT, align: 'right' });
  };
  // Each page starts with the band: the seller and the document's title.
  const band = (first: boolean) => {
    const h = first ? 104 : 54;
    doc.box(0, 0, doc.width, h, INK);
    doc.box(0, h, doc.width, 3, GOLD);
    const initials = (d.seller.name.match(/\b\p{L}/gu) ?? ['B']).slice(0, 2).join('').toUpperCase();
    const r0 = first ? 21 : 14;
    const cy = first ? 52 : 27;
    doc.circle(L + r0, cy, r0, GOLD);
    doc.text(initials, L + r0, cy + (first ? 6 : 4), { size: first ? 15 : 10, style: 'bold', color: INK, align: 'center' });
    const nx = L + 2 * r0 + 12;
    doc.text(d.seller.name, nx, first ? 47 : 31, { size: first ? 16 : 11, style: 'bold', color: PAPER });
    if (first) {
      const sub = [d.seller.phone, d.seller.email].filter(Boolean).join(' · ');
      if (sub) doc.text(sub, nx, 63, { size: 8.5, color: MIST });
    }
    doc.text(tax ? 'TAX INVOICE' : 'INVOICE', R, first ? 48 : 31, { size: first ? 24 : 13, style: 'bold', color: PAPER, align: 'right' });
    if (first) {
      doc.text(tax ? 'فاتورة ضريبية' : 'فاتورة', R, 68, { size: 12, color: GOLD_LIGHT, align: 'right' });
      doc.text('Electronic invoice', R, 84, { size: 8, color: MIST, align: 'right' });
    }
    y = h + 22;
  };
  const newPage = (first = false) => {
    if (doc.pageCount) footer();
    doc.addPage();
    band(first);
  };
  newPage(true);

  // The seller's legal lines (licence, TRN, address), small, under the band.
  const sellerLines = [
    d.seller.trn ? `TRN: ${d.seller.trn}` : '',
    d.seller.tradeLicence ? `Trade licence: ${d.seller.tradeLicence}${d.seller.authority ? ` (${d.seller.authority})` : ''}` : d.seller.authority ? `Licensed by ${d.seller.authority}` : '',
    d.seller.address ?? '',
  ].filter(Boolean);
  if (sellerLines.length) {
    for (const l of doc.wrap(sellerLines.join('  ·  '), 8.5, W)) {
      doc.text(l, L, y, { size: 8.5, color: SOFT });
      y += 11.5;
    }
    y += 8;
  }

  // Two cards: the invoice's facts, and who it is for.
  const facts: Array<[string, string]> = [
    ['Invoice number', d.number],
    ['Date of issue', niceDate(d.issuedOn)],
    ...(d.revisedOn ? ([['Revised', `${niceDate(d.revisedOn)} (version ${d.revision ?? 2})`]] as Array<[string, string]>) : []),
    ['Date of supply', niceDate(d.supplyOn)],
    ['Order', d.orderId],
    ['Currency', 'UAE dirham (AED)'],
  ];
  const gap = 14;
  const fw = Math.round((W - gap) * 0.56);
  const cw = W - gap - fw;
  const billTo = [d.buyer.company ?? '', ...d.buyer.address.split('\n'), d.buyer.trn ? `TRN: ${d.buyer.trn}` : '', d.buyer.phone, d.buyer.email ?? ''].filter(Boolean).flatMap((a) => doc.wrap(a, 9, cw - 28));
  const factRows = facts.map(([k, v]) => [k, doc.wrap(v, 9, fw - 110)] as const);
  const factsH = 34 + factRows.reduce((s, [, v]) => s + v.length * 12 + 2, 0);
  const billH = 50 + billTo.length * 12;
  const cardH = Math.max(factsH, billH) + 6;
  doc.roundBox(L, y, fw, cardH, 8, { fill: SAND });
  doc.roundBox(L + fw + gap, y, cw, cardH, 8, { fill: PAPER, stroke: LINE });
  doc.text('INVOICE DETAILS', L + 14, y + 20, { size: 7.5, style: 'bold', color: GOLD });
  let fy = y + 36;
  for (const [k, v] of factRows) {
    doc.text(k, L + 14, fy, { size: 8.5, color: SOFT });
    v.forEach((t, i) => doc.text(t, L + 100, fy + i * 12, { size: 9, style: k === 'Invoice number' ? 'bold' : 'regular', color: INK }));
    fy += v.length * 12 + 2;
  }
  const bx = L + fw + gap + 14;
  doc.text('Bill to', bx, y + 20, { size: 7.5, style: 'bold', color: GOLD });
  doc.text(d.buyer.name, bx, y + 38, { size: 11, style: 'bold', color: INK });
  let by = y + 54;
  for (const l of billTo) {
    doc.text(l, bx, by, { size: 9, color: INK });
    by += 12;
  }
  y += cardH + 10;
  // How it is paid: its own strip, the full width.
  const pay = doc.wrap(paymentText(d), 9, W - 100);
  doc.roundBox(L, y, W, 14 + pay.length * 12, 7, { fill: IVORY, stroke: LINE });
  doc.text('Payment', L + 14, y + 16, { size: 8.5, color: SOFT });
  pay.forEach((t, i) => doc.text(t, L + 100, y + 16 + i * 12, { size: 9, style: 'bold', color: INK }));
  y += 14 + pay.length * 12 + 20;

  // The lines: a dark header, light stripes.
  const cols = { qty: R - 196, unit: R - 112, total: R - 12 };
  const head = () => {
    doc.roundBox(L, y, W, 24, 6, { fill: INK });
    doc.text('Description', L + 12, y + 15.5, { size: 8.5, style: 'bold', color: PAPER });
    doc.text('Qty', cols.qty, y + 15.5, { size: 8.5, style: 'bold', color: PAPER, align: 'right' });
    doc.text('Unit price', cols.unit, y + 15.5, { size: 8.5, style: 'bold', color: PAPER, align: 'right' });
    doc.text(tax ? 'Amount incl. VAT' : 'Amount', cols.total, y + 15.5, { size: 8.5, style: 'bold', color: PAPER, align: 'right' });
    y += 30;
  };
  head();
  d.lines.forEach((l, n) => {
    const label = doc.wrap(l.label, 9, cols.qty - L - 60);
    const h = label.length * 11.5 + (l.sku ? 10 : 0) + 10;
    if (y + h > doc.height - 170) {
      newPage();
      head();
    }
    if (n % 2 === 1) doc.box(L, y - 4, W, h, STRIPE);
    label.forEach((t, i) => doc.text(t, L + 12, y + 8 + i * 11.5, { size: 9, color: INK }));
    if (l.sku) doc.text(`SKU ${l.sku}`, L + 12, y + 8 + label.length * 11.5 - 1, { size: 7.5, color: SOFT });
    doc.text(String(l.quantity), cols.qty, y + 8, { size: 9, color: INK, align: 'right' });
    doc.text(money(l.unitFils), cols.unit, y + 8, { size: 9, color: INK, align: 'right' });
    doc.text(money(l.totalFils), cols.total, y + 8, { size: 9, style: 'bold', color: INK, align: 'right' });
    y += h;
  });
  doc.line(L, y - 2, R, y - 2, LINE, 0.75);

  // Totals, on the right; the paid or due badge on the left.
  if (y > doc.height - 230) newPage();
  y += 14;
  const tw = 230;
  const tx = R - tw;
  const row = (k: string, v: string) => {
    doc.text(k, tx + 12, y, { size: 9, color: SOFT });
    doc.text(v, R - 12, y, { size: 9, color: INK, align: 'right' });
    y += 15;
  };
  const top = y;
  if (d.vat) {
    row('Total excluding VAT', `AED ${money(d.vat.netFils)}`);
    row(`VAT ${d.vat.rateBp / 100}%`, `AED ${money(d.vat.vatFils)}`);
  } else {
    row('Subtotal', `AED ${money(d.subtotalFils)}`);
    row('VAT', 'Not applicable');
  }
  y += 2;
  doc.roundBox(tx, y, tw, 34, 7, { fill: INK });
  doc.text(d.vat ? 'Total including VAT' : 'Total', tx + 12, y + 21.5, { size: 10.5, style: 'bold', color: PAPER });
  doc.text(`AED ${money(d.totalFils)}`, R - 12, y + 22, { size: 14, style: 'bold', color: GOLD_LIGHT, align: 'right' });
  y += 48;
  // Part paid, part on delivery: both, so the customer sees what is left to pay.
  const due = d.payment.dueFils;
  const part = due !== undefined && due > 0 && due < d.totalFils;
  if (part) {
    row(d.payment.movedInFils && d.payment.method === 'cod' ? 'Paid (from an earlier order)' : `Paid (${PAY[d.payment.method].toLowerCase()})`, `AED ${money(d.totalFils - due)}`);
    doc.text('To pay on delivery', tx + 12, y, { size: 10, style: 'bold', color: INK });
    doc.text(`AED ${money(due)}`, R - 12, y, { size: 10, style: 'bold', color: INK, align: 'right' });
    y += 18;
  }
  // The badge: PAID (green), DUE (amber), or on delivery; a cancelled order's says so.
  const cancelled = order?.status === 'cancelled';
  const badge = cancelled ? { t: 'CANCELLED', c: RED } : part || (!d.payment.paid && d.payment.method === 'cod') ? { t: 'PAY ON DELIVERY', c: AMBER } : d.payment.paid ? { t: 'PAID', c: GREEN } : { t: 'DUE', c: AMBER };
  const bw = doc.measure(badge.t, 11, 'bold') + 30;
  doc.roundBox(L, top - 10, bw, 26, 13, { stroke: badge.c, width: 1.6 });
  doc.text(badge.t, L + bw / 2, top + 7, { size: 11, style: 'bold', color: badge.c, align: 'center' });
  y = Math.max(y, top + 30) + 14;

  // A thank-you, then the notes.
  if (y > doc.height - 150) newPage();
  doc.text(`Thank you for choosing ${d.seller.name}.`, L, y, { size: 11, style: 'bold', color: GOLD });
  y += 18;
  const notes: string[] = [];
  if (cancelled) notes.push('This order was cancelled after this invoice was issued: nothing is due on it.');
  if (!d.vat) notes.push('The supplier is not registered for VAT in the UAE, so no VAT is charged. This is not a tax invoice.');
  else notes.push(`Amounts in UAE dirhams (AED). VAT at ${d.vat.rateBp / 100}% (standard rate).`);
  notes.push(`Questions about this invoice: ${[d.seller.phone, d.seller.email].filter(Boolean).join(' or ') || 'reply to the message it came with'}. Please quote ${d.number}.`);
  const check = customerLink(invoicePdfPath(d.orderId));
  for (const n of notes) {
    for (const l of doc.wrap(n, 8.5, W)) {
      if (y > doc.height - 60) newPage();
      doc.text(l, L, y, { size: 8.5, color: cancelled && n.startsWith('This order was cancelled') ? RED : SOFT });
      y += 11.5;
    }
    y += 3;
  }
  if (check) {
    y += 2;
    doc.text('Check this invoice online:', L, y, { size: 8.5, color: SOFT });
    const label = check.length > 90 ? `${check.slice(0, 89)}…` : check;
    const x = L + doc.measure('Check this invoice online: ', 8.5);
    doc.text(label, x, y, { size: 8.5, color: GOLD });
    doc.link(x, y - 9, doc.measure(label, 8.5), 12, check);
  }
  footer();
  return { pdf: doc.render(), number: d.number };
}

/** "Card · paid", "Card · paid AED 103.50 · AED 10.00 on delivery", "Cash on delivery · due on delivery". */
function paymentText(d: InvoiceData): string {
  const p = d.payment;
  if (p.label) return p.paid ? `${p.label} · paid${p.reference ? ` (${p.reference})` : ''}` : 'Due on receipt of this invoice';
  const due = p.dueFils;
  if (due !== undefined && due > 0 && due < d.totalFils) return `${PAY[p.method]} · paid AED ${money(d.totalFils - due)} · AED ${money(due)} on delivery`;
  if (due === 0 && p.method === 'cod' && p.movedInFils) return 'Paid (from an earlier order)';
  return `${PAY[p.method]}${p.paid ? ' · paid' : p.method === 'cod' ? ' · due on delivery' : ' · due'}`;
}

/**
 * An invoice issued before BUH-02.36.00 left out the extra added when booking the courier (it was
 * in the total but not in the lines, nor in what was left to pay). Shown with that line and that
 * amount now; its number, date, lines and total stay as issued.
 */
function repaired(d: InvoiceData, order: Order | undefined): InvoiceData {
  if (d.vat || d.payment.dueFils !== undefined) return d;
  const gap = d.subtotalFils - d.lines.reduce((sum, l) => sum + l.totalFils, 0);
  if (gap <= 0) return d;
  const note = order?.extraCharge?.note;
  const lines = [...d.lines, { label: `Extra charge${note ? ` (${note})` : ''}`, quantity: 1, unitFils: gap, totalFils: gap }];
  const dueFils = d.payment.method === 'cod' || order?.status === 'delivered' ? undefined : gap;
  return { ...d, lines, payment: { ...d.payment, ...(dueFils !== undefined ? { dueFils } : {}) } };
}

/** The file's name: Invoice-INV-2026-000123.pdf */
export const invoiceFileName = (number: string) => `${number.startsWith('INV-') ? 'Invoice' : 'Tax-Invoice'}-${number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf`;

/**
 * Email the invoice to the customer (the PDF attached, with its private link), once the invoice is
 * issued. Needs the customer's email and the shop's email set up. Noted on the invoice and audited.
 */
export async function emailInvoice(orderId: string, actor: string): Promise<{ invoice: InvoiceRecord; emailed: boolean; reason?: string }> {
  const { invoice } = issueOrderInvoice(orderId, actor);
  const order = getOrder(orderId)!;
  const to = order.customer.email;
  if (!to || !isCustomerEmail(to)) return { invoice, emailed: false, reason: 'no_email' };
  if (!emailConfigured() || !mailConfig()) return { invoice, emailed: false, reason: 'email_off' };
  const made = invoicePdf(orderId)!;
  const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
  const first = order.customer.fullName.split(/\s+/)[0] || 'there';
  const link = invoice.pdfUrl;
  await (await transport()).sendMail({
    from: sender(),
    to,
    ...(contactEmail() ? { replyTo: contactEmail() } : {}),
    subject: `Your invoice ${made.number} for order ${orderId} · ${shop}`,
    text: [`Dear ${first},`, '', `Thank you for your order ${orderId}. Your invoice ${made.number} (AED ${money(fils(invoice.total))}) is attached as a PDF.`, ...(link ? ['', `You can also open it any time here: ${link}`] : []), '', `With thanks,`, shop].join('\n'),
    attachments: [{ filename: invoiceFileName(made.number), content: made.pdf, contentType: 'application/pdf' }],
  });
  const at = new Date().toISOString();
  auditedTransaction((auditOrThrow) => {
    getDb().prepare('UPDATE invoices SET emailed_at = ?, emailed_to = ?, sent_count = sent_count + 1 WHERE order_id = ?').run(at, to, orderId);
    auditOrThrow('invoice.emailed', { by: actor, orderId, number: invoice.number });
  });
  logEvent('info', 'invoice_emailed', { orderId, number: invoice.number });
  bump('orders');
  return { invoice: invoiceOfOrder(orderId)!, emailed: true };
}

/** The owner sent the link on WhatsApp (counted, so the hub shows it was sent). */
export function noteInvoiceShared(orderId: string, actor: string): InvoiceRecord {
  const { invoice } = issueOrderInvoice(orderId, actor);
  auditedTransaction((auditOrThrow) => {
    getDb().prepare('UPDATE invoices SET sent_count = sent_count + 1 WHERE order_id = ?').run(orderId);
    auditOrThrow('invoice.shared', { by: actor, orderId, number: invoice.number, via: 'whatsapp' });
  });
  return invoiceOfOrder(orderId)!;
}
