import { CourierSettings, Order } from '@/types';
import { HttpError } from './http';

/**
 * Allow-list validation for what the admin hub sends to the courier routes.
 * Only the fields the courier payloads use are kept; strings are length-capped
 * and numbers must be finite and in range, so a malformed or hostile body is
 * refused with a 400 instead of failing deep inside a carrier call.
 */

type Obj = Record<string, unknown>;

function obj(value: unknown, field: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${field} is missing.`);
  return value as Obj;
}

function text(value: unknown, field: string, max: number, required = true): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `${field} must be text.`);
  // Control characters have no place in a shipping label.
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function num(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a number between ${min} and ${max}.`);
  }
  return n;
}

const PAYMENT = new Set(['cod', 'bank_transfer', 'online_card']);
const EMIRATES = new Set(['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain']);

function emirate(value: unknown, field: string, fallback?: string): string {
  const v = text(value, field, 40, fallback === undefined) || fallback!;
  if (!EMIRATES.has(v)) throw new HttpError(400, `${field} must be one of the seven Emirates.`);
  return v;
}

export function parseCourierProvider(value: unknown): 'jeebly' | 'echo' {
  if (value === 'jeebly' || value === 'echo') return value;
  throw new HttpError(400, 'Unknown courier provider.');
}

export function parseCourierSettings(value: unknown): CourierSettings {
  const s = obj(value, 'Courier settings');
  const j = obj(s.jeebly ?? {}, 'Jeebly settings');
  const e = obj(s.echo ?? {}, 'Eco Express settings');
  return {
    autoAssignRules: { codCourier: 'jeebly', prepaidCourier: 'echo' },
    jeebly: {
      apiKey: text(j.apiKey, 'Jeebly API key', 200, false),
      clientKey: text(j.clientKey, 'Jeebly client key', 200, false),
      sandboxApiKey: text(j.sandboxApiKey, 'Jeebly sandbox API key', 200, false),
      sandboxClientKey: text(j.sandboxClientKey, 'Jeebly sandbox client key', 200, false),
      serviceType: j.serviceType === 'Express' ? 'Express' : 'Scheduled',
      isLive: j.isLive === true,
      pickupLocationName: text(j.pickupLocationName, 'Pickup location', 120, false),
      pickupPhone: text(j.pickupPhone, 'Pickup phone', 32, false),
      pickupAddress: text(j.pickupAddress, 'Pickup address', 200, false),
      liveBaseUrl: text(j.liveBaseUrl, 'Jeebly live address', 200, false),
      pickupBuilding: text(j.pickupBuilding, 'Pickup building', 120, false),
      pickupArea: text(j.pickupArea, 'Pickup area', 120, false),
      pickupUnit: text(j.pickupUnit, 'Pickup unit', 40, false),
      pickupLandmark: text(j.pickupLandmark, 'Pickup landmark', 120, false),
      pickupEmirate: emirate(j.pickupEmirate, 'Pickup emirate', 'Dubai') as CourierSettings['jeebly']['pickupEmirate'],
    },
    echo: {
      apiKey: text(e.apiKey, 'Eco Express API key', 200, false),
      accountId: text(e.accountId, 'Eco Express account', 80, false),
      isLive: e.isLive === true,
      hubCode: text(e.hubCode, 'Hub code', 40, false),
      serviceTier: text(e.serviceTier, 'Service tier', 40, false),
    },
  };
}
