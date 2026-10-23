import { createJeeblyShipment, jeeblyModeOf } from '@/lib/jeebly';
import { createEchoShipment } from '@/lib/echo';
import { BLOCKED_MESSAGE, carrierLabel, ECO_LIVE_NOT_CONNECTED } from '@/lib/courierMode';
import type { Order } from '@/types';
import { HttpError } from './http';
import { cancelJeeblyBooking, jeeblyBooking } from './jeeblyOps';
import { assertNotHeld, assertShipAllowed, getOrder, recordBooking } from './orders';
import { emailOrder } from './orderMail';
import { contactEmail, getSettings } from './settings';

export interface DispatchOutcome {
  status: number;
  body: Record<string, unknown>;
  /** What was attempted, for the audit log (undefined when nothing was sent to a carrier). */
  attempt?: { success: boolean; simulated: boolean; uncertain: boolean; awb: string };
}

// One booking per order at a time: a double click must not book twice.
const inFlight = new Set<string>();

/**
 * Book a courier for a stored order, using the courier keys stored on the
 * server. At most once per order in live mode: a repeat returns the booking
 * already made, and an attempt the carrier never answered must be confirmed
 * (`rebook`) before booking again. The result is saved on the order.
 */
export async function dispatchOrder(input: {
  orderId: string;
  provider: 'jeebly' | 'echo';
  pickupDate?: string;
  weightKg?: number;
  pieces?: number;
  adminNotes?: string;
  rebook: boolean;
  actor: string;
  /** The owner's "ship anyway" for a COD order not yet confirmed on WhatsApp (asked first, then recorded). */
  shipUnconfirmed?: boolean;
  /** The owner's explicit "yes, a test booking" when the courier is not in Live mode (asked first). */
  testBooking?: boolean;
}): Promise<DispatchOutcome> {
  const { orderId, provider, rebook, actor } = input;
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (order.status === 'cancelled' || order.status === 'delivered') {
    throw new HttpError(409, `This order is ${order.status} and cannot be booked.`);
  }
  // Held until the customer confirms on WhatsApp (Settings → Store & contact): nothing goes to a carrier.
  assertNotHeld(order);
  // A card order goes to a carrier only once Stripe has said it is paid.
  if (order.paymentMethod === 'online_card' && order.card?.state !== 'paid') {
    throw new HttpError(409, `${order.id} is not paid by card yet, so it cannot be booked.`, {}, { code: 'card_unpaid' });
  }
  // Eco Express books next-day only: a same-day order (the customer paid for it) goes with Jeebly Express.
  if (order.deliveryOption === 'same_day' && provider === 'echo') {
    throw new HttpError(400, 'This is a same-day order: Eco Express books next-day only. Book it with Jeebly (Express).');
  }
  const settings = getSettings('courier');
  const live = settings[provider].isLive;
  // Eco Express has no real booking connection yet (its spec points at a mock server).
  if (provider === 'echo' && live) throw new HttpError(409, ECO_LIVE_NOT_CONNECTED, {}, { code: 'eco_not_connected' });
  const jeeblyMode = provider === 'jeebly' ? jeeblyModeOf(settings.jeebly) : null;
  if (jeeblyMode === 'blocked') throw new HttpError(409, BLOCKED_MESSAGE, {}, { code: 'no_test_keys' });

  if (inFlight.has(order.id)) {
    return { status: 409, body: { success: false, message: 'This order is already being booked. Please wait.' } };
  }

  const previous = order.courier.bookingState;
  // A real booking is never made twice, and never replaced by a test one: a repeat returns it.
  // A live attempt Jeebly never answered stays in the way in any mode (a test booking never clears
  // it), until the owner confirms it is not in the portal. (A test booking leaves bookingState
  // as it was, so it never blocks a real one.)
  if (previous === 'booked' || (previous === 'uncertain' && !rebook)) {
    if (previous === 'booked') {
      return {
        status: 200,
        body: {
          success: true,
          alreadyBooked: true,
          order,
          awbNumber: order.courier.awbNumber,
          trackingUrl: order.courier.trackingUrl,
          isSimulated: false,
          message: `Already booked with ${carrierLabel(order.courier.provider, order.courier.carrierName)} (AWB ${order.courier.awbNumber}). Not booked again.`,
        },
      };
    }
    return {
      status: 409,
      body: {
        success: false,
        needsConfirm: true,
        message: `The last booking attempt for ${order.id} got no answer from the carrier, so it may already be booked. Check the carrier portal for reference ${order.id} first. Book again only if it is not there.`,
      },
    };
  }

  const toBook: Order = {
    ...order,
    adminNotes: input.adminNotes ?? order.adminNotes,
    courier: {
      ...order.courier,
      pickupDate: input.pickupDate ?? order.courier.pickupDate,
      weightKg: input.weightKg ?? order.courier.weightKg,
      pieces: input.pieces ?? order.courier.pieces,
    },
  };

  // Not confirmed on WhatsApp yet (cash on delivery, no code): the owner's explicit "ship anyway",
  // in the order's history and the audit log before anything goes to a carrier.
  assertShipAllowed(order.id, actor, input.shipUnconfirmed === true);

  // Not Live: a test booking (Jeebly's sandbox, or practice), only once the owner has said so.
  if (!live && input.testBooking !== true) {
    const what = jeeblyMode === 'sandbox' ? "a test shipment in Jeebly's sandbox" : `a practice booking (nothing is sent to ${carrierLabel(provider)})`;
    throw new HttpError(
      409,
      `${carrierLabel(provider)} is in Test mode: this makes ${what}, not a real shipment. The customer sees no tracking.`,
      {},
      { code: 'test_booking', needsTestConfirm: true, mode: jeeblyMode ?? 'practice' }
    );
  }

  // A size with no weight: the parcel's weight is unknown, and is never guessed for Jeebly
  // (a practice booking sends nothing, so it may go without).
  if (jeeblyMode && jeeblyMode !== 'practice' && !(Number(toBook.courier.weightKg) > 0)) {
    throw new HttpError(400, 'Enter the parcel weight (kg): some sizes in this order have no weight yet.', {}, { code: 'weight_required' });
  }

  inFlight.add(order.id);
  try {
    const result = provider === 'jeebly'
      ? await createJeeblyShipment(toBook, settings.jeebly, { shopName: getSettings('brand').storeName, email: contactEmail() })
      : await createEchoShipment(toBook, settings.echo);

    let saved = order;
    if (result.success) {
      const testStatus = result.testKind === 'sandbox' ? "Test booking in Jeebly's sandbox – not sent to the courier" : 'Practice booking – not sent to the courier';
      saved = recordBooking(order.id, actor, {
        provider,
        awbNumber: result.awbNumber,
        // Only a link the carrier gave (Jeebly gives none); nothing left over from an earlier booking.
        trackingUrl: result.trackingUrl,
        carrierEnv: 'carrierEnv' in result ? result.carrierEnv : undefined,
        enteredByHand: false,
        carrierName: '',
        testKind: result.isSimulated ? result.testKind : undefined,
        status: result.isSimulated ? testStatus : 'Booked with the carrier',
        pickupDate: toBook.courier.pickupDate,
        weightKg: toBook.courier.weightKg,
        pieces: toBook.courier.pieces,
        labelGenerated: true,
        dispatchedAt: new Date().toISOString(),
        bookingState: live && !result.isSimulated ? 'booked' : undefined,
        simulated: result.isSimulated === true,
        notes: input.adminNotes,
      });
    } else if (live && result.uncertain) {
      saved = recordBooking(order.id, actor, { provider, bookingState: 'uncertain', status: 'Booking sent – no answer from the carrier' });
    }
    // Jeebly booked it after the order was cancelled or its card refunded (flagged by recordBooking):
    // cancelled with Jeebly at once (audited); if Jeebly does not confirm, the flag stays.
    const late = saved.status === 'cancelled' || (saved.paymentMethod === 'online_card' && saved.card?.state !== 'paid');
    if (result.success && provider === 'jeebly' && late && saved.attention?.kind === 'booked_after_cancel' && jeeblyBooking(saved)) {
      await cancelJeeblyBooking(saved, actor).catch((err) => console.warn('Jeebly cancel after a late booking failed:', (err as Error).message));
      saved = getOrder(order.id) ?? saved;
    }

    // Booked with a real courier: the order is confirmed for the customer too (once; never a test booking).
    if (result.success && !result.isSimulated && saved.status !== 'cancelled' && saved.customer.email) void emailOrder(saved.id, 'confirmed');
    const { rawResponse: _raw, ...safe } = result as typeof result & { rawResponse?: unknown };
    void _raw;
    return {
      status: result.success ? 200 : 502,
      body: { ...(safe as Record<string, unknown>), order: saved },
      attempt: { success: result.success, simulated: result.isSimulated, uncertain: result.uncertain === true, awb: result.awbNumber },
    };
  } finally {
    inFlight.delete(order.id);
  }
}
