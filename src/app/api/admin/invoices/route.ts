import { createBulkInvoice, listBulkInvoices } from '@/lib/server/bulkOrders';
import { requireAdmin, requireReader } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

/** Money → Invoices: the bulk orders with their invoices, newest first (the owner, or the accountant: read-only). */
export async function GET(req: Request) {
  try {
    await requireReader(req);
    return json({ invoices: listBulkInvoices(200) });
  } catch (err) {
    return handleRouteError(err, 'admin/invoices');
  }
}

/**
 * A bulk order and its invoice, from the owner's data: { key, customer, lines, deliveryFee?,
 * discount?, date?, paidWith, reference?, delivered?, note? }. Every field is checked on the server
 * (src/lib/server/orders.ts createBulkOrder); the key makes a retry return the first one.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 64 * 1024);
    allowFields(body, ['key', 'customer', 'lines', 'deliveryFee', 'discount', 'date', 'paidWith', 'reference', 'delivered', 'note']);
    const { key, ...fields } = body;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) throw new HttpError(400, 'key is required (one per save).');
    const r = createBulkInvoice(fields, session.email, key);
    return json(r, r.created ? 201 : 200);
  } catch (err) {
    return handleRouteError(err, 'admin/invoices/create');
  }
}
