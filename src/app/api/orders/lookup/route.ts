import { enforceIpLimit } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { normalizePhoneNumber } from '@/lib/otpService';
import { getOrder, lookupOrder, lookupTracked } from '@/lib/server/orders';
import { customerTracking } from '@/lib/server/jeeblyOps';
import { rateLimit } from '@/lib/server/rateLimit';

/**
 * Track Order: order number + the phone number on the order, or the order's private tracking link
 * ({ token }, sent by the shop on WhatsApp). Limited to slow guessing.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'lookup', 30, 15 * 60 * 1000, 'Too many lookups. Please wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    if (body.token !== undefined) {
      allowFields(body, ['token']);
      const tracked = lookupTracked(body.token);
      if (!tracked) return json({ found: false, code: 'track_link_invalid', message: 'This tracking link is not valid. Please check it, or use your order number and phone number.' }, 404);
      const full = getOrder(tracked.id);
      const live = full ? await customerTracking(full).catch(() => undefined) : undefined;
      return json({ found: true, order: live ? { ...tracked, courier: { ...tracked.courier, live } } : tracked });
    }
    const orderId = str(body.orderId, 'Order number', 40);
    const phone = normalizePhoneNumber(str(body.phone, 'Phone number', 32));
    // Per order number too, so spreading guesses over addresses does not help.
    if (!rateLimit(`lookup:order:${orderId.toUpperCase()}`, 10, 15 * 60 * 1000).ok) {
      return json({ found: false, code: 'rate_limited', message: 'Too many lookups for this order. Please wait a few minutes.' }, 429);
    }
    const order = lookupOrder(orderId, phone);
    if (!order) return json({ found: false, code: 'order_no_match', message: 'No order matches that order number and phone number.' }, 404);
    // A real Jeebly booking: its live status and events (kept 5 minutes; never phones, rider, proof or signature).
    const full = getOrder(order.id);
    const live = full ? await customerTracking(full).catch(() => undefined) : undefined;
    return json({ found: true, order: live ? { ...order, courier: { ...order.courier, live } } : order });
  } catch (err) {
    return handleRouteError(err, 'orders/lookup', { found: false });
  }
}
