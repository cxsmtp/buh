import { PALETTE } from '@/lib/design/tokens';
import { dubaiDateOf } from '@/lib/reportPeriods';
import type { Order } from '@/types';
import { aedText } from './csv';
import { getSettings } from './settings';
import { creditNotesFor, invoiceFor, orderVat, syncVatDocuments } from './vat';

/**
 * An order's printable document, the same for the customer (their private link) and the hub:
 *  - with a VAT breakdown and a tax invoice issued: "Tax Invoice" (a simplified tax invoice, FTA:
 *    the words "Tax Invoice", the supplier's name, address and TRN, the invoice number and date, the
 *    goods, the VAT and the total including VAT), with any credit notes against it;
 *  - with a VAT breakdown, the invoice not yet due (the order isn't confirmed or paid yet): an order
 *    summary that says when the tax invoice comes;
 *  - otherwise (VAT off, or an order from before it): a plain "Receipt", nothing about VAT.
 * Plain HTML, no scripts: Print → Save as PDF. Text only through esc().
 */

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fils = (aed: number | undefined) => Math.round((aed ?? 0) * 100);
const money = (f: number) => `AED ${aedText(f)}`;
const niceDate = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return y && m && day ? `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}` : d;
};

export const DOCUMENT_STYLE = `
*{box-sizing:border-box}
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:${PALETTE.ink};background:${PALETTE.ivory};margin:0;padding:16px}
main{max-width:760px;margin:0 auto;background:${PALETTE.surface};border:1px solid ${PALETTE.line};border-radius:12px;padding:20px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:.02em}
h2{font-size:15px;margin:18px 0 6px}
p{margin:2px 0}
.muted{color:${PALETTE['ink-soft']}}
.head{display:flex;flex-wrap:wrap;gap:12px 24px;justify-content:space-between;border-bottom:1px solid ${PALETTE.line};padding-bottom:12px;margin-bottom:12px}
.head>div{min-width:0;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid ${PALETTE.line};padding:6px 4px;text-align:left;vertical-align:top;overflow-wrap:break-word}
th{font-size:12px;color:${PALETTE['ink-soft']};font-weight:600}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.q{text-align:right;white-space:nowrap}
.totals td{border:0;padding:3px 4px}
.totals .grand td{font-weight:700;border-top:2px solid ${PALETTE.ink};padding-top:6px}
.note{margin-top:14px;font-size:12px;color:${PALETTE['ink-soft']}}
.print{margin-top:16px;font-size:12px;color:${PALETTE['ink-muted']}}
@media (max-width:480px){body{padding:8px}main{padding:14px}h1{font-size:19px}th,td{font-size:12px;padding:5px 3px}}
@media print{body{background:#fff;padding:0}main{border:0;border-radius:0;max-width:none;padding:0}.print{display:none}}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${DOCUMENT_STYLE}</style></head><body><main>
${body}
<p class="print">To keep a copy: your browser’s Print → Save as PDF.</p>
</main></body></html>
`;
}

function itemRows(order: Order, lines?: Array<{ label: string; quantity: number; totalFils: number; netFils: number; vatFils: number }>): string {
  if (lines) {
    return lines
      .map((l) => `<tr><td>${esc(l.label)}</td><td class="q">${esc(l.quantity)}</td><td class="n">${esc(aedText(l.netFils))}</td><td class="n">${esc(aedText(l.vatFils))}</td><td class="n">${esc(aedText(l.totalFils))}</td></tr>`)
      .join('\n');
  }
  const rows = order.items.map((i) => `<tr><td>${esc(`${i.title} (${i.profileName}${i.color ? `, ${i.color}` : ''})`)}</td><td class="q">${esc(i.quantity)}</td><td class="n">${esc(aedText(fils(i.totalPrice)))}</td></tr>`);
  if (fils(order.deliveryFee)) rows.push(`<tr><td>Delivery</td><td class="q">1</td><td class="n">${esc(aedText(fils(order.deliveryFee)))}</td></tr>`);
  if (fils(order.codFee)) rows.push(`<tr><td>Cash-on-delivery fee</td><td class="q">1</td><td class="n">${esc(aedText(fils(order.codFee)))}</td></tr>`);
  if (fils(order.cardFee)) rows.push(`<tr><td>Card payment fee</td><td class="q">1</td><td class="n">${esc(aedText(fils(order.cardFee)))}</td></tr>`);
  return rows.join('\n');
}

function customerBlock(order: Order): string {
  const c = order.customer;
  return `<div><p class="muted">Customer</p><p><strong>${esc(c.fullName)}</strong></p><p>${esc([c.area, c.emirate].filter(Boolean).join(', '))}</p>${c.email ? `<p>${esc(c.email)}</p>` : ''}</div>`;
}

/** The document for an order (see the comment at the top). */
export function orderDocumentHtml(order: Order): string {
  try {
    syncVatDocuments(order.id);
  } catch {
    // shown as it stands; the sync runs again on the next change
  }
  const vat = orderVat(order.id);
  const inv = vat ? invoiceFor(order.id) : null;
  const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
  const placed = dubaiDateOf(order.createdAt);

  if (!vat) {
    const address = getSettings('store').storeAddress;
    return page(`Receipt ${order.id} — ${shop}`, `
<div class="head"><div><h1>Receipt</h1><p><strong>${esc(shop)}</strong></p>${address ? `<p>${esc(address)}</p>` : ''}</div>
<div><p class="muted">Order</p><p><strong>${esc(order.id)}</strong></p><p>${esc(niceDate(placed))}</p></div>${customerBlock(order)}</div>
<table><thead><tr><th>Item</th><th class="q">Qty</th><th class="n">AED</th></tr></thead><tbody>
${itemRows(order)}
</tbody></table>
<table class="totals"><tbody><tr class="grand"><td>Total</td><td class="n">${esc(money(fils(order.total)))}</td></tr></tbody></table>
${order.status === 'cancelled' ? '<p class="note"><strong>This order was cancelled.</strong></p>' : ''}`);
  }

  const s = vat.supplier;
  const rate = vat.rateBp / 100;
  const lines = itemRows(order, vat.lines);
  const totals = `<table class="totals"><tbody>
<tr><td>Total excluding VAT</td><td class="n">${esc(money(vat.netFils))}</td></tr>
<tr><td>VAT ${esc(rate)}%</td><td class="n">${esc(money(vat.vatFils))}</td></tr>
<tr class="grand"><td>Total including VAT</td><td class="n">${esc(money(vat.totalFils))}</td></tr></tbody></table>`;
  const table = `<table><thead><tr><th>Item</th><th class="q">Qty</th><th class="n">Excl. VAT</th><th class="n">VAT</th><th class="n">Incl. VAT</th></tr></thead><tbody>
${lines}
</tbody></table>`;
  const supplier = `<p><strong>${esc(s.name)}</strong></p>${s.address ? `<p>${esc(s.address)}</p>` : ''}<p>TRN: <strong>${esc(s.trn)}</strong></p>`;

  if (!inv) {
    return page(`Order ${order.id} — ${shop}`, `
<div class="head"><div><h1>Order summary</h1>${supplier}</div>
<div><p class="muted">Order</p><p><strong>${esc(order.id)}</strong></p><p>${esc(niceDate(placed))}</p></div>${customerBlock(order)}</div>
${table}${totals}
<p class="note">${order.status === 'cancelled' ? '<strong>This order was cancelled.</strong> No tax invoice was issued.' : 'Your tax invoice is issued here once your order is confirmed or paid.'}</p>`);
  }

  const credits = creditNotesFor(order.id);
  const creditRows = credits.length
    ? `<h2>Credit notes</h2><table><thead><tr><th>Credit note</th><th>Date</th><th class="n">VAT</th><th class="n">Amount</th></tr></thead><tbody>
${credits.map((c) => `<tr><td>${esc(c.number)} <span class="muted">(${esc(c.reason === 'refund' ? 'refund' : c.reason === 'cancelled' ? 'order cancelled' : 'reversal')}, against ${esc(c.invoiceNumber)})</span></td><td>${esc(niceDate(c.issuedOn))}</td><td class="n">${esc(aedText(-c.vatFils))}</td><td class="n">${esc(aedText(-c.totalFils))}</td></tr>`).join('\n')}
</tbody></table>`
    : '';
  return page(`Tax Invoice ${inv.number} — ${shop}`, `
<div class="head"><div><h1>Tax Invoice</h1>${supplier}</div>
<div><p class="muted">Invoice number</p><p><strong data-testid="invoice-number">${esc(inv.number)}</strong></p><p class="muted">Date</p><p>${esc(niceDate(inv.issuedOn))}</p><p class="muted">Order ${esc(order.id)}</p></div>${customerBlock(order)}</div>
${table}${totals}
${creditRows}
<p class="note">Amounts in UAE dirhams (AED). VAT at ${esc(rate)}% (standard rate).</p>`);
}
