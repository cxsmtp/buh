import type { Emirate } from '@/types';
import { inUAE } from './delivery';

/** Well-known UAE communities, for "Drop pin on map" and to suggest an area from a GPS reading. */

export interface UAEKnownLocation {
  name: string;
  emirate: Emirate;
  lat: number;
  lng: number;
}

export const UAE_KEY_LOCATIONS: UAEKnownLocation[] = [
  // Dubai
  { name: 'Dubai Marina', emirate: 'Dubai', lat: 25.0772, lng: 55.1396 },
  { name: 'Downtown Dubai / Burj Khalifa', emirate: 'Dubai', lat: 25.1972, lng: 55.2744 },
  { name: 'Palm Jumeirah', emirate: 'Dubai', lat: 25.1124, lng: 55.1390 },
  { name: 'JBR (Jumeirah Beach Residence)', emirate: 'Dubai', lat: 25.0805, lng: 55.1364 },
  { name: 'Jumeirah Village Circle (JVC)', emirate: 'Dubai', lat: 25.0597, lng: 55.2078 },
  { name: 'Business Bay', emirate: 'Dubai', lat: 25.1837, lng: 55.2666 },
  { name: 'Arabian Ranches', emirate: 'Dubai', lat: 25.0534, lng: 55.2655 },
  { name: 'Dubai Hills Estate', emirate: 'Dubai', lat: 25.1122, lng: 55.2536 },
  { name: 'Al Barsha', emirate: 'Dubai', lat: 25.1118, lng: 55.2039 },
  { name: 'Mirdif', emirate: 'Dubai', lat: 25.2167, lng: 55.4167 },
  { name: 'Deira', emirate: 'Dubai', lat: 25.2697, lng: 55.3095 },
  { name: 'Bur Dubai', emirate: 'Dubai', lat: 25.2532, lng: 55.2974 },
  { name: 'Dubai Silicon Oasis', emirate: 'Dubai', lat: 25.1245, lng: 55.3789 },
  
  // Abu Dhabi
  { name: 'Corniche / Downtown', emirate: 'Abu Dhabi', lat: 24.4697, lng: 54.3435 },
  { name: 'Saadiyat Island', emirate: 'Abu Dhabi', lat: 24.5422, lng: 54.4372 },
  { name: 'Yas Island', emirate: 'Abu Dhabi', lat: 24.4962, lng: 54.6064 },
  { name: 'Al Reem Island', emirate: 'Abu Dhabi', lat: 24.4975, lng: 54.4069 },
  { name: 'Khalifa City', emirate: 'Abu Dhabi', lat: 24.4258, lng: 54.5800 },
  { name: 'Al Ain Central', emirate: 'Abu Dhabi', lat: 24.2075, lng: 55.7447 },

  // Sharjah
  { name: 'Al Majaz Waterfront', emirate: 'Sharjah', lat: 25.3283, lng: 55.3854 },
  { name: 'Al Nahda', emirate: 'Sharjah', lat: 25.3012, lng: 55.3725 },
  { name: 'Muwailih Commercial', emirate: 'Sharjah', lat: 25.3060, lng: 55.4590 },
  { name: 'Al Taawun', emirate: 'Sharjah', lat: 25.3167, lng: 55.3722 },

  // Ajman
  { name: 'Ajman Corniche', emirate: 'Ajman', lat: 25.4111, lng: 55.4350 },
  { name: 'Al Nuaimiya', emirate: 'Ajman', lat: 25.3875, lng: 55.4560 },

  // Ras Al Khaimah
  { name: 'Al Marjan Island', emirate: 'Ras Al Khaimah', lat: 25.6800, lng: 55.7400 },
  { name: 'Al Hamra Village', emirate: 'Ras Al Khaimah', lat: 25.6989, lng: 55.7878 },

  // Fujairah
  { name: 'Fujairah City Center', emirate: 'Fujairah', lat: 25.1288, lng: 56.3265 },

  // Umm Al Quwain
  { name: 'Al Salamah / UAQ Marina', emirate: 'Umm Al Quwain', lat: 25.5647, lng: 55.5552 },
];

/** Distance in km (haversine). */
export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * The nearest known community to a GPS reading, only if the reading is in the UAE and within
 * `maxKm` of one; otherwise null (a guess would put the customer in the wrong emirate).
 */
export function nearestUAELocation(lat: number, lng: number, maxKm = 15): { location: UAEKnownLocation; km: number } | null {
  if (!inUAE(lat, lng)) return null;
  let best: { location: UAEKnownLocation; km: number } | null = null;
  for (const loc of UAE_KEY_LOCATIONS) {
    const km = kmBetween({ lat, lng }, loc);
    if (!best || km < best.km) best = { location: loc, km };
  }
  return best && best.km <= maxKm ? best : null;
}
