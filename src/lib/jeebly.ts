import crypto from 'node:crypto';
import { Order, CourierSettings } from '@/types';
import { BLOCKED_MESSAGE, jeeblyMode, type JeeblyMode } from './courierMode';
import { callJeebly, JEEBLY_API, jeeblyAwb, jeeblyCity, jeeblyHint, jeeblyMobile, jeeblyOk, jeeblySaid } from './jeeblyApi';

/** `uncertain`: no answer from the carrier, so the shipment may or may not exist. */
function failure(message: string, httpStatus?: number, uncertain = false): JeeblyApiResponse {
  return { success: false, awbNumber: '', trackingNumber: '', trackingUrl: '', message, isSimulated: false, httpStatus, uncertain };
}

/** Jeebly Scheduled "Create Order" body (flat snake_case, verified against Jeebly's docs and demo). */
export interface JeeblyCreateOrderPayload {
  delivery_type: 'Next day' | 'Same day';
  load_type: 'Document' | 'Non-document';
  consignment_type: 'Forward' | 'Reverse';
  description: string;
  /** Whole kilograms. */
  weight: number;
  payment_type: 'PREPAID' | 'COD';
  /** AED, only for COD. */
  cod_amount?: number;
  num_pieces: number;
  customer_reference_number: string;
  /** YYYY-MM-DD, Dubai time; never a Sunday or a past day. */
  pickup_date: string;
  origin_address_name: string;
  origin_address_house_no: string;
  origin_address_building_name: string;
  origin_address_area: string;
  origin_address_city: string;
  origin_address_type: 'Normal' | 'Western';
  origin_address_mob_no_country_code: string;
  origin_address_mobile_number: string;
  origin_address_landmark: string;
  destination_address_name: string;
  destination_address_house_no: string;
  destination_address_building_name: string;
  destination_address_area: string;
  destination_address_city: string;
  destination_address_type: 'Normal' | 'Western';
  destination_address_mob_no_country_code: string;
  destination_address_mobile_number: string;
  destination_address_landmark: string;
}

export interface JeeblyApiResponse {
  success: boolean;
  awbNumber: string;
  trackingNumber: string;
  /** Jeebly's API gives no tracking page link: always empty (customers see the AWB and its events). */
  trackingUrl: string;
  message: string;
  /** Not a real shipment: a sandbox or practice booking. */
  isSimulated: boolean;
  testKind?: 'sandbox' | 'practice';
  /** Where the booking lives at Jeebly (for its label, tracking and cancel). */
  carrierEnv?: 'sandbox' | 'live';
  mode?: JeeblyMode;
  httpStatus?: number;
  rawResponse?: Record<string, unknown>;
  uncertain?: boolean;
}

/** Who sends the parcel: the shop's name from Settings, the rest from Couriers → pickup. */
export interface JeeblySender {
  shopName: string;
  email?: string;
}

export function jeeblyModeOf(settings: CourierSettings['jeebly']): JeeblyMode {
  return jeeblyMode({
    isLive: settings.isLive === true,
    hasLiveKeys: Boolean(settings.apiKey && settings.clientKey),
    hasSandboxKeys: Boolean(settings.sandboxApiKey && settings.sandboxClientKey),
  });
}

/** The pickup details Jeebly requires that are still empty (named as in Couriers). */
export function missingPickup(settings: Partial<CourierSettings['jeebly']>): string[] {
  const missing: string[] = [];
  if (!jeeblyMobile(settings.pickupPhone || '')) missing.push('pickup phone');
  if (!settings.pickupUnit?.trim()) missing.push('unit / shop / villa no.');
  if (!settings.pickupBuilding?.trim()) missing.push('building');
  if (!settings.pickupArea?.trim()) missing.push('area');
  if (!settings.pickupLandmark?.trim()) missing.push('landmark');
  if (!jeeblyCity(settings.pickupEmirate || '')) missing.push('emirate');
  return missing;
}

const DUBAI_MS = 4 * 3600_000;
/** The pickup day, Dubai time: the one asked for, not before today, moved off Sunday to Monday. */
export function jeeblyPickupDate(asked: string | undefined, now = Date.now()): string {
  const today = new Date(now + DUBAI_MS).toISOString().slice(0, 10);
  let day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked >= today ? asked : today;
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) day = new Date(Date.parse(`${day}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  return day;
}

const cut = (s: string, max = 120) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

/** The create-shipment request, from the order and the owner's own pickup details: nothing invented. */
export function buildJeeblyPayload(order: Order, settings: CourierSettings['jeebly'], sender: JeeblySender): JeeblyCreateOrderPayload {
  const c = order.customer;
  const cod = order.paymentMethod === 'cod';
  const pieces = order.courier?.pieces || order.items.reduce((sum, item) => sum + item.quantity, 0) || 1;
  return {
    // A same-day order (the customer paid for it) is booked Same day.
    delivery_type: order.deliveryOption === 'same_day' ? 'Same day' : 'Next day',
    load_type: 'Non-document',
    consignment_type: 'Forward',
    description: cut(order.items.map((i) => `${i.quantity}x ${i.title} (${i.profileName})`).join(', '), 250),
    weight: Math.max(1, Math.ceil(Number(order.courier?.weightKg) || 1)),
    payment_type: cod ? 'COD' : 'PREPAID',
    // Dirhams from fils, so 0.1 + 0.2 never becomes 0.30000000000000004.
    ...(cod ? { cod_amount: Math.round(Number(order.total) * 100) / 100 } : {}),
    num_pieces: pieces,
    customer_reference_number: order.id,
    pickup_date: jeeblyPickupDate(order.courier?.pickupDate),
    origin_address_name: cut(settings.pickupLocationName || sender.shopName),
    origin_address_house_no: cut(settings.pickupUnit || ''),
    origin_address_building_name: cut(settings.pickupBuilding || ''),
    origin_address_area: cut(settings.pickupArea || ''),
    origin_address_city: jeeblyCity(settings.pickupEmirate),
    origin_address_type: 'Normal',
    origin_address_mob_no_country_code: '+971',
    origin_address_mobile_number: jeeblyMobile(settings.pickupPhone),
    origin_address_landmark: cut([settings.pickupLandmark, settings.pickupAddress].filter(Boolean).join(', ')),
    destination_address_name: cut(c.fullName),
    destination_address_house_no: cut(c.flatVillaNo || ''),
    destination_address_building_name: cut(c.buildingVilla || ''),
    destination_address_area: cut(c.area || ''),
    destination_address_city: jeeblyCity(c.emirate),
    destination_address_type: 'Normal',
    destination_address_mob_no_country_code: '+971',
    destination_address_mobile_number: jeeblyMobile(c.phone),
    // Jeebly has no street field: the landmark carries the street too.
    destination_address_landmark: cut([c.landmark, c.streetAddress].filter(Boolean).join(', ') || c.area),
  };
}

/**
 * Book with Jeebly. Live: a real shipment with the live keys at the live address. Sandbox (Live
 * off, sandbox keys saved): a test shipment in Jeebly's demo system, with Jeebly's own AWB.
 * Practice (no keys at all): offline, nothing is sent, the AWB says PRACTICE. No AWB is ever made
 * up for a live or sandbox booking: when Jeebly refuses or does not answer, nothing is booked,
 * and Jeebly's own message is shown.
 */
export async function createJeeblyShipment(order: Order, settings: CourierSettings['jeebly'], sender: JeeblySender): Promise<JeeblyApiResponse> {
  const mode = jeeblyModeOf(settings);

  if (mode === 'practice') {
    const awbNumber = `PRACTICE-${crypto.randomInt(100000, 1000000)}`;
    return {
      success: true,
      awbNumber,
      trackingNumber: awbNumber,
      trackingUrl: '',
      message: 'Practice booking: no Jeebly keys are saved, so nothing was sent to Jeebly. This is not a shipment.',
      isSimulated: true,
      testKind: 'practice',
      mode,
    };
  }
  if (mode === 'blocked') return { ...failure(BLOCKED_MESSAGE), mode };

  const live = mode === 'live';
  const keys = live ? { apiKey: settings.apiKey, clientKey: settings.clientKey } : { apiKey: settings.sandboxApiKey, clientKey: settings.sandboxClientKey };
  if (live && (!keys.apiKey || !keys.clientKey)) return { ...failure('Live mode is on but the Jeebly live keys are not saved. Add them in Couriers.'), mode };
  if (live && !settings.liveBaseUrl) return { ...failure("Add Jeebly's live address in Couriers (Jeebly gives it with your production keys)."), mode };
  const missing = missingPickup(settings);
  if (missing.length) return { ...failure(`Add your pickup ${missing.join(', ')} in Couriers before booking: Jeebly needs them to collect the parcel.`), mode };
  const city = jeeblyCity(order.customer.emirate);
  if (!city) return { ...failure(`Jeebly does not deliver to "${order.customer.emirate}".`), mode };

  const where = live ? 'Jeebly' : "Jeebly's sandbox";
  const call = await callJeebly(live ? settings.liveBaseUrl! : JEEBLY_API.sandboxBase, JEEBLY_API.paths.create, keys, buildJeeblyPayload(order, settings, sender));
  const okStatus = call.reached && call.status !== undefined && call.status >= 200 && call.status < 300;
  // Live: no answer, a reply cut off or unreadable after a 2xx, or a server error (5xx) may all
  // follow a shipment Jeebly made, so it is remembered as uncertain. A refused address sent nothing.
  // Sandbox: nothing is recorded.
  const unanswered = !call.reached ? call.error !== 'blocked' : (okStatus && !call.readable) || (call.status ?? 0) >= 500;
  if (live && unanswered) {
    console.warn('Jeebly API create: no clear answer', call.reached ? `HTTP ${call.status}` : call.error);
    const what = call.reached ? `Jeebly's answer could not be read (HTTP ${call.status})` : 'No answer from Jeebly (timeout or network)';
    return { ...failure(`${what}, so the shipment may or may not have been created. Check the Jeebly portal for reference ${order.id} before booking again.`, call.status, true), mode };
  }
  if (!call.reached) {
    console.warn('Jeebly API connection attempt error:', call.error);
    return { ...failure(`Could not reach ${where} (${call.error}). Nothing was booked.`), mode };
  }
  const said = jeeblySaid(call.data, [keys.apiKey, keys.clientKey]);
  if (!okStatus || !jeeblyOk(call.data)) {
    return { ...failure(`${where} did not book it (HTTP ${call.status})${said ? `. Jeebly said: "${said}"` : ''}. Nothing was booked.${jeeblyHint(said)}`, call.status), mode };
  }
  const awb = jeeblyAwb(call.data);
  if (!awb) return { ...failure(`${where} answered success but gave no AWB number${said ? ` ("${said}")` : ''}. Check the Jeebly portal for reference ${order.id}.`, call.status, live), mode };

  return {
    success: true,
    awbNumber: awb,
    trackingNumber: awb,
    trackingUrl: '',
    message: live ? `Booked with Jeebly (AWB ${awb}).` : `Sandbox booking: Jeebly's sandbox gave AWB ${awb}. This is a test, not a real shipment.`,
    isSimulated: !live,
    ...(live ? {} : { testKind: 'sandbox' as const }),
    carrierEnv: live ? 'live' : 'sandbox',
    mode,
    httpStatus: call.status,
    rawResponse: (call.data ?? undefined) as Record<string, unknown> | undefined,
  };
}
