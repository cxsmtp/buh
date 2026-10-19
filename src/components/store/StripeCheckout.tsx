'use client';

import React, { useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe, StripeElements, StripeElementsOptions, StripeExpressCheckoutElementConfirmEvent } from '@stripe/stripe-js';
import { Elements, ExpressCheckoutElement, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { PALETTE } from '@/lib/design/tokens';
import type { WalletContact } from '@/lib/walletAddress';

/**
 * Stripe's own fields at checkout, loaded only there and only when card payments are on (this file
 * is its own chunk: the shop's first load never carries it, and Stripe.js itself comes from
 * js.stripe.com only when checkout shows it). Card numbers are typed into Stripe's frames, never
 * into the shop.
 *
 * - ExpressCheckout: Apple Pay (Safari, iPhone), Google Pay (Chrome, Android) and Link at the top
 *   of checkout. The wallet gives the name, email, phone and delivery address; checkout maps them
 *   onto the shop's emirates and areas (asking for anything it can't match before anyone pays).
 * - CardFields: Stripe's Payment Element for a card typed in.
 *
 * Both work the same way: the amount shown is checkout's own total, but what is charged is the
 * PaymentIntent the server makes from the order (its prices, never this page's). The server marks
 * the order paid only on Stripe's word.
 */

const stripes = new Map<string, Promise<Stripe | null>>();
/** Stripe.js for this key, once per page. Blocked or offline: null (checkout then says so). */
function stripeFor(publishableKey: string): Promise<Stripe | null> {
  if (!stripes.has(publishableKey)) stripes.set(publishableKey, loadStripe(publishableKey).catch(() => null));
  return stripes.get(publishableKey)!;
}

/** Did Stripe.js fail to load (an ad blocker, no connection)? */
function useStripeFailed(publishableKey: string): boolean {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void stripeFor(publishableKey).then((s) => live && setFailed(!s));
    return () => {
      live = false;
    };
  }, [publishableKey]);
  return failed;
}

/** What checkout's server call gives back for a card order. */
export interface StartedCardOrder {
  ok: boolean;
  message?: string;
  orderId?: string;
  clientSecret?: string;
  /** The order was already paid (a retried checkout). */
  paid?: boolean;
}

/**
 * How a payment try ended. errorType is Stripe.js's error type: only card_error (declined) and
 * validation_error (details refused) mean for sure that nothing was charged; anything else (a lost
 * connection, an API error) leaves it unknown until the server has asked Stripe.
 */
export interface CardResult {
  ok: boolean;
  message?: string;
  orderId?: string;
  clientSecret?: string;
  errorType?: string;
}

/** Pay with what is in the fields: checkout creates the order (on the server) when asked. */
export type CardPay = (createOrder: () => Promise<StartedCardOrder>) => Promise<CardResult>;

/**
 * Stripe's fields in the shop's look: the colours are read from the page (the chosen look, light or
 * dark, from /look.css), so a dark look gets dark card fields instead of a stark white box. Before
 * the page has styles (or outside a browser) it falls back to Ivory & Gold light.
 */
function appearance(): StripeElementsOptions['appearance'] {
  const css = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const token = (name: keyof typeof PALETTE) => css?.getPropertyValue(`--color-${name}`).trim() || PALETTE[name];
  const dark = css?.colorScheme.includes('dark') ?? false;
  return {
    theme: dark ? 'night' : 'stripe',
    variables: {
      colorPrimary: token('ink'),
      colorText: token('ink'),
      colorTextSecondary: token('ink-soft'),
      colorBackground: token('surface'),
      colorDanger: token('danger'),
      borderRadius: '12px',
      fontSizeBase: '14px',
    },
  };
}

function options(amountFils: number): StripeElementsOptions {
  return { mode: 'payment', amount: amountFils, currency: 'aed', paymentMethodTypes: ['card', 'link'], appearance: appearance() };
}

/** After Stripe has the payment: confirm it in the browser (3-D Secure in a frame, no redirect for cards). */
async function confirm(stripe: Stripe, elements: StripeElements, clientSecret: string, orderId: string): Promise<{ message: string; type?: string } | null> {
  try {
    const { error } = await stripe.confirmPayment({
      elements,
      clientSecret,
      // Only used by payment types that must leave the page (not cards or wallets).
      confirmParams: { return_url: `${window.location.origin}/?order=${encodeURIComponent(orderId)}` },
      redirect: 'if_required',
    });
    if (!error) return null;
    return { message: error.message || 'The payment did not go through.', type: error.type };
  } catch {
    // Stripe.js itself failed (no connection): whether the card was charged is not known here.
    return { message: 'The payment could not be confirmed.', type: 'api_connection_error' };
  }
}

// ── Card typed in ───────────────────────────────────────────────────────────

export function CardFields({ publishableKey, amountFils, onReady }: { publishableKey: string; amountFils: number; onReady: (pay: CardPay | null) => void }) {
  if (useStripeFailed(publishableKey)) {
    return (
      <p role="alert" className="text-[11px] text-danger py-2">
        The secure card form could not load (a blocker, or no connection). Please choose cash on delivery, or try again later.
      </p>
    );
  }
  return (
    <Elements stripe={stripeFor(publishableKey)} options={options(amountFils)}>
      <CardFieldsInner onReady={onReady} />
    </Elements>
  );
}

function CardFieldsInner({ onReady }: { onReady: (pay: CardPay | null) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!stripe || !elements || !loaded) return;
    onReady(async (createOrder) => {
      const { error } = await elements.submit();
      if (error) return { ok: false, message: error.message || 'Please check the card details.' };
      const started = await createOrder();
      if (!started.ok || !started.clientSecret || !started.orderId) return { ok: started.paid === true, orderId: started.orderId, message: started.message };
      const problem = await confirm(stripe, elements, started.clientSecret, started.orderId);
      return { ok: !problem, message: problem?.message, errorType: problem?.type, orderId: started.orderId, clientSecret: started.clientSecret };
    });
    return () => onReady(null);
  }, [stripe, elements, loaded, onReady]);
  return (
    <div data-testid="card-element" className="min-h-[3rem]">
      <PaymentElement
        onReady={() => setLoaded(true)}
        options={{ layout: 'tabs', wallets: { applePay: 'never', googlePay: 'never' } }}
      />
      {!loaded && <p className="text-[11px] text-ink-muted py-2">Loading the secure card form…</p>}
    </div>
  );
}

// ── Apple Pay / Google Pay / Link ───────────────────────────────────────────

export interface WalletPayment {
  contact: WalletContact;
  deliveryOption: 'standard' | 'same_day';
}

export function ExpressCheckout({
  publishableKey,
  amountFils,
  shippingRate,
  servesEmirate,
  onWallet,
  onDone,
}: {
  publishableKey: string;
  amountFils: number;
  /** The delivery the customer chose in checkout (shown in the wallet's sheet). */
  shippingRate: { id: 'standard' | 'same_day'; displayName: string; amount: number };
  /** Is this emirate (as the wallet names it) one the shop delivers to? */
  servesEmirate: (state: string, city: string) => boolean;
  /** Turn the wallet's details into an order on the server, or say what to ask for. */
  onWallet: (p: WalletPayment) => Promise<StartedCardOrder & { reason?: 'invalid_shipping_address' | 'address_unserviceable' | 'fail' }>;
  onDone: (result: CardResult) => void;
}) {
  if (useStripeFailed(publishableKey)) return null;
  return (
    <Elements stripe={stripeFor(publishableKey)} options={options(amountFils)}>
      <ExpressInner shippingRate={shippingRate} servesEmirate={servesEmirate} onWallet={onWallet} onDone={onDone} />
    </Elements>
  );
}

function ExpressInner({ shippingRate, servesEmirate, onWallet, onDone }: Omit<React.ComponentProps<typeof ExpressCheckout>, 'publishableKey' | 'amountFils'>) {
  const stripe = useStripe();
  const elements = useElements();
  const [available, setAvailable] = useState<boolean | null>(null);
  const busy = useRef(false);

  const onConfirm = async (event: StripeExpressCheckoutElementConfirmEvent) => {
    if (!stripe || !elements || busy.current) return event.paymentFailed({ reason: 'fail' });
    busy.current = true;
    try {
      const { error } = await elements.submit();
      if (error) {
        event.paymentFailed({ reason: 'fail' });
        return onDone({ ok: false, message: error.message });
      }
      const b = event.billingDetails;
      const started = await onWallet({
        contact: { name: event.shippingAddress?.name || b?.name, email: b?.email, phone: b?.phone, address: event.shippingAddress?.address ?? b?.address },
        deliveryOption: event.shippingRate?.id === 'same_day' ? 'same_day' : 'standard',
      });
      if (!started.ok || !started.clientSecret || !started.orderId) {
        event.paymentFailed({ reason: started.reason ?? 'fail', ...(started.message ? { message: started.message.slice(0, 200) } : {}) });
        return onDone({ ok: started.paid === true, orderId: started.orderId, message: started.message });
      }
      const problem = await confirm(stripe, elements, started.clientSecret, started.orderId);
      if (problem) event.paymentFailed({ reason: 'fail' });
      onDone({ ok: !problem, message: problem?.message, errorType: problem?.type, orderId: started.orderId, clientSecret: started.clientSecret });
    } finally {
      busy.current = false;
    }
  };

  return (
    <div data-testid="express-checkout" className={available === false ? 'hidden' : 'space-y-1.5'}>
      {available && <p className="label-caps text-ink-muted text-center">Express checkout · your address and phone fill in</p>}
      <ExpressCheckoutElement
        options={{
          emailRequired: true,
          phoneNumberRequired: true,
          shippingAddressRequired: true,
          allowedShippingCountries: ['AE'],
          shippingRates: [shippingRate],
          buttonType: { applePay: 'buy', googlePay: 'buy' },
          buttonHeight: 44,
          layout: { maxColumns: 2, maxRows: 1, overflow: 'auto' },
        }}
        onReady={(e) => setAvailable(Boolean(e.availablePaymentMethods && Object.values(e.availablePaymentMethods).some(Boolean)))}
        onShippingAddressChange={(e) => (servesEmirate(e.address.state, e.address.city) ? e.resolve({ shippingRates: [shippingRate] }) : e.reject())}
        onConfirm={(e) => void onConfirm(e)}
      />
    </div>
  );
}
