import { after } from 'next/server';
import { audit } from '@/lib/server/audit';
import { emailBankDetails } from '@/lib/server/bankMail';
import { enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, clientIp, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { customerView, getOrder, placeOrder } from '@/lib/server/orders';
import { abandonUnstarted, startCardPayment } from '@/lib/server/payments';

/**
 * Place an order. With Settings → Phone check "SMS code", needs the signed proof of SMS
 * verification for the phone number (a card order needs none: it counts once Stripe says it is
 * paid); with "WhatsApp (free)", the number only (checked like checkout's), confirmed on WhatsApp
 * afterwards, with caps per phone, per connection and overall (src/lib/server/orders.ts);
 * prices, stock and totals are worked out on the server. A card order also
 * gets its Stripe PaymentIntent here: only its client secret goes back. A bank-transfer order's
 * bank details are emailed to the customer after the answer (when they gave an email), with the
 * order's private link; the answer itself carries only that link, never the account.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'orders', 20, 60 * 60 * 1000, 'Too many orders from this connection. Please try again later.');
    // A bank receipt (max 5 MB) arrives base64-encoded, so allow ~7 MB.
    const body = await readJsonBody(req, 7 * 1024 * 1024);
    const ip = clientIp(req);
    const { order, created } = placeOrder(body, { ip });
    if (created) audit('order.created', { orderId: order.id, total: order.total, paymentMethod: order.paymentMethod, ip });
    if (created && order.bankTransfer && order.customer.email) after(() => emailBankDetails(order.id));
    if (order.paymentMethod !== 'online_card') return json({ success: true, order: customerView(order) }, created ? 201 : 200);
    // The same checkout sent again (a retry): the same order, and the same PaymentIntent (or, once
    // paid, the paid order: never a second charge).
    if (order.card?.state !== 'pending' && order.card?.state !== 'failed') return json({ success: true, order: customerView(order) }, 200);
    try {
      const { clientSecret, paid } = await startCardPayment(order.id);
      if (paid) return json({ success: true, order: customerView(getOrder(order.id)!) }, 200);
      return json({ success: true, order: customerView(order), payment: { clientSecret } }, created ? 201 : 200);
    } catch (err) {
      // No client secret left the server, so nobody can pay it: free its pieces now.
      abandonUnstarted(order.id);
      if (err instanceof HttpError) throw new HttpError(err.status, err.message, err.headers, { ...err.details, code: 'card_start_failed' });
      throw err;
    }
  } catch (err) {
    return handleRouteError(err, 'orders');
  }
}
