import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Stripe from 'stripe';

/**
 * A stand-in for Stripe's API on 127.0.0.1, so tests never call the real Stripe. The shop's
 * server is pointed at it with BUH_TEST_STRIPE_API (src/lib/server/payments.ts: loopback only).
 * It keeps PaymentIntents, refunds and payment method domains in memory, honours idempotency
 * keys like Stripe (same key, same answer), and records every request for the tests to inspect.
 */

export const TEST_KEYS = {
  publishable: 'pk_test_51BuhTestPublishableKey0000000000',
  secret: 'sk_test_51BuhTestSecretKeyAAAAAAAAAAAAAAAA',
  webhook: 'whsec_buhTestWebhookSigningSecret0000000000',
};

export interface MockIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  client_secret: string;
  metadata: Record<string, string>;
  latest_charge: string | null;
  last_payment_error: null | { code?: string; decline_code?: string; message?: string };
}

export interface MockRequest {
  method: string;
  path: string;
  idempotencyKey: string | null;
  auth: string;
  body: URLSearchParams;
}

export interface StripeMock {
  url: string;
  requests: MockRequest[];
  intents: Map<string, MockIntent>;
  /** What the next refund answers with ('succeeded' by default; 'pending' to wait for the webhook). */
  refundStatus: string;
  /** Mark an intent paid, with how (e.g. Apple Pay, Visa 4242). */
  succeed(id: string, card?: { brand?: string; last4?: string; wallet?: string | null }): MockIntent;
  /** The signed webhook body Stripe would send (with this secret, or another one). */
  event(type: string, object: unknown, opts?: { id?: string; secret?: string }): { body: string; signature: string; id: string };
  close(): Promise<void>;
}

export async function startStripeMock(): Promise<StripeMock> {
  const requests: MockRequest[] = [];
  const intents = new Map<string, MockIntent>();
  const charges = new Map<string, Record<string, unknown>>();
  const refunds = new Map<string, Record<string, unknown>>();
  const domains = new Map<string, Record<string, unknown>>();
  const byKey = new Map<string, { status: number; body: unknown }>();
  const id = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;

  const mock = {
    url: '',
    requests,
    intents,
    refundStatus: 'succeeded',
  } as StripeMock;

  const err = (status: number, type: string, message: string, code?: string) => ({ status, body: { error: { type, message, ...(code ? { code } : {}) } } });

  function intentView(pi: MockIntent, expand: string[]) {
    return expand.includes('latest_charge') && pi.latest_charge ? { ...pi, latest_charge: charges.get(pi.latest_charge) } : pi;
  }

  function route(method: string, path: string, body: URLSearchParams, query: URLSearchParams): { status: number; body: unknown } {
    const expand = [...body.getAll('expand[]'), ...query.getAll('expand[]'), ...query.getAll('expand[0]'), ...body.getAll('expand[0]')];
    if (method === 'GET' && path === '/v1/account') {
      return { status: 200, body: { id: 'acct_buhtest', object: 'account', settings: { dashboard: { display_name: 'Beautiful UAE Home (test)' } }, business_profile: { name: 'Beautiful UAE Home' }, charges_enabled: true, country: 'AE', email: 'owner@shop.test' } };
    }
    if (method === 'POST' && path === '/v1/payment_intents') {
      const pi: MockIntent = {
        id: id('pi'),
        object: 'payment_intent',
        amount: Number(body.get('amount')),
        amount_received: 0,
        currency: String(body.get('currency')),
        status: 'requires_payment_method',
        client_secret: '',
        metadata: { orderId: String(body.get('metadata[orderId]') ?? '') },
        latest_charge: null,
        last_payment_error: null,
      };
      pi.client_secret = `${pi.id}_secret_${crypto.randomBytes(12).toString('hex')}`;
      intents.set(pi.id, pi);
      return { status: 200, body: pi };
    }
    let m = /^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/.exec(path);
    if (m) {
      const pi = intents.get(m[1]);
      if (!pi) return err(404, 'invalid_request_error', 'No such payment_intent', 'resource_missing');
      if (m[2]) {
        if (pi.status === 'succeeded' || pi.status === 'canceled' || pi.status === 'processing') {
          return err(400, 'invalid_request_error', `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`, 'payment_intent_unexpected_state');
        }
        pi.status = 'canceled';
      }
      return { status: 200, body: intentView(pi, expand) };
    }
    if (method === 'POST' && path === '/v1/refunds') {
      const pi = intents.get(String(body.get('payment_intent')));
      if (!pi || pi.status !== 'succeeded') return err(400, 'invalid_request_error', 'This PaymentIntent does not have a successful charge to refund.', 'charge_not_refundable');
      const refund = { id: id('re'), object: 'refund', amount: pi.amount, currency: pi.currency, payment_intent: pi.id, status: mock.refundStatus, metadata: { orderId: body.get('metadata[orderId]') } };
      refunds.set(refund.id, refund);
      return { status: 200, body: refund };
    }
    if (method === 'GET' && path === '/v1/payment_method_domains') {
      const data = [...domains.values()].filter((d) => d.domain_name === query.get('domain_name'));
      return { status: 200, body: { object: 'list', data, has_more: false, url: '/v1/payment_method_domains' } };
    }
    if (method === 'POST' && path === '/v1/payment_method_domains') {
      const d = { id: id('pmd'), object: 'payment_method_domain', domain_name: body.get('domain_name'), enabled: true, apple_pay: { status: 'active' }, google_pay: { status: 'active' }, link: { status: 'active' }, livemode: false };
      domains.set(String(d.id), d);
      return { status: 200, body: d };
    }
    m = /^\/v1\/payment_method_domains\/([^/]+)\/validate$/.exec(path);
    if (m && domains.has(m[1])) return { status: 200, body: domains.get(m[1]) };
    return err(404, 'invalid_request_error', `Unrecognized request URL (${method}: ${path}).`);
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://x');
      const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const idem = (req.headers['idempotency-key'] as string | undefined) ?? null;
      const auth = String(req.headers.authorization || '');
      requests.push({ method: req.method || '', path: url.pathname, idempotencyKey: idem, auth, body });
      let answer: { status: number; body: unknown };
      if (auth !== `Bearer ${TEST_KEYS.secret}`) {
        answer = err(401, 'invalid_request_error', 'Invalid API Key provided.');
      } else if (idem && req.method === 'POST' && byKey.has(idem)) {
        answer = byKey.get(idem)!; // Stripe: the same key gives the first answer again
      } else {
        answer = route(req.method || '', url.pathname, body, url.searchParams);
        if (idem && req.method === 'POST' && answer.status < 500) byKey.set(idem, answer);
      }
      res.writeHead(answer.status, { 'content-type': 'application/json', 'request-id': id('req') });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  mock.succeed = (piId, card = {}) => {
    const pi = intents.get(piId)!;
    const charge = {
      id: id('ch'),
      object: 'charge',
      amount: pi.amount,
      amount_refunded: 0,
      payment_intent: pi.id,
      payment_method_details: { type: 'card', card: { brand: card.brand ?? 'visa', last4: card.last4 ?? '4242', wallet: card.wallet === undefined ? { type: 'apple_pay' } : card.wallet ? { type: card.wallet } : null } },
    };
    charges.set(charge.id, charge);
    pi.status = 'succeeded';
    pi.amount_received = pi.amount;
    pi.latest_charge = charge.id;
    return pi;
  };
  mock.event = (type, object, opts = {}) => {
    const eventId = opts.id ?? id('evt');
    const body = JSON.stringify({ id: eventId, object: 'event', type, api_version: '2025-08-27.basil', created: Math.floor(Date.now() / 1000), data: { object }, livemode: false });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: opts.secret ?? TEST_KEYS.webhook });
    return { body, signature, id: eventId };
  };
  mock.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return mock;
}
