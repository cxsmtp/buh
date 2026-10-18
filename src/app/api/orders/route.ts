import { after } from 'next/server';
import { audit } from '@/lib/server/audit';
import { emailBankDetails } from '@/lib/server/bankMail';
import { enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, clientIp, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { customerView, placeOrder } from '@/lib/server/orders';
import { abandonUnstarted, startCardPayment } from '@/lib/server/payments';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * Place an order. Needs the signed proof of SMS verification for the phone
 * number (a card order needs none: it counts once Stripe says it is paid);
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
    const { order, created } = placeOrder(body);
    if (created) audit('order.created', { orderId: order.id, total: order.total, paymentMethod: order.paymentMethod, ip: clientIp(req) });
    if (created && order.bankTransfer && order.customer.email) {
      const base = await siteUrl();
      after(() => emailBankDetails(order.id, base));
    }
    if (order.paymentMethod !== 'online_card') return json({ success: true, order: customerView(order) }, created ? 201 : 200);
    // The same checkout sent again (a retry): the same order, and the same PaymentIntent.
    if (order.card?.state !== 'pending' && order.card?.state !== 'failed') return json({ success: true, order: customerView(order) }, 200);
    try {
      const { clientSecret } = await startCardPayment(order.id);
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
