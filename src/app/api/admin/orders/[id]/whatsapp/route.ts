import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { checkWhatsApp, getOrder, type WhatsAppResult } from '@/lib/server/orders';

const RESULTS: readonly WhatsAppResult[] = ['confirmed', 'mismatch'];

/**
 * The owner's one tap on an order asked to confirm on WhatsApp: "Confirmed on WhatsApp" (the
 * message came from the number on the order) or "Number didn't match". The order is looked up
 * here; the same tap twice changes nothing. Audited before it is reported done.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['result']);
    if (!RESULTS.includes(body.result as WhatsAppResult)) throw new HttpError(400, 'Result must be "confirmed" or "mismatch".');
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    const { order, changed } = checkWhatsApp(id, body.result as WhatsAppResult, session.email);
    return json({ order, changed });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/whatsapp');
  }
}
