import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { jeeblyTrackingFor } from '@/lib/server/jeeblyOps';
import { getOrder } from '@/lib/server/orders';

/**
 * Admin "Refresh tracking": the booking's status and events from Jeebly, asked again now (only
 * status, description, hub and time). It never moves the order: the owner marks it delivered.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Order not found.');
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    enforceLimit(`carrier-tracking:${session.email}`, 120, 60 * 60 * 1000, 'Too many refreshes this hour. Please wait a little.');
    const tracking = await jeeblyTrackingFor(order, { fresh: true });
    if ('error' in tracking) throw new HttpError(502, tracking.error);
    return json({ tracking });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/carrier-tracking');
  }
}
