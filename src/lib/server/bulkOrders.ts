import type { Order } from '@/types';
import { invoicesOf, issueOrderInvoice, type InvoiceRecord } from './invoices';
import { createBulkOrder, listBulkOrders } from './orders';

/**
 * Money → Invoices: a bulk order the owner received outside the shop becomes an order (counted in
 * the sales like any other, src/lib/server/orders.ts createBulkOrder) and its invoice, made at once
 * from exactly the data given. The same key again returns the same order and invoice.
 */
export function createBulkInvoice(body: Record<string, unknown>, actor: string, key: string): { order: Order; invoice: InvoiceRecord; created: boolean } {
  const { order, created } = createBulkOrder(body, actor, key);
  const { invoice } = issueOrderInvoice(order.id, actor);
  return { order: { ...order, invoice: { number: invoice.number, issuedAt: invoice.issuedAt, sentCount: invoice.sentCount, pdfPath: invoice.pdfPath, ...(invoice.pdfUrl ? { pdfUrl: invoice.pdfUrl } : {}), ...(invoice.emailedAt ? { emailedAt: invoice.emailedAt } : {}) } }, invoice, created };
}

export interface BulkInvoiceRow {
  orderId: string;
  number: string | null;
  date: string;
  customer: string;
  company?: string;
  total: number;
  paidWith: NonNullable<Order['bulk']>['paidWith'];
  status: Order['status'];
  order: Order;
}

/** The bulk orders with their invoices (newest first), for Money → Invoices. */
export function listBulkInvoices(limit = 200): BulkInvoiceRow[] {
  const list = listBulkOrders(limit);
  const inv = invoicesOf(list.map((o) => o.id));
  return list.map((o) => {
    const i = inv.get(o.id);
    const order: Order = i ? { ...o, invoice: { number: i.number, issuedAt: i.issuedAt, sentCount: i.sentCount, pdfPath: i.pdfPath, ...(i.pdfUrl ? { pdfUrl: i.pdfUrl } : {}), ...(i.emailedAt ? { emailedAt: i.emailedAt } : {}) } } : o;
    return { orderId: o.id, number: i?.number ?? null, date: o.createdAt, customer: o.customer.fullName, ...(o.customer.company ? { company: o.customer.company } : {}), total: o.total, paidWith: o.bulk!.paidWith, status: o.status, order };
  });
}
