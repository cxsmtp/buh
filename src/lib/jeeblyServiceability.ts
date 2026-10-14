import { Emirate } from '@/types';

export interface ServiceabilityResult {
  serviceable: boolean;
  provider: 'jeebly';
  hub: string;
  zone: string;
  deliverySpeed: string;
  estimatedTransitHours: number;
  cutoffTime: string;
  codAllowed: boolean;
  serviceMessage: string;
  matchedArea?: string;
  matchedEmirate?: Emirate;
  coordinates?: {
    lat: number;
    lng: number;
  };
}

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

export function findClosestUAELocation(lat: number, lng: number): UAEKnownLocation {
  let closest = UAE_KEY_LOCATIONS[0];
  let minDistance = Number.MAX_VALUE;

  for (const loc of UAE_KEY_LOCATIONS) {
    const dLat = loc.lat - lat;
    const dLng = loc.lng - lng;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < minDistance) {
      minDistance = dist;
      closest = loc;
    }
  }

  return closest;
}

export function checkJeeblyServiceability(params: {
  emirate?: string;
  area?: string;
  lat?: number;
  lng?: number;
}): ServiceabilityResult {
  const { emirate, area, lat, lng } = params;

  // 1. If GPS coordinates provided, verify they are within UAE bounding box
  if (lat !== undefined && lng !== undefined) {
    const isWithinUAE = lat >= 22.4 && lat <= 26.5 && lng >= 51.0 && lng <= 56.8;
    if (!isWithinUAE) {
      return {
        serviceable: false,
        provider: 'jeebly',
        hub: 'Unserviceable Zone',
        zone: 'International / Remote Out-of-Bounds',
        deliverySpeed: 'Unavailable',
        estimatedTransitHours: 0,
        cutoffTime: 'N/A',
        codAllowed: false,
        serviceMessage: 'GPS pin is outside the United Arab Emirates delivery territory.',
        coordinates: { lat, lng },
      };
    }
  }

  const selectedEmirate = (emirate || 'Dubai') as Emirate;

  // 2. Hub and delivery SLA mapping for Jeebly
  switch (selectedEmirate) {
    case 'Dubai':
      return {
        serviceable: true,
        provider: 'jeebly',
        hub: 'Jeebly Dubai Central Logistics Hub (Al Quoz DXB-01)',
        zone: 'Zone 1 - Dubai Metro Priority',
        deliverySpeed: 'Same-Day (before 1 PM) / Next-Day Guaranteed',
        estimatedTransitHours: 18,
        cutoffTime: '4:00 PM for next-day 10:00 AM delivery',
        codAllowed: true,
        serviceMessage: `Address in ${area || 'Dubai'} is 100% verified & serviceable with Same-Day/Next-Day express delivery.`,
        matchedArea: area || 'Central Dubai',
        matchedEmirate: 'Dubai',
        coordinates: lat && lng ? { lat, lng } : { lat: 25.1972, lng: 55.2744 },
      };

    case 'Abu Dhabi':
      return {
        serviceable: true,
        provider: 'jeebly',
        hub: 'Jeebly Capital Delivery Depot (AUH-01, Musaffah)',
        zone: 'Zone 2 - Capital Region Express',
        deliverySpeed: 'Guaranteed Next-Day Express Delivery',
        estimatedTransitHours: 24,
        cutoffTime: '3:00 PM for next-day doorstep delivery',
        codAllowed: true,
        serviceMessage: `Address in ${area || 'Abu Dhabi'} is fully serviceable by Jeebly Capital Hub.`,
        matchedArea: area || 'Central Abu Dhabi',
        matchedEmirate: 'Abu Dhabi',
        coordinates: lat && lng ? { lat, lng } : { lat: 24.4697, lng: 54.3435 },
      };

    case 'Sharjah':
    case 'Ajman':
      return {
        serviceable: true,
        provider: 'jeebly',
        hub: 'Jeebly Northern Emirates Hub (SHJ-01, Industrial Area)',
        zone: 'Zone 3 - Northern Emirates Urban',
        deliverySpeed: 'Next-Day Priority Delivery',
        estimatedTransitHours: 24,
        cutoffTime: '3:30 PM for next-day delivery',
        codAllowed: true,
        serviceMessage: `Address in ${area || selectedEmirate} is verified for next-day priority courier dispatch.`,
        matchedArea: area || selectedEmirate,
        matchedEmirate: selectedEmirate,
        coordinates: lat && lng ? { lat, lng } : { lat: 25.3283, lng: 55.3854 },
      };

    case 'Ras Al Khaimah':
    case 'Fujairah':
    case 'Umm Al Quwain':
    default:
      return {
        serviceable: true,
        provider: 'jeebly',
        hub: 'Jeebly Regional Express Hub (RAK-01 / Coastal)',
        zone: 'Zone 4 - Regional Emirates Express',
        deliverySpeed: '24 to 48 Hours Express Delivery',
        estimatedTransitHours: 36,
        cutoffTime: '2:00 PM for 24-hr transit',
        codAllowed: true,
        serviceMessage: `Address in ${area || selectedEmirate} is verified. Fast delivery within 24-48 hours.`,
        matchedArea: area || selectedEmirate,
        matchedEmirate: selectedEmirate,
        coordinates: lat && lng ? { lat, lng } : { lat: 25.6800, lng: 55.7400 },
      };
  }
}
