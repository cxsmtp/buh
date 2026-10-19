import type { Order } from '@/types';
import { callJeebly, fetchJeeblyLabel, JEEBLY_API, jeeblyOk, jeeblySaid, mapJeeblyTracking, type JeeblyTracking } from '@/lib/jeeblyApi';
import { auditOrThrow } from './audit';
import { redact } from './log';
import { getOrder, noteCarrierCancel } from './orders';
import { rateLimit } from './rateLimit';
import { getSettings } from './settings';

/**
 * Jeebly calls about a booking already made: its label PDF, its tracking and cancelling it. The
 * booking's own environment decides the host and keys (a sandbox test in Jeebly's demo system, a
 * real one at the live address), so a test AWB never goes to the live system or the other way.
 */

type Access = { base: string; keys: { apiKey: string; clientKey: string }; env: 'sandbox' | 'live'; awb: string };

/** A Jeebly booking made through the API or typed in from Jeebly's portal (not a practice one). */
export function jeeblyBooking(order: Order): boolean {
  const c = order.courier;
  return c.provider === 'jeebly' && Boolean(c.awbNumber) && c.testKind !== 'practice' && (c.bookingState === 'booked' || c.testKind === 'sandbox');
}

export function jeeblyAccess(order: Order): Access | { error: string } {
  if (!jeeblyBooking(order)) return { error: 'This order has no Jeebly booking.' };
  const c = order.courier;
  const s = getSettings('courier').jeebly;
  const env = c.carrierEnv ?? (c.simulated ? 'sandbox' : 'live');
  if (env === 'sandbox') {
    if (!s.sandboxApiKey || !s.sandboxClientKey) return { error: 'The Jeebly sandbox keys are not saved any more (Couriers).' };
    return { base: JEEBLY_API.sandboxBase, keys: { apiKey: s.sandboxApiKey, clientKey: s.sandboxClientKey }, env, awb: c.awbNumber };
  }
  if (!s.liveBaseUrl || !s.apiKey || !s.clientKey) return { error: "Jeebly's live address and live keys are needed for this (Couriers)." };
  return { base: s.liveBaseUrl, keys: { apiKey: s.apiKey, clientKey: s.clientKey }, env, awb: c.awbNumber };
}

/** The label PDF Jeebly makes for this booking. */
export async function jeeblyLabelFor(order: Order): Promise<{ pdf: Buffer; access: Access } | { error: string }> {
  const access = jeeblyAccess(order);
  if ('error' in access) return access;
  const res = await fetchJeeblyLabel(access.base, access.keys, access.awb);
  return 'pdf' in res ? { pdf: res.pdf, access } : { error: res.error };
}

const scrub = (text: string) => String(redact(text));

const TRACK_TTL = 5 * 60_000;
/** A failed lookup is kept only briefly, so a passing outage is not shown for 5 minutes. */
const TRACK_FAIL_TTL = 30_000;
const tracked = new Map<string, { at: number; value: JeeblyTracking | { error: string } }>();

export function forgetTracking(awb: string): void {
  for (const k of tracked.keys()) if (k.endsWith(`:${awb}`)) tracked.delete(k);
}

/**
 * The booking's tracking from Jeebly: kept 5 minutes per AWB (the customer's Track Order and the
 * hub share it), and at most 60 calls a minute to Jeebly in all. `fresh` (the owner's "Refresh
 * tracking") asks again.
 */
export async function jeeblyTrackingFor(order: Order, { fresh = false } = {}): Promise<JeeblyTracking | { error: string }> {
  const access = jeeblyAccess(order);
  if ('error' in access) return access;
  const key = `${access.env}:${access.awb}`;
  const hit = tracked.get(key);
  if (hit && !fresh && Date.now() - hit.at < ('error' in hit.value ? TRACK_FAIL_TTL : TRACK_TTL)) return hit.value;
  // The owner's "Refresh tracking" has its own budget: customers' lookups can't use it up.
  if (!rateLimit(fresh ? 'jeebly:track:owner' : 'jeebly:track', 60, 60_000).ok) return hit?.value ?? { error: 'Tracking is busy: try again in a minute.' };
  const call = await callJeebly(access.base, JEEBLY_API.paths.track, access.keys, { reference_number: access.awb }, 10_000);
  const value: JeeblyTracking | { error: string } = !call.reached
    ? { error: `Could not reach Jeebly (${call.error}).` }
    : mapJeeblyTracking(call.data) ?? { error: `Jeebly gave no tracking (HTTP ${call.status})${jeeblySaid(call.data, [access.keys.apiKey, access.keys.clientKey]) ? `: ${jeeblySaid(call.data, [access.keys.apiKey, access.keys.clientKey])}` : ''}.` };
  if (tracked.size > 5000) tracked.clear();
  tracked.set(key, { at: Date.now(), value });
  return value;
}

/** What Track Order may show: the live status and events (no phones, rider, proof or signature). */
export async function customerTracking(order: Order): Promise<{ lastStatus: string; events: JeeblyTracking['events'] } | undefined> {
  if (order.courier.simulated || order.courier.bookingState !== 'booked' || !jeeblyBooking(order)) return undefined;
  const t = await jeeblyTrackingFor(order);
  if ('error' in t) return undefined;
  // Jeebly's free text may carry a phone or an email (a rider's, the customer's): masked.
  return { lastStatus: scrub(t.lastStatus), events: t.events.map(({ status, desc, hub, at }) => ({ status: scrub(status), desc: scrub(desc), hub: scrub(hub), at })) };
}

/**
 * Cancel the booking with Jeebly (the owner cancelled the order). The result is in the audit log
 * before it is reported, and on the order. Never claims a cancel Jeebly did not confirm.
 */
export async function cancelJeeblyBooking(order: Order, actor: string): Promise<{ attempted: boolean; cancelled: boolean; message: string }> {
  const none = { attempted: false, cancelled: false, message: '' };
  // The order as it is now: a second request (or the refund's webhook) finds it cancelled already.
  order = getOrder(order.id) ?? order;
  const c = order.courier;
  // A live attempt Jeebly never answered: there may be a shipment, which only the portal can show.
  if (c.provider === 'jeebly' && c.bookingState === 'uncertain') {
    const message = `This order's courier booking may exist: check the Jeebly portal for reference ${order.id} and cancel it there.`;
    auditOrThrow('courier.cancel', { by: actor, orderId: order.id, awb: c.awbNumber || null, cancelled: false, reason: 'uncertain' });
    noteCarrierCancel(order.id, actor, false, message);
    return { attempted: false, cancelled: false, message };
  }
  if (!jeeblyBooking(order) || c.status === 'Cancelled with the carrier' || cancelling.has(order.id)) return none;
  cancelling.add(order.id);
  try {
    return await cancelNow(order, actor);
  } finally {
    cancelling.delete(order.id);
  }
}

// One cancel per order at a time (two requests cancelling at once send it once).
const cancelling = new Set<string>();

async function cancelNow(order: Order, actor: string): Promise<{ attempted: boolean; cancelled: boolean; message: string }> {
  const access = jeeblyAccess(order);
  if ('error' in access) {
    const message = `The Jeebly booking ${order.courier.awbNumber} was not cancelled (${access.error}): cancel it in the Jeebly portal.`;
    auditOrThrow('courier.cancel', { by: actor, orderId: order.id, awb: order.courier.awbNumber, cancelled: false, reason: access.error });
    noteCarrierCancel(order.id, actor, false, message);
    return { attempted: false, cancelled: false, message };
  }
  const call = await callJeebly(access.base, JEEBLY_API.paths.cancel, access.keys, { reference_number: access.awb });
  const said = call.reached ? jeeblySaid(call.data, [access.keys.apiKey, access.keys.clientKey]) : '';
  const cancelled = Boolean(call.reached && call.status! >= 200 && call.status! < 300 && jeeblyOk(call.data));
  const message = cancelled
    ? `Jeebly cancelled the shipment ${access.awb}${said ? ` ("${said}")` : ''}.`
    : `Jeebly did not cancel the shipment ${access.awb}${call.reached ? ` (HTTP ${call.status}${said ? `: "${said}"` : ''})` : ` (no answer: ${call.error})`}. Cancel it in the Jeebly portal so it is not collected.`;
  auditOrThrow('courier.cancel', { by: actor, orderId: order.id, awb: access.awb, env: access.env, cancelled, httpStatus: call.status ?? null, said });
  noteCarrierCancel(order.id, actor, cancelled, message);
  forgetTracking(access.awb);
  return { attempted: true, cancelled, message };
}

/**
 * A full refund made in Stripe's dashboard cancelled the order (its webhook): the Jeebly booking
 * is cancelled too, as "stripe". Whatever happens is on the order: Jeebly's answer (audited), or
 * the flag to cancel it in the portal. Never throws.
 */
export async function cancelJeeblyAfterRefund(orderId: string): Promise<void> {
  const order = getOrder(orderId);
  if (!order || order.status !== 'cancelled') return;
  try {
    await cancelJeeblyBooking(order, 'stripe');
  } catch (err) {
    console.warn('Jeebly cancel after a Stripe refund failed:', (err as Error).message);
    try {
      noteCarrierCancel(orderId, 'stripe', false, `Refunded in Stripe, but its Jeebly booking${order.courier.awbNumber ? ` (AWB ${order.courier.awbNumber})` : ''} could not be cancelled from here: check the Jeebly portal for reference ${orderId} and cancel it there.`);
    } catch {
      // The flag set with the refund stays.
    }
  }
}
