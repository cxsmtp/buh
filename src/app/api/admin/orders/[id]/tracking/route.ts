import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { enterTracking, getOrder, HAND_CARRIERS, type HandCarrier } from '@/lib/server/orders';
import { assertPublicHttpsUrl } from '@/lib/server/outbound';

/**
 * "Enter tracking number": the owner booked the parcel in the carrier's own portal and types the
 * real AWB (and, if they have it, the tracking link) in. Checked and audited on the server before
 * it is reported done; a real booking already on the order is replaced only with `replace: true`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 2 * 1024);
    allowFields(body, ['carrier', 'carrierName', 'awb', 'trackingUrl', 'replace']);
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    if (!HAND_CARRIERS.includes(body.carrier as HandCarrier)) throw new HttpError(400, 'Choose Jeebly, Eco Express or another courier.');
    if (body.replace !== undefined && typeof body.replace !== 'boolean') throw new HttpError(400, 'replace must be true or false.');
    const awb = str(body.awb, 'Tracking number', 40);
    const carrierName = str(body.carrierName, 'Courier name', 40, { required: false });
    const link = str(body.trackingUrl, 'Tracking link', 500, { required: false });
    // A link customers will open: https on a public host only.
    const trackingUrl = link ? (await assertPublicHttpsUrl(link, 'Tracking link')).toString() : '';
    const order = enterTracking(id, session.email, { carrier: body.carrier as HandCarrier, carrierName, awb, trackingUrl, replace: body.replace === true });
    return json({ order });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/tracking');
  }
}
