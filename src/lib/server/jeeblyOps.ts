import type { Order } from '@/types';
import { callJeebly, fetchJeeblyLabel, JEEBLY_API, jeeblyOk, jeeblySaid, mapJeeblyTracking, type JeeblyTracking } from '@/lib/jeeblyApi';
import { auditOrThrow } from './audit';
import { noteCarrierCancel } from './orders';
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

const TRACK_TTL = 5 * 60_000;
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
  if (hit && !fresh && Date.now() - hit.at < TRACK_TTL) return hit.value;
  if (!rateLimit('jeebly:track', 60, 60_000).ok) return hit?.value ?? { error: 'Tracking is busy: try again in a minute.' };
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
  return { lastStatus: t.lastStatus, events: t.events.map(({ status, desc, hub, at }) => ({ status, desc, hub, at })) };
}

/**
 * Cancel the booking with Jeebly (the owner cancelled the order). The result is in the audit log
 * before it is reported, and on the order. Never claims a cancel Jeebly did not confirm.
 */
export async function cancelJeeblyBooking(order: Order, actor: string): Promise<{ attempted: boolean; cancelled: boolean; message: string }> {
  if (!jeeblyBooking(order)) return { attempted: false, cancelled: false, message: '' };
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
