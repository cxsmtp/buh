import { shopVariantSku } from './marketplace';
import crypto from 'node:crypto';
import { markChanged } from './dataChanges';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { BankState, CardPayment, CardState, Customer, Emirate, Order, OrderAttention, OrderStatus } from '@/types';
import { deliveryCheck, uaeDate } from '@/lib/delivery';
import { dataDir } from './dataDir';
import { folderRoomProblem } from './diskRoom';
import { customerLink } from './runtimeConfig';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { parseReceiptDataUrl } from './imageInput';
import { verifyPhoneToken } from './phoneToken';
import { getProduct, invalidateProducts, listProducts } from './products';
import { bump } from './live';
import { bankTransferMode, cardFeePercent, cardPaymentsReady, getSettings, phoneCheckMode, phoneCodesOn } from './settings';
import { cardFeeFils, vatOnTopFils } from '@/lib/money';
import { checkoutVat, orderVat, recordOrderVat, syncVatDocumentsQuietly } from './vat';
import { mac } from './secrets';
import { audit, auditedTransaction, auditOrThrow } from './audit';
import { kvGet, kvSet } from './kv';
import { logEvent as logEvent_ } from './log';
import { issuePayLink, payPathOf } from './bankPay';
import { waMeLink } from '@/lib/whatsappConfirm';
import { validatePhone } from '@/lib/otpService';
import { DEFAULT_PACKAGING_GRAMS, shipmentWeight } from '@/lib/shipmentWeight';

/**
 * Orders, stored on the server. Everything that decides what a customer pays
 * is computed here from the catalogue, never taken from the browser:
 *  - prices come from the product and the chosen bed size;
 *  - stock is reserved in the same transaction (no overselling the last set);
 *  - the phone number is the one proven by an SMS code (a signed token); with Settings →
 *    Phone check "WhatsApp (free)" (the default), the one typed at checkout, confirmed by the
 *    customer's one WhatsApp message afterwards (an order still unconfirmed after the set hours
 *    is cancelled, its pieces back on sale), and with caps per phone, per connection and in
 *    total (no code costs an attacker anything now); for a card order, the one the card
 *    holder gave (paying is the proof; the order waits for Stripe's word before it counts,
 *    and "Confirm on WhatsApp" still applies);
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
/**
 * Settings → Phone check "WhatsApp (free)": orders no code proved and not yet confirmed hold
 * pieces, so they can't pile up: per phone, per connection and across the shop. (Changeable by
 * tests only.)
 */
export const UNCONFIRMED_LIMITS = {
  perPhone: 2,
  perIp: 4,
  shop: 60,
  /** No TRUST_PROXY (the shop can't tell customers apart, so no per-connection cap): stricter. */
  shopNoProxy: 15,
  /** The owner is alerted when this share of the shop cap is reached. */
  nearShare: 0.8,
  /** Of one product's size, at most this share of its pieces is held by orders not yet confirmed (at least sizeMin). */
  sizeShare: 0.5,
  sizeMin: 2,
};
/** The shop-wide cap on unconfirmed orders that applies with this connection's address known or not. */
export function unconfirmedShopCap(ipKnown = process.env.TRUST_PROXY === '1'): number {
  return ipKnown ? UNCONFIRMED_LIMITS.shop : UNCONFIRMED_LIMITS.shopNoProxy;
}
/** An order no code proved and not yet confirmed (on WhatsApp or by phone call), still waiting. */
const UNCONFIRMED_OPEN =
  "status = 'pending_confirmation' AND phone_check <> 'confirmed' AND COALESCE(json_extract(data, '$.customer.phoneVerified'), 0) = 0 AND card_state NOT IN ('paid', 'refund_pending', 'refunded')";

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
  phone_check_method: string | null;
  wa_cancel_at: string | null;
  wa_unopened_cancel_at: string | null;
}
/**
 * The order's JSON, the WhatsApp confirmation (migration 8), the card payment (migration 9) and the
 * bank transfer (migration 10), in their own columns.
 */
const COLUMNS =
  'data, wa_code, phone_check, wa_hold, wa_opened_at, phone_checked_at, phone_checked_by, card_state, payment_ref, paid_fils, paid_at, card_label, refund_ref, refunded_at, card_livemode, refunded_fils, refund_outside_at, needs_attention, ' +
  'id, status, payment_status, pay_nonce, pay_expires_at, bank_state, transfer_uploads, transfer_uploaded_at, bank_emailed_at, bank_checked_at, bank_checked_by, ' +
  'phone_check_method, wa_cancel_at, wa_unopened_cancel_at';
const ATTENTION_KINDS: OrderAttention['kind'][] = ['refund_failed', 'booked_after_cancel', 'refund_outside_stripe', 'card_unreachable', 'call_customer', 'bank_unconfirmed'];
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
    // A bank transfer is never auto-cancelled (its private page lasts 14 days): no deadline is shown.
    const cancels = r.phone_check !== 'confirmed' && order.paymentMethod !== 'bank_transfer';
    order.whatsappCheck = {
      status: r.phone_check,
      code: r.wa_code,
      hold: r.wa_hold === 1,
      ...(r.wa_opened_at ? { openedAt: r.wa_opened_at } : {}),
      ...(r.phone_checked_at ? { checkedAt: r.phone_checked_at } : {}),
      ...(r.phone_checked_by ? { checkedBy: r.phone_checked_by } : {}),
      ...(r.phone_check === 'confirmed' ? { method: r.phone_check_method === 'call' ? ('call' as const) : ('whatsapp' as const) } : {}),
      ...(r.wa_cancel_at && cancels ? { cancelAt: r.wa_cancel_at } : {}),
      ...(r.wa_unopened_cancel_at && cancels && !r.wa_opened_at ? { openBy: r.wa_unopened_cancel_at } : {}),
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
  // UAE VAT (only orders with a VAT breakdown): the tax invoice once due, credit notes after a cancel.
  syncVatDocumentsQuietly(order.id);
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

/** VAT added on top at checkout (prices excluding VAT); 0 when prices include it. */
function recordableVat(baseFils: number, plan: { rateBp: number; inclusive: boolean }): number {
  return plan.inclusive ? 0 : vatOnTopFils(baseFils, plan.rateBp / 100);
}

/**
 * The customer's private address for their order's receipt (or tax invoice, with VAT on):
 * /invoice/<order>.<mac>, made from the server's key (never stored), so only someone given it opens it.
 */
export function documentPath(orderId: string): string {
  return `/invoice/${orderId}.${mac('order-document', orderId)}`;
}

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
  // Settings → Phone check "WhatsApp (free)": no code; the number typed (UAE mobile rules) is
  // confirmed by the customer's WhatsApp message afterwards. "SMS code": with an SMS gateway
  // switched on, a card order proves its phone like any order. Without one, a card order needs no
  // code: the card holder pays before it counts. A code, if given, always wins.
  const whatsappMode = phoneCheckMode() === 'whatsapp';
  const provenPhone = verifyPhoneToken(body.verificationToken);
  const typedPhone = (body.customer as Obj | undefined)?.phone;
  const phone =
    provenPhone ??
    (whatsappMode && typedPhone !== undefined
      ? validatePhone(typedPhone)
      : card && !phoneCodesOn() && body.verificationToken === undefined
        ? validatePhone(typedPhone)
        : null);
  if (!phone) throw new HttpError(401, 'Please verify your UAE mobile number again (the code check has expired).');
  // No code proved it: the WhatsApp message (or the owner's call) will.
  const unproven = !provenPhone;

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
  // Settings → Payments → Bank transfer: our details sent automatically, or asked for on WhatsApp.
  const bankMode = paymentMethod === 'bank_transfer' ? bankTransferMode() : null;
  if (paymentMethod === 'bank_transfer' && !bankMode) {
    throw new HttpError(400, 'Bank transfer is not available right now. Please choose Cash on Delivery.');
  }
  // Settings → Payments "Card payment fee (%)": card orders only, worked out here (never the browser's).
  const feePercent = card ? cardFeePercent() : 0;
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
  // No code proved this phone: the order holds pieces before anyone has paid or confirmed (a card
  // order until it is paid, any other until the WhatsApp message or the owner's call), so a small
  // bag only.
  const smallBag = !provenPhone;
  const bagLimit = (what: string) =>
    card
      ? new HttpError(400, `Paying by card, at most ${what} per order. For more, place a second order, or choose Cash on Delivery.`, {}, { code: 'card_bag_limit' })
      : new HttpError(400, `At most ${what} per order until we have confirmed your number. For more, please message us on WhatsApp.`, {}, { code: 'unconfirmed_bag_limit' });
  if (smallBag && body.items.length > MAX_UNVERIFIED_CARD_LINES) throw bagLimit(`${MAX_UNVERIFIED_CARD_LINES} different items`);
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
  // Pieces per product and size (the same size may come on two lines).
  const perItem = new Map<string, { productId: string; profileId: string; quantity: number }>();
  for (const l of lines) {
    const k = `${l.productId}|${l.profileId}`;
    perItem.set(k, { productId: l.productId, profileId: l.profileId, quantity: (perItem.get(k)?.quantity ?? 0) + l.quantity });
  }
  if (smallBag && [...perItem.values()].some((q) => q.quantity > MAX_UNVERIFIED_CARD_QTY)) throw bagLimit(`${MAX_UNVERIFIED_CARD_QTY} of each item`);
  // The connection's address is kept only as a hash (enough to count, not to know it); in card_ip
  // (migration 9) for every order, for the caps on card orders and on orders not yet confirmed.
  // IPv6: by its /64 (one home or phone gets a whole /64, so a single address is no limit).
  const ipHash = context.ip ? sha256(`card-ip:${connectionKey(context.ip)}`) : null;

  const courierSettings = getSettings('courier');
  const store = getSettings('store');
  // "Confirm on WhatsApp": only with the shop's number set (Settings → Store & contact). With Phone
  // check "WhatsApp (free)" it is how every order is confirmed; otherwise Store & contact's switch.
  const shopNumber = Boolean(waMeLink(store.whatsappNumber, ''));
  const askWhatsApp = shopNumber && ((whatsappMode && unproven) || store.confirmOrdersOnWhatsApp);
  // WhatsApp mode, no code, not a card: cancelled if still not confirmed after the set hours, and
  // sooner if the customer never even opens WhatsApp (a card order is cancelled in 10 minutes if
  // unpaid, and a paid one is trusted). A bank transfer is never cancelled for this (its private
  // page lasts 14 days): at the deadline it is flagged for the owner, its pieces still held.
  const whatsappUnconfirmed = whatsappMode && unproven && !card;
  const phoneCheck = getSettings('phoneCheck');
  const cancelAt = whatsappUnconfirmed && askWhatsApp ? new Date(Date.now() + phoneCheck.unconfirmedCancelHours * 3600_000).toISOString() : null;
  const unopenedAt =
    cancelAt && paymentMethod !== 'bank_transfer' ? new Date(Date.now() + Math.min(phoneCheck.unopenedCancelHours, phoneCheck.unconfirmedCancelHours) * 3600_000).toISOString() : null;
  const shopCap = unconfirmedShopCap(Boolean(ipHash));
  // WhatsApp mode without the shop's number: nothing can confirm the order. Still taken, never
  // treated as verified, and flagged for the owner to call the customer.
  const callCustomer = whatsappMode && unproven && !shopNumber && !card;
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
    // The shop-wide cap refused a customer: the owner is told (outside the rolled-back transaction).
    if (err instanceof HttpError && err.details?.code === 'shop_busy') noteUnconfirmedPressure('refused', shopCap);
    throw err;
  }
  if (whatsappUnconfirmed) noteUnconfirmedPressure('placed', shopCap);
  function placeInTransaction(): Order {
    return inTransaction(() => {
      // One verified phone can't tie up the stock with a pile of unconfirmed orders.
      const open = (getDb().prepare("SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND status = 'pending_confirmation'").get(phone) as { n: number }).n;
      if (open >= MAX_OPEN_PER_PHONE) {
        throw new HttpError(429, `You already have ${open} orders waiting for confirmation. We'll call you shortly, or contact us to add to them.`);
      }
      if (whatsappUnconfirmed) {
        // No code cost anything: orders not yet confirmed are capped per phone, per connection and
        // overall (stricter when the shop can't tell connections apart), and can hold only part of
        // any one size's pieces.
        const count = (where: string, ...args: unknown[]) => getDb().prepare(`SELECT COUNT(*) FROM orders WHERE ${UNCONFIRMED_OPEN}${where}`).pluck().get(...args) as number;
        if (count(' AND phone = ?', phone) >= UNCONFIRMED_LIMITS.perPhone) {
          throw new HttpError(429, `You already have ${UNCONFIRMED_LIMITS.perPhone} orders waiting for your WhatsApp confirmation. Please confirm them first (tap “Confirm on WhatsApp”), or contact us.`, {}, { code: 'unconfirmed_limit' });
        }
        if (ipHash && count(' AND card_ip = ?', ipHash) >= UNCONFIRMED_LIMITS.perIp) {
          throw new HttpError(429, 'Several orders from this connection are waiting for their WhatsApp confirmation. Please confirm them first, or contact us.', {}, { code: 'unconfirmed_limit' });
        }
        if (count('') >= shopCap) {
          throw new HttpError(429, 'We’re receiving a lot of orders right now, sorry. Please try again in a little while, or message us on WhatsApp.', {}, { code: 'shop_busy' });
        }
        for (const item of perItem.values()) {
          const held = unconfirmedHeld(item.productId, item.profileId);
          const left = (getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').pluck().get(item.productId, item.profileId) as number | undefined) ?? 0;
          const cap = Math.max(UNCONFIRMED_LIMITS.sizeMin, Math.floor((left + held) * UNCONFIRMED_LIMITS.sizeShare));
          if (held + item.quantity > cap && item.quantity <= left) {
            throw new HttpError(409, 'This piece is very popular right now — please message us on WhatsApp and we’ll reserve it for you.', {}, { code: 'popular_piece' });
          }
        }
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
        if (!profile) throw new HttpError(409, `${product.title}: that ${product.productType === 'simple' ? 'option' : 'bed size'} is no longer offered.`);
        // No colours on the product: none is chosen (a colour sent from an older bag is ignored).
        const color = !product.colors.length ? undefined : line.color && product.colors.some((c2) => c2.name === line.color) ? line.color : product.colors[0]?.name;
        if (product.colors.length && line.color && color !== line.color) throw new HttpError(409, `${product.title}: that colour is no longer offered.`);
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
          // The size's packed weight now (a snapshot: editing the product later does not change this order).
          ...(Number(profile.weightGrams) > 0 ? { weightGrams: Math.round(Number(profile.weightGrams)) } : {}),
          // A simple product's variant (towels, cushions…): its dimensions, as shown when it was bought.
          ...(product.productType === 'simple' ? { productType: 'simple' as const, ...(profile.dimensions ? { dimensions: profile.dimensions } : {}) } : {}),
          // The size's SKU as it was (BUH-…-KING), for packing and the books.
          ...(product.sku ? { sku: shopVariantSku(product, profile.id) } : {}),
        });
      }

      const subtotalFils = items.reduce((s, i) => s + fils(i.totalPrice), 0);
      const codFils = paymentMethod === 'cod' ? fils(COD_FEE) : 0;
      // The card fee: a percent of items + delivery, in whole fils (half up), part of the total Stripe is asked for.
      const cardFeeF = card ? cardFeeFils(subtotalFils + deliveryFils, feePercent) : 0;
      // UAE VAT (Settings → Payments → VAT, off by default): from its effective date. Prices include
      // VAT unless the owner chose otherwise; then 5% of the whole is added on top here.
      const vatPlan = checkoutVat();
      const vatPlanned = vatPlan ? recordableVat(subtotalFils + deliveryFils + codFils + cardFeeF, vatPlan) : 0;
      const totalFils = subtotalFils + deliveryFils + codFils + cardFeeF + vatPlanned;
      // Never charge a total the customer was not shown (a price changed while they were at checkout).
      if (expectedTotalFils !== null && expectedTotalFils !== totalFils) {
        throw new HttpError(409, `Prices have changed since you opened checkout: your total is now AED ${aed(totalFils)}. Please check your bag and confirm again.`, {}, { code: 'price_changed', total: aed(totalFils), ...(card ? { cardFeePercent: feePercent } : {}) });
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
        ...(cardFeeF ? { cardFee: aed(cardFeeF), cardFeePercent: feePercent } : {}),
        ...(vatPlanned ? { vatAdded: aed(vatPlanned) } : {}),
        discount: 0,
        total: aed(totalFils),
        paymentMethod: paymentMethod as Order['paymentMethod'],
        ...(bankMode === 'ask_whatsapp' ? { bankDetailsBy: 'whatsapp' as const } : {}),
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
          // From the sizes' weights and the packaging allowance; 0 (unknown, entered when booking) when a size has none.
          weightKg: Math.min(500, shipmentWeight({ items }, courierSettings.packagingGrams ?? DEFAULT_PACKAGING_GRAMS).kg ?? 0),
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
      // Its VAT breakdown, worked out here and stored once (never for an order placed without VAT).
      if (vatPlan) recordOrderVat(created, vatPlan);
      logEvent(id, 'customer', 'created', { total: created.total, paymentMethod, ...(created.cardFee ? { cardFee: created.cardFee } : {}), ...(created.bankDetailsBy ? { bankDetailsBy: created.bankDetailsBy } : {}) });
      if (ipHash) getDb().prepare('UPDATE orders SET card_ip = ? WHERE id = ?').run(ipHash, id);
      if (card) {
        getDb().prepare("UPDATE orders SET card_state = 'pending' WHERE id = ?").run(id);
        created.card = { state: 'pending' };
      }
      if (askWhatsApp) {
        // 4 random digits, made here (never by the browser); not a secret from the customer.
        const code = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
        const hold = store.holdUntilWhatsAppConfirmed;
        getDb().prepare("UPDATE orders SET wa_code = ?, phone_check = 'awaiting', wa_hold = ?, wa_cancel_at = ?, wa_unopened_cancel_at = ? WHERE id = ?").run(code, hold ? 1 : 0, cancelAt, unopenedAt, id);
        logEvent(id, 'shop', 'whatsapp_asked', { hold, ...(cancelAt ? { [paymentMethod === 'bank_transfer' ? 'flagAt' : 'cancelAt']: cancelAt } : {}), ...(unopenedAt ? { openBy: unopenedAt } : {}) });
      }
      if (callCustomer) {
        setAttention(id, 'call_customer', `No WhatsApp number is set (Settings → Store & contact), so this customer could not confirm on WhatsApp: call them on ${phone} before shipping.`);
        logEvent(id, 'shop', 'call_customer');
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
      // The file lands after the order's commit: the next backup must take it too.
      markChanged('orders');
    } catch (err) {
      logEvent_('error', 'receipt_write_failed', { orderId: order.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  invalidateProducts();
  return { order, created: true };
}

/**
 * The part of a connection's address that names one customer: an IPv4 address as it is; an IPv6
 * address by its /64 (a home or a phone gets a whole /64, and can pick any address in it); an
 * IPv4-mapped IPv6 address as its IPv4 address.
 */
export function connectionKey(ip: string): string {
  const v = ip.trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  if (!net.isIPv6(v)) return v.toLowerCase();
  const [head, tail = ''] = v.split('::');
  const groups = (part: string) => {
    if (!part) return [] as string[];
    return part.split(':').flatMap((g) => {
      if (!net.isIPv4(g)) return [g];
      const [a, b, c, d] = g.split('.').map(Number);
      return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
    });
  };
  const h = groups(head);
  const t = v.includes('::') ? groups(tail) : [];
  const full = v.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Pieces of one product's size held by orders not yet confirmed (inside the caller's transaction). */
function unconfirmedHeld(productId: string, sizeId: string): number {
  return getDb()
    .prepare(
      `SELECT COALESCE(SUM(json_extract(j.value, '$.quantity')), 0) FROM (SELECT data FROM orders WHERE ${UNCONFIRMED_OPEN}) AS o, json_each(o.data, '$.items') AS j
       WHERE json_extract(j.value, '$.productId') = ? AND json_extract(j.value, '$.profileId') = ?`
    )
    .pluck()
    .get(productId, sizeId) as number;
}

/** Orders not yet confirmed (WhatsApp mode), the shop cap that applies, and the last refusal (Settings → System shows it for a day). */
export function unconfirmedPressure(now = Date.now()): { open: number; cap: number; near: boolean; refusedAt: string | null } {
  const open = getDb().prepare(`SELECT COUNT(*) FROM orders WHERE ${UNCONFIRMED_OPEN}`).pluck().get() as number;
  const cap = unconfirmedShopCap();
  const refused = kvGet<{ at: string }>('unconfirmed:refused')?.data;
  return { open, cap, near: open >= Math.ceil(cap * UNCONFIRMED_LIMITS.nearShare), refusedAt: refused && now - Date.parse(refused.at) < 24 * 3600_000 ? refused.at : null };
}

/**
 * After an order no code proved (placed, or refused by the shop cap): at 80% of the cap, or on a
 * refusal, logged and emailed to the owner (each at most every 6 hours). The monitor shows it as
 * a problem while it lasts. Never throws.
 */
function noteUnconfirmedPressure(what: 'placed' | 'refused', cap: number): void {
  try {
    const open = getDb().prepare(`SELECT COUNT(*) FROM orders WHERE ${UNCONFIRMED_OPEN}`).pluck().get() as number;
    if (what === 'placed' && open < Math.ceil(cap * UNCONFIRMED_LIMITS.nearShare)) return;
    const key = what === 'refused' ? 'unconfirmed:refused' : 'unconfirmed:near';
    const last = kvGet<{ at: string; alertedAt?: string }>(key)?.data;
    const now = new Date().toISOString();
    const alert = !last?.alertedAt || Date.now() - Date.parse(last.alertedAt) >= 6 * 3600_000;
    kvSet(key, { at: now, open, cap, alertedAt: alert ? now : last?.alertedAt });
    logEvent_('warn', what === 'refused' ? 'unconfirmed_cap_refused' : 'unconfirmed_cap_near', { open, cap });
    if (!alert) return;
    const subject = what === 'refused' ? 'Orders refused: too many waiting for WhatsApp' : 'Many orders are waiting for WhatsApp';
    const body =
      what === 'refused'
        ? `A customer could not order because ${open} orders are waiting for their WhatsApp confirmation (the cap is ${cap}). They were asked to try again later or message you on WhatsApp.`
        : `${open} orders are waiting for their WhatsApp confirmation (the cap is ${cap}; new ones are refused at ${cap}).`;
    void import('./adminAlerts')
      .then(({ alertOwner }) =>
        alertOwner(subject, `${body}\n\nOpen the Admin Hub → Orders: confirm the real ones (or call them), and cancel any you don't recognise. Many at once from strangers can be someone holding your stock.`)
      )
      .catch(() => undefined);
  } catch (err) {
    logEvent_('warn', 'unconfirmed_pressure_note_failed', { error: err instanceof Error ? err.message : String(err) });
  }
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
  return folderRoomProblem(receiptsDir(), incoming, RECEIPT_LIMITS, 'receipts');
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
    // The file lands after the order's commit: the next backup must take it too.
    markChanged('orders');
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

const OPEN_TRANSFER = "status <> 'cancelled' AND payment_status NOT IN ('verified', 'paid')";

/** Bank transfers with a screenshot waiting for the owner's check. */
export function transfersToCheckCount(): number {
  return getDb().prepare(`SELECT COUNT(*) FROM orders WHERE bank_state = 'uploaded' AND ${OPEN_TRANSFER}`).pluck().get() as number;
}

/** Bank transfers still waiting for the customer (no screenshot yet, or not received). */
export function transfersAwaitedCount(): number {
  return getDb().prepare(`SELECT COUNT(*) FROM orders WHERE bank_state IN ('awaiting', 'not_received') AND ${OPEN_TRANSFER}`).pluck().get() as number;
}

/**
 * Bank-details emails go to whatever address was typed at checkout, so they are limited: at most
 * 3 a day to one address, and 5 a day for orders from one connection (counted from the orders
 * themselves, so a restart or a second copy of the shop doesn't reset them). (Changeable by tests only.)
 */
export const BANK_EMAIL_LIMITS = { perAddress: 3, perConnection: 5, windowMs: 24 * 3600_000 };

/**
 * Claim an order's one bank-details email (two copies of the shop may try at once during an
 * update): 'claimed', 'already' (sent, or being sent), or 'limited' (the address, or the
 * connection, had its share today: the customer still has the private page from checkout).
 */
export function claimBankEmail(id: string): 'claimed' | 'already' | 'limited' {
  return inTransaction(() => {
    const db = getDb();
    const row = db.prepare("SELECT bank_emailed_at, card_ip, lower(json_extract(data, '$.customer.email')) AS email FROM orders WHERE id = ?").get(id) as
      | { bank_emailed_at: string | null; card_ip: string | null; email: string | null }
      | undefined;
    if (!row || row.bank_emailed_at) return 'already';
    const since = new Date(Date.now() - BANK_EMAIL_LIMITS.windowMs).toISOString();
    const sent = (where: string, value: string) =>
      db.prepare(`SELECT COUNT(*) FROM orders WHERE payment_method = 'bank_transfer' AND bank_emailed_at >= ? AND ${where}`).pluck().get(since, value) as number;
    if (row.email && sent("lower(json_extract(data, '$.customer.email')) = ?", row.email) >= BANK_EMAIL_LIMITS.perAddress) return 'limited';
    if (row.card_ip && sent('card_ip = ?', row.card_ip) >= BANK_EMAIL_LIMITS.perConnection) return 'limited';
    return db.prepare('UPDATE orders SET bank_emailed_at = ? WHERE id = ? AND bank_emailed_at IS NULL').run(new Date().toISOString(), id).changes === 1 ? 'claimed' : 'already';
  });
}

/** A bank-details email not sent because of the limits above (noted on the order's history). */
export function bankEmailLimited(id: string): void {
  logEvent(id, 'shop', 'bank_email_limited');
  bump('orders');
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
  // Audited inside the transaction with what changed (before → after), and the owner's "ship
  // anyway": if the log can't be written, nothing is saved (503), so a status or payment change is
  // never done unrecorded, and a rollback can't leave an entry behind unnoted.
  const updated = auditedTransaction((auditFn) => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const changes: Obj = {};
    const notesBefore = order.adminNotes ?? '';

    if (p.status !== undefined && p.status !== order.status) {
      const status = p.status as OrderStatus;
      if (!ORDER_STATUSES.includes(status)) throw new HttpError(400, 'Unknown order status.');
      if (!NEXT[order.status].includes(status)) {
        throw new HttpError(409, `An order that is ${order.status.replace(/_/g, ' ')} cannot become ${status.replace(/_/g, ' ')}.`);
      }
      if (status !== 'cancelled') assertNotHeld(order);
      if (status !== 'cancelled' && unconfirmedCod(order)) {
        // Not confirmed on WhatsApp yet: only with the owner's explicit "ship anyway" (recorded).
        if (p.shipUnconfirmed !== true) throw shipAnywayQuestion(order);
        noteShipAnyway(order, actor, `status:${status}`, auditFn);
      }
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
      const { adminNotes: notesChanged, ...rest } = changes;
      auditFn('order.updated', {
        by: actor,
        orderId: id,
        amountFils: fils(order.total),
        paymentMethod: order.paymentMethod,
        ...rest,
        ...(notesChanged ? { adminNotes: { from: notesBefore.slice(0, 300), to: (order.adminNotes ?? '').slice(0, 300) } } : {}),
      });
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

export type WhatsAppResult = 'confirmed' | 'mismatch' | 'call' | 'use_sender' | 'correct_phone';

/** Why a cancelled or delivered order can't be confirmed (or its number changed) any more. */
function closedOrderProblem(order: Order): HttpError {
  if (order.status === 'delivered') return new HttpError(409, `${order.id} is already delivered: nothing to confirm or change.`, {}, { code: 'order_closed' });
  const auto = (getDb().prepare("SELECT at FROM order_events WHERE order_id = ? AND event IN ('auto_cancelled_unconfirmed', 'auto_cancelled_unopened') ORDER BY id DESC LIMIT 1").pluck().get(order.id) as string | undefined) ?? null;
  const at = auto ? `${new Date(auto).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (UAE)` : '';
  return new HttpError(409, auto ? `Auto-cancelled at ${at} — its pieces are back on sale, so ask the customer to place a new order.` : `${order.id} is cancelled — ask the customer to place a new order.`, {}, { code: 'order_closed' });
}

/** The order's phone becomes `to` (validated), the old number kept in its history; audited. Inside the caller's audited transaction. */
function changeOrderPhone(order: Order, to: string, actor: string, why: string, auditFn: (action: string, details: Record<string, unknown>) => void): void {
  const from = order.customer.phone;
  order.customer.phone = to;
  writeOrder(order);
  getDb().prepare('UPDATE orders SET phone = ? WHERE id = ?').run(to, order.id);
  logEvent(order.id, actor, 'phone_changed', { from, to, ...(why === 'owner_correction' ? { correction: true } : {}) });
  auditFn('order.phone_changed', { by: actor, orderId: order.id, from, to, why });
}

/**
 * The owner's one tap: the customer's WhatsApp message came from the number on the order
 * (confirmed), or from another number (mismatch); "Confirmed by phone call" (call: the owner
 * rang the customer, also for an order that could not be asked on WhatsApp); "Use the number it
 * came from" (use_sender: the order's phone becomes the sender's, validated like checkout's, the
 * old number kept in the order's history, then confirmed); or, once confirmed, "Correct the phone
 * number" (correct_phone: undoes a wrong number, the same way). Idempotent: the same answer again
 * changes nothing. Written to the audit log inside the same transaction, so it is never reported
 * done (or saved) without its audit entry. A mismatch can still be corrected to confirmed. A
 * cancelled (perhaps auto-cancelled: its pieces are back on sale) or delivered order is never
 * confirmed or changed (409). Confirming stops the auto-cancel (Settings → Phone check).
 */
export function checkWhatsApp(id: string, result: WhatsAppResult, actor: string, opts: { phone?: string } = {}): { order: Order; changed: boolean } {
  return auditedTransaction((auditOrThrow) => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    const check = order.whatsappCheck;
    const closed = order.status === 'cancelled' || order.status === 'delivered';
    const at = new Date().toISOString();

    if (result === 'correct_phone') {
      if (closed) throw closedOrderProblem(order);
      if (!opts.phone) throw new HttpError(400, 'Type the correct phone number.');
      const to = validatePhone(opts.phone);
      if (to === order.customer.phone) return { order, changed: false };
      changeOrderPhone(order, to, actor, 'owner_correction', auditOrThrow);
      bump('orders');
      return { order: getOrder(id)!, changed: true };
    }

    if (!check && result !== 'call') throw new HttpError(409, 'This order was not asked to confirm on WhatsApp.');
    if (result === 'mismatch') {
      if (check!.status === 'mismatch') return { order, changed: false };
      if (check!.status === 'confirmed') throw new HttpError(409, `${order.id} is already confirmed.`);
      if (closed) throw closedOrderProblem(order);
      getDb().prepare("UPDATE orders SET phone_check = 'mismatch', phone_checked_at = ?, phone_checked_by = ?, updated_at = ? WHERE id = ?").run(at, actor, at, id);
      logEvent(id, actor, 'whatsapp_mismatch', { from: check!.status });
      auditOrThrow('order.whatsapp_mismatch', { by: actor, orderId: id, from: check!.status, held: check!.hold });
      bump('orders');
      return { order: getOrder(id)!, changed: true };
    }

    // confirmed, call, use_sender: never on an order that is over (the sweep may have cancelled it
    // and put its pieces back on sale).
    if (closed) throw closedOrderProblem(order);
    if (result === 'call' && !check && (order.customer.phoneVerified || order.status !== 'pending_confirmation')) {
      // Only an order still waiting: asked on WhatsApp (awaiting or mismatch), or one no code proved
      // that could not be asked (no shop number: "call the customer").
      throw new HttpError(409, `${order.id} isn't waiting for a confirmation.`);
    }
    if (result === 'use_sender') {
      if (!opts.phone) throw new HttpError(400, 'Type the number the message came from.');
      const to = validatePhone(opts.phone);
      if (check!.status === 'confirmed' && to === order.customer.phone) return { order, changed: false };
      if (check!.status === 'confirmed') throw new HttpError(409, `${order.id} is already confirmed: use “Correct the phone number” to change it.`);
      if (to !== order.customer.phone) changeOrderPhone(order, to, actor, 'whatsapp_sender', auditOrThrow);
    } else if (check?.status === 'confirmed') {
      return { order, changed: false };
    }
    const from = check?.status ?? 'none';
    const method = result === 'call' ? 'call' : 'whatsapp';
    // An order never asked (no shop number) gets its code now, so every version shows it confirmed.
    const code = check?.code ?? String(crypto.randomInt(0, 10_000)).padStart(4, '0');
    getDb()
      .prepare("UPDATE orders SET wa_code = ?, phone_check = 'confirmed', phone_check_method = ?, phone_checked_at = ?, phone_checked_by = ?, updated_at = ? WHERE id = ?")
      .run(code, method, at, actor, at, id);
    if (order.attention?.kind === 'call_customer') getDb().prepare('UPDATE orders SET needs_attention = NULL WHERE id = ?').run(id);
    logEvent(id, actor, method === 'call' ? 'phone_call_confirmed' : 'whatsapp_confirmed', { from, ...(result === 'use_sender' ? { numberChanged: true } : {}) });
    auditOrThrow(method === 'call' ? 'order.phone_call_confirmed' : 'order.whatsapp_confirmed', { by: actor, orderId: id, from, held: Boolean(check?.hold), method });
    bump('orders');
    return { order: getOrder(id)!, changed: true };
  });
}

/**
 * A cash-on-delivery order whose phone no code proved and that is not yet confirmed (on WhatsApp
 * or by phone call). Shipping it takes the owner's explicit "ship anyway" (they may have called).
 */
export function unconfirmedCod(order: Order): boolean {
  return order.paymentMethod === 'cod' && order.status === 'pending_confirmation' && !order.customer.phoneVerified && order.whatsappCheck?.status !== 'confirmed';
}

function shipAnywayQuestion(order: Order): HttpError {
  return new HttpError(409, `This customer hasn't confirmed ${order.id} on WhatsApp yet — ship anyway?`, {}, { code: 'whatsapp_unconfirmed' });
}

/**
 * Inside the caller's audited transaction: the owner chose to ship an unconfirmed order (history
 * and audit, or nothing happens). It also stops the auto-cancel: the owner has decided.
 */
function noteShipAnyway(order: Order, actor: string, via: string, auditFn: (action: string, details: Record<string, unknown>) => void): void {
  getDb().prepare('UPDATE orders SET wa_cancel_at = NULL, wa_unopened_cancel_at = NULL WHERE id = ?').run(order.id);
  logEvent(order.id, actor, 'ship_unconfirmed', { via, check: order.whatsappCheck?.status ?? 'none' });
  auditFn('order.ship_unconfirmed', { by: actor, orderId: order.id, via, check: order.whatsappCheck?.status ?? 'none', autoCancelStopped: Boolean(order.whatsappCheck?.cancelAt || order.whatsappCheck?.openBy) });
}

/**
 * Before a courier is booked (dispatch): an unconfirmed COD order needs `shipUnconfirmed` (the
 * owner's "ship anyway"), recorded in the order's history and the audit log before the booking.
 */
export function assertShipAllowed(orderId: string, actor: string, shipUnconfirmed: boolean): void {
  const order = getOrder(orderId);
  if (!order || !unconfirmedCod(order)) return;
  if (!shipUnconfirmed) throw shipAnywayQuestion(order);
  auditedTransaction((auditFn) => {
    // Read again inside the transaction: the sweep may have cancelled it meanwhile.
    const now = getOrder(orderId);
    if (!now || !unconfirmedCod(now)) {
      if (now?.status === 'cancelled') throw new HttpError(409, `${orderId} was cancelled meanwhile: nothing was booked.`);
      return;
    }
    noteShipAnyway(now, actor, 'courier', auditFn);
  });
  bump('orders');
}

/**
 * Settings → Phone check "WhatsApp (free)": orders still not confirmed when their time is up
 * (wa_cancel_at, set at checkout), or sooner when the customer never even opened WhatsApp
 * (wa_unopened_cancel_at), are cancelled and their pieces put back on sale, exactly once (the
 * order is claimed with one conditional UPDATE, so two copies of the shop can't both do it),
 * audited before it counts. Not cancelled: a confirmed order (WhatsApp or phone call), a paid card
 * order, and a bank transfer: one whose screenshot is uploaded or that is paid is left to the owner
 * (its time is cleared), and one with neither is flagged for the owner ("check your bank, then
 * cancel or confirm"), its pieces still held and its private page still open (14 days). Returns
 * how many were cancelled.
 */
export function sweepUnconfirmedOrders(now = Date.now()): number {
  const nowIso = new Date(now).toISOString();
  const due = getDb()
    .prepare(
      `SELECT id FROM orders WHERE wa_cancel_at IS NOT NULL AND wa_cancel_at <= ? AND phone_check IN ('awaiting', 'mismatch')
       UNION SELECT id FROM orders WHERE wa_unopened_cancel_at IS NOT NULL AND wa_unopened_cancel_at <= ? AND phone_check IN ('awaiting', 'mismatch') AND wa_opened_at IS NULL
       LIMIT 100`
    )
    .pluck()
    .all(nowIso, nowIso) as string[];
  let cancelled = 0;
  let flagged = false;
  for (const id of due) {
    try {
      const done = auditedTransaction((auditOrThrow): 'cancelled' | 'flagged' | false => {
        const r = getDb().prepare('SELECT wa_cancel_at, wa_unopened_cancel_at, wa_opened_at, phone_check FROM orders WHERE id = ?').get(id) as
          | { wa_cancel_at: string | null; wa_unopened_cancel_at: string | null; wa_opened_at: string | null; phone_check: string }
          | undefined;
        if (!r || (r.phone_check !== 'awaiting' && r.phone_check !== 'mismatch')) return false;
        const unopened = Boolean(r.wa_unopened_cancel_at && !r.wa_opened_at && r.wa_unopened_cancel_at <= nowIso);
        const expired = Boolean(r.wa_cancel_at && r.wa_cancel_at <= nowIso);
        if (!unopened && !expired) return false;
        const claimed =
          getDb()
            .prepare("UPDATE orders SET wa_cancel_at = NULL, wa_unopened_cancel_at = NULL WHERE id = ? AND wa_cancel_at IS ? AND wa_unopened_cancel_at IS ? AND phone_check IN ('awaiting', 'mismatch')")
            .run(id, r.wa_cancel_at, r.wa_unopened_cancel_at).changes === 1;
        if (!claimed) return false;
        const order = getOrder(id)!;
        const paidCard = order.card?.state === 'paid' || order.card?.state === 'refund_pending' || order.card?.state === 'refunded';
        const bank = order.paymentMethod === 'bank_transfer';
        const transferIn = bank && (order.bankTransfer?.state === 'uploaded' || order.bankTransfer?.state === 'paid' || order.paymentStatus === 'verified' || order.paymentStatus === 'paid');
        if (order.status !== 'pending_confirmation' || paidCard || transferIn) {
          if (transferIn && order.status === 'pending_confirmation') logEvent(id, 'shop', 'auto_cancel_skipped', { why: 'transfer' });
          return false;
        }
        const dueAt = unopened && !expired ? r.wa_unopened_cancel_at! : r.wa_cancel_at ?? r.wa_unopened_cancel_at!;
        const hours = Math.round((Date.parse(dueAt) - Date.parse(order.createdAt)) / 3600_000);
        if (bank) {
          // Never cancelled for this: the customer may be paying (the private page lasts 14 days).
          setAttention(id, 'bank_unconfirmed', `Bank transfer not confirmed after ${hours} h — check your bank, then cancel or confirm. (Its pieces are still held; the customer's payment page stays open until it is paid or cancelled, 14 days at most.)`);
          logEvent(id, 'shop', 'bank_unconfirmed_flagged', { hours, check: order.whatsappCheck?.status });
          auditOrThrow('order.bank_unconfirmed_flagged', { orderId: id, hours, check: order.whatsappCheck?.status, amountFils: fils(order.total), by: 'shop' });
          return 'flagged';
        }
        releaseStock(order, 'cancelled');
        order.status = 'cancelled';
        writeOrder(order);
        const why = unopened && !expired ? 'whatsapp_never_opened' : 'not_confirmed';
        logEvent(id, 'shop', why === 'whatsapp_never_opened' ? 'auto_cancelled_unopened' : 'auto_cancelled_unconfirmed', { hours, check: order.whatsappCheck?.status });
        auditOrThrow('order.auto_cancelled_unconfirmed', { orderId: id, hours, why, check: order.whatsappCheck?.status, amountFils: fils(order.total), by: 'shop' });
        return 'cancelled';
      });
      if (done === 'cancelled') cancelled++;
      if (done === 'flagged') {
        flagged = true;
        notifyAttention(getOrder(id));
      }
    } catch (err) {
      logEvent_('warn', 'unconfirmed_sweep_order_failed', { orderId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (cancelled) invalidateProducts();
  if (cancelled || flagged) bump('orders');
  return cancelled;
}

let unconfirmedTimer: NodeJS.Timeout | null = null;

/** Start the sweep of unconfirmed orders (every 5 minutes, and once soon after start). Off with UNCONFIRMED_SWEEP_DISABLED=1. */
export function startUnconfirmedSweep(): void {
  if (unconfirmedTimer || process.env.UNCONFIRMED_SWEEP_DISABLED === '1') return;
  const tick = () => {
    try {
      const n = sweepUnconfirmedOrders();
      if (n) logEvent_('info', 'unconfirmed_orders_cancelled', { orders: n });
    } catch (err) {
      logEvent_('warn', 'unconfirmed_sweep_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  };
  setTimeout(tick, 45_000).unref();
  unconfirmedTimer = setInterval(tick, 5 * 60_000);
  unconfirmedTimer.unref();
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
    // A test or practice result never clears what a live attempt left (an unanswered one may exist).
    if (courier.bookingState === undefined) delete courier.bookingState;
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

/** Courier choices for a tracking number typed in by the owner. */
export const HAND_CARRIERS = ['jeebly', 'echo', 'other'] as const;
export type HandCarrier = (typeof HAND_CARRIERS)[number];
const HAND_STATUSES: OrderStatus[] = ['confirmed', 'dispatched', 'out_for_delivery'];
export const AWB_PATTERN = /^[A-Za-z0-9-]{4,40}$/;
const CARRIER_NAME = /^[\p{L}\p{N}][\p{L}\p{N} &.'-]{1,39}$/u;

/**
 * "Enter tracking number": the owner booked in the carrier's own portal (the API is not set up,
 * or another courier) and types the real AWB in. Checked here: the order's status, the AWB, the
 * courier, and an https link already vetted by the route (assertPublicHttpsUrl). A real booking
 * already on the order is replaced only with `replace` (the owner's confirm). Written to the audit
 * log before it counts; the customer's Track Order then shows it.
 */
export function enterTracking(
  id: string,
  actor: string,
  input: { carrier: HandCarrier; carrierName?: string; awb: string; trackingUrl?: string; replace?: boolean }
): Order {
  if (!HAND_CARRIERS.includes(input.carrier)) throw new HttpError(400, 'Choose Jeebly, Eco Express or another courier.');
  const awb = String(input.awb ?? '').trim();
  if (!AWB_PATTERN.test(awb)) throw new HttpError(400, 'The tracking number is 4 to 40 letters, digits or dashes.');
  const carrierName = input.carrier === 'other' ? String(input.carrierName ?? '').trim() : '';
  if (input.carrier === 'other' && !CARRIER_NAME.test(carrierName)) throw new HttpError(400, "Type the courier's name (2 to 40 letters).");
  const trackingUrl = String(input.trackingUrl ?? '').trim();
  if (trackingUrl && (!trackingUrl.startsWith('https://') || trackingUrl.length > 500)) throw new HttpError(400, 'The tracking link must start with https://.');

  const saved = auditedTransaction((auditFn) => {
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    if (!HAND_STATUSES.includes(order.status)) {
      throw new HttpError(409, `A tracking number can be entered for a confirmed, dispatched or out-for-delivery order; ${order.id} is ${order.status.replace(/_/g, ' ')}.`);
    }
    const before = order.courier;
    const hadReal = before.bookingState === 'booked' && !before.simulated && Boolean(before.awbNumber);
    if (hadReal && before.awbNumber === awb && (before.trackingUrl || '') === trackingUrl && (before.carrierName || '') === carrierName) return order; // the same entry twice
    if (hadReal && input.replace !== true) {
      const name = before.provider === 'manual' ? before.carrierName || 'a courier' : before.provider === 'jeebly' ? 'Jeebly' : 'Eco Express';
      throw new HttpError(
        409,
        `${order.id} is already booked with ${name} (AWB ${before.awbNumber}). Replace it with ${awb}? Cancel the old booking with the courier if it is not used.`,
        {},
        { code: 'tracking_replace', needsReplaceConfirm: true, current: before.awbNumber }
      );
    }
    const provider = input.carrier === 'other' ? 'manual' : input.carrier;
    order.courier = {
      ...before,
      provider,
      carrierName,
      awbNumber: awb,
      trackingUrl,
      // A Jeebly AWB from Jeebly's portal is a live shipment: its label, tracking and cancel work through the API.
      carrierEnv: provider === 'jeebly' ? 'live' : undefined,
      status: 'Booked with the carrier (entered by hand)',
      bookingState: 'booked',
      simulated: false,
      testKind: undefined,
      enteredByHand: true,
      labelGenerated: true,
      dispatchedAt: before.dispatchedAt || new Date().toISOString(),
    };
    auditFn(hadReal ? 'order.tracking_replaced' : 'order.tracking_entered', {
      by: actor,
      orderId: id,
      provider,
      ...(carrierName ? { carrierName } : {}),
      awb,
      link: Boolean(trackingUrl),
      ...(hadReal ? { replaced: before.awbNumber } : {}),
      ...(before.simulated && before.awbNumber ? { replacedTest: before.awbNumber } : {}),
    });
    writeOrder(order);
    logEvent(id, actor, 'tracking_entered', { provider, awb, ...(hadReal ? { replaced: before.awbNumber } : {}) });
    return getOrder(id)!;
  });
  bump('orders');
  return saved;
}

/**
 * The carrier's answer to cancelling a booking (src/lib/server/jeeblyOps.ts, audited there first): on
 * the order's courier status and history. A real booking Jeebly did not cancel flags the order for
 * the owner (cancel it in the portal).
 */
export function noteCarrierCancel(id: string, actor: string, cancelled: boolean, message: string): void {
  let flagged = false as boolean;
  inTransaction(() => {
    const order = getOrder(id);
    if (!order) return;
    order.courier.status = cancelled ? 'Cancelled with the carrier' : 'Not cancelled with the carrier – cancel it in the portal';
    const uncertain = order.courier.bookingState === 'uncertain';
    if (cancelled) order.courier.bookingState = undefined;
    writeOrder(order);
    logEvent(id, actor, 'carrier_cancel', { cancelled, awb: order.courier.awbNumber });
    // Jeebly confirmed the cancel: a "booked after it was cancelled" flag has nothing left to do.
    if (cancelled && order.attention?.kind === 'booked_after_cancel') getDb().prepare('UPDATE orders SET needs_attention = NULL WHERE id = ?').run(id);
    if (!cancelled && (!order.courier.simulated || uncertain)) {
      setAttention(id, 'booked_after_cancel', message.slice(0, 400));
      flagged = true;
    }
  });
  if (flagged) notifyAttention(getOrder(id));
  else bump('orders');
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
  // Best effort: nothing is paid yet (payment.paid is audited before it counts).
  audit('payment.card_started', { orderId: id, ref, ...(livemode === undefined ? {} : { mode: livemode ? 'live' : 'test' }) });
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
    auditOrThrow('payment.card_declined', { orderId, ref: pi.id, via: actor, ...(pi.declineCode ? { declineCode: pi.declineCode.slice(0, 40) } : {}), ...(event ? { event: event.id } : {}) });
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

// ── The refunds ledger ──────────────────────────────────────────────────────

export interface RefundRow {
  orderId: string;
  /** Fils; negative when a refund failed afterwards (the money came back to the shop). */
  amountFils: number;
  at: string;
  source: 'stripe' | 'hub';
  stripeRefundId: string | null;
  /** Filled in from an order refunded before the ledger existed: the date is the best known one. */
  dateApprox: boolean;
}

/**
 * Bring the refunds ledger (card_refunds) to `totalFils` refunded so far for this order: one row
 * for the difference, dated now (a negative one when a refund failed). Called in the transaction
 * that changes the order's refunded amount, so the two always agree. A Stripe refund id is kept
 * once per direction (a refund, and its reversal if it failed).
 */
function ledgerRefund(orderId: string, totalFils: number, source: RefundRow['source'], refundId?: string | null): number {
  const db = getDb();
  const sum = db.prepare('SELECT COALESCE(SUM(amount_fils), 0) FROM card_refunds WHERE order_id = ?').pluck().get(orderId) as number;
  const delta = totalFils - sum;
  if (!delta) return 0;
  let id = refundId ?? null;
  if (id && db.prepare(`SELECT 1 FROM card_refunds WHERE stripe_refund_id = ? AND amount_fils ${delta > 0 ? '>' : '<'} 0`).get(id)) id = null;
  db.prepare('INSERT INTO card_refunds (order_id, amount_fils, at, source, stripe_refund_id) VALUES (?, ?, ?, ?, ?)').run(orderId, delta, new Date().toISOString(), source, id);
  // A credit note for it (or a negative one for a refund that failed), when the order has a tax invoice.
  syncVatDocumentsQuietly(orderId);
  return delta;
}

const LEDGER_GAPS = `
  SELECT o.id, o.refunded_at, o.updated_at,
    CASE WHEN o.card_state = 'refunded' THEN COALESCE(o.refunded_fils, o.paid_fils, 0) ELSE COALESCE(o.refunded_fils, 0) END AS want,
    COALESCE((SELECT SUM(r.amount_fils) FROM card_refunds r WHERE r.order_id = o.id), 0) AS have
  FROM orders o
  WHERE o.payment_method = 'online_card' AND (o.refunded_fils IS NOT NULL OR o.card_state = 'refunded' OR EXISTS (SELECT 1 FROM card_refunds r WHERE r.order_id = o.id))`;

/**
 * Orders refunded before the ledger existed (or by an older version during an update's overlap):
 * one row each for what the ledger is missing, dated when the order says it was refunded (or last
 * changed), marked approximate. Idempotent: an order whose ledger already adds up is left alone.
 */
export function backfillRefundLedger(): number {
  type Gap = { id: string; refunded_at: string | null; updated_at: string; want: number; have: number };
  const gaps = () => (getDb().prepare(LEDGER_GAPS).all() as Gap[]).filter((g) => g.want !== g.have);
  if (!gaps().length) return 0;
  const added = inTransaction(() => {
    const insert = getDb().prepare("INSERT INTO card_refunds (order_id, amount_fils, at, source, date_approx) VALUES (?, ?, ?, 'stripe', 1)");
    const found = gaps();
    for (const g of found) insert.run(g.id, g.want - g.have, g.refunded_at || g.updated_at);
    return found.length;
  });
  if (added) logEvent_('info', 'refund_ledger_filled_in', { orders: added });
  return added;
}

/** Every row of the refunds ledger, oldest first. */
export function refundLedger(): RefundRow[] {
  return (getDb().prepare('SELECT order_id, amount_fils, at, source, stripe_refund_id, date_approx FROM card_refunds ORDER BY at, id').all() as Array<{ order_id: string; amount_fils: number; at: string; source: RefundRow['source']; stripe_refund_id: string | null; date_approx: number }>).map((r) => ({
    orderId: r.order_id,
    amountFils: r.amount_fils,
    at: r.at,
    source: r.source,
    stripeRefundId: r.stripe_refund_id,
    dateApprox: r.date_approx === 1,
  }));
}

/** Stripe says how much of the charge is refunded so far (e.g. a partial refund in its dashboard): noted. */
export function noteRefundedSoFar(orderId: string, refundedFils: number): void {
  // Money back to a customer is in the audit log before it is on the order (or neither is), and a
  // commit that fails after the entry is written gets its "rolled back" entry.
  const changed = auditedTransaction((auditOrThrow) => {
    const before = getDb().prepare('SELECT refunded_fils FROM orders WHERE id = ?').pluck().get(orderId) as number | null | undefined;
    if (getDb().prepare('UPDATE orders SET refunded_fils = ? WHERE id = ? AND COALESCE(refunded_fils, 0) <> ?').run(refundedFils, orderId, refundedFils).changes !== 1) return false;
    ledgerRefund(orderId, refundedFils, 'stripe');
    auditOrThrow('payment.refunded_so_far', { orderId, fromFils: before ?? 0, toFils: refundedFils, via: 'stripe' });
    return true;
  });
  if (changed) bump('orders');
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
    // In the ledger once Stripe says the money went back (a pending one when its webhook says so).
    ledgerRefund(orderId, done ? paidFils : paidFils - left, done ? 'hub' : 'stripe', done ? refund.id : null);
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

/** A real (or unanswered) Jeebly booking that cancelling the order must cancel with Jeebly too. */
export function jeeblyToCancel(order: Order): boolean {
  const c = order.courier;
  return c.provider === 'jeebly' && ((c.bookingState === 'booked' && Boolean(c.awbNumber) && !c.simulated) || c.bookingState === 'uncertain');
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
      if (order.card.state === 'paid' && fils(order.card.refundedAmount ?? 0) !== charge.amountRefunded) {
        getDb().prepare('UPDATE orders SET refunded_fils = ? WHERE id = ?').run(charge.amountRefunded, order.id);
        ledgerRefund(order.id, charge.amountRefunded, 'stripe', charge.refundId);
        auditOrThrow('payment.refunded_so_far', { orderId: order.id, ref, fromFils: fils(order.card.refundedAmount ?? 0), toFils: charge.amountRefunded, via: actor, ...(event ? { event: event.id } : {}) });
      }
      logEvent(order.id, actor, 'card_partly_refunded', { amount: aed(charge.amountRefunded) });
      return 'partial';
    }
    getDb()
      .prepare("UPDATE orders SET card_state = 'refunded', refunded_at = ?, refunded_fils = ?, refund_ref = COALESCE(refund_ref, ?) WHERE id = ? AND card_state IN ('paid', 'refund_pending')")
      .run(new Date().toISOString(), charge.amountRefunded, charge.refundId ?? null, order.id);
    // The hub's own refund (pending until now), or one made in Stripe's dashboard.
    ledgerRefund(order.id, charge.amountRefunded, order.card.refundRef ? 'hub' : 'stripe', order.card.refundRef ?? charge.refundId);
    // Refunded in full (also from Stripe's dashboard): the order is cancelled, its pieces back on
    // sale if they never left, exactly once (a cancelled or delivered order stays as it is).
    if (order.status !== 'cancelled' && order.status !== 'delivered') {
      releaseStock(order, 'cancelled');
      order.status = 'cancelled';
      writeOrder(order);
      // Its Jeebly booking is cancelled with Jeebly next (once Stripe is answered: the webhook
      // route), flagged until Jeebly confirms, so a cancel that never runs is not missed.
      if (jeeblyToCancel(order)) {
        setAttention(order.id, 'booked_after_cancel', `Refunded in Stripe, so the order was cancelled: its Jeebly booking${order.courier.awbNumber ? ` (AWB ${order.courier.awbNumber})` : ''} is being cancelled with Jeebly. If this note stays, check the Jeebly portal for reference ${order.id} and cancel it there.`);
      }
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
    // A refund already booked comes off again, on the day it failed (a negative row).
    ledgerRefund(order.id, stillRefunded, 'stripe', refund.id);
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
  // Refunds by the day the money went back (the ledger: partial ones too, less any that failed).
  const refunded = db.prepare('SELECT COUNT(DISTINCT CASE WHEN amount_fils > 0 THEN order_id END) AS n, COALESCE(SUM(amount_fils), 0) AS f FROM card_refunds WHERE at >= ? AND at < ?').get(from, to) as { n: number; f: number };
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
    // The printable receipt (a tax invoice once VAT is on and it is issued): the customer's own private link.
    documentPath: documentPath(order.id),
    documentLabel: orderVat(order.id) ? 'Tax invoice' : 'Receipt',
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
  return { status: check.status, code: check.code, hold: check.hold, ...(check.cancelAt ? { cancelAt: check.cancelAt } : {}), ...(check.openBy ? { openBy: check.openBy } : {}) };
}

function trackingView(order: Order) {
  const c = order.courier;
  // Only a real booking reaches the customer: a test (sandbox or practice) AWB is not a shipment.
  const real = !c.simulated && c.bookingState !== 'uncertain' && Boolean(c.awbNumber);
  return {
    awbNumber: real ? c.awbNumber : '',
    trackingUrl: real ? c.trackingUrl : '',
    // The courier's name is not shown to customers (the tracking link is enough), except with a
    // link the owner typed in themselves (another courier's page needs its name).
    ...(real && c.enteredByHand && c.trackingUrl ? { carrier: c.provider === 'manual' ? c.carrierName || '' : c.provider === 'jeebly' ? 'Jeebly' : 'Eco Express' } : {}),
    status: real ? (order.status === 'delivered' ? 'Delivered' : 'Booked with the courier') : CUSTOMER_STATUS[order.status],
    dispatchedAt: c.dispatchedAt,
    deliveredAt: c.deliveredAt,
  };
}

/** What Track Order says about delivery while there is no real tracking number. */
const CUSTOMER_STATUS: Record<OrderStatus, string> = {
  pending_payment: 'Waiting for payment',
  pending_confirmation: 'Order placed – awaiting confirmation',
  confirmed: 'Confirmed – being prepared for delivery',
  dispatched: 'With our delivery team',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/**
 * Track Order: needs both the order number and the phone number on it (the one on it now, or one
 * it had before the owner changed it: "Use the number it came from", a correction). Shows status
 * and delivery only: no address, email or full name.
 */
export function lookupOrder(id: string, phone: string) {
  const order = getOrder(id.trim().toUpperCase());
  if (!order) return null;
  if (order.customer.phone !== phone && !hadPhone(order.id, phone)) return null;
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
    items: order.items.map((i) => ({ title: i.title, image: i.image, profileName: i.profileName, ...(i.dimensions ? { dimensions: i.dimensions } : {}), color: i.color, quantity: i.quantity, totalPrice: i.totalPrice })),
    courier: trackingView(order),
    ...(order.whatsappCheck ? { whatsappCheck: whatsAppView(order.whatsappCheck) } : {}),
    ...(order.card ? { card: cardView(order.card) } : {}),
    ...(order.bankTransfer ? { bankTransfer: bankView(order.bankTransfer) } : {}),
  };
}

/** The number was on the order before the owner changed it (its phone_changed history). */
function hadPhone(orderId: string, phone: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM order_events WHERE order_id = ? AND event = 'phone_changed' AND (json_extract(detail, '$.from') = ? OR json_extract(detail, '$.to') = ?) LIMIT 1")
      .get(orderId, phone, phone)
  );
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
