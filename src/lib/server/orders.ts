import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Customer, Emirate, Order, OrderStatus } from '@/types';
import { checkJeeblyServiceability } from '@/lib/jeeblyServiceability';
import { dataDir } from './dataDir';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { parseReceiptDataUrl } from './imageInput';
import { verifyPhoneToken } from './phoneToken';
import { getProduct, invalidateProducts, listProducts } from './products';
import { bankTransferReady, getSettings } from './settings';

/**
 * Orders, stored on the server. Everything that decides what a customer pays
 * is computed here from the catalogue, never taken from the browser:
 *  - prices come from the product and the chosen bed size;
 *  - stock is reserved in the same transaction (no overselling the last set);
 *  - the phone number is the one proven by an SMS code (a signed token);
 *  - one checkout attempt (idempotency key) creates at most one order.
 */

export const DELIVERY_FEE = 0; // free delivery across the UAE
export const COD_FEE = 0;
const MAX_LINES = 20;
const MAX_QTY = 20;
/** Orders still waiting for confirmation, per phone. */
export const MAX_OPEN_PER_PHONE = 3;

const EMIRATES: Emirate[] = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'];
export const ORDER_STATUSES: OrderStatus[] = ['pending_payment', 'pending_confirmation', 'confirmed', 'dispatched', 'out_for_delivery', 'delivered', 'cancelled'];
const PAYMENT_STATUSES: Order['paymentStatus'][] = ['pending', 'receipt_uploaded', 'verified', 'cod_pending', 'paid'];

type Obj = Record<string, unknown>;

function text(v: unknown, field: string, max: number, { required = false } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (required && !s) throw new HttpError(400, `${field} is required.`);
  if (s.length > max) throw new HttpError(400, `${field} is too long.`);
  return s;
}

const fils = (aed: number) => Math.round(aed * 100);
const aed = (f: number) => f / 100;

function newOrderId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join('');
  return `BUH-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${random}`;
}

function receiptsDir(): string {
  const dir = path.join(dataDir(), 'receipts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

interface Row {
  data: string;
}
const parse = (r: Row | undefined): Order | undefined => (r ? (JSON.parse(r.data) as Order) : undefined);

export function getOrder(id: string): Order | undefined {
  return parse(getDb().prepare('SELECT data FROM orders WHERE id = ?').get(id) as Row | undefined);
}

export function listOrders({ limit = 500, status }: { limit?: number; status?: string } = {}): Order[] {
  const n = Math.min(Math.max(1, Math.floor(limit)), 2000);
  const rows = status
    ? (getDb().prepare('SELECT data FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, n) as Row[])
    : (getDb().prepare('SELECT data FROM orders ORDER BY created_at DESC LIMIT ?').all(n) as Row[]);
  return rows.map((r) => JSON.parse(r.data) as Order);
}

/** Every order, newest first, for backups and the customer list (no cap). */
export function allOrders(): Order[] {
  const out: Order[] = [];
  for (const r of getDb().prepare('SELECT data FROM orders ORDER BY created_at DESC').iterate() as IterableIterator<Row>) {
    out.push(JSON.parse(r.data) as Order);
  }
  return out;
}

function writeOrder(order: Order, idempotencyKey?: string) {
  getDb()
    .prepare(
      `INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, idempotency_key, data)
       VALUES (@id, @created, @updated, @phone, @status, @method, @paymentStatus, @total, @key, @data)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status,
         payment_status = excluded.payment_status, data = excluded.data`
    )
    .run({
      id: order.id,
      created: order.createdAt,
      updated: new Date().toISOString(),
      phone: order.customer.phone,
      status: order.status,
      method: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      total: fils(order.total),
      key: idempotencyKey ?? null,
      data: JSON.stringify(order),
    });
}

function logEvent(orderId: string, actor: string, event: string, detail?: unknown) {
  getDb()
    .prepare('INSERT INTO order_events (order_id, at, actor, event, detail) VALUES (?, ?, ?, ?, ?)')
    .run(orderId, new Date().toISOString(), actor, event, detail === undefined ? null : JSON.stringify(detail));
}

export function orderEvents(orderId: string) {
  return (getDb().prepare('SELECT at, actor, event, detail FROM order_events WHERE order_id = ? ORDER BY id').all(orderId) as Array<{
    at: string;
    actor: string;
    event: string;
    detail: string | null;
  }>).map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
}

// ── Placing an order (public) ───────────────────────────────────────────────

export interface PlaceOrderResult {
  order: Order;
  created: boolean;
}

export function placeOrder(input: unknown): PlaceOrderResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Order must be an object.');
  const body = input as Obj;

  const phone = verifyPhoneToken(body.verificationToken);
  if (!phone) throw new HttpError(401, 'Please verify your UAE mobile number again (the code check has expired).');

  const idempotencyKey = text(body.idempotencyKey, 'Checkout reference', 64, { required: true });
  if (!/^[A-Za-z0-9-]{16,64}$/.test(idempotencyKey)) throw new HttpError(400, 'Checkout reference is invalid.');
  const existing = parse(getDb().prepare('SELECT data FROM orders WHERE idempotency_key = ?').get(idempotencyKey) as Row | undefined);
  if (existing) {
    // The same checkout sent twice (double tap, network retry): same order back.
    if (existing.customer.phone !== phone) throw new HttpError(409, 'This checkout reference was already used.');
    return { order: existing, created: false };
  }

  const c = (body.customer && typeof body.customer === 'object' ? body.customer : {}) as Obj;
  const emirate = text(c.emirate, 'Emirate', 40, { required: true });
  if (!EMIRATES.includes(emirate as Emirate)) throw new HttpError(400, 'Please choose one of the seven Emirates.');
  const email = text(c.email, 'Email', 254);
  if (email && !/^(?=[^]{3,254}$)[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw new HttpError(400, 'Please check the email address.');
  const gps = c.gpsCoordinates && typeof c.gpsCoordinates === 'object' ? (c.gpsCoordinates as Obj) : null;
  const lat = gps && typeof gps.lat === 'number' && Number.isFinite(gps.lat) && Math.abs(gps.lat) <= 90 ? gps.lat : undefined;
  const lng = gps && typeof gps.lng === 'number' && Number.isFinite(gps.lng) && Math.abs(gps.lng) <= 180 ? gps.lng : undefined;
  const customer: Order['customer'] = {
    fullName: text(c.fullName, 'Full name', 120, { required: true }),
    phone,
    email: email || undefined,
    emirate: emirate as Emirate,
    area: text(c.area, 'Area', 120, { required: true }),
    streetAddress: text(c.streetAddress, 'Street address', 200, { required: true }),
    buildingVilla: text(c.buildingVilla, 'Building / villa', 120, { required: true }),
    flatVillaNo: text(c.flatVillaNo, 'Flat / villa number', 40, { required: true }),
    landmark: text(c.landmark, 'Landmark', 200) || undefined,
    gpsCoordinates: lat !== undefined && lng !== undefined ? { lat, lng } : undefined,
    phoneVerified: true,
  };

  const serviceability = checkJeeblyServiceability({ emirate, area: customer.area, lat, lng });
  if (!serviceability.serviceable) throw new HttpError(400, serviceability.serviceMessage);

  const paymentMethod = text(body.paymentMethod, 'Payment method', 20, { required: true });
  if (paymentMethod !== 'cod' && paymentMethod !== 'bank_transfer') throw new HttpError(400, 'Choose Cash on Delivery or Bank Transfer.');
  if (paymentMethod === 'bank_transfer' && !bankTransferReady(getSettings('bank'))) {
    throw new HttpError(400, 'Bank transfer is not available right now. Please choose Cash on Delivery.');
  }
  const bankRef = text(body.bankTransferRef, 'Transfer reference', 60);
  const expectedTotalFils =
    body.expectedTotal === undefined ? null : typeof body.expectedTotal === 'number' && Number.isFinite(body.expectedTotal) ? fils(body.expectedTotal) : -1;
  const receipt = body.receipt ? parseReceiptDataUrl(body.receipt) : null;

  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'Your bag is empty.');
  if (body.items.length > MAX_LINES) throw new HttpError(400, `At most ${MAX_LINES} lines per order.`);
  const lines = body.items.map((raw, i) => {
    const it = (raw && typeof raw === 'object' ? raw : {}) as Obj;
    const quantity = it.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      throw new HttpError(400, `Line ${i + 1}: quantity must be 1 to ${MAX_QTY}.`);
    }
    return {
      productId: text(it.productId, `Line ${i + 1} product`, 80, { required: true }),
      profileId: text(it.profileId, `Line ${i + 1} size`, 20, { required: true }),
      color: text(it.color, `Line ${i + 1} colour`, 40),
      quantity,
    };
  });

  // The per-line cap also holds per product, so a bag can't split 100 units over five lines.
  const perProduct = new Map<string, number>();
  for (const l of lines) perProduct.set(l.productId, (perProduct.get(l.productId) ?? 0) + l.quantity);
  if ([...perProduct.values()].some((q) => q > MAX_QTY)) throw new HttpError(400, `At most ${MAX_QTY} of one product per order.`);

  const courierSettings = getSettings('courier');
  listProducts({ includeHidden: true }); // load (and seed) the catalogue before the transaction
  const order = inTransaction(() => {
    // One verified phone can't tie up the stock with a pile of unconfirmed orders.
    const open = (getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND status = 'pending_confirmation'").get(phone) as { n: number }).n;
    if (open >= MAX_OPEN_PER_PHONE) {
      throw new HttpError(429, `You already have ${open} orders waiting for confirmation. We'll call you shortly, or contact us to add to them.`);
    }
    const items: Order['items'] = [];
    for (const line of lines) {
      const product = getProduct(line.productId);
      if (!product || !product.active) throw new HttpError(409, 'An item in your bag is no longer available. Please remove it and try again.');
      const profile = product.profiles.find((p) => p.id === line.profileId);
      if (!profile) throw new HttpError(409, `${product.title}: that bed size is no longer offered.`);
      const color = line.color && product.colors.some((c2) => c2.name === line.color) ? line.color : product.colors[0]?.name;
      if (line.color && color !== line.color) throw new HttpError(409, `${product.title}: that colour is no longer offered.`);
      // Reserve stock atomically: fails if another order took the last ones.
      const reserved = getDb().prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND active = 1 AND stock >= ?').run(line.quantity, product.id, line.quantity);
      if (reserved.changes !== 1) {
        const left = (getDb().prepare('SELECT stock FROM products WHERE id = ?').get(product.id) as { stock: number }).stock;
        throw new HttpError(409, left > 0 ? `${product.title}: only ${left} left.` : `${product.title} is sold out.`);
      }
      const unitFils = fils(product.price) + fils(profile.priceDelta || 0);
      items.push({
        productId: product.id,
        title: product.title,
        image: product.aiTransformedImage || product.featuredImage,
        profileId: profile.id,
        profileName: profile.name,
        mattressSize: profile.mattressSize,
        fittedSheet: profile.fittedSheet,
        flatSheet: profile.flatSheet,
        pillowcases: profile.pillowcases,
        color,
        unitPrice: aed(unitFils),
        quantity: line.quantity,
        totalPrice: aed(unitFils * line.quantity),
      });
    }

    const subtotalFils = items.reduce((s, i) => s + fils(i.totalPrice), 0);
    const codFils = paymentMethod === 'cod' ? fils(COD_FEE) : 0;
    const totalFils = subtotalFils + fils(DELIVERY_FEE) + codFils;
    // Never charge a total the customer was not shown (a price changed while they were at checkout).
    if (expectedTotalFils !== null && expectedTotalFils !== totalFils) {
      throw new HttpError(409, `Prices have changed since you opened checkout: your total is now AED ${aed(totalFils)}. Please check your bag and confirm again.`, {}, { code: 'price_changed', total: aed(totalFils) });
    }
    const provider = paymentMethod === 'cod' ? courierSettings.autoAssignRules.codCourier : courierSettings.autoAssignRules.prepaidCourier;

    let id = newOrderId();
    while (getOrder(id)) id = newOrderId();
    const now = new Date().toISOString();
    const created: Order = {
      id,
      createdAt: now,
      customer,
      items,
      subtotal: aed(subtotalFils),
      deliveryFee: DELIVERY_FEE,
      codFee: aed(codFils),
      discount: 0,
      total: aed(totalFils),
      paymentMethod: paymentMethod as Order['paymentMethod'],
      paymentStatus: paymentMethod === 'cod' ? 'cod_pending' : receipt ? 'receipt_uploaded' : 'pending',
      paymentReceiptUrl: receipt ? `/api/admin/orders/${id}/receipt` : undefined,
      bankTransferRef: bankRef || undefined,
      status: 'pending_confirmation',
      courier: {
        provider: provider === 'manual' ? 'jeebly' : provider,
        serviceType: 'Scheduled',
        awbNumber: '',
        trackingUrl: '',
        status: 'Order placed – awaiting confirmation',
        pickupDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
        weightKg: Math.min(500, 2.5 * items.reduce((s, i) => s + i.quantity, 0)),
        pieces: items.reduce((s, i) => s + i.quantity, 0),
        labelGenerated: false,
        codAmountCollected: paymentMethod === 'cod' ? aed(totalFils) : 0,
        serviceability: {
          verified: serviceability.serviceable,
          hub: serviceability.hub,
          deliverySpeed: serviceability.deliverySpeed,
          zone: serviceability.zone,
          checkedAt: now,
        },
      } as Order['courier'],
      adminNotes: undefined,
    };
    writeOrder(created, idempotencyKey);
    logEvent(id, 'customer', 'created', { total: created.total, paymentMethod });
    if (receipt) {
      // Written inside the transaction: if this fails, the order (and its stock) is rolled back.
      fs.writeFileSync(path.join(receiptsDir(), `${id}.${receipt.ext}`), receipt.bytes, { mode: 0o600 });
    }
    return created;
  });
  invalidateProducts();
  return { order, created: true };
}

// ── Receipts (admin) ────────────────────────────────────────────────────────

export function readReceipt(orderId: string): { bytes: Buffer; mime: string } | null {
  if (!/^BUH-[A-Z0-9-]{4,40}$/.test(orderId)) return null;
  for (const [ext, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'], ['pdf', 'application/pdf']] as const) {
    try {
      return { bytes: fs.readFileSync(path.join(receiptsDir(), `${orderId}.${ext}`)), mime };
    } catch {
      // try the next type
    }
  }
  return null;
}

// ── Admin changes ───────────────────────────────────────────────────────────

/** Allowed status moves. Cancelled and delivered are final. */
const NEXT: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['pending_confirmation', 'confirmed', 'cancelled'],
  pending_confirmation: ['confirmed', 'cancelled'],
  confirmed: ['dispatched', 'cancelled'],
  dispatched: ['out_for_delivery', 'delivered', 'cancelled'],
  out_for_delivery: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export function updateOrderByAdmin(id: string, patch: unknown, actor: string): Order {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'Changes must be an object.');
  const p = patch as Obj;
  const updated = inTransaction(() => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const changes: Obj = {};

    if (p.status !== undefined && p.status !== order.status) {
      const status = p.status as OrderStatus;
      if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Unknown order status.');
      if (!NEXT[order.status].includes(status)) {
        throw new HttpError(409, `An order that is ${order.status.replace(/_/g, ' ')} cannot become ${status.replace(/_/g, ' ')}.`);
      }
      if (status === 'cancelled') {
        // Put the reserved stock back.
        for (const item of order.items) {
          getDb().prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.quantity, item.productId);
        }
      }
      if (status === 'delivered') order.courier.deliveredAt = new Date().toISOString();
      changes.status = { from: order.status, to: status };
      order.status = status;
    }
    if (p.paymentStatus !== undefined && p.paymentStatus !== order.paymentStatus) {
      if (!PAYMENT_STATUSES.includes(p.paymentStatus as Order['paymentStatus'])) throw new HttpError(400, 'Unknown payment status.');
      changes.paymentStatus = { from: order.paymentStatus, to: p.paymentStatus };
      order.paymentStatus = p.paymentStatus as Order['paymentStatus'];
    }
    if (p.adminNotes !== undefined) {
      order.adminNotes = text(p.adminNotes, 'Notes', 1000) || undefined;
      changes.adminNotes = true;
    }
    if (Object.keys(changes).length) {
      writeOrder(order);
      logEvent(id, actor, 'updated', changes);
    }
    return order;
  });
  invalidateProducts();
  return updated;
}

/** Record a courier booking result on the order (used by dispatch). */
export function recordBooking(id: string, actor: string, booking: Partial<Order['courier']> & { notes?: string }): Order {
  return inTransaction(() => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const { notes, ...courier } = booking;
    order.courier = { ...order.courier, ...courier };
    if (notes !== undefined) order.adminNotes = notes || undefined;
    if (courier.bookingState === 'booked' || courier.simulated) {
      if (order.status === 'pending_confirmation' || order.status === 'pending_payment') order.status = 'confirmed';
    }
    writeOrder(order);
    logEvent(id, actor, 'courier', { provider: order.courier.provider, awb: order.courier.awbNumber, state: courier.bookingState, simulated: courier.simulated });
    return order;
  });
}

// ── What customers may see ──────────────────────────────────────────────────

/** A placed order as shown to the customer who placed it (no internal notes). */
export function customerView(order: Order) {
  const { adminNotes: _notes, paymentReceiptUrl: _receipt, ...rest } = order;
  void _notes;
  void _receipt;
  return { ...rest, courier: trackingView(order) };
}

function trackingView(order: Order) {
  return {
    provider: order.courier.provider,
    awbNumber: order.courier.simulated ? '' : order.courier.awbNumber,
    trackingUrl: order.courier.simulated ? '' : order.courier.trackingUrl,
    status: order.courier.status,
    dispatchedAt: order.courier.dispatchedAt,
    deliveredAt: order.courier.deliveredAt,
  };
}

/**
 * Track Order: needs both the order number and the phone number on it. Shows
 * status and delivery only: no address, email or full name.
 */
export function lookupOrder(id: string, phone: string) {
  const order = getOrder(id.trim().toUpperCase());
  if (!order || order.customer.phone !== phone) return null;
  return {
    id: order.id,
    createdAt: order.createdAt,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    total: order.total,
    firstName: order.customer.fullName.split(/\s+/)[0],
    emirate: order.customer.emirate,
    area: order.customer.area,
    items: order.items.map((i) => ({ title: i.title, image: i.image, profileName: i.profileName, color: i.color, quantity: i.quantity, totalPrice: i.totalPrice })),
    courier: trackingView(order),
  };
}

// ── Customers (admin CRM), built from orders ────────────────────────────────

export function listCustomers(): Customer[] {
  const byPhone = new Map<string, Customer>();
  // Oldest first, so the latest order's name and address win.
  for (const o of allOrders().reverse()) {
    const c = byPhone.get(o.customer.phone) ?? {
      id: `cust-${o.customer.phone.replace(/\D/g, '')}`,
      fullName: o.customer.fullName,
      phone: o.customer.phone,
      email: o.customer.email,
      emirate: o.customer.emirate,
      area: o.customer.area,
      totalOrders: 0,
      totalSpent: 0,
      lastOrderDate: o.createdAt,
      defaultAddress: { buildingVilla: '', flatVillaNo: '', streetAddress: '' },
    };
    c.fullName = o.customer.fullName;
    c.email = o.customer.email || c.email;
    c.emirate = o.customer.emirate;
    c.area = o.customer.area;
    c.lastOrderDate = o.createdAt;
    c.defaultAddress = {
      buildingVilla: o.customer.buildingVilla,
      flatVillaNo: o.customer.flatVillaNo,
      streetAddress: o.customer.streetAddress,
      landmark: o.customer.landmark,
    };
    if (o.status !== 'cancelled') {
      c.totalOrders += 1;
      c.totalSpent = aed(fils(c.totalSpent) + fils(o.total));
    }
    byPhone.set(o.customer.phone, c);
  }
  return [...byPhone.values()].sort((a, b) => b.lastOrderDate.localeCompare(a.lastOrderDate));
}
