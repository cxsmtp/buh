import { createJeeblyShipment } from '@/lib/jeebly';
import { createEchoShipment } from '@/lib/echo';
import type { Order } from '@/types';
import { HttpError } from './http';
import { getOrder, recordBooking } from './orders';
import { getSettings } from './settings';

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
}): Promise<DispatchOutcome> {
  const { orderId, provider, rebook, actor } = input;
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (order.status === 'cancelled' || order.status === 'delivered') {
    throw new HttpError(409, `This order is ${order.status} and cannot be booked.`);
  }
  // Eco Express books next-day only: a same-day order (the customer paid for it) goes with Jeebly Express.
  if (order.deliveryOption === 'same_day' && provider === 'echo') {
    throw new HttpError(400, 'This is a same-day order: Eco Express books next-day only. Book it with Jeebly (Express).');
  }
  const settings = getSettings('courier');
  const live = settings[provider].isLive;

  if (inFlight.has(order.id)) {
    return { status: 409, body: { success: false, message: 'This order is already being booked. Please wait.' } };
  }

  const previous = order.courier.bookingState;
  if (live && previous && !rebook) {
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
          message: `Already booked with ${order.courier.provider === 'jeebly' ? 'Jeebly' : 'Eco Express'} (AWB ${order.courier.awbNumber}). Not booked again.`,
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

  inFlight.add(order.id);
  try {
    const result = provider === 'jeebly'
      ? await createJeeblyShipment(toBook, settings.jeebly)
      : await createEchoShipment(toBook, settings.echo);

    let saved = order;
    if (result.success) {
      saved = recordBooking(order.id, actor, {
        provider,
        awbNumber: result.awbNumber,
        trackingUrl: result.trackingUrl,
        status: result.isSimulated ? 'Sandbox booking (simulated AWB)' : 'Booked with the carrier',
        pickupDate: toBook.courier.pickupDate,
        weightKg: toBook.courier.weightKg,
        pieces: toBook.courier.pieces,
        labelGenerated: true,
        dispatchedAt: new Date().toISOString(),
        bookingState: live && !result.isSimulated ? 'booked' : undefined,
        simulated: result.isSimulated,
        notes: input.adminNotes,
      });
    } else if (live && result.uncertain) {
      saved = recordBooking(order.id, actor, { provider, bookingState: 'uncertain', status: 'Booking sent – no answer from the carrier' });
    }

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
