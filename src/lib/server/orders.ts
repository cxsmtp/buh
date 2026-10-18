import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BankState, CardPayment, CardState, Customer, Emirate, Order, OrderAttention, OrderStatus } from '@/types';
import { deliveryCheck, uaeDate } from '@/lib/delivery';
import { dataDir } from './dataDir';
import { customerLink } from './runtimeConfig';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { parseReceiptDataUrl } from './imageInput';
import { verifyPhoneToken } from './phoneToken';
import { getProduct, invalidateProducts, listProducts } from './products';
import { bump } from './live';
import { bankTransferReady, cardPaymentsReady, getSettings, phoneCodesOn } from './settings';
import { audit } from './audit';
import { kvGet, kvSet } from './kv';
import { logEvent as logEvent_ } from './log';
import { issuePayLink, payPathOf } from './bankPay';
import { waMeLink } from '@/lib/whatsappConfirm';
import { validatePhone } from '@/lib/otpService';

/**
 * Orders, stored on the server. Everything that decides what a customer pays
 * is computed here from the catalogue, never taken from the browser:
 *  - prices come from the product and the chosen bed size;
 *  - stock is reserved in the same transaction (no overselling the last set);
 *  - the phone number is the one proven by an SMS code (a signed token), or, for a
 *    card order, the one the card holder gave (paying is the proof; the order waits
 *    for Stripe's word before it counts, and "Confirm on WhatsApp" still applies);
 *  - one checkout attempt (idempotency key) creates at most one order.
 * A bank-transfer order gets a private page (src/lib/server/bankPay.ts) where the customer sees
 * the bank details and uploads the transfer screenshot; the account is never on the website.
 */

export const DELIVERY_FEE = 0; // free delivery across the UAE
export const COD_FEE = 0;
const MAX_LINES = 20;
const MAX_QTY = 20;
/** Orders still waiting for confirmation, per phone. */
export const MAX_OPEN_PER_PHONE = 3;
/** Unpaid card orders hold their pieces until paid or timed out: a few per phone and per connection, a cap overall. */
export const MAX_UNPAID_CARD_PER_PHONE = 2;
export const MAX_UNPAID_CARD_PER_IP = 3;
export const MAX_UNPAID_CARD_TOTAL = 30;
/** A card order whose phone no code proved: a small bag only (it holds pieces before anyone has paid). */
export const MAX_UNVERIFIED_CARD_QTY = 2;
export const MAX_UNVERIFIED_CARD_LINES = 5;
/** An unpaid card order is cancelled (its pieces back on sale) after this long. */
export const CARD_PAYMENT_TTL_MS = 10 * 60 * 1000;
export const CARD_PAYMENT_TTL_MINUTES = CARD_PAYMENT_TTL_MS / 60_000;

const ORDER_SOURCES = ['instagram', 'whatsapp', 'facebook', 'tiktok', 'google', 'email', 'direct', 'other'];
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

/**
 * One plain address (name@domain.tld): no spaces or control characters, and no ',' or ';' (which a
 * mail server would read as a second recipient), quotes, brackets or backslashes.
 */
export function isCustomerEmail(email: string): boolean {
  return /^(?=[^]{3,254}$)[^\s\p{C}@<>",;()[\]\\]+@[^\s\p{C}@<>",;()[\]\\]+\.[^\s\p{C}@<>",;()[\]\\]+$/u.test(email);
}

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
  wa_code: string | null;
  phone_check: string;
  wa_hold: number;
  wa_opened_at: string | null;
  phone_checked_at: string | null;
  phone_checked_by: string | null;
  card_state: string;
  payment_ref: string | null;
  paid_fils: number | null;
  paid_at: string | null;
  card_label: string | null;
  refund_ref: string | null;
  refunded_at: string | null;
  card_livemode: number | null;
  refunded_fils: number | null;
  refund_outside_at: string | null;
  needs_attention: string | null;
  id: string;
  status: string;
  payment_status: string;
  pay_nonce: string | null;
  pay_expires_at: string | null;
  bank_state: string;
  transfer_uploads: number;
  transfer_uploaded_at: string | null;
  bank_emailed_at: string | null;
  bank_checked_at: string | null;
  bank_checked_by: string | null;
}
/**
 * The order's JSON, the WhatsApp confirmation (migration 8), the card payment (migration 9) and the
 * bank transfer (migration 10), in their own columns.
 */
const COLUMNS =
  'data, wa_code, phone_check, wa_hold, wa_opened_at, phone_checked_at, phone_checked_by, card_state, payment_ref, paid_fils, paid_at, card_label, refund_ref, refunded_at, card_livemode, refunded_fils, refund_outside_at, needs_attention, ' +
  'id, status, payment_status, pay_nonce, pay_expires_at, bank_state, transfer_uploads, transfer_uploaded_at, bank_emailed_at, bank_checked_at, bank_checked_by';
const ATTENTION_KINDS: OrderAttention['kind'][] = ['refund_failed', 'booked_after_cancel', 'refund_outside_stripe', 'card_unreachable'];
const CARD_STATES: CardState[] = ['pending', 'failed', 'paid', 'refund_pending', 'refunded', 'canceled'];
const BANK_STATES: BankState[] = ['awaiting', 'uploaded', 'not_received', 'paid'];

/** Migration 10's rule for a bank-transfer order from before it: paid, a screenshot to check, or waiting. */
function legacyBankState(paymentStatus: string): BankState {
  return paymentStatus === 'verified' || paymentStatus === 'paid' ? 'paid' : paymentStatus === 'receipt_uploaded' ? 'uploaded' : 'awaiting';
}

/**
 * Bank-transfer orders an older version wrote after migration 10 ran (during an update's overlap,
 * or after a rollback) still say bank_state 'none': give them their state, as migration 10 did.
 * Data only and idempotent (it only touches rows still at 'none'); run at start-up and every minute.
 */
export function normalizeBankStates(): number {
  return getDb()
    .prepare(
      `UPDATE orders SET bank_state = CASE
          WHEN payment_status IN ('verified', 'paid') THEN 'paid'
          WHEN payment_status = 'receipt_uploaded' THEN 'uploaded'
          ELSE 'awaiting' END,
        transfer_uploads = CASE WHEN json_extract(data, '$.paymentReceiptUrl') IS NOT NULL THEN 1 ELSE 0 END
        WHERE payment_method = 'bank_transfer' AND bank_state = 'none'`
    )
    .run().changes;
}

function fromRow(r: Row): Order {
  const order = JSON.parse(r.data) as Order;
  delete order.whatsappCheck;
  delete order.card;
  delete order.bankTransfer;
  delete order.attention;
  // Written by an older version (during an update, or after a rollback) after migration 10 ran:
  // bank_state is still 'none', so it is worked out like migration 10 did (normalizeBankStates()
  // then saves it).
  const legacy = order.paymentMethod === 'bank_transfer' && r.bank_state === 'none';
  const bankState = legacy ? legacyBankState(r.payment_status) : r.bank_state;
  if (order.paymentMethod === 'bank_transfer' && BANK_STATES.includes(bankState as BankState)) {
    const paid = bankState === 'paid' || r.payment_status === 'verified' || r.payment_status === 'paid';
    const payPath = payPathOf(r);
    const payUrl = payPath ? customerLink(payPath) : undefined;
    order.bankTransfer = {
      state: paid ? 'paid' : (bankState as BankState),
      uploads: legacy ? (order.paymentReceiptUrl ? 1 : 0) : r.transfer_uploads,
      ...(r.transfer_uploaded_at ? { uploadedAt: r.transfer_uploaded_at } : {}),
      ...(r.bank_emailed_at ? { emailedAt: r.bank_emailed_at } : {}),
      ...(r.bank_checked_at ? { checkedAt: r.bank_checked_at } : {}),
      ...(r.bank_checked_by ? { checkedBy: r.bank_checked_by } : {}),
      ...(payPath ? { payPath } : {}),
      ...(payUrl ? { payUrl } : {}),
    };
  }
  if (CARD_STATES.includes(r.card_state as CardState)) {
    order.card = {
      state: r.card_state as CardState,
      ...(r.payment_ref ? { ref: r.payment_ref } : {}),
      ...(r.card_label ? { label: r.card_label } : {}),
      ...(r.paid_at ? { paidAt: r.paid_at } : {}),
      ...(r.paid_fils !== null ? { paidAmount: aed(r.paid_fils) } : {}),
      ...(r.refund_ref ? { refundRef: r.refund_ref } : {}),
      ...(r.refunded_at ? { refundedAt: r.refunded_at } : {}),
      ...(r.refunded_fils ? { refundedAmount: aed(r.refunded_fils) } : {}),
      ...(r.card_livemode !== null ? { mode: r.card_livemode === 1 ? ('live' as const) : ('test' as const) } : {}),
      ...(r.refund_outside_at ? { refundOutsideAt: r.refund_outside_at } : {}),
    };
  }
  if (r.needs_attention) {
    try {
      const a = JSON.parse(r.needs_attention) as OrderAttention;
      if (ATTENTION_KINDS.includes(a.kind) && typeof a.text === 'string') order.attention = { kind: a.kind, text: a.text, at: String(a.at) };
    } catch {
      // unreadable: ignored
    }
  }
  if (r.wa_code && (r.phone_check === 'awaiting' || r.phone_check === 'confirmed' || r.phone_check === 'mismatch')) {
    order.whatsappCheck = {
      status: r.phone_check,
      code: r.wa_code,
      hold: r.wa_hold === 1,
      ...(r.wa_opened_at ? { openedAt: r.wa_opened_at } : {}),
      ...(r.phone_checked_at ? { checkedAt: r.phone_checked_at } : {}),
      ...(r.phone_checked_by ? { checkedBy: r.phone_checked_by } : {}),
    };
  }
  return order;
}
const parse = (r: Row | undefined): Order | undefined => (r ? fromRow(r) : undefined);

export function getOrder(id: string): Order | undefined {
  return parse(getDb().prepare(`SELECT ${COLUMNS} FROM orders WHERE id = ?`).get(id) as Row | undefined);
}

export function listOrders({ limit = 500, status }: { limit?: number; status?: string } = {}): Order[] {
  const n = Math.min(Math.max(1, Math.floor(limit)), 2000);
  const rows = status
    ? (getDb().prepare(`SELECT ${COLUMNS} FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, n) as Row[])
    : (getDb().prepare(`SELECT ${COLUMNS} FROM orders ORDER BY created_at DESC LIMIT ?`).all(n) as Row[]);
  return rows.map(fromRow);
}

/** Every order, newest first, for backups and the customer list (no cap). */
export function allOrders(): Order[] {
  const out: Order[] = [];
  for (const r of getDb().prepare(`SELECT ${COLUMNS} FROM orders ORDER BY created_at DESC`).iterate() as IterableIterator<Row>) {
    out.push(fromRow(r));
  }
  return out;
}

function writeOrder(order: Order, idempotencyKey?: string) {
  // The WhatsApp confirmation, the card payment, the bank transfer and the owner's notes live in their own columns, never in the JSON.
  const { whatsappCheck: _check, card: _card, bankTransfer: _bank, attention: _attention, ...stored } = order;
  void _check;
  void _card;
  void _bank;
  void _attention;
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
      data: JSON.stringify(stored),
    });
  bump('orders'); // the admin hub shows it straight away
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

/** Where the order came from: the connection's address, when the server can know it (TRUST_PROXY). */
export interface PlaceOrderContext {
  ip?: string | null;
}

export function placeOrder(input: unknown, context: PlaceOrderContext = {}): PlaceOrderResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Order must be an object.');
  const body = input as Obj;

  const paymentMethod = text(body.paymentMethod, 'Payment method', 20, { required: true });
  const card = paymentMethod === 'online_card';
  if (card && !cardPaymentsReady()) throw new HttpError(400, 'Card payment is not available right now. Please choose Cash on Delivery.', {}, { code: 'card_unavailable' });
  // With an SMS gateway switched on, a card order proves its phone like any order. Without one, a
  // card order needs no code: the card holder pays before it counts (a code, if given, still wins).
  const provenPhone = verifyPhoneToken(body.verificationToken);
  const phone = provenPhone ?? (card && !phoneCodesOn() && body.verificationToken === undefined ? validatePhone((body.customer as Obj | undefined)?.phone) : null);
  if (!phone) throw new HttpError(401, 'Please verify your UAE mobile number again (the code check has expired).');

  const idempotencyKey = text(body.idempotencyKey, 'Checkout reference', 64, { required: true });
  if (!/^[A-Za-z0-9-]{16,64}$/.test(idempotencyKey)) throw new HttpError(400, 'Checkout reference is invalid.');
  const existing = parse(getDb().prepare(`SELECT ${COLUMNS} FROM orders WHERE idempotency_key = ?`).get(idempotencyKey) as Row | undefined);
  if (existing) {
    // The same checkout sent twice (double tap, network retry): same order back.
    if (existing.customer.phone !== phone) throw new HttpError(409, 'This checkout reference was already used.');
    return { order: existing, created: false };
  }

  const c = (body.customer && typeof body.customer === 'object' ? body.customer : {}) as Obj;
  const emirate = text(c.emirate, 'Emirate', 40, { required: true });
  if (!EMIRATES.includes(emirate as Emirate)) throw new HttpError(400, 'Please choose one of the seven Emirates.');
  const email = text(c.email, 'Email', 254);
  if (email && !isCustomerEmail(email)) throw new HttpError(400, 'Please check the email address.');
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
    // Proven by an SMS code; a card order without one is proven by its payment instead.
    phoneVerified: Boolean(provenPhone),
  };

  // Where we deliver comes from the address, never the GPS reading (often a network location far away).
  const delivery = deliveryCheck({ emirate, area: customer.area }, getSettings('delivery'));
  if (!delivery.serviceable) throw new HttpError(400, delivery.message);
  const deliveryOption = body.deliveryOption === 'same_day' ? 'same_day' : 'standard';
  if (deliveryOption === 'same_day' && !delivery.sameDay.available) {
    throw new HttpError(409, delivery.sameDay.reason || 'Same-day delivery is not available for this order. Choose standard delivery.', {}, { code: 'same_day_unavailable' });
  }
  const deliveryFils = deliveryOption === 'same_day' ? fils(delivery.sameDay.fee) : fils(DELIVERY_FEE);

  if (paymentMethod !== 'cod' && paymentMethod !== 'bank_transfer' && !card) throw new HttpError(400, 'Choose Cash on Delivery, Bank Transfer or Card.');
  if (paymentMethod === 'bank_transfer' && !bankTransferReady(getSettings('bank'))) {
    throw new HttpError(400, 'Bank transfer is not available right now. Please choose Cash on Delivery.');
  }
  const bankRef = text(body.bankTransferRef, 'Transfer reference', 60);
  // Where the customer came from: an allow-listed label only (for the owner's records).
  const src = body.source && typeof body.source === 'object' ? (body.source as Obj) : null;
  const source =
    src && typeof src.source === 'string' && ORDER_SOURCES.includes(src.source)
      ? { source: src.source, ...(typeof src.campaign === 'string' && src.campaign ? { campaign: src.campaign.replace(/[^\w -]/g, '').slice(0, 60) } : {}) }
      : undefined;
  const expectedTotalFils =
    body.expectedTotal === undefined ? null : typeof body.expectedTotal === 'number' && Number.isFinite(body.expectedTotal) ? fils(body.expectedTotal) : -1;
  let receipt = body.receipt && paymentMethod === 'bank_transfer' ? parseReceiptDataUrl(body.receipt) : null;
  if (receipt) {
    // No room for it: the order still goes through, and the customer uploads (or sends) it later.
    const room = receiptRoomProblem(receipt.bytes.length);
    if (room) {
      noteNoRoom('(checkout)', room);
      receipt = null;
    }
  }

  if (!Array.isArray(body.items) || body.items.length === 0) throw new HttpError(400, 'Your bag is empty.');
  if (body.items.length > MAX_LINES) throw new HttpError(400, `At most ${MAX_LINES} lines per order.`);
  // No code proved this phone: a card order holds pieces before anyone has paid, so a small bag only.
  const unverifiedCard = card && !provenPhone;
  if (unverifiedCard && body.items.length > MAX_UNVERIFIED_CARD_LINES) {
    throw new HttpError(400, `Paying by card, at most ${MAX_UNVERIFIED_CARD_LINES} different items per order. For more, place a second order, or choose Cash on Delivery.`, {}, { code: 'card_bag_limit' });
  }
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
  if (unverifiedCard) {
    const perItem = new Map<string, number>();
    for (const l of lines) perItem.set(`${l.productId}|${l.profileId}`, (perItem.get(`${l.productId}|${l.profileId}`) ?? 0) + l.quantity);
    if ([...perItem.values()].some((q) => q > MAX_UNVERIFIED_CARD_QTY)) {
      throw new HttpError(400, `Paying by card, at most ${MAX_UNVERIFIED_CARD_QTY} of each item per order. For more, choose Cash on Delivery, or contact us.`, {}, { code: 'card_bag_limit' });
    }
  }
  // The connection's address is kept only as a hash (enough to count, not to know it).
  const ipHash = card && context.ip ? sha256(`card-ip:${context.ip}`) : null;

  const courierSettings = getSettings('courier');
  const store = getSettings('store');
  // "Confirm on WhatsApp" (Settings → Store & contact): only with the shop's number set.
  const askWhatsApp = Boolean(store.confirmOrdersOnWhatsApp && waMeLink(store.whatsappNumber, ''));
  listProducts({ includeHidden: true }); // load (and seed) the catalogue before the transaction
  // A screenshot sent with the order (a checkout page from before this version) is the first upload:
  // written beside its place first (if that fails, no order), moved there once the order is saved.
  const freshReceipt = path.join(receiptsDir(), `checkout-${process.pid}-${crypto.randomBytes(6).toString('hex')}.upload.tmp`);
  if (receipt) fs.writeFileSync(freshReceipt, receipt.bytes, { mode: 0o600 });
  let order: Order;
  try {
    order = placeInTransaction();
  } catch (err) {
    if (receipt) fs.rmSync(freshReceipt, { force: true });
    throw err;
  }
  function placeInTransaction(): Order {
    return inTransaction(() => {
      // One verified phone can't tie up the stock with a pile of unconfirmed orders.
      const open = (getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND status = 'pending_confirmation'").get(phone) as { n: number }).n;
      if (open >= MAX_OPEN_PER_PHONE) {
        throw new HttpError(429, `You already have ${open} orders waiting for confirmation. We'll call you shortly, or contact us to add to them.`);
      }
      if (card) {
        // Unpaid card orders hold pieces, so they can't pile up: per phone, per connection, and overall.
        const count = (where: string, ...args: unknown[]) => getDb().prepare(`SELECT COUNT(*) AS n FROM orders WHERE card_state IN ('pending', 'failed')${where}`).pluck().get(...args) as number;
        if (count(' AND phone = ?', phone) >= MAX_UNPAID_CARD_PER_PHONE || (ipHash && count(' AND card_ip = ?', ipHash) >= MAX_UNPAID_CARD_PER_IP)) {
          throw new HttpError(429, 'Too many card payments are waiting to be finished. Please finish or close the other checkout, or choose Cash on Delivery.', {}, { code: 'card_unpaid_limit' });
        }
        if (count('') >= MAX_UNPAID_CARD_TOTAL) {
          throw new HttpError(429, 'Card checkout is very busy right now, sorry. Please try again in a few minutes, or choose Cash on Delivery.', {}, { code: 'card_busy' });
        }
      }
      const items: Order['items'] = [];
      for (const line of lines) {
        const product = getProduct(line.productId);
        if (!product || !product.active) throw new HttpError(409, 'An item in your bag is no longer available. Please remove it and try again.');
        const profile = product.profiles.find((p) => p.id === line.profileId);
        if (!profile) throw new HttpError(409, `${product.title}: that bed size is no longer offered.`);
        const color = line.color && product.colors.some((c2) => c2.name === line.color) ? line.color : product.colors[0]?.name;
        if (line.color && color !== line.color) throw new HttpError(409, `${product.title}: that colour is no longer offered.`);
        // Reserve this size's pieces atomically: fails if another order took the last one.
        const reserved = getDb()
          .prepare('UPDATE product_stock SET qty = qty - ? WHERE product_id = ? AND size_id = ? AND qty >= ? AND EXISTS (SELECT 1 FROM products WHERE id = ? AND active = 1 AND archived = 0)')
          .run(line.quantity, product.id, profile.id, line.quantity, product.id);
        if (reserved.changes !== 1) {
          const left = (getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').get(product.id, profile.id) as { qty: number } | undefined)?.qty ?? 0;
          throw new HttpError(409, left > 0 ? `${product.title} (${profile.name}): only ${left} left.` : `${product.title} (${profile.name}) has just sold out.`);
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
      const totalFils = subtotalFils + deliveryFils + codFils;
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
        deliveryFee: aed(deliveryFils),
        deliveryOption,
        codFee: aed(codFils),
        discount: 0,
        total: aed(totalFils),
        paymentMethod: paymentMethod as Order['paymentMethod'],
        paymentStatus: paymentMethod === 'cod' ? 'cod_pending' : receipt ? 'receipt_uploaded' : 'pending',
        paymentReceiptUrl: receipt ? `/api/admin/orders/${id}/receipt` : undefined,
        bankTransferRef: bankRef || undefined,
        // A card order counts once Stripe says it is paid (status values every version knows).
        status: card ? 'pending_payment' : 'pending_confirmation',
        courier: {
          provider: provider === 'manual' ? 'jeebly' : provider,
          serviceType: deliveryOption === 'same_day' ? 'Express' : 'Scheduled',
          awbNumber: '',
          trackingUrl: '',
          status: 'Order placed – awaiting confirmation',
          // Same day: collected today (UAE date); otherwise tomorrow.
          pickupDate: uaeDate(Date.now(), deliveryOption === 'same_day' ? 0 : 1),
          weightKg: Math.min(500, 2.5 * items.reduce((s, i) => s + i.quantity, 0)),
          pieces: items.reduce((s, i) => s + i.quantity, 0),
          labelGenerated: false,
          codAmountCollected: paymentMethod === 'cod' ? aed(totalFils) : 0,
          serviceability: {
            verified: delivery.serviceable,
            hub: '',
            deliverySpeed: deliveryOption === 'same_day' ? 'Same day' : delivery.days,
            zone: emirate,
            checkedAt: now,
          },
        } as Order['courier'],
        adminNotes: undefined,
        ...(source ? { source } : {}),
      };
      writeOrder(created, idempotencyKey);
      logEvent(id, 'customer', 'created', { total: created.total, paymentMethod });
      if (card) {
        getDb().prepare("UPDATE orders SET card_state = 'pending', card_ip = ? WHERE id = ?").run(ipHash, id);
        created.card = { state: 'pending' };
      }
      if (askWhatsApp) {
        // 4 random digits, made here (never by the browser); not a secret from the customer.
        const code = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
        const hold = store.holdUntilWhatsAppConfirmed;
        getDb().prepare("UPDATE orders SET wa_code = ?, phone_check = 'awaiting', wa_hold = ? WHERE id = ?").run(code, hold ? 1 : 0, id);
        created.whatsappCheck = { status: 'awaiting', code, hold };
        logEvent(id, 'shop', 'whatsapp_asked', { hold });
      }
      if (paymentMethod === 'bank_transfer') {
        // The private page with the bank details and the screenshot upload (the account is never on the website).
        issuePayLink(id, now);
        getDb()
          .prepare('UPDATE orders SET bank_state = ?, transfer_uploads = ?, transfer_uploaded_at = ? WHERE id = ?')
          .run(receipt ? 'uploaded' : 'awaiting', receipt ? 1 : 0, receipt ? now : null, id);
        logEvent(id, 'shop', 'bank_link_made');
      }
      return getOrder(id)!;
    });
  }
  if (receipt) {
    try {
      fs.renameSync(freshReceipt, path.join(receiptsDir(), `${order.id}.${receipt.ext}`));
    } catch (err) {
      logEvent_('error', 'receipt_write_failed', { orderId: order.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  invalidateProducts();
  return { order, created: true };
}

// ── Receipts (admin) ────────────────────────────────────────────────────────

const RECEIPT_TYPES = [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'], ['pdf', 'application/pdf']] as const;

/**
 * A transfer screenshot (or PDF): the latest, or an earlier one (version 1 is the first). The
 * latest is receipts/<order>.<ext>; each earlier one is kept as receipts/<order>.v<n>.<ext>.
 */
export function readReceipt(orderId: string, version?: number): { bytes: Buffer; mime: string } | null {
  if (!/^BUH-[A-Z0-9-]{4,40}$/.test(orderId)) return null;
  if (version !== undefined && !(Number.isInteger(version) && version >= 1 && version <= 1000)) return null;
  for (const [ext, mime] of RECEIPT_TYPES) {
    try {
      return { bytes: fs.readFileSync(path.join(receiptsDir(), version === undefined ? `${orderId}.${ext}` : `${orderId}.v${version}.${ext}`)), mime };
    } catch {
      // try the next type
    }
  }
  return null;
}

// ── Bank transfer: the customer's private page, the owner's check ───────────

/**
 * Limits on transfer screenshots, so uploads can't fill the disk (or make backups too big to make):
 * the latest 5 per order are kept (older ones are deleted), the receipts folder stops taking new
 * ones at 2 GB, and nothing is taken while the disk has less than 1 GB free. Then the customer is
 * asked to send the screenshot on WhatsApp, and the owner is told. (Changeable by tests only.)
 */
export const RECEIPT_LIMITS = { versions: 5, folderBytes: 2 * 1024 ** 3, minFreeBytes: 1024 ** 3 };
const NO_ROOM = 'We can’t take the upload right now, sorry. Please send the screenshot on WhatsApp instead.';

/** Why a new receipt can't be stored now (the folder is full, or the disk nearly is), or null. */
function receiptRoomProblem(incoming: number): string | null {
  const dir = receiptsDir();
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free - incoming < RECEIPT_LIMITS.minFreeBytes) return `the disk has only ${Math.round(free / 1024 ** 2)} MB free`;
  } catch {
    // statfs unavailable: the folder cap below still applies
  }
  let used = 0;
  for (const f of fs.readdirSync(dir)) {
    try {
      used += fs.statSync(path.join(dir, f)).size;
    } catch {
      // removed meanwhile
    }
  }
  if (used + incoming > RECEIPT_LIMITS.folderBytes) return `the receipts folder holds ${Math.round(used / 1024 ** 2)} MB (the cap is ${Math.round(RECEIPT_LIMITS.folderBytes / 1024 ** 2)} MB)`;
  return null;
}

/** An upload refused for room: logged, shown in Settings → System, and emailed to the owner (at most every 6 hours). */
function noteNoRoom(orderId: string, why: string): void {
  logEvent_('warn', 'receipt_refused_no_room', { orderId, why });
  const last = kvGet<{ at: string }>('receipts:no-room');
  kvSet('receipts:no-room', { at: new Date().toISOString(), why });
  if (last && Date.now() - Date.parse(last.data.at) < 6 * 3600_000) return;
  void import('./adminAlerts')
    .then(({ alertOwner }) =>
      alertOwner(
        'Transfer screenshots can’t be uploaded',
        `A customer could not upload a transfer screenshot (order ${orderId}) because ${why}. They were asked to send it on WhatsApp.\n\nFree some space on the server (old backups, logs), then check Settings → System & backups.`
      )
    )
    .catch(() => undefined);
}

/** The last time an upload was refused for room (Settings → System shows it for a day). */
export function receiptsNoRoom(): { at: string; why: string } | null {
  const v = kvGet<{ at: string; why: string }>('receipts:no-room')?.data;
  return v && Date.now() - Date.parse(v.at) < 24 * 3600_000 ? v : null;
}

/** Keep the latest RECEIPT_LIMITS.versions of an order's screenshots (the latest is version n). */
function pruneReceiptVersions(dir: string, orderId: string, n: number): void {
  const oldest = n - RECEIPT_LIMITS.versions + 1;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(`${orderId}.v`)) continue;
    const m = /^(.+)\.v(\d+)\.[a-z]+$/.exec(f);
    if (m && m[1] === orderId && Number(m[2]) < oldest) fs.rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * The customer uploads the transfer screenshot (image or PDF) on the order's private page. The
 * file is checked like a checkout receipt always was (its first bytes, 5 MB at most). Uploading
 * again replaces it on screen; the 4 before it are kept for the owner. The caller has checked the
 * private link; this checks the order still takes one (not paid, not cancelled), that there is
 * room for it, and audits it before the change is saved. The files are only swapped once the
 * change is saved, so a failed save leaves the screenshots as they were. Synchronous throughout,
 * so two uploads in this process can't interleave.
 */
export function uploadTransfer(orderId: string, file: unknown, context: { ip?: string | null } = {}): Order {
  const receipt = parseReceiptDataUrl(file);
  const before = getOrder(orderId);
  if (!before || before.paymentMethod !== 'bank_transfer' || !before.bankTransfer) throw new HttpError(404, 'Not found.');
  if (before.status === 'cancelled' || before.bankTransfer.state === 'paid') throw new HttpError(409, 'This order is already paid or closed: nothing more to upload.');
  const room = receiptRoomProblem(receipt.bytes.length);
  if (room) {
    noteNoRoom(orderId, room);
    throw new HttpError(507, NO_ROOM, {}, { code: 'no_room' });
  }
  const dir = receiptsDir();
  const fresh = path.join(dir, `${orderId}.upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(fresh, receipt.bytes, { mode: 0o600 });
  let n = 0;
  try {
    auditedTransaction((auditOrThrow) => {
      const order = getOrder(orderId);
      if (!order || order.paymentMethod !== 'bank_transfer' || !order.bankTransfer) throw new HttpError(404, 'Not found.');
      if (order.status === 'cancelled' || order.bankTransfer.state === 'paid') throw new HttpError(409, 'This order is already paid or closed: nothing more to upload.');
      n = order.bankTransfer.uploads + 1;
      const at = new Date().toISOString();
      getDb().prepare("UPDATE orders SET bank_state = 'uploaded', transfer_uploads = ?, transfer_uploaded_at = ? WHERE id = ?").run(n, at, orderId);
      order.paymentStatus = 'receipt_uploaded';
      order.paymentReceiptUrl = `/api/admin/orders/${orderId}/receipt`;
      writeOrder(order);
      logEvent(orderId, 'customer', 'transfer_uploaded', { n, type: receipt.ext });
      auditOrThrow('order.transfer_uploaded', { orderId, uploads: n, type: receipt.ext, ...(context.ip ? { ip: context.ip } : {}) });
    });
  } catch (err) {
    fs.rmSync(fresh, { force: true });
    throw err;
  }
  // Saved: now the files (the latest becomes version n − 1; the new one is the latest).
  try {
    for (const [ext] of RECEIPT_TYPES) {
      const current = path.join(dir, `${orderId}.${ext}`);
      if (fs.existsSync(current)) fs.renameSync(current, path.join(dir, `${orderId}.v${n - 1}.${ext}`));
    }
    fs.renameSync(fresh, path.join(dir, `${orderId}.${receipt.ext}`));
    pruneReceiptVersions(dir, orderId, n);
  } catch (err) {
    logEvent_('error', 'receipt_swap_failed', { orderId, n, error: err instanceof Error ? err.message : String(err) });
  }
  bump('orders');
  return getOrder(orderId)!;
}

export type BankResult = 'received' | 'not_received';

/**
 * The owner's tap on a bank-transfer order: "Payment received" (the money is in the account: the
 * order is paid, and its private page closes) or "Not received yet" (looked, not there; the
 * customer may upload again). Checked against the order here, idempotent (the same answer again
 * changes nothing), and written to the audit log inside the same transaction, so it is never
 * reported done (or saved) without its audit entry. A paid order is never un-paid.
 */
export function checkBankTransfer(id: string, result: BankResult, actor: string): { order: Order; changed: boolean } {
  return auditedTransaction((auditOrThrow) => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const bank = order.bankTransfer;
    if (order.paymentMethod !== 'bank_transfer' || !bank) throw new HttpError(409, 'This order is not paid by bank transfer.');
    if (result === 'received' && bank.state === 'paid') return { order, changed: false };
    if (result === 'not_received' && bank.state === 'not_received') return { order, changed: false };
    if (result === 'not_received' && bank.state === 'paid') throw new HttpError(409, `${order.id} is already marked as paid.`);
    if (order.status === 'cancelled') throw new HttpError(409, `${order.id} is cancelled.`);
    const at = new Date().toISOString();
    getDb()
      .prepare('UPDATE orders SET bank_state = ?, bank_checked_at = ?, bank_checked_by = ? WHERE id = ?')
      .run(result === 'received' ? 'paid' : 'not_received', at, actor, id);
    if (result === 'received') {
      // Paid the way every version knows (the JSON's payment status), so an older one shows it too.
      order.paymentStatus = 'verified';
      writeOrder(order);
    }
    logEvent(id, actor, result === 'received' ? 'bank_paid' : 'bank_not_received', { from: bank.state, uploads: bank.uploads });
    auditOrThrow(result === 'received' ? 'payment.bank_received' : 'payment.bank_not_received', { by: actor, orderId: id, amountFils: fils(order.total), from: bank.state, uploads: bank.uploads });
    bump('orders');
    return { order: getOrder(id)!, changed: true };
  });
}

/**
 * A transaction whose changes are audited before they count: each auditOrThrow() writes its entry
 * (or throws 503, and nothing is saved). The entry is written before COMMIT, so if the commit
 * itself then fails (the disk is full, the database is busy), a "rolled_back" entry follows it at
 * once: the audit log never claims a change the database doesn't have.
 */
function auditedTransaction<T>(fn: (auditOrThrow: (action: string, details: Record<string, unknown>) => void) => T): T {
  const written: Array<{ action: string; details: Record<string, unknown> }> = [];
  const record = (action: string, details: Record<string, unknown>) => {
    auditOrThrow(action, details);
    written.push({ action, details });
  };
  try {
    return inTransaction(() => fn(record));
  } catch (err) {
    for (const w of written) {
      const ok = audit('audit.rolled_back', {
        action: w.action,
        ...(typeof w.details.orderId === 'string' ? { orderId: w.details.orderId } : {}),
        ...(typeof w.details.by === 'string' ? { by: w.details.by } : {}),
        error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
      if (!ok) logEvent_('error', 'audit_rollback_note_failed', { action: w.action });
    }
    throw err;
  }
}

const OPEN_TRANSFER = "status <> 'cancelled' AND payment_status NOT IN ('verified', 'paid')";

/** Bank transfers with a screenshot waiting for the owner's check. */
export function transfersToCheckCount(): number {
  return getDb().prepare(`SELECT COUNT(*) FROM orders WHERE bank_state = 'uploaded' AND ${OPEN_TRANSFER}`).pluck().get() as number;
}

/** Bank transfers still waiting for the customer (no screenshot yet, or not received). */
export function transfersAwaitedCount(): number {
  return getDb().prepare(`SELECT COUNT(*) FROM orders WHERE bank_state IN ('awaiting', 'not_received') AND ${OPEN_TRANSFER}`).pluck().get() as number;
}

/** Claim an order's one bank-details email (two copies of the shop may try at once during an update). */
export function claimBankEmail(id: string): boolean {
  return getDb().prepare('UPDATE orders SET bank_emailed_at = ? WHERE id = ? AND bank_emailed_at IS NULL').run(new Date().toISOString(), id).changes === 1;
}

/** The bank-details email was sent (noted on the order's history), or failed (noted; the owner sends it on WhatsApp). */
export function bankEmailDone(id: string, ok: boolean): void {
  if (!ok) getDb().prepare('UPDATE orders SET bank_emailed_at = NULL WHERE id = ?').run(id);
  logEvent(id, 'shop', ok ? 'bank_emailed' : 'bank_email_failed');
  bump('orders');
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
      if (status !== 'cancelled') assertNotHeld(order);
      assertCardAllows(order, status);
      releaseStock(order, status);
      if (status === 'delivered') order.courier.deliveredAt = new Date().toISOString();
      changes.status = { from: order.status, to: status };
      order.status = status;
    }
    if (p.paymentStatus !== undefined && p.paymentStatus !== order.paymentStatus) {
      // Only Stripe's word (the webhook, or asking Stripe) marks a card order paid.
      if (order.paymentMethod === 'online_card') throw new HttpError(409, 'Card payments are recorded by Stripe, not by hand.', {}, { code: 'card_payment' });
      if (!PAYMENT_STATUSES.includes(p.paymentStatus as Order['paymentStatus'])) throw new HttpError(400, 'Unknown payment status.');
      // A bank transfer is marked paid only with "Payment received" (checkBankTransfer: it refuses a
      // cancelled order, closes the private page and is audited before it counts), never by hand here.
      if (order.paymentMethod === 'bank_transfer') {
        throw new HttpError(409, order.bankTransfer?.state === 'paid' ? `${order.id} is already marked as paid.` : 'Use "Payment received" on the order to mark a bank transfer paid.', {}, { code: 'use_bank_check' });
      }
      changes.paymentStatus = { from: order.paymentStatus, to: p.paymentStatus };
      order.paymentStatus = p.paymentStatus as Order['paymentStatus'];
    }
    if (p.adminNotes !== undefined) {
      order.adminNotes = text(p.adminNotes, 'Notes', 1000) || undefined;
      changes.adminNotes = true;
    }
    // "Mark as handled" on something that needed the owner's attention.
    if (p.clearAttention !== undefined) {
      if (p.clearAttention !== true) throw new HttpError(400, 'clearAttention must be true.');
      if (order.attention) {
        getDb().prepare('UPDATE orders SET needs_attention = NULL WHERE id = ?').run(id);
        changes.attentionHandled = order.attention.kind;
        delete order.attention;
      }
    }
    if (Object.keys(changes).length) {
      writeOrder(order);
      logEvent(id, actor, 'updated', changes);
    }
    return getOrder(id)!;
  });
  invalidateProducts();
  return updated;
}

/**
 * Put a cancelled order's reserved pieces back, size by size (the row is recreated if the size
 * was removed meanwhile). Only if they never left: once dispatched, the piece is with the courier
 * (most designs are one of a kind), so the owner adds it back with + when it returns. Called inside
 * the transaction that moves the order to cancelled, once (a cancelled order can't be cancelled again).
 */
function releaseStock(order: Order, to: OrderStatus): void {
  if (to !== 'cancelled' || !(order.status === 'pending_confirmation' || order.status === 'pending_payment' || order.status === 'confirmed')) return;
  for (const item of order.items) {
    getDb()
      .prepare('INSERT INTO product_stock (product_id, size_id, qty) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM products WHERE id = ?) ON CONFLICT(product_id, size_id) DO UPDATE SET qty = qty + excluded.qty')
      .run(item.productId, item.profileId, item.quantity, item.productId);
  }
}

/**
 * A card order moves only with its payment: not confirmed or booked before Stripe says paid,
 * and a paid one is cancelled through "Cancel & refund" (so the money goes back with it).
 * An unpaid one is cancelled through cancelCardOrder (the payment is stopped at Stripe first).
 */
function assertCardAllows(order: Order, to: OrderStatus): void {
  const state = order.card?.state;
  if (order.paymentMethod !== 'online_card' || !state) return;
  if (state === 'pending' || state === 'failed') {
    throw new HttpError(409, to === 'cancelled' ? 'This card payment is still open: cancel it from the order (it is stopped at Stripe first).' : `${order.id} is waiting for the customer's card payment.`, {}, { code: 'card_unpaid' });
  }
  if (to === 'cancelled' && (state === 'paid' || state === 'refund_pending') && order.status !== 'cancelled') {
    throw new HttpError(409, `${order.id} was paid by card: use “Cancel & refund AED ${order.total}” so the money goes back to the card.`, {}, { code: 'refund_first' });
  }
}

/**
 * Settings → Store & contact "Hold orders until confirmed on WhatsApp": an order asked to
 * confirm is not confirmed or booked until the owner has marked the customer's message as
 * received. Cancelling is always possible.
 */
export function assertNotHeld(order: Order): void {
  const check = order.whatsappCheck;
  if (check?.hold && check.status !== 'confirmed') {
    throw new HttpError(409, `${order.id} is held until the customer confirms on WhatsApp. Tap “Confirmed on WhatsApp” once their message has come, or cancel the order.`, {}, { code: 'whatsapp_hold' });
  }
}

export type WhatsAppResult = 'confirmed' | 'mismatch';

/**
 * The owner's one tap: the customer's WhatsApp message came from the number on the order
 * (confirmed), or from another number (mismatch). Idempotent: the same answer again changes
 * nothing. Written to the audit log inside the same transaction, so it is never reported done
 * (or saved) without its audit entry. A mismatch can still be corrected to confirmed.
 */
export function checkWhatsApp(id: string, result: WhatsAppResult, actor: string): { order: Order; changed: boolean } {
  return inTransaction(() => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const check = order.whatsappCheck;
    if (!check) throw new HttpError(409, 'This order was not asked to confirm on WhatsApp.');
    if (check.status === result) return { order, changed: false };
    const at = new Date().toISOString();
    getDb().prepare('UPDATE orders SET phone_check = ?, phone_checked_at = ?, phone_checked_by = ?, updated_at = ? WHERE id = ?').run(result, at, actor, at, id);
    logEvent(id, actor, result === 'confirmed' ? 'whatsapp_confirmed' : 'whatsapp_mismatch', { from: check.status });
    if (!audit(result === 'confirmed' ? 'order.whatsapp_confirmed' : 'order.whatsapp_mismatch', { by: actor, orderId: id, from: check.status, held: check.hold })) {
      throw new HttpError(503, 'The audit log could not be written, so nothing was changed. Please try again.');
    }
    bump('orders');
    return { order: getOrder(id)!, changed: true };
  });
}

/**
 * The customer tapped "Confirm on WhatsApp": note when their WhatsApp opened, once. Needs the
 * order number and the phone number on it (as Track Order does), so nobody can mark another
 * order. Says nothing about whether the pair matched.
 */
export function markWhatsAppOpened(id: string, phone: string): boolean {
  const at = new Date().toISOString();
  const changed = getDb()
    .prepare("UPDATE orders SET wa_opened_at = ? WHERE id = ? AND phone = ? AND phone_check = 'awaiting' AND wa_opened_at IS NULL")
    .run(at, id.trim().toUpperCase(), phone).changes === 1;
  if (changed) {
    logEvent(id.trim().toUpperCase(), 'customer', 'whatsapp_opened');
    bump('orders');
  }
  return changed;
}

/** Orders still waiting for the customer's WhatsApp message (not cancelled). */
export function awaitingWhatsAppCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE phone_check = 'awaiting' AND status <> 'cancelled'").get() as { n: number }).n;
}

/**
 * Record a courier booking result on the order (used by dispatch). The carrier answered after the
 * order was cancelled, or its card payment refunded or not paid (a refund raced the booking): the
 * booking is kept on the order (its AWB is needed to cancel the pickup), the order is not moved,
 * and it is flagged for the owner, audited and alerted.
 */
export function recordBooking(id: string, actor: string, booking: Partial<Order['courier']> & { notes?: string }): Order {
  let raced = false as boolean;
  const saved = inTransaction(() => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const { notes, ...courier } = booking;
    const cardState = order.paymentMethod === 'online_card' ? order.card?.state : undefined;
    const why = order.status === 'cancelled' ? 'the order was cancelled' : cardState !== undefined && cardState !== 'paid' ? `its card payment is ${cardState === 'refund_pending' || cardState === 'refunded' ? 'refunded' : 'not paid'}` : '';
    order.courier = { ...order.courier, ...courier };
    if (notes !== undefined) order.adminNotes = notes || undefined;
    if (!why && (courier.bookingState === 'booked' || courier.simulated)) {
      if (order.status === 'pending_confirmation' || order.status === 'pending_payment') order.status = 'confirmed';
    }
    writeOrder(order);
    logEvent(id, actor, 'courier', { provider: order.courier.provider, awb: order.courier.awbNumber, state: courier.bookingState, simulated: courier.simulated });
    if (why) {
      const awb = order.courier.awbNumber || '';
      const text = `A courier booking${awb ? ` (AWB ${awb})` : ''} came back after ${why}. Cancel that pickup in the carrier's portal so nothing is sent.`;
      setAttention(id, 'booked_after_cancel', text);
      logEvent(id, actor, 'booking_after_cancel', { awb, why });
      auditOrThrow('order.booking_exception', { orderId: id, awb, why, provider: order.courier.provider, by: actor });
      raced = true;
    }
    return getOrder(id)!;
  });
  if (raced) notifyAttention(saved);
  return saved;
}

/** Flag an order for the owner (shown in the hub until "Mark as handled"). Inside the caller's transaction. */
function setAttention(id: string, kind: OrderAttention['kind'], text: string): void {
  getDb().prepare('UPDATE orders SET needs_attention = ? WHERE id = ?').run(JSON.stringify({ kind, text, at: new Date().toISOString() }), id);
}

/** Tell the owner (email to the admin address when mail is set up); never throws or waits. */
function notifyAttention(order: Order | undefined): void {
  bump('orders');
  if (!order?.attention) return;
  const { id } = order;
  const { text } = order.attention;
  void import('./adminAlerts').then(({ alertOwner }) => alertOwner(`Order ${id} needs your attention`, `${text}\n\nOpen the Admin Hub → Orders → ${id}.`)).catch(() => undefined);
}

/** Orders flagged for the owner (not yet marked as handled). */
export function ordersNeedingAttention(): number {
  return getDb().prepare('SELECT COUNT(*) FROM orders WHERE needs_attention IS NOT NULL').pluck().get() as number;
}

// ── Card payments (Stripe) ──────────────────────────────────────────────────
//
// Only Stripe's word moves a card order: its signed webhook (src/app/api/stripe/webhook), or this
// server asking Stripe (src/lib/server/payments.ts). Each change below is one transaction with its
// conditions in the UPDATE (so it happens once, even with two copies of the shop running), and is
// written to the audit log before it counts: if the log can't be written, nothing is saved and
// Stripe (or the next check) tries again.

const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

function auditOrThrow(action: string, details: Record<string, unknown>): void {
  if (!audit(action, details)) throw new HttpError(503, 'The audit log could not be written, so nothing was changed. Please try again.');
}

/** What Stripe says about a PaymentIntent (amount in fils; never what a browser says). */
export interface IntentFacts {
  id: string;
  amount: number;
  currency: string;
  /** metadata.orderId, set by this server when it made the intent. */
  orderId?: string;
  /** "Apple Pay · Visa •••• 4242", when known. */
  label?: string;
}

/** A Stripe event, applied once: its id is recorded in the same transaction as its effect. */
export interface StripeEventRef {
  id: string;
  type: string;
}

export type CardOutcome = 'paid' | 'paid_after_cancel' | 'already' | 'mismatch' | 'unknown' | 'failed' | 'cancelled' | 'refunded' | 'refund_pending' | 'refund_failed' | 'partial' | 'ignored' | 'duplicate';

function applyOnce(event: StripeEventRef | undefined, orderId: string | null, fn: () => CardOutcome): CardOutcome {
  return inTransaction(() => {
    const db = getDb();
    if (event) {
      const fresh = db.prepare('INSERT INTO stripe_events (id, type, order_id, at, outcome) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(event.id, event.type, orderId, new Date().toISOString(), 'applying').changes === 1;
      if (!fresh) return 'duplicate';
    }
    const outcome = fn();
    if (event) db.prepare('UPDATE stripe_events SET outcome = ? WHERE id = ?').run(outcome, event.id);
    return outcome;
  });
}

/** The PaymentIntent Stripe made for this order, and a hash of its client secret (the paying browser's proof). */
export function recordCardIntent(id: string, ref: string, clientSecret: string, livemode?: boolean): void {
  const r = getDb()
    .prepare("UPDATE orders SET payment_ref = ?, card_secret_hash = ?, card_livemode = COALESCE(?, card_livemode) WHERE id = ? AND card_state IN ('pending', 'failed') AND (payment_ref IS NULL OR payment_ref = ?)")
    .run(ref, sha256(clientSecret), livemode === undefined ? null : livemode ? 1 : 0, id, ref);
  if (r.changes !== 1) throw new HttpError(409, 'This card payment can no longer be started. Please start checkout again.', {}, { code: 'card_closed' });
  logEvent(id, 'stripe', 'card_intent', { ref });
}

/** Does this client secret belong to this order (the browser paying for it holds it)? */
export function cardSecretMatches(id: string, clientSecret: unknown): boolean {
  if (typeof clientSecret !== 'string' || !clientSecret || clientSecret.length > 300) return false;
  const row = getDb().prepare('SELECT card_secret_hash FROM orders WHERE id = ?').get(id) as { card_secret_hash: string | null } | undefined;
  if (!row?.card_secret_hash) return false;
  return crypto.timingSafeEqual(Buffer.from(row.card_secret_hash, 'hex'), Buffer.from(sha256(clientSecret), 'hex'));
}

export function orderByPaymentRef(ref: string): Order | undefined {
  return parse(getDb().prepare(`SELECT ${COLUMNS} FROM orders WHERE payment_ref = ?`).get(ref) as Row | undefined);
}

/** Card orders still unpaid, made before `before` (ISO): the sweep cancels them. */
export function unpaidCardOrders(before: string): Array<{ id: string; ref: string | null }> {
  return (
    getDb().prepare("SELECT id, payment_ref FROM orders WHERE card_state IN ('pending', 'failed') AND created_at < ? ORDER BY created_at LIMIT 100").all(before) as Array<{ id: string; payment_ref: string | null }>
  ).map((r) => ({ id: r.id, ref: r.payment_ref }));
}

/** Did Stripe take exactly this order's total, in AED, on the intent this server made for it? */
export function intentMatches(order: Order, pi: IntentFacts): boolean {
  return order.paymentMethod === 'online_card' && order.card?.ref === pi.id && pi.orderId === order.id && pi.currency === 'aed' && pi.amount === fils(order.total);
}

/**
 * Stripe says the payment succeeded. Idempotent: an order already paid (or refunded) stays as it is,
 * and an event seen before changes nothing. A mismatch (another amount, currency or intent) is
 * recorded and audited, never counted as paid. Paid after the order was cancelled (only possible
 * around a rollback): recorded as paid, so the owner refunds it from the hub.
 */
export function markCardPaid(orderId: string, pi: IntentFacts, actor: string, event?: StripeEventRef): CardOutcome {
  const outcome = applyOnce(event, orderId, () => {
    const order = getOrder(orderId);
    if (!order || !order.card) return 'unknown';
    if (!intentMatches(order, pi)) {
      logEvent(orderId, actor, 'card_mismatch', { ref: pi.id, amount: aed(pi.amount), currency: pi.currency });
      auditOrThrow('payment.mismatch', { orderId, ref: pi.id, amountFils: pi.amount, currency: pi.currency, expectedFils: fils(order.total), via: actor });
      return 'mismatch';
    }
    if (order.card.state === 'paid' || order.card.state === 'refund_pending' || order.card.state === 'refunded') return 'already';
    const at = new Date().toISOString();
    const changed = getDb()
      .prepare("UPDATE orders SET card_state = 'paid', paid_fils = ?, paid_at = ?, card_label = ? WHERE id = ? AND card_state IN ('pending', 'failed', 'canceled')")
      .run(pi.amount, at, pi.label?.slice(0, 80) || null, orderId).changes;
    if (changed !== 1) return 'already';
    const late = order.status === 'cancelled';
    order.paymentStatus = 'paid';
    if (order.status === 'pending_payment') order.status = 'pending_confirmation';
    writeOrder(order);
    logEvent(orderId, actor, late ? 'card_paid_after_cancel' : 'card_paid', { ref: pi.id, amount: aed(pi.amount), label: pi.label });
    auditOrThrow(late ? 'payment.paid_after_cancel' : 'payment.paid', { orderId, ref: pi.id, amountFils: pi.amount, via: actor, ...(event ? { event: event.id } : {}) });
    return late ? 'paid_after_cancel' : 'paid';
  });
  if (outcome === 'paid' || outcome === 'paid_after_cancel') bump('orders');
  return outcome;
}

/** A try was declined: noted, and the customer may try again until the order times out. Never un-pays. */
export function markCardFailed(orderId: string, pi: { id: string; declineCode?: string }, actor: string, event?: StripeEventRef): CardOutcome {
  return applyOnce(event, orderId, () => {
    const order = getOrder(orderId);
    if (!order?.card || order.card.ref !== pi.id) return 'unknown';
    if (order.card.state !== 'pending' && order.card.state !== 'failed') return 'ignored';
    const changed = getDb().prepare("UPDATE orders SET card_state = 'failed' WHERE id = ? AND card_state = 'pending'").run(orderId).changes;
    logEvent(orderId, actor, 'card_declined', pi.declineCode ? { reason: pi.declineCode.slice(0, 40) } : undefined);
    if (changed) bump('orders');
    return 'failed';
  });
}

/**
 * An unpaid card order is over (Stripe cancelled the payment, the customer left checkout, it timed
 * out, or the owner cancelled it): cancelled, and its pieces back on sale, exactly once (the UPDATE
 * only matches an open payment). The caller has stopped the payment at Stripe first, so it can't
 * be paid later.
 */
export function cancelCardOrder(orderId: string, actor: string, reason: string, event?: StripeEventRef, attention?: { kind: OrderAttention['kind']; text: string }): CardOutcome {
  const outcome = applyOnce(event, orderId, () => {
    const changed = getDb().prepare("UPDATE orders SET card_state = 'canceled' WHERE id = ? AND card_state IN ('pending', 'failed')").run(orderId).changes;
    if (changed !== 1) return 'ignored';
    const order = getOrder(orderId)!;
    if (order.status !== 'cancelled') {
      releaseStock(order, 'cancelled');
      order.status = 'cancelled';
      writeOrder(order);
    }
    if (attention) setAttention(orderId, attention.kind, attention.text);
    logEvent(orderId, actor, 'card_cancelled', { reason });
    auditOrThrow('payment.card_cancelled', { orderId, reason, by: actor, ...(event ? { event: event.id } : {}) });
    return 'cancelled';
  });
  if (outcome === 'cancelled') {
    invalidateProducts();
    if (attention) notifyAttention(getOrder(orderId));
  }
  return outcome;
}

/** What is left to refund of a paid card order, in fils (paid, less any refund already made). */
export function refundableFils(order: Order): number {
  return Math.max(0, fils(order.card?.paidAmount ?? 0) - fils(order.card?.refundedAmount ?? 0));
}

/** Stripe says how much of the charge is refunded so far (e.g. a partial refund in its dashboard): noted. */
export function noteRefundedSoFar(orderId: string, refundedFils: number): void {
  if (getDb().prepare('UPDATE orders SET refunded_fils = ? WHERE id = ? AND COALESCE(refunded_fils, 0) <> ?').run(refundedFils, orderId, refundedFils).changes) bump('orders');
}

/**
 * "Cancel & refund" from the hub, with Stripe's answer to the refund: refunded (Stripe says
 * succeeded) or refund pending (its webhook says when), and the order is cancelled (pieces back on
 * sale if they never left). Full refunds only. The same refund again changes nothing.
 */
export function recordCardRefund(orderId: string, refund: { id: string; status: string; amount: number }, actor: string, expectedFils?: number): { order: Order; outcome: CardOutcome } {
  const result = inTransaction(() => {
    const order = getOrder(orderId);
    if (!order?.card) throw new HttpError(404, 'Order not found.');
    if (order.card.state === 'refunded' || (order.card.state === 'refund_pending' && order.card.refundRef === refund.id)) return { order, outcome: 'already' as CardOutcome };
    if (order.card.state !== 'paid' && order.card.state !== 'refund_pending') throw new HttpError(409, 'Only a paid card order can be refunded.');
    // What was left to refund (paid, less a partial refund already made in Stripe's dashboard).
    const left = expectedFils ?? refundableFils(order);
    if (refund.amount !== left || left <= 0) {
      throw new HttpError(502, 'Stripe answered with a different refund amount. Check the payment in your Stripe dashboard.');
    }
    const done = refund.status === 'succeeded';
    const paidFils = fils(order.card.paidAmount ?? 0);
    getDb()
      .prepare("UPDATE orders SET card_state = ?, refund_ref = ?, refunded_at = ?, refunded_fils = ? WHERE id = ? AND card_state IN ('paid', 'refund_pending')")
      .run(done ? 'refunded' : 'refund_pending', refund.id, done ? new Date().toISOString() : null, done ? paidFils : paidFils - left || null, orderId);
    if (order.status !== 'cancelled' && order.status !== 'delivered') {
      releaseStock(order, 'cancelled');
      order.status = 'cancelled';
      writeOrder(order);
    }
    logEvent(orderId, actor, done ? 'card_refunded' : 'card_refund_pending', { ref: refund.id, amount: aed(refund.amount) });
    auditOrThrow(done ? 'payment.refunded' : 'payment.refund_pending', { orderId, refund: refund.id, amountFils: refund.amount, by: actor });
    return { order: getOrder(orderId)!, outcome: (done ? 'refunded' : 'refund_pending') as CardOutcome };
  });
  invalidateProducts();
  bump('orders');
  return result;
}

/**
 * Stripe says a charge was refunded (its webhook; also refunds made in the Stripe dashboard).
 * A full refund marks the order refunded, once; a partial one is only noted (the shop refunds in full).
 */
export function markCardRefunded(ref: string, charge: { amount: number; amountRefunded: number; refundId?: string }, actor: string, event?: StripeEventRef): CardOutcome {
  const found = orderByPaymentRef(ref);
  const outcome = applyOnce(event, found?.id ?? null, () => {
    const order = found && getOrder(found.id);
    if (!order?.card) return 'unknown';
    if (order.card.state === 'refunded') return 'already';
    if (order.card.state !== 'paid' && order.card.state !== 'refund_pending') return 'ignored';
    if (charge.amountRefunded < (order.card.paidAmount !== undefined ? fils(order.card.paidAmount) : charge.amount)) {
      // A partial refund (Stripe's dashboard): noted, so "Cancel & refund" offers only what is left.
      if (order.card.state === 'paid') getDb().prepare('UPDATE orders SET refunded_fils = ? WHERE id = ?').run(charge.amountRefunded, order.id);
      logEvent(order.id, actor, 'card_partly_refunded', { amount: aed(charge.amountRefunded) });
      return 'partial';
    }
    getDb()
      .prepare("UPDATE orders SET card_state = 'refunded', refunded_at = ?, refunded_fils = ?, refund_ref = COALESCE(refund_ref, ?) WHERE id = ? AND card_state IN ('paid', 'refund_pending')")
      .run(new Date().toISOString(), charge.amountRefunded, charge.refundId ?? null, order.id);
    // Refunded in full (also from Stripe's dashboard): the order is cancelled, its pieces back on
    // sale if they never left, exactly once (a cancelled or delivered order stays as it is).
    if (order.status !== 'cancelled' && order.status !== 'delivered') {
      releaseStock(order, 'cancelled');
      order.status = 'cancelled';
      writeOrder(order);
    }
    logEvent(order.id, actor, 'card_refunded', { amount: aed(charge.amountRefunded) });
    auditOrThrow('payment.refunded', { orderId: order.id, ref, amountFils: charge.amountRefunded, via: actor, ...(event ? { event: event.id } : {}) });
    return 'refunded';
  });
  if (outcome === 'refunded') {
    invalidateProducts();
    bump('orders');
  }
  return outcome;
}

/**
 * Stripe says a refund failed after all (charge.refund.updated / refund.failed: e.g. the card was
 * closed). The order goes back to paid (the money is still with the shop), audited, flagged and the
 * owner told: refund it again, or another way. Once per refund (the state only moves from refunded
 * or refund pending, for this refund).
 */
export function markRefundFailed(ref: string, refund: { id: string; amount: number; reason?: string }, actor: string, event?: StripeEventRef): CardOutcome {
  const found = orderByPaymentRef(ref);
  const outcome = applyOnce(event, found?.id ?? null, () => {
    const order = found && getOrder(found.id);
    if (!order?.card) return 'unknown';
    if ((order.card.state !== 'refunded' && order.card.state !== 'refund_pending') || (order.card.refundRef && order.card.refundRef !== refund.id)) return 'ignored';
    // What stays refunded once this one failed (a partial refund made before it still counts).
    const stillRefunded = Math.max(0, (order.card.state === 'refunded' ? fils(order.card.refundedAmount ?? order.card.paidAmount ?? 0) : fils(order.card.refundedAmount ?? 0) + refund.amount) - refund.amount);
    const changed = getDb()
      .prepare("UPDATE orders SET card_state = 'paid', refunded_at = NULL, refund_ref = NULL, refunded_fils = ? WHERE id = ? AND card_state IN ('refunded', 'refund_pending')")
      .run(stillRefunded || null, order.id).changes;
    if (changed !== 1) return 'ignored';
    const text = `Stripe could not refund AED ${aed(refund.amount)} to the customer's card${refund.reason ? ` (${refund.reason.replace(/_/g, ' ')})` : ''}: the money is still in your Stripe account. Refund it again, or pay the customer back another way.`;
    setAttention(order.id, 'refund_failed', text);
    logEvent(order.id, actor, 'card_refund_failed', { refund: refund.id, amount: aed(refund.amount), reason: refund.reason });
    auditOrThrow('payment.refund_failed', { orderId: order.id, ref, refund: refund.id, amountFils: refund.amount, reason: refund.reason, via: actor, ...(event ? { event: event.id } : {}) });
    return 'refund_failed';
  });
  if (outcome === 'refund_failed') notifyAttention(found && getOrder(found.id));
  return outcome;
}

/** How many refunds of this order failed (each new try gets its own idempotency key). */
export function failedRefunds(orderId: string): number {
  return getDb().prepare("SELECT COUNT(*) FROM order_events WHERE order_id = ? AND event = 'card_refund_failed'").pluck().get(orderId) as number;
}

/**
 * The owner cancels a paid card order whose payment the Stripe account now saved can't see (the
 * keys were switched between test and live, or removed): no refund goes through the shop, the owner
 * refunds it in the Stripe dashboard of the account it was paid to. Audited before it counts; the
 * order is cancelled (its pieces back if they never left) and flagged until marked handled. Once.
 */
export function cancelPaidWithoutStripe(orderId: string, actor: string, why: string): Order {
  const result = inTransaction(() => {
    const order = getOrder(orderId);
    if (!order?.card) throw new HttpError(404, 'Order not found.');
    if (order.card.refundOutsideAt) return order;
    if (order.card.state !== 'paid') throw new HttpError(409, 'Only a paid card order can be cancelled this way.');
    if (order.status === 'delivered') throw new HttpError(409, 'This order was delivered: refund it from your Stripe dashboard if the parcel comes back.');
    auditOrThrow('payment.cancelled_without_refund', { orderId, ref: order.card.ref, amountFils: refundableFils(order), why, by: actor });
    const at = new Date().toISOString();
    getDb().prepare("UPDATE orders SET refund_outside_at = ? WHERE id = ? AND card_state = 'paid' AND refund_outside_at IS NULL").run(at, orderId);
    if (order.status !== 'cancelled') {
      releaseStock(order, 'cancelled');
      order.status = 'cancelled';
      writeOrder(order);
    }
    setAttention(
      orderId,
      'refund_outside_stripe',
      `Cancelled without a refund through the shop (${why}). Refund AED ${aed(refundableFils(order))} (payment ${order.card.ref ?? ''}) in the Stripe dashboard of the account it was paid to${order.card.mode ? ` (${order.card.mode} mode)` : ''}.`
    );
    logEvent(orderId, actor, 'card_cancelled_without_refund', { why, ref: order.card.ref });
    return getOrder(orderId)!;
  });
  invalidateProducts();
  bump('orders');
  return result;
}

/** Card orders still open (unpaid, or paid and not yet delivered or cancelled), by Stripe mode. */
export function openCardOrders(): { test: number; live: number; unknown: number } {
  const rows = getDb()
    .prepare("SELECT card_livemode AS m, COUNT(*) AS n FROM orders WHERE card_state IN ('pending', 'failed') OR (card_state IN ('paid', 'refund_pending') AND status NOT IN ('delivered', 'cancelled')) GROUP BY card_livemode")
    .all() as Array<{ m: number | null; n: number }>;
  const out = { test: 0, live: 0, unknown: 0 };
  for (const r of rows) out[r.m === 1 ? 'live' : r.m === 0 ? 'test' : 'unknown'] += r.n;
  return out;
}

/** How it was paid ("Apple Pay · Visa •••• 4242"), from Stripe, once known. */
export function setCardLabel(orderId: string, label: string): void {
  if (getDb().prepare('UPDATE orders SET card_label = ? WHERE id = ? AND card_label IS NULL').run(label.slice(0, 80), orderId).changes) bump('orders');
}

/** Card takings between two times (ISO), for the daily summary: paid, and refunded. */
export function cardTakings(from: string, to: string): { paid: number; paidFils: number; refunded: number; refundedFils: number } {
  const db = getDb();
  const paid = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(paid_fils), 0) AS f FROM orders WHERE paid_at >= ? AND paid_at < ? AND card_state IN ('paid', 'refund_pending', 'refunded')").get(from, to) as { n: number; f: number };
  const refunded = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(paid_fils), 0) AS f FROM orders WHERE refunded_at >= ? AND refunded_at < ? AND card_state = 'refunded'").get(from, to) as { n: number; f: number };
  return { paid: paid.n, paidFils: paid.f, refunded: refunded.n, refundedFils: refunded.f };
}

// ── What customers may see ──────────────────────────────────────────────────

/** A placed order as shown to the customer who placed it (no internal notes). */
export function customerView(order: Order) {
  const { adminNotes: _notes, paymentReceiptUrl: _receipt, whatsappCheck: _check, card: _card, bankTransfer: _bank, attention: _attention, ...rest } = order;
  void _attention;
  void _notes;
  void _receipt;
  void _check;
  void _card;
  void _bank;
  return {
    ...rest,
    courier: trackingView(order),
    ...(order.whatsappCheck ? { whatsappCheck: whatsAppView(order.whatsappCheck) } : {}),
    ...(order.card ? { card: cardView(order.card) } : {}),
    ...(order.bankTransfer ? { bankTransfer: bankView(order.bankTransfer) } : {}),
  };
}

/** The customer's side of a bank transfer: where it stands, and their own private page while it is open. */
export function bankView(bank: NonNullable<Order['bankTransfer']>): Pick<NonNullable<Order['bankTransfer']>, 'state' | 'uploads' | 'payPath'> {
  return { state: bank.state, uploads: bank.uploads, ...(bank.payPath ? { payPath: bank.payPath } : {}) };
}

/** The customer's side of a card payment: paid or not, and how (no Stripe references). */
export function cardView(card: CardPayment): Pick<CardPayment, 'state' | 'label'> {
  return { state: card.state, ...(card.label ? { label: card.label } : {}) };
}

/** The customer's side of the WhatsApp confirmation (not who confirmed it). */
function whatsAppView(check: NonNullable<Order['whatsappCheck']>) {
  return { status: check.status, code: check.code, hold: check.hold };
}

function trackingView(order: Order) {
  // The courier's name is not shown to customers (the tracking link is enough).
  return {
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
    ...(order.whatsappCheck ? { whatsappCheck: whatsAppView(order.whatsappCheck) } : {}),
    ...(order.card ? { card: cardView(order.card) } : {}),
    ...(order.bankTransfer ? { bankTransfer: bankView(order.bankTransfer) } : {}),
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
