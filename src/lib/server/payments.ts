import Stripe from 'stripe';
import { HttpError } from './http';
import { logEvent } from './log';
import { audit } from './audit';
import {
  CARD_PAYMENT_TTL_MS,
  cancelCardOrder,
  cardSecretMatches,
  getOrder,
  markCardFailed,
  markCardPaid,
  markCardRefunded,
  recordCardIntent,
  recordCardRefund,
  setCardLabel,
  unpaidCardOrders,
  type CardOutcome,
  type IntentFacts,
  type StripeEventRef,
} from './orders';
import { appUrl } from './runtimeConfig';
import { getSettings, stripeMode } from './settings';
import type { Order } from '@/types';

/**
 * Card payments (with Apple Pay, Google Pay and Link) through the owner's Stripe account.
 *
 * - The amount is the order's total, worked out on the server from the catalogue (orders.ts), in
 *   fils, AED. The browser never says what it pays: it only confirms the PaymentIntent made here.
 * - One order, one PaymentIntent: created with the idempotency key `order:<id>`, so a retried
 *   request gets the same intent back; refunds use `refund:<id>`.
 * - An order is marked paid only on Stripe's word: the signed webhook (payment_intent.succeeded),
 *   or this server retrieving the PaymentIntent from Stripe when the customer comes back. Never
 *   on the browser's say-so. Amount, currency and order id must match.
 * - An unpaid card order holds its pieces for CARD_PAYMENT_TTL_MS. Then (or when Stripe cancels the
 *   payment, or the customer leaves checkout) the payment is stopped at Stripe first and the order
 *   cancelled, its stock released exactly once.
 * - Card numbers never reach this server: Stripe's own fields (in Stripe's frames) take them.
 *
 * Calls go to Stripe's fixed API through the official library (no address a person can choose).
 */

const API_VERSION: Stripe.LatestApiVersion = '2025-08-27.basil';
const METHOD_TYPES = ['card', 'link'];
/** Stripe's webhook bodies are a few KB; anything bigger is refused before it is read. */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

const fils = (aed: number) => Math.round(aed * 100);

/**
 * Tests only: BUH_TEST_STRIPE_API=http://127.0.0.1:<port> points the library at a stand-in on the
 * same machine. Anything other than a plain-http loopback address is ignored, so a shipped server
 * can't be pointed anywhere else with it.
 */
function testApi(): { host: string; port: number; protocol: 'http' } | null {
  const v = process.env.BUH_TEST_STRIPE_API;
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port && u.pathname === '/' && !u.search) {
      return { host: u.hostname, port: Number(u.port), protocol: 'http' };
    }
  } catch {
    // ignored below
  }
  logEvent('warn', 'stripe_test_api_ignored', {});
  return null;
}

let cached: { key: string; client: Stripe } | null = null;

/** The Stripe client for a secret key (the saved one by default). */
export function stripeClient(key = getSettings('payments').stripeSecretKey): Stripe {
  if (!key) throw new HttpError(503, 'Card payment is not available right now. Please choose Cash on Delivery.', {}, { code: 'card_unavailable' });
  if (cached?.key === key) return cached.client;
  const client = new Stripe(key, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 20_000, telemetry: false, ...(testApi() ?? {}) });
  cached = { key, client };
  return client;
}

/** Stripe's error, in a line that is safe to log (type and code; the library's message has no keys). */
function stripeError(err: unknown): Record<string, unknown> {
  const e = err as { type?: string; code?: string; statusCode?: number; message?: string };
  return { type: e?.type, code: e?.code, status: e?.statusCode, error: e?.message?.slice(0, 200) };
}

const WALLETS: Record<string, string> = { apple_pay: 'Apple Pay', google_pay: 'Google Pay', link: 'Link', samsung_pay: 'Samsung Pay' };
const BRANDS: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };

/** "Apple Pay · Visa •••• 4242", from the charge Stripe made (no card number: Stripe only gives the last 4). */
export function paymentLabel(charge: Stripe.Charge | string | null | undefined): string {
  if (!charge || typeof charge === 'string') return '';
  const d = charge.payment_method_details;
  if (!d) return '';
  if (d.type === 'card' && d.card) {
    const wallet = d.card.wallet?.type ? WALLETS[d.card.wallet.type] ?? '' : '';
    const brand = BRANDS[d.card.brand ?? ''] ?? (d.card.brand ? d.card.brand[0].toUpperCase() + d.card.brand.slice(1) : 'Card');
    const last4 = /^\d{4}$/.test(d.card.last4 ?? '') ? ` •••• ${d.card.last4}` : '';
    return [wallet, `${brand}${last4}`].filter(Boolean).join(' · ');
  }
  if (d.type === 'link') return 'Link';
  return '';
}

function facts(pi: Stripe.PaymentIntent): IntentFacts {
  return { id: pi.id, amount: pi.amount_received || pi.amount, currency: pi.currency, orderId: pi.metadata?.orderId, label: paymentLabel(pi.latest_charge as Stripe.Charge | string | null) };
}

async function retrieveIntent(client: Stripe, ref: string): Promise<Stripe.PaymentIntent> {
  return client.paymentIntents.retrieve(ref, { expand: ['latest_charge'] });
}

// ── Checkout ────────────────────────────────────────────────────────────────

/**
 * The PaymentIntent for a card order just placed (or placed before, on a retry): its client secret
 * goes back to the paying browser, nothing else. The order's amount, never the browser's.
 */
export async function startCardPayment(orderId: string): Promise<{ clientSecret: string }> {
  const order = getOrder(orderId);
  if (!order?.card || (order.card.state !== 'pending' && order.card.state !== 'failed')) {
    throw new HttpError(409, 'This card payment can no longer be started. Please start checkout again.', {}, { code: 'card_closed' });
  }
  const client = stripeClient();
  const amount = fils(order.total);
  let pi: Stripe.PaymentIntent;
  try {
    pi = order.card.ref
      ? await client.paymentIntents.retrieve(order.card.ref)
      : await client.paymentIntents.create(
          {
            amount,
            currency: 'aed',
            payment_method_types: METHOD_TYPES,
            metadata: { orderId: order.id },
            description: `Order ${order.id}`,
            shipping: {
              name: order.customer.fullName,
              phone: order.customer.phone,
              address: { line1: order.customer.streetAddress, line2: `${order.customer.buildingVilla}, ${order.customer.flatVillaNo}`, city: order.customer.area, state: order.customer.emirate, country: 'AE' },
            },
          },
          { idempotencyKey: `order:${order.id}` }
        );
  } catch (err) {
    logEvent('warn', 'stripe_intent_failed', { orderId: order.id, ...stripeError(err) });
    throw new HttpError(502, 'Card payment could not be started. Nothing was charged. Please try again, or choose Cash on Delivery.', {}, { code: 'card_start_failed' });
  }
  if (pi.amount !== amount || pi.currency !== 'aed' || pi.metadata?.orderId !== order.id || !pi.client_secret) {
    logEvent('error', 'stripe_intent_mismatch', { orderId: order.id, ref: pi.id });
    throw new HttpError(502, 'Card payment could not be started. Nothing was charged. Please choose Cash on Delivery.', {}, { code: 'card_start_failed' });
  }
  recordCardIntent(order.id, pi.id, pi.client_secret);
  return { clientSecret: pi.client_secret };
}

/**
 * A card order that could not get its PaymentIntent (Stripe unreachable): no client secret ever
 * left the server, so nobody can pay it. Cancelled at once, so its pieces don't wait 30 minutes.
 */
export function abandonUnstarted(orderId: string): void {
  const order = getOrder(orderId);
  if (order?.card && !order.card.ref) cancelCardOrder(orderId, 'shop', 'card payment could not be started');
}

/** What the customer's screen shows: paid (with how), still being confirmed, or over. */
export interface CardStatusView {
  status: Order['status'];
  card: { state: string; label?: string };
}

function statusView(order: Order): CardStatusView {
  return { status: order.status, card: { state: order.card!.state, ...(order.card!.label ? { label: order.card!.label } : {}) } };
}

/**
 * The paying browser asks about its own order (it proves that with the client secret it holds).
 * While unpaid, the server asks Stripe itself: the browser's "it worked" is never taken as paid.
 */
export async function checkCardPayment(orderId: string, clientSecret: unknown): Promise<CardStatusView> {
  if (!cardSecretMatches(orderId, clientSecret)) throw new HttpError(404, 'No card payment matches.');
  let order = getOrder(orderId)!;
  if ((order.card?.state === 'pending' || order.card?.state === 'failed') && order.card.ref) {
    try {
      const pi = await retrieveIntent(stripeClient(), order.card.ref);
      applyIntent(order.id, pi, 'stripe-check');
    } catch (err) {
      // Not reachable now: the webhook (or the next check) will tell.
      logEvent('warn', 'stripe_check_failed', { orderId, ...stripeError(err) });
    }
    order = getOrder(orderId)!;
  }
  return statusView(order);
}

/** Apply what Stripe says the PaymentIntent's state is (from retrieving it, not from a browser). */
function applyIntent(orderId: string, pi: Stripe.PaymentIntent, actor: string): CardOutcome {
  if (pi.status === 'succeeded') return markCardPaid(orderId, facts(pi), actor);
  if (pi.status === 'canceled') return cancelCardOrder(orderId, actor, 'canceled at Stripe');
  if (pi.status === 'requires_payment_method' && pi.last_payment_error) return markCardFailed(orderId, { id: pi.id, declineCode: pi.last_payment_error.decline_code || pi.last_payment_error.code }, actor);
  return 'ignored';
}

/**
 * Stop an unpaid card payment at Stripe, then cancel the order (stock back) — unless Stripe says it
 * was paid meanwhile, which is then recorded instead. Leaves it alone while Stripe is still
 * processing it or can't be reached (the next sweep tries again).
 */
async function stopCardPayment(orderId: string, actor: string, reason: string): Promise<CardOutcome> {
  const order = getOrder(orderId);
  if (!order?.card || (order.card.state !== 'pending' && order.card.state !== 'failed')) return 'ignored';
  if (!order.card.ref) return cancelCardOrder(orderId, actor, reason);
  const client = stripeClient();
  try {
    const pi = await client.paymentIntents.cancel(order.card.ref);
    if (pi.status === 'canceled') return cancelCardOrder(orderId, actor, reason);
    return applyIntent(orderId, pi, actor);
  } catch (err) {
    // Already paid, already cancelled or processing: Stripe refuses the cancel. Ask it what is true.
    try {
      const pi = await retrieveIntent(client, order.card.ref);
      if (pi.status === 'canceled') return cancelCardOrder(orderId, actor, reason);
      return applyIntent(orderId, pi, actor);
    } catch {
      logEvent('warn', 'stripe_cancel_failed', { orderId, ...stripeError(err) });
      throw new HttpError(502, 'Stripe could not be reached to stop the payment. Please try again in a minute.');
    }
  }
}

/** The customer left card checkout (switched to cash, or closed it): stop the payment and free the pieces. */
export async function abandonCardPayment(orderId: string, clientSecret: unknown): Promise<CardStatusView> {
  if (!cardSecretMatches(orderId, clientSecret)) throw new HttpError(404, 'No card payment matches.');
  await stopCardPayment(orderId, 'customer', 'left card checkout');
  return statusView(getOrder(orderId)!);
}

/** The owner cancels an unpaid card order in the hub. */
export async function cancelUnpaidCardOrder(orderId: string, actor: string): Promise<Order> {
  const outcome = await stopCardPayment(orderId, actor, 'cancelled by the owner');
  const order = getOrder(orderId)!;
  if (outcome === 'paid' || order.card?.state === 'paid') {
    throw new HttpError(409, `${orderId} has just been paid by card. Refresh: cancel it with “Cancel & refund” if you still want to.`, {}, { code: 'card_paid' });
  }
  if (order.status !== 'cancelled') throw new HttpError(409, 'Stripe is still processing this payment. Try again in a minute.');
  return order;
}

/** Every few minutes: card orders unpaid for 30 minutes are stopped at Stripe and cancelled. */
export async function sweepCardOrders(now = Date.now()): Promise<number> {
  let cancelled = 0;
  for (const { id } of unpaidCardOrders(new Date(now - CARD_PAYMENT_TTL_MS).toISOString())) {
    try {
      if ((await stopCardPayment(id, 'shop', 'not paid within 30 minutes')) === 'cancelled') cancelled++;
    } catch (err) {
      logEvent('warn', 'card_sweep_order_failed', { orderId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return cancelled;
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Start the sweep (every 2 minutes). Off with CARD_SWEEP_DISABLED=1. */
export function startCardSweep() {
  if (sweepTimer || process.env.CARD_SWEEP_DISABLED === '1') return;
  const tick = () =>
    void sweepCardOrders().catch((err) => logEvent('warn', 'card_sweep_failed', { error: err instanceof Error ? err.message : String(err) }));
  setTimeout(tick, 30_000).unref();
  sweepTimer = setInterval(tick, 2 * 60_000);
  sweepTimer.unref();
}

// ── Refunds (owner) ─────────────────────────────────────────────────────────

/**
 * "Cancel & refund AED X": a full refund of the card payment, once (idempotency key refund:<id>).
 * The request is audited before it goes to Stripe; the result is recorded from Stripe's answer
 * (refunded, or pending until its charge.refunded webhook), and the order is cancelled.
 */
export async function refundCardOrder(orderId: string, actor: string): Promise<{ order: Order; outcome: CardOutcome }> {
  const order = getOrder(orderId);
  if (!order) throw new HttpError(404, 'Order not found.');
  if (order.paymentMethod !== 'online_card' || !order.card?.ref) throw new HttpError(409, 'This order was not paid by card.');
  if (order.card.state === 'refunded') return { order, outcome: 'already' };
  if (order.card.state !== 'paid' && order.card.state !== 'refund_pending') throw new HttpError(409, 'Only a paid card order can be refunded.');
  if (order.status === 'delivered') throw new HttpError(409, 'This order was delivered: refund it from your Stripe dashboard if the parcel comes back (the order will show it).');
  if (!audit('payment.refund_requested', { orderId, ref: order.card.ref, amountFils: fils(order.card.paidAmount ?? order.total), by: actor })) {
    throw new HttpError(503, 'The audit log could not be written, so nothing was refunded. Please try again.');
  }
  let refund: Stripe.Refund;
  try {
    refund = await stripeClient().refunds.create({ payment_intent: order.card.ref, reason: 'requested_by_customer', metadata: { orderId } }, { idempotencyKey: `refund:${orderId}` });
  } catch (err) {
    logEvent('warn', 'stripe_refund_failed', { orderId, ...stripeError(err) });
    throw new HttpError(502, 'Stripe did not take the refund, so nothing changed. Please try again, or refund it in your Stripe dashboard.');
  }
  if (refund.status === 'failed' || refund.status === 'canceled') {
    logEvent('warn', 'stripe_refund_refused', { orderId, refund: refund.id, status: refund.status });
    throw new HttpError(502, `Stripe could not refund this payment (${refund.status}). Check it in your Stripe dashboard.`);
  }
  return recordCardRefund(orderId, { id: refund.id, status: refund.status ?? 'pending', amount: refund.amount }, actor);
}

// ── The webhook ─────────────────────────────────────────────────────────────

/** Every refused webhook gets this same answer: nothing tells a prober which check failed. */
export const WEBHOOK_REFUSED = 'Invalid request.';

/**
 * A webhook from Stripe: the signature over the raw body (with the saved signing secret) must
 * check out, or nothing happens. Each event id is applied once. A paid event must match the
 * order's intent, amount and currency. Returns what happened (for the log; Stripe only needs 200).
 */
export function handleStripeWebhook(raw: Buffer, signature: string | null): { type: string; outcome: CardOutcome } {
  const secret = getSettings('payments').stripeWebhookSecret;
  if (!secret || !signature || signature.length > 2000) throw new HttpError(400, WEBHOOK_REFUSED);
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(raw, signature, secret);
  } catch {
    throw new HttpError(400, WEBHOOK_REFUSED);
  }
  const ref: StripeEventRef = { id: event.id, type: event.type };
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      const orderId = pi.metadata?.orderId;
      if (!orderId) return { type: event.type, outcome: 'unknown' };
      // The label (wallet, brand, last 4) needs the charge; the event carries only its id.
      return { type: event.type, outcome: markCardPaid(orderId, facts(pi), 'stripe', ref) };
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      if (!pi.metadata?.orderId) return { type: event.type, outcome: 'unknown' };
      return { type: event.type, outcome: markCardFailed(pi.metadata.orderId, { id: pi.id, declineCode: pi.last_payment_error?.decline_code || pi.last_payment_error?.code }, 'stripe', ref) };
    }
    case 'payment_intent.canceled': {
      const pi = event.data.object;
      const orderId = pi.metadata?.orderId;
      const order = orderId ? getOrder(orderId) : undefined;
      if (!order || order.card?.ref !== pi.id) return { type: event.type, outcome: 'unknown' };
      return { type: event.type, outcome: cancelCardOrder(order.id, 'stripe', 'canceled at Stripe', ref) };
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (!pi) return { type: event.type, outcome: 'unknown' };
      return { type: event.type, outcome: markCardRefunded(pi, { amount: charge.amount, amountRefunded: charge.amount_refunded, refundId: charge.refunds?.data?.[0]?.id }, 'stripe', ref) };
    }
    default:
      return { type: event.type, outcome: 'ignored' };
  }
}

/** After a paid webhook: fetch how it was paid ("Apple Pay · Visa •••• 4242") for the hub. Best effort. */
export async function fillPaymentLabel(orderId: string): Promise<void> {
  const order = getOrder(orderId);
  if (!order?.card?.ref || order.card.label || order.card.state !== 'paid') return;
  try {
    const label = paymentLabel((await retrieveIntent(stripeClient(), order.card.ref)).latest_charge as Stripe.Charge | null);
    if (label) setCardLabel(orderId, label);
  } catch (err) {
    logEvent('warn', 'stripe_label_failed', { orderId, ...stripeError(err) });
  }
}

// ── Settings → Payments (owner) ─────────────────────────────────────────────

/** "Check the connection": the account behind the secret key (typed now, or saved). */
export async function checkStripeAccount(typedKey?: string): Promise<{ mode: 'test' | 'live' | null; name: string; chargesEnabled: boolean; country: string; email: string }> {
  const key = typedKey || getSettings('payments').stripeSecretKey;
  if (!key) throw new HttpError(400, 'Type the secret key (or save it) first.');
  try {
    const acct = await stripeClient(key).accounts.retrieve();
    return {
      mode: stripeMode(key),
      name: acct.settings?.dashboard?.display_name || acct.business_profile?.name || '',
      chargesEnabled: Boolean(acct.charges_enabled),
      country: acct.country || '',
      email: acct.email || '',
    };
  } catch (err) {
    const e = err as { type?: string };
    logEvent('warn', 'stripe_check_account_failed', stripeError(err));
    throw new HttpError(502, e?.type === 'StripeAuthenticationError' ? 'Stripe did not accept this secret key. Copy it again from Stripe → Developers → API keys.' : 'Stripe could not be reached. Please try again.');
  }
}

export interface DomainStatus {
  domain: string;
  registered: boolean;
  applePay?: string;
  googlePay?: string;
  message?: string;
}

/** The shop's own domain (from NEXT_PUBLIC_APP_URL, or the hub's address), if it is a public name. */
export function shopDomain(fallbackHost?: string | null): string | null {
  let host = '';
  try {
    host = appUrl() ? new URL(appUrl()!).hostname : (fallbackHost || '').split(':')[0];
  } catch {
    host = '';
  }
  host = host.toLowerCase();
  return /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && !/\.(local|localhost|internal|test)$/.test(host) ? host : null;
}

function domainView(d: Stripe.PaymentMethodDomain): DomainStatus {
  return {
    domain: d.domain_name,
    registered: d.enabled,
    applePay: d.apple_pay?.status,
    googlePay: d.google_pay?.status,
    message: d.apple_pay?.status_details?.error_message || d.google_pay?.status_details?.error_message || undefined,
  };
}

/** "Register this domain for Apple Pay" (Stripe's payment method domains): register once, then validate. */
export async function registerPaymentDomain(domain: string, { register }: { register: boolean }): Promise<DomainStatus> {
  const client = stripeClient();
  try {
    const found = (await client.paymentMethodDomains.list({ domain_name: domain, limit: 1 })).data[0];
    if (found) return domainView(register ? await client.paymentMethodDomains.validate(found.id) : found);
    if (!register) return { domain, registered: false };
    return domainView(await client.paymentMethodDomains.create({ domain_name: domain, enabled: true }));
  } catch (err) {
    logEvent('warn', 'stripe_domain_failed', { domain, ...stripeError(err) });
    throw new HttpError(502, 'Stripe could not register the domain right now. Check that the site is live at https://' + domain + ', then try again.');
  }
}
