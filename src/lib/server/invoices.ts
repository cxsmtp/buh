import { dubaiDateOf } from '@/lib/reportPeriods';
import type { Order } from '@/types';
import { auditedTransaction } from './audit';
import { getDb } from './db';
import { HttpError } from './http';
import { bump } from './live';
import { logEvent } from './log';
import { emailConfigured, mailConfig, sender, transport } from './mail';
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
  buyer: { name: string; phone: string; email?: string; address: string };
  lines: Line[];
  subtotalFils: number;
  vat?: { rateBp: number; netFils: number; vatFils: number };
  totalFils: number;
  payment: { method: Order['paymentMethod']; paid: boolean };
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
  return lines;
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
    buyer: { name: c.fullName, phone: c.phone, ...(c.email ? { email: c.email } : {}), address },
    lines: linesOf(order),
    subtotalFils: fils(order.total) - fils(order.vatAdded),
    totalFils: fils(order.total),
    payment: { method: order.paymentMethod, paid },
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

const INK: RGB = [0.14, 0.11, 0.1];
const SOFT: RGB = [0.42, 0.38, 0.35];
const GOLD: RGB = [0.62, 0.47, 0.2];
const SAND: RGB = [0.965, 0.95, 0.925];
const LINE: RGB = [0.86, 0.83, 0.78];

const niceDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return y && m && day ? `${day} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}` : d;
};

/** The invoice as a PDF (A4), from its record; a cancelled order's says so. */
export function invoicePdf(orderId: string): { pdf: Buffer; number: string } | null {
  const r = rowOf(orderId);
  if (!r) return null;
  const d = JSON.parse(r.data) as InvoiceData;
  const order = getOrder(orderId);
  const doc = new PdfDoc({ title: `${d.kind === 'tax_invoice' ? 'Tax Invoice' : 'Invoice'} ${d.number}`, author: d.seller.name, subject: `Order ${d.orderId}` });
  const L = 42;
  const R = doc.width - 42;
  const W = R - L;
  let y = 0;
  const footer = () => {
    const n = doc.pageCount;
    doc.line(L, doc.height - 48, R, doc.height - 48, LINE);
    doc.text('This electronic invoice was issued by the seller and is valid without a signature or stamp.', L, doc.height - 34, { size: 7.5, color: SOFT });
    doc.text(`${d.number} · page ${n}`, R, doc.height - 34, { size: 7.5, color: SOFT, align: 'right' });
  };
  const newPage = () => {
    if (doc.pageCount) footer();
    doc.addPage();
    y = 48;
  };
  newPage();

  // Header: the seller, and the document's title.
  doc.text(d.seller.name, L, y + 14, { size: 15, style: 'bold', color: INK });
  doc.text(d.kind === 'tax_invoice' ? 'TAX INVOICE' : 'INVOICE', R, y + 16, { size: 22, style: 'bold', color: INK, align: 'right' });
  doc.text(d.kind === 'tax_invoice' ? 'فاتورة ضريبية' : 'فاتورة', R, y + 34, { size: 12, color: GOLD, align: 'right' });
  doc.text('Electronic invoice', R, y + 48, { size: 8.5, color: SOFT, align: 'right' });
  let sy = y + 30;
  const sellerLines = [
    d.seller.trn ? `TRN: ${d.seller.trn}` : '',
    d.seller.tradeLicence ? `Trade licence: ${d.seller.tradeLicence}${d.seller.authority ? ` (${d.seller.authority})` : ''}` : d.seller.authority ? `Licensed by ${d.seller.authority}` : '',
    ...(d.seller.address ? doc.wrap(d.seller.address, 9, W * 0.55) : []),
    [d.seller.phone, d.seller.email].filter(Boolean).join(' · '),
  ].filter(Boolean);
  for (const l of sellerLines) {
    doc.text(l, L, sy, { size: 9, color: SOFT });
    sy += 12;
  }
  y = Math.max(sy, y + 60) + 8;
  doc.line(L, y, R, y, LINE);
  y += 16;

  // The invoice's facts (left) and the customer (right).
  const facts: Array<[string, string]> = [
    ['Invoice number', d.number],
    ['Date of issue', niceDate(d.issuedOn)],
    ['Date of supply', niceDate(d.supplyOn)],
    ['Order', d.orderId],
    ['Currency', 'UAE dirham (AED)'],
    ['Payment', `${PAY[d.payment.method]}${d.payment.paid ? ' · paid' : d.payment.method === 'cod' ? ' · due on delivery' : ' · due'}`],
  ];
  let fy = y;
  for (const [k, v] of facts) {
    doc.text(k, L, fy, { size: 8.5, color: SOFT });
    doc.text(v, L + 92, fy, { size: 9, style: k === 'Invoice number' ? 'bold' : 'regular', color: INK });
    fy += 13;
  }
  const bx = L + W * 0.55;
  let by = y;
  doc.text('Bill to', bx, by, { size: 8.5, color: SOFT });
  by += 13;
  doc.text(d.buyer.name, bx, by, { size: 10, style: 'bold', color: INK });
  by += 13;
  for (const l of [...d.buyer.address.split('\n').flatMap((a) => doc.wrap(a, 9, R - bx)), d.buyer.phone, d.buyer.email ?? ''].filter(Boolean)) {
    doc.text(l, bx, by, { size: 9, color: INK });
    by += 12;
  }
  y = Math.max(fy, by) + 12;

  // The lines.
  const tax = d.kind === 'tax_invoice';
  const cols = { qty: R - 190, unit: R - 110, total: R };
  const head = () => {
    doc.box(L, y, W, 20, SAND);
    doc.text('Description', L + 6, y + 13.5, { size: 8.5, style: 'bold', color: INK });
    doc.text('Qty', cols.qty, y + 13.5, { size: 8.5, style: 'bold', color: INK, align: 'right' });
    doc.text('Unit price', cols.unit, y + 13.5, { size: 8.5, style: 'bold', color: INK, align: 'right' });
    doc.text(tax ? 'Amount incl. VAT' : 'Amount', cols.total - 6, y + 13.5, { size: 8.5, style: 'bold', color: INK, align: 'right' });
    y += 26;
  };
  head();
  for (const l of d.lines) {
    const label = doc.wrap(l.label, 9, cols.qty - L - 50);
    const h = label.length * 11.5 + (l.sku ? 10 : 0) + 8;
    if (y + h > doc.height - 150) {
      newPage();
      head();
    }
    label.forEach((t, i) => doc.text(t, L + 6, y + 4 + i * 11.5, { size: 9, color: INK }));
    if (l.sku) doc.text(`SKU ${l.sku}`, L + 6, y + 4 + label.length * 11.5 - 1, { size: 7.5, color: SOFT });
    doc.text(String(l.quantity), cols.qty, y + 4, { size: 9, color: INK, align: 'right' });
    doc.text(money(l.unitFils), cols.unit, y + 4, { size: 9, color: INK, align: 'right' });
    doc.text(money(l.totalFils), cols.total - 6, y + 4, { size: 9, color: INK, align: 'right' });
    y += h;
    doc.line(L, y - 4, R, y - 4, LINE, 0.5);
  }

  // Totals.
  if (y > doc.height - 190) newPage();
  y += 8;
  const tx = R - 220;
  const total = (k: string, v: string, bold = false) => {
    doc.text(k, tx, y, { size: bold ? 10.5 : 9, style: bold ? 'bold' : 'regular', color: INK });
    doc.text(v, R - 6, y, { size: bold ? 10.5 : 9, style: bold ? 'bold' : 'regular', color: INK, align: 'right' });
    y += bold ? 16 : 13;
  };
  if (d.vat) {
    total('Total excluding VAT', `AED ${money(d.vat.netFils)}`);
    total(`VAT ${d.vat.rateBp / 100}%`, `AED ${money(d.vat.vatFils)}`);
  } else {
    total('Subtotal', `AED ${money(d.subtotalFils)}`);
    total('VAT', 'Not applicable');
  }
  doc.line(tx, y - 6, R, y - 6, INK, 1);
  y += 4;
  total(d.vat ? 'Total including VAT' : 'Total', `AED ${money(d.totalFils)}`, true);
  y += 10;

  // Notes.
  const notes: string[] = [];
  if (order?.status === 'cancelled') notes.push('This order was cancelled after this invoice was issued: nothing is due on it.');
  if (!d.vat) notes.push('The supplier is not registered for VAT in the UAE, so no VAT is charged. This is not a tax invoice.');
  else notes.push(`Amounts in UAE dirhams (AED). VAT at ${d.vat.rateBp / 100}% (standard rate).`);
  notes.push(`Questions about this invoice: ${[d.seller.phone, d.seller.email].filter(Boolean).join(' or ') || 'reply to the message it came with'}. Please quote ${d.number}.`);
  const check = customerLink(invoicePdfPath(d.orderId));
  for (const n of notes) {
    for (const l of doc.wrap(n, 8.5, W)) {
      if (y > doc.height - 70) newPage();
      doc.text(l, L, y, { size: 8.5, color: order?.status === 'cancelled' && n.startsWith('This order was cancelled') ? [0.7, 0.15, 0.12] : SOFT });
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
