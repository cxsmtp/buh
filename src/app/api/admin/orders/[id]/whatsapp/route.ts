import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { checkWhatsApp, getOrder, type WhatsAppResult } from '@/lib/server/orders';

const RESULTS: readonly WhatsAppResult[] = ['confirmed', 'mismatch', 'call', 'use_sender', 'correct_phone'];
const WITH_PHONE: readonly WhatsAppResult[] = ['use_sender', 'correct_phone'];

/**
 * The owner's one tap on an order's confirmation: "Confirmed on WhatsApp" (the message came from
 * the number on the order), "Number didn't match", "Confirmed by phone call", or "Use the number it
 * came from" (with that number, checked like checkout's: the order's phone becomes it, the old one
 * stays in the order's history), or, later, "Correct the phone number" (correct_phone, the same way;
 * refused for a cancelled or delivered order). The order is looked up here; the same tap twice changes nothing.
 * Audited before it is reported done.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['result', 'phone']);
    if (!RESULTS.includes(body.result as WhatsAppResult)) throw new HttpError(400, 'Result must be "confirmed", "mismatch", "call", "use_sender" or "correct_phone".');
    const result = body.result as WhatsAppResult;
    if (body.phone !== undefined && !WITH_PHONE.includes(result)) throw new HttpError(400, 'A phone number goes only with "use_sender" or "correct_phone".');
    const phone = WITH_PHONE.includes(result) ? str(body.phone, 'Phone number', 32) : undefined;
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    const { order, changed } = checkWhatsApp(id, result, session.email, { phone });
    return json({ order, changed });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/whatsapp');
  }
}
