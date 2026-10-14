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

export function parseCourierProvider(value: unknown): 'jeebly' | 'echo' {
  if (value === 'jeebly' || value === 'echo') return value;
  throw new HttpError(400, 'Unknown courier provider.');
}

export function parseOrderForDispatch(value: unknown): Order {
  const o = obj(value, 'Order');
  const c = obj(o.customer, 'Customer');
  const courier = o.courier ? obj(o.courier, 'Courier details') : {};
  const rawItems = o.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
    throw new HttpError(400, 'Order items are missing.');
  }
  const paymentMethod = text(o.paymentMethod, 'Payment method', 20);
  if (!PAYMENT.has(paymentMethod)) throw new HttpError(400, 'Unknown payment method.');

  const pickupDate = text(courier.pickupDate, 'Pickup date', 10, false);
  if (pickupDate && !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) throw new HttpError(400, 'Pickup date must be YYYY-MM-DD.');

  return {
    id: text(o.id, 'Order id', 40),
    createdAt: text(o.createdAt, 'Created at', 40, false),
    customer: {
      fullName: text(c.fullName, 'Customer name', 120),
      phone: text(c.phone, 'Customer phone', 32),
      email: text(c.email, 'Customer email', 254, false) || undefined,
      emirate: text(c.emirate, 'Emirate', 40) as Order['customer']['emirate'],
      area: text(c.area, 'Area', 120),
      streetAddress: text(c.streetAddress, 'Street address', 200, false),
      buildingVilla: text(c.buildingVilla, 'Building / villa', 120, false),
      flatVillaNo: text(c.flatVillaNo, 'Flat / villa number', 40, false),
      landmark: text(c.landmark, 'Landmark', 200, false) || undefined,
    },
    items: rawItems.map((raw, i) => {
      const item = obj(raw, `Item ${i + 1}`);
      return {
        productId: text(item.productId, 'Product id', 80, false),
        title: text(item.title, 'Item title', 200),
        image: '',
        profileId: text(item.profileId, 'Bed profile', 60, false) as Order['items'][number]['profileId'],
        profileName: text(item.profileName, 'Bed profile name', 120, false),
        mattressSize: text(item.mattressSize, 'Mattress size', 80, false),
        fittedSheet: text(item.fittedSheet, 'Fitted sheet', 80, false),
        flatSheet: text(item.flatSheet, 'Flat sheet', 80, false),
        pillowcases: text(item.pillowcases, 'Pillowcases', 80, false),
        unitPrice: num(item.unitPrice, 'Unit price', 0, 1_000_000),
        quantity: Math.round(num(item.quantity, 'Quantity', 1, 1000)),
        totalPrice: num(item.totalPrice ?? 0, 'Item total', 0, 100_000_000),
      };
    }),
    subtotal: num(o.subtotal ?? 0, 'Subtotal', 0, 100_000_000),
    deliveryFee: num(o.deliveryFee ?? 0, 'Delivery fee', 0, 100_000),
    codFee: num(o.codFee ?? 0, 'COD fee', 0, 100_000),
    discount: num(o.discount ?? 0, 'Discount', 0, 100_000_000),
    total: num(o.total, 'Order total', 0, 100_000_000),
    paymentMethod: paymentMethod as Order['paymentMethod'],
    paymentStatus: 'pending',
    status: 'pending_confirmation' as Order['status'],
    adminNotes: text(o.adminNotes, 'Admin notes', 500, false) || undefined,
    courier: {
      pickupDate: pickupDate || undefined,
      weightKg: courier.weightKg === undefined ? undefined : num(courier.weightKg, 'Weight', 0.1, 500),
      pieces: courier.pieces === undefined ? undefined : Math.round(num(courier.pieces, 'Pieces', 1, 500)),
    },
  } as Order;
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
      serviceType: j.serviceType === 'Express' ? 'Express' : 'Scheduled',
      isLive: j.isLive === true,
      pickupLocationName: text(j.pickupLocationName, 'Pickup location', 120, false),
      pickupPhone: text(j.pickupPhone, 'Pickup phone', 32, false),
      pickupAddress: text(j.pickupAddress, 'Pickup address', 200, false),
      pickupEmirate: (text(j.pickupEmirate, 'Pickup emirate', 40, false) || 'Dubai') as CourierSettings['jeebly']['pickupEmirate'],
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
