import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { confirmPhotoAmount, getOrder } from '@/lib/server/orders';

/**
 * "Confirm amount" on an order from a photo: the owner checks the photos and the amount the
 * customer typed (agreed on WhatsApp), and corrects it if needed. Only then can the order be
 * confirmed or booked. The same amount again changes nothing; audited before it is reported done.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['amount']);
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)?.photoOrder) throw new HttpError(404, 'Order not found.');
    const { order, changed } = confirmPhotoAmount(id, body.amount, session.email);
    return json({ order, changed });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/photo-amount');
  }
}
