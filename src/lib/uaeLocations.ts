import type { Emirate } from '@/types';
import { UAE_AREAS } from '@/data/uaeAreas';
import { inUAE } from './delivery';

/** Communities whose centre we know, for "Drop pin" and to suggest an area from a precise GPS reading. */

export interface UAEKnownLocation {
  name: string;
  emirate: Emirate;
  lat: number;
  lng: number;
}

export const UAE_KEY_LOCATIONS: UAEKnownLocation[] = UAE_AREAS.filter((a) => a.lat !== undefined && a.lng !== undefined).map((a) => ({
  name: a.name,
  emirate: a.emirate,
  lat: a.lat!,
  lng: a.lng!,
}));

/** Distance in km (haversine). */
export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** A community is suggested only within this distance of its centre… */
export const SUGGEST_WITHIN_KM = 1.5;
/** …and only from a reading this precise (metres). Wi-Fi and network locations are often ±1–5 km. */
export const SUGGEST_MAX_ACCURACY_M = 300;

/**
 * The nearest known community to a GPS reading, only if the reading is in the UAE and within
 * `maxKm` of one; otherwise null (a guess would put the customer in the wrong community).
 */
export function nearestUAELocation(lat: number, lng: number, maxKm = SUGGEST_WITHIN_KM): { location: UAEKnownLocation; km: number } | null {
  if (!inUAE(lat, lng)) return null;
  let best: { location: UAEKnownLocation; km: number } | null = null;
  for (const loc of UAE_KEY_LOCATIONS) {
    const km = kmBetween({ lat, lng }, loc);
    if (!best || km < best.km) best = { location: loc, km };
  }
  return best && best.km <= maxKm ? best : null;
}

export type GpsSuggestion =
  | { kind: 'outside' }
  /** Accuracy worse than SUGGEST_MAX_ACCURACY_M: keep the pin for the driver, guess nothing. */
  | { kind: 'approximate'; accuracyM: number }
  /** Precise, but no known community centre within SUGGEST_WITHIN_KM. */
  | { kind: 'unknown' }
  | { kind: 'area'; location: UAEKnownLocation; km: number };

/**
 * What a GPS reading tells us about the customer's area. Only a precise reading (≤ 300 m) within
 * 1.5 km of a known community suggests that community; a laptop's ±2 km Wi-Fi location once
 * "found" a customer in Discovery Gardens 12 km away in Arabian Ranches.
 */
export function suggestAreaFromGps(lat: number, lng: number, accuracyM: number): GpsSuggestion {
  if (!inUAE(lat, lng)) return { kind: 'outside' };
  // A missing or nonsense accuracy is treated as approximate, never as precise.
  if (!(Number.isFinite(accuracyM) && accuracyM >= 0 && accuracyM <= SUGGEST_MAX_ACCURACY_M)) {
    return { kind: 'approximate', accuracyM: Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : Infinity };
  }
  const near = nearestUAELocation(lat, lng);
  return near ? { kind: 'area', ...near } : { kind: 'unknown' };
}

/** "± 2 km", "± 1.5 km", "± 450 m" (unknown: "unknown accuracy"). */
export function formatAccuracy(m: number): string {
  if (!Number.isFinite(m)) return 'unknown accuracy';
  if (m < 1000) return `± ${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return `± ${km < 10 ? Math.round(km * 10) / 10 : Math.round(km)} km`;
}
