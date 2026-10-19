import { enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { normalizePhoneNumber } from '@/lib/otpService';
import { getOrder, lookupOrder } from '@/lib/server/orders';
import { customerTracking } from '@/lib/server/jeeblyOps';
import { rateLimit } from '@/lib/server/rateLimit';

/** Track Order: order number + the phone number on the order. Limited to slow guessing. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'lookup', 30, 15 * 60 * 1000, 'Too many lookups. Please wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    const orderId = str(body.orderId, 'Order number', 40);
    const phone = normalizePhoneNumber(str(body.phone, 'Phone number', 32));
    // Per order number too, so spreading guesses over addresses does not help.
    if (!rateLimit(`lookup:order:${orderId.toUpperCase()}`, 10, 15 * 60 * 1000).ok) {
      return json({ found: false, message: 'Too many lookups for this order. Please wait a few minutes.' }, 429);
    }
    const order = lookupOrder(orderId, phone);
    if (!order) return json({ found: false, message: 'No order matches that order number and phone number.' }, 404);
    // A real Jeebly booking: its live status and events (kept 5 minutes; never phones, rider, proof or signature).
    const full = getOrder(order.id);
    const live = full ? await customerTracking(full).catch(() => undefined) : undefined;
    return json({ found: true, order: live ? { ...order, courier: { ...order.courier, live } } : order });
  } catch (err) {
    return handleRouteError(err, 'orders/lookup', { found: false });
  }
}
