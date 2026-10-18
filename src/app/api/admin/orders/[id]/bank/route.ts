import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { checkBankTransfer, getOrder, type BankResult } from '@/lib/server/orders';

const RESULTS: readonly BankResult[] = ['received', 'not_received'];

/**
 * The owner's tap on a bank-transfer order: "Payment received" (the order is paid, its private
 * page closes) or "Not received yet". The order is looked up and checked here; the same tap twice
 * changes nothing. Audited before it is reported done.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['result']);
    if (!RESULTS.includes(body.result as BankResult)) throw new HttpError(400, 'Result must be "received" or "not_received".');
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    const { order, changed } = checkBankTransfer(id, body.result as BankResult, session.email);
    return json({ order, changed });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/bank');
  }
}
