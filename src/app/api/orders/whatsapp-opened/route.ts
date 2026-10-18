import { enforceIpLimit, enforceLimit } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { normalizePhoneNumber } from '@/lib/otpService';
import { markWhatsAppOpened } from '@/lib/server/orders';

/**
 * The customer tapped "Confirm on WhatsApp": note that their WhatsApp opened (shown on the
 * order's timeline). Needs the order number and the phone number on it, like Track Order; it
 * only ever sets that order's "opened" time, once, and answers the same whether or not the
 * pair matched (so it tells a guesser nothing).
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'wa-opened', 30, 15 * 60 * 1000, 'Too many requests. Please wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['orderId', 'phone']);
    const orderId = str(body.orderId, 'Order number', 40).toUpperCase();
    const phone = normalizePhoneNumber(str(body.phone, 'Phone number', 32));
    enforceLimit(`wa-opened:order:${orderId}`, 10, 15 * 60 * 1000, 'Too many requests for this order. Please wait a few minutes.');
    markWhatsAppOpened(orderId, phone);
    return json({ ok: true });
  } catch (err) {
    return handleRouteError(err, 'orders/whatsapp-opened', { ok: false });
  }
}
