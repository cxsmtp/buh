import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { checkStripeAccount, registerPaymentDomain, shopDomain } from '@/lib/server/payments';
import { appUrl } from '@/lib/server/runtimeConfig';
import { getSettings, stripeMode } from '@/lib/server/settings';

/** The events the shop listens for (the owner ticks these in Stripe → Webhooks). */
const EVENTS = ['payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded'];

/** Where Stripe should send its webhook: this shop's own address. */
function webhookUrl(req: Request): string {
  const base = appUrl() || `https://${(req.headers.get('host') || 'your-domain').split(',')[0].trim()}`;
  return `${base.replace(/\/+$/, '')}/api/stripe/webhook`;
}

/**
 * Settings → Payments (owner): test or live mode (from the key prefix), the webhook address and
 * events to paste into Stripe, and the shop's domain for Apple Pay. No key ever comes back.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const p = getSettings('payments');
    return json({
      mode: stripeMode(p.stripePublishableKey) ?? stripeMode(p.stripeSecretKey),
      webhookUrl: webhookUrl(req),
      events: EVENTS,
      domain: shopDomain(req.headers.get('host')),
    });
  } catch (err) {
    return handleRouteError(err, 'admin/payments');
  }
}

/**
 * "Check the connection" (the account behind the secret key: its name, and whether it can take
 * payments), and "Register this domain for Apple Pay" (or just its status). Stripe's fixed API only.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 2048);
    allowFields(body, ['action', 'secretKey']);
    if (body.action === 'check') {
      const typed = typeof body.secretKey === 'string' ? body.secretKey.trim() : '';
      if (body.secretKey !== undefined && typeof body.secretKey !== 'string') throw new HttpError(400, 'Secret key must be text.');
      if (typed && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,240}$/.test(typed)) throw new HttpError(400, 'The secret key starts with sk_test_, sk_live_ or rk_.');
      const account = await checkStripeAccount(typed || undefined);
      audit('payments.checked', { by: session.email, mode: account.mode, chargesEnabled: account.chargesEnabled });
      return json({ success: true, account });
    }
    if (body.action === 'domain' || body.action === 'domain_status') {
      if (body.secretKey !== undefined) throw new HttpError(400, 'Unexpected field: secretKey.');
      const domain = shopDomain(req.headers.get('host'));
      if (!domain) throw new HttpError(400, 'Apple Pay needs the shop on its own domain (set NEXT_PUBLIC_APP_URL, e.g. https://beautifuluaehome.com).');
      const status = await registerPaymentDomain(domain, { register: body.action === 'domain' });
      if (body.action === 'domain') audit('payments.domain_registered', { by: session.email, domain, applePay: status.applePay, googlePay: status.googlePay });
      return json({ success: true, domain: status });
    }
    throw new HttpError(400, 'Action must be "check", "domain" or "domain_status".');
  } catch (err) {
    return handleRouteError(err, 'admin/payments');
  }
}
