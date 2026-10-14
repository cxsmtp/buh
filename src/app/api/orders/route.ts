import { audit } from '@/lib/server/audit';
import { enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, clientIp, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { customerView, placeOrder } from '@/lib/server/orders';

/**
 * Place an order. Needs the signed proof of SMS verification for the phone
 * number; prices, stock and totals are worked out on the server.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'orders', 20, 60 * 60 * 1000, 'Too many orders from this connection. Please try again later.');
    // A bank receipt (max 5 MB) arrives base64-encoded, so allow ~7 MB.
    const body = await readJsonBody(req, 7 * 1024 * 1024);
    const { order, created } = placeOrder(body);
    if (created) audit('order.created', { orderId: order.id, total: order.total, paymentMethod: order.paymentMethod, ip: clientIp(req) });
    return json({ success: true, order: customerView(order) }, created ? 201 : 200);
  } catch (err) {
    return handleRouteError(err, 'orders');
  }
}
