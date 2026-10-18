import { enforceIpLimit } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { abandonCardPayment, checkCardPayment } from '@/lib/server/payments';
import { rateLimit } from '@/lib/server/rateLimit';

/**
 * The paying browser asks about its own card order ("check": the server asks Stripe, never takes
 * the browser's word), or leaves card checkout ("abandon": the payment is stopped at Stripe and the
 * pieces go back on sale). It proves the order is its own with the PaymentIntent's client secret,
 * which only that browser was given. A wrong pair gets the same answer as an unknown order.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'card-status', 120, 15 * 60 * 1000, 'Too many requests. Please wait a minute.');
    const body = await readJsonBody(req, 2048);
    allowFields(body, ['orderId', 'clientSecret', 'action']);
    const orderId = str(body.orderId, 'Order number', 40).toUpperCase();
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(orderId)) throw new HttpError(404, 'No card payment matches.');
    const action = body.action === 'abandon' ? 'abandon' : body.action === undefined || body.action === 'check' ? 'check' : null;
    if (!action) throw new HttpError(400, 'Unknown action.');
    // Per order too: the confirmation screen asks every few seconds for a minute or so.
    if (!rateLimit(`card-status:${orderId}`, 90, 15 * 60 * 1000).ok) throw new HttpError(429, 'Too many requests. Please wait a minute.');
    const view = action === 'abandon' ? await abandonCardPayment(orderId, body.clientSecret) : await checkCardPayment(orderId, body.clientSecret);
    return json({ success: true, ...view });
  } catch (err) {
    return handleRouteError(err, 'orders/payment');
  }
}
