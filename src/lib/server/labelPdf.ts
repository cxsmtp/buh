import type { CourierSettings, LabelPaper, Order } from '@/types';
import { code128Bars } from '@/lib/code128';
import { aed2, carrierLabel } from '@/lib/courierMode';
import { labelContents } from '@/lib/labelContents';
import { dueOnDeliveryFils } from '@/lib/orderMoney';
import { PdfDoc, type RGB } from './pdf/pdf';

/**
 * The shop's shipping label as a PDF file (the same contents as the label in the hub,
 * src/components/admin/ShippingLabelModal.tsx), for printing anywhere, a printer's email address
 * included (HP ePrint and the like print A4 only):
 *  - 'a4': A4 landscape with two A5 labels side by side and a dashed line between them: print it on
 *    any A4 printer, cut it in half, and each half is an A5 label. Two orders per sheet; one order
 *    leaves the right half empty (kept for the next one);
 *  - 'a5': one A5 label per page; '4x6': one 4 × 6 in label per page.
 * The label is drawn at 4 × 6 in (288 × 432 pt) and scaled to fit its place.
 */

export interface LabelContext {
  shopName: string;
  pickup: Partial<CourierSettings['jeebly']>;
}

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [1, 1, 1];
const GREY: RGB = [0.55, 0.55, 0.55];
const LW = 288;
const LH = 432;

const PAGES: Record<LabelPaper, { size: [number, number]; perPage: number }> = {
  a4: { size: [841.89, 595.28], perPage: 2 },
  a5: { size: [419.53, 595.28], perPage: 1 },
  '4x6': { size: [288, 432], perPage: 1 },
};

function dateOf(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' });
}

/** One label, its top-left at (ox, oy), drawn at scale s (1 = 4 × 6 in). */
function drawLabel(doc: PdfDoc, ox: number, oy: number, s: number, order: Order, ctx: LabelContext): void {
  const X = (u: number) => ox + u * s;
  const Y = (u: number) => oy + u * s;
  const t = (text: string, x: number, y: number, size: number, o: { bold?: boolean; color?: RGB; align?: 'left' | 'right' | 'center' } = {}) =>
    doc.text(text, X(x), Y(y), { size: size * s, style: o.bold ? 'bold' : 'regular', color: o.color ?? BLACK, align: o.align ?? 'left' });
  const wrap = (text: string, size: number, width: number, bold = false) => doc.wrap(text, size * s, width * s, bold ? 'bold' : 'regular');
  const rule = (y: number) => doc.box(X(9), Y(y), (LW - 18) * s, 1.5 * s, BLACK);
  const barcode = (value: string, y: number, h: number) => {
    const { bars, total } = code128Bars(value);
    const width = LW - 18;
    const m = width / total;
    for (const [x, w] of bars) doc.box(X(9 + x * m), Y(y), w * m * s, h * s, BLACK);
  };

  const c = order.courier;
  const test = Boolean(c.simulated);
  const codFils = dueOnDeliveryFils(order);
  const pieces = c.pieces || order.items.reduce((n, i) => n + i.quantity, 0);
  const sender = ctx.pickup.pickupLocationName?.trim() || ctx.shopName;
  const p = ctx.pickup;

  doc.roundBox(X(0), Y(0), LW * s, LH * s, 0.5, { fill: WHITE, stroke: BLACK, width: 1.5 * s });
  let y = 9;
  if (test) {
    doc.box(X(1), Y(1), (LW - 2) * s, 13 * s, BLACK);
    t('TEST BOOKING – NOT A REAL SHIPMENT – DO NOT SEND', LW / 2, 10.5, 7.5, { bold: true, color: WHITE, align: 'center' });
    y = 20;
  }

  // Carrier, order and date
  t(`${carrierLabel(c.provider, c.carrierName).toUpperCase()}${c.serviceType ? ` · ${c.serviceType}` : ''}`, 9, y + 7, 7.5, { bold: true });
  t(`Dispatch ${dateOf(c.dispatchedAt)}`, 9, y + 16, 7.5);
  t(`Order ${order.id}`, LW - 9, y + 7, 7.5, { bold: true, align: 'right' });
  t(`${pieces} piece${pieces === 1 ? '' : 's'} · ${c.weightKg ? `${c.weightKg} kg` : 'weight –'}`, LW - 9, y + 16, 7.5, { align: 'right' });
  y += 21;
  rule(y);

  // AWB barcode
  y += 9;
  t('AWB / TRACKING NUMBER', 9, y, 6.5, { bold: true });
  if (c.awbNumber) {
    barcode(c.awbNumber, y + 4, 46);
    t(c.awbNumber, LW / 2, y + 63, 12, { bold: true, align: 'center' });
  } else {
    t('No AWB yet: book the courier or enter its number first', LW / 2, y + 30, 8, { align: 'center' });
  }
  y += 69;
  rule(y);

  // Consignee
  y += 9;
  t('DELIVER TO', 9, y, 6.5, { bold: true });
  y += 4;
  for (const l of wrap(order.customer.fullName, 13, LW - 18, true).slice(0, 2)) {
    y += 13;
    t(l, 9, y, 13, { bold: true });
  }
  y += 12;
  t(order.customer.phone, 9, y, 10, { bold: true });
  const street = [order.customer.flatVillaNo, order.customer.buildingVilla, order.customer.streetAddress].filter(Boolean).join(', ');
  for (const l of wrap(street, 8.5, LW - 18).slice(0, 3)) {
    y += 10.5;
    t(l, 9, y, 8.5);
  }
  y += 13;
  t(`${order.customer.area}, ${order.customer.emirate}`.toUpperCase(), 9, y, 11, { bold: true });
  if (order.customer.landmark) {
    for (const l of wrap(`Landmark: ${order.customer.landmark}`, 7.5, LW - 18).slice(0, 2)) {
      y += 9;
      t(l, 9, y, 7.5);
    }
  }
  y += 6;
  rule(y);

  // Payment
  y += 6;
  if (codFils > 0) {
    doc.box(X(9), Y(y), (LW - 18) * s, 32 * s, BLACK);
    t('CASH ON DELIVERY – COLLECT', LW / 2, y + 11, 7.5, { bold: true, color: WHITE, align: 'center' });
    t(`AED ${aed2(codFils / 100)}`, LW / 2, y + 27, 15, { bold: true, color: WHITE, align: 'center' });
  } else {
    doc.roundBox(X(9), Y(y), (LW - 18) * s, 32 * s, 0.5, { stroke: BLACK, width: 1.5 * s });
    t('PREPAID – DO NOT COLLECT CASH', LW / 2, y + 20, 11, { bold: true, align: 'center' });
  }
  y += 40;

  // Shipper and contents
  const col = (LW - 24) / 2;
  t('FROM', 9, y + 7, 6.5, { bold: true });
  t('CONTENTS', 15 + col, y + 7, 6.5, { bold: true });
  const from = [
    ...wrap(sender, 7, col, true).map((l) => ({ l, bold: true })),
    ...[[p.pickupUnit, p.pickupBuilding].filter(Boolean).join(', '), [p.pickupAddress, p.pickupArea].filter(Boolean).join(', '), p.pickupLandmark ? `Landmark: ${p.pickupLandmark}` : '', [p.pickupEmirate, 'UAE'].filter(Boolean).join(', '), p.pickupPhone ?? '']
      .filter(Boolean)
      .flatMap((x) => wrap(x, 7, col).map((l) => ({ l, bold: false }))),
  ];
  let fy = y + 7;
  for (const { l, bold } of from.slice(0, 8)) {
    fy += 8.5;
    t(l, 9, fy, 7, { bold });
  }
  let cy = y + 7;
  for (const l of wrap(labelContents(order), 7, col).slice(0, 8)) {
    cy += 8.5;
    t(l, 15 + col, cy, 7);
  }

  // Order barcode, at the bottom
  barcode(order.id, LH - 36, 20);
  t(order.id, LW / 2, LH - 7, 7.5, { align: 'center' });

  // A test booking says so across the label too.
  if (test) {
    t('TEST – DO NOT SEND', LW / 2, LH / 2 + 10, 26, { bold: true, color: [0.75, 0.75, 0.75], align: 'center' });
  }
}

/** The labels of these orders in one PDF, on the paper chosen (A4: two A5 labels per sheet). */
export function labelsPdf(orders: Order[], paper: LabelPaper, ctx: LabelContext): Buffer {
  const page = PAGES[paper] ?? PAGES.a5;
  const doc = new PdfDoc({ title: orders.length === 1 ? `Label ${orders[0].id}` : `Labels (${orders.length})`, author: ctx.shopName }, page.size);
  const [pw, ph] = page.size;
  const slotW = pw / page.perPage;
  const margin = paper === '4x6' ? 0 : 14;
  const s = Math.min((slotW - 2 * margin) / LW, (ph - 2 * margin) / LH);
  orders.forEach((order, i) => {
    const slot = i % page.perPage;
    if (slot === 0) {
      doc.addPage();
      if (page.perPage === 2) {
        // The cut line between the two A5 halves.
        doc.line(slotW, 6, slotW, ph - 6, GREY, 0.6, [4, 3]);
        doc.text('cut here', slotW, 14, { size: 6, color: GREY, align: 'center' });
        doc.text('cut here', slotW, ph - 8, { size: 6, color: GREY, align: 'center' });
      }
    }
    const ox = slot * slotW + (slotW - LW * s) / 2;
    const oy = (ph - LH * s) / 2;
    drawLabel(doc, ox, oy, s, order, ctx);
  });
  if (!orders.length) doc.addPage();
  return doc.render();
}

// ── Which labels, and the printer's email ────────────────────────────────────

const ORDER_ID = /^BUH-[A-Z0-9-]{4,40}$/;

/** The context from the settings: the shop's name and the pickup details (the sender). */
export async function labelContext(): Promise<LabelContext> {
  const { getSettings } = await import('./settings');
  return { shopName: getSettings('brand').storeName || 'Beautiful UAE Home', pickup: getSettings('courier').jeebly };
}

/**
 * The orders whose labels to print: the ids given (at most 40, in that order), or, with none, every
 * order booked with a courier and not yet dispatched (the parcels to pack now), oldest first.
 */
export async function ordersForLabels(ids: unknown): Promise<Order[]> {
  const { getOrder, listOrders } = await import('./orders');
  if (ids === undefined || ids === null || ids === '') {
    return listOrders({ limit: 2000, status: 'confirmed' })
      .filter((o) => Boolean(o.courier.awbNumber))
      .reverse()
      .slice(0, 40);
  }
  const list = Array.isArray(ids) ? ids : String(ids).split(',');
  const { HttpError } = await import('./http');
  if (list.length > 40) throw new HttpError(400, 'At most 40 labels at a time.');
  const out: Order[] = [];
  for (const raw of list) {
    const id = String(raw).trim();
    if (!ORDER_ID.test(id)) throw new HttpError(400, 'Choose orders from the list.');
    const o = getOrder(id);
    if (!o) throw new HttpError(404, `Order ${id} not found.`);
    if (o.status === 'cancelled') throw new HttpError(409, `${id} is cancelled: no label.`, {}, { code: 'cancelled' });
    if (!out.some((x) => x.id === id)) out.push(o);
  }
  return out;
}

/** "Email to printer": the labels' PDF to the printer's own address (Couriers). Audited. */
export async function emailLabels(orders: Order[], paper: LabelPaper, actor: string, { carrier = false } = {}): Promise<{ to: string; count: number }> {
  const { getSettings } = await import('./settings');
  const { HttpError } = await import('./http');
  const { emailConfigured, mailConfig, sender, transport } = await import('./mail');
  const { audit } = await import('./audit');
  const to = getSettings('courier').printerEmail?.trim();
  if (!to) throw new HttpError(409, "Add your printer's email address in Couriers first.", {}, { code: 'no_printer' });
  if (!orders.length) throw new HttpError(409, 'No labels to print: no booked order is waiting for dispatch.', {}, { code: 'no_labels' });
  if (!emailConfigured() || !mailConfig()) throw new HttpError(409, 'Email is not set up (Settings → Email): download the PDF and print it instead.', {}, { code: 'email_off' });
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  let name = orders.length === 1 ? `Label-${orders[0].id}.pdf` : `Labels-${orders.length}.pdf`;
  if (carrier) {
    // Jeebly's own label for each of its bookings, as Jeebly made it (the printer fits it to its paper).
    const { jeeblyLabelFor } = await import('./jeeblyOps');
    for (const o of orders) {
      const made = await jeeblyLabelFor(o);
      if ('error' in made) throw new HttpError(502, `${o.id}: ${made.error}`, {}, { code: 'carrier_label' });
      attachments.push({ filename: `Jeebly-${o.courier.awbNumber}.pdf`, content: made.pdf, contentType: 'application/pdf' });
    }
    name = attachments[0].filename;
  } else {
    attachments.push({ filename: name, content: labelsPdf(orders, paper, await labelContext()), contentType: 'application/pdf' });
  }
  const what = carrier ? "Jeebly's label" : `shipping label (${paper === 'a4' ? 'A4, two A5 labels per sheet: cut in half' : paper === '4x6' ? '4 × 6 in' : 'A5'})`;
  await (await transport()).sendMail({ from: sender(), to, subject: name.replace('.pdf', ''), text: `${orders.length} ${what} to print.`, attachments });
  audit('labels.emailed_to_printer', { by: actor, orders: orders.map((o) => o.id), paper, carrier });
  return { to, count: orders.length };
}
