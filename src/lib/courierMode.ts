/**
 * Which kind of booking a courier makes now, in words the owner and the code share
 * (the admin hub works it out from the "saved" flags, the server from the stored keys).
 *
 * Jeebly:
 *  - live: Live mode on: a real shipment with the live keys.
 *  - sandbox: Live off, sandbox keys saved: a test shipment in Jeebly's sandbox (its own AWB).
 *  - practice: no keys saved at all: an offline practice booking, nothing is sent anywhere.
 *  - blocked: Live off with only live keys: nothing to test with (add sandbox keys, or go live).
 * Eco Express: live booking is not connected yet, so it is practice or refused.
 */
export type JeeblyMode = 'live' | 'sandbox' | 'practice' | 'blocked';

export function jeeblyMode(s: { isLive: boolean; hasLiveKeys: boolean; hasSandboxKeys: boolean }): JeeblyMode {
  if (s.isLive) return 'live';
  if (s.hasSandboxKeys) return 'sandbox';
  if (s.hasLiveKeys) return 'blocked';
  return 'practice';
}

export const LIVE_OFF_WARNING =
  'Live mode is off: bookings are tests only. Nothing reaches Jeebly, and the customer sees no tracking. Turn on Live mode in Couriers.';

export const BLOCKED_MESSAGE =
  'Live mode is off and only live keys are saved, so there is nothing to test with: add your Jeebly sandbox keys in Couriers (test bookings), or run the Sandbox check and turn on Live mode.';

export const ECO_LIVE_NOT_CONNECTED =
  "Eco Express live booking isn't connected yet: book in the Eco portal and use Enter tracking number.";

/** The phrase the owner types to switch Jeebly Live on without a passed Sandbox check. */
export const LIVE_OVERRIDE_PHRASE = 'TURN ON WITHOUT SANDBOX CHECK';

/** Customer-facing courier names (the admin hub; customers see a name only for a hand-entered link). */
export function carrierLabel(provider: string, carrierName?: string): string {
  if (provider === 'jeebly') return 'Jeebly';
  if (provider === 'echo') return 'Eco Express';
  return carrierName || 'Courier';
}

/** AED with two decimals and thousands separators (1,234.50), from a number of dirhams. */
export function aed2(amount: number): string {
  const fils = Math.round((Number(amount) || 0) * 100);
  return (fils / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
