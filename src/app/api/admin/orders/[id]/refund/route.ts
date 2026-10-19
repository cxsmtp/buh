import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getOrder, refundableFils } from '@/lib/server/orders';
import { cancelJeeblyBooking } from '@/lib/server/jeeblyOps';
import { cancelPaidCardWithoutStripe, refundCardOrder } from '@/lib/server/payments';

/** What the owner must send to cancel a paid card order without a Stripe refund: typed on purpose. */
const NO_STRIPE_REFUND_CONFIRM = 'refund-in-stripe-dashboard';

/**
 * "Cancel & refund AED X to the card": refunds what is left of the payment through Stripe (once:
 * idempotency key refund:<order>), recorded from Stripe's answer, and the order cancelled. The body
 * must say the amount the owner was shown, so a refund is never for an amount they didn't see.
 *
 * "Cancel without Stripe refund" (`withoutStripeRefund: true` and `confirm: "refund-in-stripe-dashboard"`):
 * only when the saved keys can't reach the payment (another mode or account); the owner refunds it
 * in that Stripe dashboard. Audited before it counts.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['amount', 'withoutStripeRefund', 'confirm']);
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Order not found.');
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const shown = typeof body.amount === 'number' && Number.isFinite(body.amount) ? Math.round(body.amount * 100) : NaN;
    const left = order.card?.state === 'paid' ? refundableFils(order) : Math.round((order.card?.paidAmount ?? order.total) * 100);
    if (shown !== left) throw new HttpError(409, `The amount to refund is AED ${left / 100}: refresh and try again.`);
    if (body.withoutStripeRefund !== undefined) {
      if (body.withoutStripeRefund !== true || body.confirm !== NO_STRIPE_REFUND_CONFIRM) {
        throw new HttpError(400, `To cancel without a Stripe refund, send withoutStripeRefund: true and confirm: "${NO_STRIPE_REFUND_CONFIRM}".`);
      }
      const cancelledOrder = await cancelPaidCardWithoutStripe(id, session.email);
      const carrierCancel = await cancelJeeblyBooking(cancelledOrder, session.email);
      return json({ order: carrierCancel.attempted || carrierCancel.message ? getOrder(id) : cancelledOrder, outcome: 'cancelled_without_refund', ...(carrierCancel.message ? { carrierCancel } : {}) });
    }
    if (body.confirm !== undefined) throw new HttpError(400, 'Unexpected field: confirm.');
    const { order: updated, outcome } = await refundCardOrder(id, session.email, shown);
    // Cancelled with the refund: a Jeebly booking is cancelled too (audited; never claimed if Jeebly refuses).
    const carrierCancel = updated.status === 'cancelled' && order.status !== 'cancelled' ? await cancelJeeblyBooking(updated, session.email) : null;
    return json({ order: carrierCancel?.message ? getOrder(id) : updated, outcome, ...(carrierCancel?.message ? { carrierCancel } : {}) });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/refund');
  }
}
