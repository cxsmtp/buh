import { after } from 'next/server';
import { clientIp, handleRouteError, HttpError, json, readRawBody } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';
import { fillPaymentLabel, handleStripeWebhook, WEBHOOK_MAX_BYTES, WEBHOOK_REFUSED } from '@/lib/server/payments';
import { rateLimit } from '@/lib/server/rateLimit';
import { cancelJeeblyAfterRefund } from '@/lib/server/jeeblyOps';

/**
 * Stripe's webhook (Settings → Payments shows this address to paste into Stripe). Public by
 * nature, so it trusts nothing but the signature: the raw body (size-capped) must be signed with
 * the saved webhook signing secret, or nothing happens. Every refusal (no secret saved, no or a
 * wrong signature, too big, not JSON) gets the same short answer. Each event is applied once.
 * Only a POST carrying a Stripe-Signature header reaches this route: the front gate answers
 * anything else (a GET, a HEAD, a probe) as an unknown address (src/lib/server/frontGate.ts).
 */
const refused = () => json({ received: false, message: WEBHOOK_REFUSED }, 400);

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    if ((ip && !rateLimit(`stripe-webhook:${ip}`, 300, 60_000).ok) || !rateLimit('global:stripe-webhook', 1200, 60_000).ok) {
      return json({ received: false, message: 'Too many requests.' }, 429, { 'Retry-After': '60' });
    }
    const raw = await readRawBody(req, WEBHOOK_MAX_BYTES, new HttpError(400, WEBHOOK_REFUSED));
    const { type, outcome, carrierCancel } = handleStripeWebhook(raw, req.headers.get('stripe-signature'));
    if (outcome === 'mismatch') logEvent('error', 'stripe_webhook_mismatch', { type });
    else logEvent('info', 'stripe_webhook', { type, outcome });
    if (type === 'payment_intent.succeeded' && outcome === 'paid') {
      // How it was paid (Apple Pay, Visa •••• 4242) needs one more call to Stripe: after answering.
      const orderId = (JSON.parse(raw.toString('utf8')) as { data?: { object?: { metadata?: { orderId?: string } } } }).data?.object?.metadata?.orderId;
      if (orderId) {
        try {
          after(() => fillPaymentLabel(orderId));
        } catch {
          void fillPaymentLabel(orderId); // outside a request (called directly): just start it
        }
      }
    }
    if (carrierCancel) {
      // Refunded in Stripe's dashboard: the order's Jeebly booking is cancelled too (audited), after answering.
      try {
        after(() => cancelJeeblyAfterRefund(carrierCancel));
      } catch {
        void cancelJeeblyAfterRefund(carrierCancel);
      }
    }
    return json({ received: true });
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) return refused();
    // Not applied (e.g. the audit log could not be written): Stripe sends it again later.
    return handleRouteError(err, 'stripe/webhook', { received: false });
  }
}
