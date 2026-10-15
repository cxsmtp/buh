import type { DeliverySettings, Emirate } from '@/types';

/**
 * Where and how fast we deliver. Used by checkout (to show it) and by the
 * server (which decides, and charges any same-day fee in fils).
 *
 * Serviceability comes from the address the customer chooses (emirate and
 * area), never from a GPS reading: phones and laptops often report a network
 * location far from where they are. The courier is chosen behind the scenes
 * and is not shown to customers; Jeebly covers all seven emirates, and a
 * booking it refuses is reported to the owner, never invented.
 */

export const EMIRATES_LIST: Emirate[] = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'];

export interface DeliveryCheck {
  serviceable: boolean;
  /** For the customer: "We deliver to Al Barsha, Dubai". */
  message: string;
  /** "1–2 days" */
  days: string;
  sameDay: { available: boolean; fee: number; cutoff: string; reason?: string };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The time in the UAE (UTC+4 all year). */
export function uaeMinutes(now: number): number {
  const d = new Date(now + 4 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function deliveryCheck(input: { emirate: string; area: string }, s: DeliverySettings, now = Date.now()): DeliveryCheck {
  const emirate = EMIRATES_LIST.find((e) => e === input.emirate);
  const area = input.area.trim();
  const notServed = s.notServed.map(norm).filter(Boolean);
  const blocked = Boolean(area) && notServed.some((n) => norm(area) === n || norm(area).includes(n));
  const where = [area, emirate].filter(Boolean).join(', ');
  const serviceable = Boolean(emirate) && s.emirates.includes(emirate!) && !blocked;
  const [h, m] = s.sameDayCutoff.split(':').map(Number);
  const beforeCutoff = uaeMinutes(now) < h * 60 + m;
  const sameDayHere = Boolean(emirate) && s.sameDayEmirates.includes(emirate!);
  const sameDay = {
    available: serviceable && s.sameDayEnabled && sameDayHere && beforeCutoff,
    fee: s.sameDayFee,
    cutoff: s.sameDayCutoff,
    reason: !s.sameDayEnabled ? undefined : !sameDayHere ? `Same-day delivery is for ${s.sameDayEmirates.join(', ')}.` : !beforeCutoff ? `Same-day delivery is for orders before ${s.sameDayCutoff}; tomorrow is the earliest now.` : undefined,
  };
  return {
    serviceable,
    message: serviceable
      ? `We deliver to ${where || emirate}`
      : !emirate
        ? 'Choose your emirate.'
        : `Sorry, we don’t deliver to ${where} yet. Message us and we’ll see what we can do.`,
    days: s.standardDays,
    sameDay,
  };
}

/** A GPS reading inside the UAE (anything else is a network location, not the customer). */
export function inUAE(lat: number, lng: number): boolean {
  return lat >= 22.5 && lat <= 26.2 && lng >= 51.4 && lng <= 56.5;
}
