import { createJeeblyShipment } from '@/lib/jeebly';
import { createEchoShipment } from '@/lib/echo';
import type { CourierSettings, Order } from '@/types';
import { getBooking, saveBooking } from './bookings';

export interface DispatchOutcome {
  status: number;
  body: Record<string, unknown>;
  /** What was attempted, for the audit log (undefined when nothing was sent to a carrier). */
  attempt?: { success: boolean; simulated: boolean; uncertain: boolean; awb: string };
}

// One booking per order at a time: a double click must not book twice.
const inFlight = new Set<string>();

/**
 * Book a courier for an order, at most once per order in live mode: a repeat
 * returns the booking already made, and an attempt the carrier never answered
 * must be confirmed (`rebook`) before booking again.
 */
export async function dispatchOrder(input: {
  provider: 'jeebly' | 'echo';
  order: Order;
  settings: CourierSettings;
  rebook: boolean;
}): Promise<DispatchOutcome> {
  const { provider, order, settings, rebook } = input;
  const live = settings[provider].isLive;

  if (inFlight.has(order.id)) {
    return { status: 409, body: { success: false, message: 'This order is already being booked. Please wait.' } };
  }

  const previous = live ? getBooking(order.id) : undefined;
  if (previous && !rebook) {
    if (previous.state === 'booked') {
      return {
        status: 200,
        body: {
          success: true,
          alreadyBooked: true,
          awbNumber: previous.awbNumber,
          trackingNumber: previous.awbNumber,
          trackingUrl: previous.trackingUrl,
          isSimulated: false,
          message: `Already booked with ${previous.provider === 'jeebly' ? 'Jeebly' : 'Eco Express'} on ${previous.at.slice(0, 16).replace('T', ' ')} UTC (AWB ${previous.awbNumber}). Not booked again.`,
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

  inFlight.add(order.id);
  try {
    const result = provider === 'jeebly'
      ? await createJeeblyShipment(order, settings.jeebly)
      : await createEchoShipment(order, settings.echo);

    if (live && result.success && !result.isSimulated) {
      saveBooking(order.id, { state: 'booked', provider, awbNumber: result.awbNumber, trackingUrl: result.trackingUrl, at: new Date().toISOString() });
    } else if (live && result.uncertain) {
      saveBooking(order.id, { state: 'uncertain', provider, awbNumber: '', trackingUrl: '', at: new Date().toISOString() });
    }

    const { rawResponse: _raw, ...safe } = result as typeof result & { rawResponse?: unknown };
    void _raw;
    return {
      status: result.success ? 200 : 502,
      body: safe as Record<string, unknown>,
      attempt: { success: result.success, simulated: result.isSimulated, uncertain: result.uncertain === true, awb: result.awbNumber },
    };
  } finally {
    inFlight.delete(order.id);
  }
}
