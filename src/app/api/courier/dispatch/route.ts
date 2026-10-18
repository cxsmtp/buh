import { audit } from '@/lib/server/audit';
import { parseCourierProvider } from '@/lib/server/courierInput';
import { dispatchOrder } from '@/lib/server/dispatch';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';

/** Admin: book a courier for a stored order. The order and courier keys are read on the server. */
export async function POST(request: Request) {
  try {
    const session = await requireAdmin(request);
    const body = await readJsonBody(request, 8 * 1024);
    const orderId = str(body.orderId, 'Order', 60);
    const provider = parseCourierProvider(body.provider);
    const pickupDate = str(body.pickupDate, 'Pickup date', 10, { required: false });
    if (pickupDate && !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new HttpError(400, 'Pickup date must be YYYY-MM-DD.');
    const number = (v: unknown, field: string, min: number, max: number) => {
      if (v === undefined || v === null || v === '') return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max}.`);
      return n;
    };

    const outcome = await dispatchOrder({
      orderId,
      provider,
      pickupDate: pickupDate || undefined,
      weightKg: number(body.weightKg, 'Weight', 0.1, 500),
      pieces: number(body.pieces, 'Pieces', 1, 500),
      adminNotes: body.adminNotes === undefined ? undefined : str(body.adminNotes, 'Notes', 1000, { required: false }),
      // true once the owner has checked the carrier portal after an unanswered attempt
      rebook: body.rebook === true,
      actor: session.email,
      // true once the owner has answered "ship anyway" for an order not confirmed on WhatsApp
      shipUnconfirmed: body.shipUnconfirmed === true,
    });
    if (outcome.attempt) {
      audit('courier.dispatch', { by: session.email, orderId, provider, rebook: body.rebook === true, ...outcome.attempt });
    }
    return json(outcome.body, outcome.status);
  } catch (error) {
    return handleRouteError(error, 'courier/dispatch');
  }
}
