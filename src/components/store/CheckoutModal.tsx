'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { CartItem, Emirate, Order, PaymentMethod, PhoneVerificationConfig } from '@/types';
import { UAE_EMIRATES } from '@/data/initialData';
import { resolveArea, searchAreas, type UAEArea } from '@/data/uaeAreas';
import { cartFils, formatAed, toFils } from '@/lib/money';
import { useShop } from '@/lib/client/shop';
import { postJson } from '@/lib/apiClient';
import { formatAccuracy, suggestAreaFromGps, UAE_KEY_LOCATIONS } from '@/lib/uaeLocations';
import { deliveryCheck } from '@/lib/delivery';
import { emirateFrom, walletAddress } from '@/lib/walletAddress';
import type { CardPay, StartedCardOrder, WalletPayment } from './StripeCheckout';
import { AreaCombobox } from './AreaCombobox';
import { WhatsAppConfirm } from './WhatsAppConfirm';
import { 
  X, 
  CheckCircle2, 
  Check, 
  Upload, 
  MessageCircle, 
  ArrowRight, 
  ShieldCheck, 
  Banknote, 
  Building2, 
  MapPin, 
  Navigation, 
  Crosshair, 
  Sparkles, 
  AlertCircle,
  Truck,
  CreditCard,
  Loader2
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { PALETTE } from '@/lib/design/tokens';
import { classifyPhone, PhoneVerification } from './PhoneVerification';

// Stripe's fields: their own chunk, fetched only when checkout offers cards (never on the shop's first load).
const CardFields = dynamic(() => import('./StripeCheckout').then((m) => m.CardFields), {
  ssr: false,
  loading: () => <p className="text-[11px] text-ink-muted py-2">Loading the secure card form…</p>,
});
const ExpressCheckout = dynamic(() => import('./StripeCheckout').then((m) => m.ExpressCheckout), { ssr: false });

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  /**
   * Checkout offers bank transfer (the shop's account is saved). The account itself is never on the
   * website: it is sent to the customer privately after the order (src/lib/server/bankPay.ts).
   */
  bankTransfer: boolean;
  /** The server stored the order (it is shown confirmed only after that). */
  onOrderPlaced: (order: Order) => void;
  /** Reload the catalogue and the bag (prices changed on the server). */
  onPricesChanged: () => Promise<void>;
  /** Where international customers email (from the server's settings). */
  supportEmail?: string;
  /** Where the customer came from (Instagram, WhatsApp…), recorded on the order. */
  landing?: { source: string; campaign?: string } | null;
  /** How phones are verified: the shop's own SMS (default) or Firebase. */
  phoneVerification?: PhoneVerificationConfig;
  /** Card payments through the shop's Stripe account (Settings → Payments), when switched on. */
  card?: { publishableKey: string } | null;
}

/** A card order on the confirmation screen: paid only once the server has Stripe's word. */
type CardShown = { state: string; label?: string };

/** The customer's details from last time (this browser only; never the phone check). */
interface Draft {
  fullName?: string;
  phone?: string;
  email?: string;
  emirate?: Emirate;
  area?: string;
  streetAddress?: string;
  buildingVilla?: string;
  flatVillaNo?: string;
  landmark?: string;
}
const DRAFT_KEY = 'buh_checkout_details';

function readDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') as Record<string, unknown>;
    const out: Draft = {};
    for (const k of ['fullName', 'phone', 'email', 'area', 'streetAddress', 'buildingVilla', 'flatVillaNo', 'landmark'] as const) {
      if (typeof d[k] === 'string' && (d[k] as string).length <= 200) out[k] = d[k] as string;
    }
    if (typeof d.emirate === 'string' && (UAE_EMIRATES as readonly string[]).includes(d.emirate)) out.emirate = d.emirate as Emirate;
    return out;
  } catch {
    return {};
  }
}

/** Saves non-empty details; returns whether anything was saved. */
function writeDraft(d: Draft): boolean {
  const filled = Object.fromEntries(Object.entries(d).filter(([k, v]) => v && !(k === 'emirate' && v === 'Dubai' && !d.area)));
  try {
    if (Object.keys(filled).length) localStorage.setItem(DRAFT_KEY, JSON.stringify(filled));
    return Object.keys(filled).length > 0;
  } catch {
    return false;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // nothing saved
  }
}

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
  isOpen,
  onClose,
  items,
  bankTransfer,
  onOrderPlaced,
  onPricesChanged,
  supportEmail,
  landing,
  phoneVerification,
  card,
}) => {
  // One checkout attempt = one order, even if "Confirm" is sent twice (double tap, retry). A card
  // attempt that didn't go through is closed (its pieces back on sale), and the next one is new.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  // Proof from the server that the phone passed SMS verification.
  const [phoneToken, setPhoneToken] = useState('');
  // Form State: what the customer typed last time is filled back in, so they carry on where they left off.
  const [draft] = useState(readDraft);
  const [fullName, setFullName] = useState(draft.fullName ?? '');
  const [phone, setPhone] = useState(draft.phone ?? '');
  const [email, setEmail] = useState(draft.email ?? '');
  const [emirate, setEmirate] = useState<Emirate>(draft.emirate ?? 'Dubai');
  const [area, setArea] = useState(draft.area ?? '');
  const [streetAddress, setStreetAddress] = useState(draft.streetAddress ?? '');
  const [buildingVilla, setBuildingVilla] = useState(draft.buildingVilla ?? '');
  const [flatVillaNo, setFlatVillaNo] = useState(draft.flatVillaNo ?? '');
  const [landmark, setLandmark] = useState(draft.landmark ?? '');
  const [hasSavedDetails, setHasSavedDetails] = useState(Object.keys(draft).length > 0);
  useEffect(() => {
    const t = setTimeout(() => {
      writeDraft({ fullName, phone, email, emirate, area, streetAddress, buildingVilla, flatVillaNo, landmark });
    }, 300);
    return () => clearTimeout(t);
  }, [fullName, phone, email, emirate, area, streetAddress, buildingVilla, flatVillaNo, landmark]);
  const forgetDetails = () => {
    clearDraft();
    setEmirate('Dubai');
    setFullName('');
    setPhone('');
    setEmail('');
    setArea('');
    setStreetAddress('');
    setBuildingVilla('');
    setFlatVillaNo('');
    setLandmark('');
    setHasSavedDetails(false);
  };

  // GPS Pin Drop State
  const [gpsCoordinates, setGpsCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [pinQuery, setPinQuery] = useState('');
  // Said once when choosing an area also changed the emirate.
  const [areaNote, setAreaNote] = useState('');

  // Customer Mobile OTP State
  const [isPhoneVerified, setIsPhoneVerified] = useState(false);

  // Delivery: decided by the address (the server checks again and charges any same-day fee).
  const { delivery: deliverySettings } = useShop();
  // Same day is chosen for one address: changing the emirate or area goes back to standard.
  const [deliveryChoice, setDeliveryChoice] = useState<{ option: 'standard' | 'same_day'; key: string }>({ option: 'standard', key: '' });
  const setDeliveryOption = (option: 'standard' | 'same_day') => setDeliveryChoice({ option, key: `${emirate}|${area}` });
  const [locationProblem, setLocationProblem] = useState(false);

  // Payment Method
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cod');

  // Submission State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<Order | null>(null);
  const [submitError, setSubmitError] = useState('');

  // Card payments: Stripe's fields say when they can pay; the confirmation screen asks the server
  // (which asks Stripe) until the payment is confirmed.
  const cardPay = useRef<CardPay | null>(null);
  // The card order the server made for this attempt (shown once Stripe has the payment).
  const placed = useRef<Order | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const onCardReady = useCallback((pay: CardPay | null) => {
    cardPay.current = pay;
    setCardReady(Boolean(pay));
  }, []);
  const [cardSecret, setCardSecret] = useState('');
  const [cardShown, setCardShown] = useState<CardShown | null>(null);
  const [walletNotice, setWalletNotice] = useState('');

  // Financial Calculations
  // In fils, like the server. Standard delivery and COD are free (same day adds Settings → Delivery's charge); the server is the source of truth and
  // refuses the order if its total differs from the one shown here (a price changed meanwhile).
  const delivery = deliveryCheck({ emirate, area }, deliverySettings);
  const sameDayChosen = deliveryChoice.option === 'same_day' && deliveryChoice.key === `${emirate}|${area}` && delivery.sameDay.available;
  const deliveryFils = sameDayChosen ? toFils(delivery.sameDay.fee) : 0;
  const totalFils = cartFils(items) + deliveryFils;
  const grandTotal = formatAed(totalFils);
  const bankReady = bankTransfer;
  const shopWhatsApp = useShop().store.whatsappNumber.replace(/\D/g, '');
  const byCard = paymentMethod === 'online_card' && Boolean(card);
  const phoneOk = classifyPhone(phone).kind === 'uae';

  // The confirmation screen of a card order: ask the server until Stripe has confirmed (or not).
  const confirmedId = confirmedOrder?.id;
  const waitingForCard = Boolean(confirmedId && cardSecret && cardShown && (cardShown.state === 'pending' || cardShown.state === 'failed'));
  useEffect(() => {
    if (!waitingForCard || !confirmedId) return;
    let tries = 0;
    let stopped = false;
    const ask = async () => {
      if (stopped) return;
      const { ok, data } = await postJson<{ card?: CardShown }>('/api/orders/payment', { orderId: confirmedId, clientSecret: cardSecret, action: 'check' });
      if (stopped) return;
      if (ok && data.card) setCardShown(data.card);
      if (++tries < 40 && !(ok && data.card && data.card.state !== 'pending' && data.card.state !== 'failed')) timer = setTimeout(ask, tries < 10 ? 1500 : 4000);
    };
    let timer = setTimeout(ask, 800);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waitingForCard, confirmedId, cardSecret]);



  // Escape closes checkout (not while an order is being saved).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isSubmitting, onClose]);

  // Every hook must run on every render, so the early return comes after them all.
  if (!isOpen) return null;

  // Handler: GPS Current Location using Browser Geolocation
  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser.');
      return;
    }
    setIsLocating(true);
    setLocationNotice(null);

    setLocationProblem(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setIsLocating(false);
        const { latitude, longitude, accuracy } = pos.coords;
        // Laptops and many phones indoors report a Wi-Fi or network location (sometimes another country,
        // e.g. through a VPN). The pin is kept for the driver, but an area is only suggested from a
        // precise reading close to a community we know; otherwise the customer chooses it.
        const reading = suggestAreaFromGps(latitude, longitude, accuracy);
        if (reading.kind === 'outside') {
          setGpsCoordinates(null);
          setLocationProblem(true);
          setLocationNotice('Your device’s location doesn’t look like the UAE (this happens with network or VPN locations). Please choose your emirate and area below.');
          return;
        }
        setGpsCoordinates({ lat: latitude, lng: longitude });
        const kept = area.trim() ? ' Your address above is kept.' : '';
        if (reading.kind === 'approximate') {
          setLocationProblem(true);
          setLocationNotice(
            `Your device gave an approximate location (${formatAccuracy(reading.accuracyM)}), so we saved it for the driver but didn’t guess your area.${kept || ' Please choose it below.'}`
          );
        } else if (reading.kind === 'unknown') {
          setLocationNotice(`Location saved for the driver.${kept || ' Please choose your area below.'}`);
        } else if (!area.trim()) {
          setEmirate(reading.location.emirate);
          setArea(reading.location.name);
          setAreaNote('');
          setLocationNotice(`Location saved for the driver, in or near ${reading.location.name}, ${reading.location.emirate}. Please check the area below.`);
        } else {
          // The customer already typed an area: never switch the emirate under it.
          setLocationNotice(`Location saved for the driver (near ${reading.location.name}, ${reading.location.emirate}).${kept}`);
        }
      },
      () => {
        setIsLocating(false);
        setLocationProblem(true);
        setLocationNotice('We couldn’t get your location. No problem: choose your emirate and area below, and add a landmark for the driver.');
      },
      { timeout: 10000, enableHighAccuracy: true, maximumAge: 60_000 }
    );
  };

  // Handler: Select location preset or drop pin on map
  const handleSelectMapLocation = (loc: typeof UAE_KEY_LOCATIONS[0]) => {
    setGpsCoordinates({ lat: loc.lat, lng: loc.lng });
    setEmirate(loc.emirate);
    setArea(loc.name);
    setAreaNote('');
    setLocationProblem(false);
    setLocationNotice(`Pin dropped on: ${loc.name}, ${loc.emirate} (${loc.lat.toFixed(4)}°N, ${loc.lng.toFixed(4)}°E)`);
    setShowMapPicker(false);
  };

  // An area chosen from the list: in another emirate, the emirate follows it.
  const handlePickArea = (a: UAEArea) => {
    setArea(a.name);
    if (a.emirate !== emirate) {
      setEmirate(a.emirate);
      setAreaNote(`Emirate changed to ${a.emirate} for ${a.name}.`);
    } else {
      setAreaNote('');
    }
  };

  // Communities with a known centre, for "Drop pin": searchable like the area field.
  const pinMatches = pinQuery.trim()
    ? searchAreas(pinQuery, emirate, 200)
        .map((m) => UAE_KEY_LOCATIONS.find((l) => l.name === m.area.name && l.emirate === m.area.emirate))
        .filter((l): l is (typeof UAE_KEY_LOCATIONS)[number] => Boolean(l))
    : [...UAE_KEY_LOCATIONS.filter((l) => l.emirate === emirate), ...UAE_KEY_LOCATIONS.filter((l) => l.emirate !== emirate)];


  /** The order body as checkout has it now, with any details the wallet gave instead. */
  const orderBody = (method: PaymentMethod, over: { customer?: Partial<Record<'fullName' | 'phone' | 'email' | 'emirate' | 'area' | 'streetAddress' | 'buildingVilla' | 'flatVillaNo', string>>; deliveryOption?: 'standard' | 'same_day' } = {}) => ({
    idempotencyKey,
    // Card: no SMS code needed (a verified number is still sent when there is one).
    verificationToken: method === 'online_card' && !(isPhoneVerified && phoneToken) ? undefined : phoneToken,
    customer: {
      fullName,
      email: email || undefined,
      emirate,
      area,
      streetAddress,
      buildingVilla,
      flatVillaNo,
      landmark: landmark || undefined,
      gpsCoordinates: gpsCoordinates || undefined,
      ...(method === 'online_card' ? { phone: classifyPhone(phone).e164 || phone } : {}),
      ...over.customer,
    },
    items: items.map((item) => ({
      productId: item.product.id,
      profileId: item.selectedProfile.id,
      color: item.selectedColor,
      quantity: item.quantity,
    })),
    paymentMethod: method,
    deliveryOption: over.deliveryOption ?? (sameDayChosen ? 'same_day' : 'standard'),
    expectedTotal: totalFils / 100,
    source: landing ?? undefined,
  });

  /** A refused order: reload prices or delivery if that was why, and say what happened. */
  const orderRefused = async (status: number, data: { message?: string; code?: string }) => {
    if (status === 401) {
      // The phone check expired (30 minutes): verify again.
      setIsPhoneVerified(false);
      setPhoneToken('');
    }
    // A price changed since the bag was filled: reload it, so the new total is shown before confirming.
    if (status === 409 && data.code === 'price_changed') await onPricesChanged();
    // Same-day closed while they were at checkout (past the cut-off): back to standard, total shown again.
    if (status === 409 && data.code === 'same_day_unavailable') setDeliveryOption('standard');
    return data.message || 'We could not place your order. Nothing was charged. Please try again.';
  };

  /** Create the card order on the server (its prices, its total) and get Stripe's client secret for it. */
  const startCardOrder = async (over: Parameters<typeof orderBody>[1] = {}): Promise<StartedCardOrder> => {
    const { ok, status, data } = await postJson<{ order?: Order; payment?: { clientSecret?: string }; message?: string; code?: string }>('/api/orders', orderBody('online_card', over));
    if (!ok || !data.order) {
      const message = await orderRefused(status, data);
      // Stripe could not be reached: that attempt is closed on the server, so the next is a new one.
      if (data.code === 'card_start_failed') setIdempotencyKey(crypto.randomUUID());
      return { ok: false, message };
    }
    placed.current = data.order;
    if (data.order.card?.state === 'paid') return { ok: false, paid: true, orderId: data.order.id };
    return { ok: true, orderId: data.order.id, clientSecret: data.payment?.clientSecret };
  };

  /** Stripe has the payment (or it didn't go through): show the confirmation, or close that attempt. */
  const cardFinished = async (result: { ok: boolean; message?: string; orderId?: string; clientSecret?: string }) => {
    const order = placed.current && placed.current.id === result.orderId ? placed.current : null;
    if (!result.ok && order && result.clientSecret) {
      // Declined, or the customer closed 3-D Secure: stop that payment so its pieces go back on sale
      // (if Stripe says it was paid after all, it counts as paid).
      const { data } = await postJson<{ card?: CardShown }>('/api/orders/payment', { orderId: order.id, clientSecret: result.clientSecret, action: 'abandon' });
      if (data.card?.state === 'paid') return showConfirmed(order, result.clientSecret, data.card);
      setIdempotencyKey(crypto.randomUUID());
    }
    if (!result.ok && order && order.card?.state === 'paid') return showConfirmed(order, '', order.card);
    if (!result.ok || !order) {
      if (result.message) setSubmitError(result.message);
      return;
    }
    showConfirmed(order, result.clientSecret || '', order.card ?? { state: 'pending' });
  };

  const showConfirmed = (order: Order, secret: string, shown: CardShown | null) => {
    setSubmitError('');
    setConfirmedOrder(order);
    setCardSecret(secret);
    setCardShown(shown);
    onOrderPlaced(order);
    celebrate();
  };

  /** Apple Pay / Google Pay gave the customer's details: fill checkout with them, and pay if nothing is missing. */
  const payFromWallet = async ({ contact, deliveryOption }: WalletPayment): Promise<StartedCardOrder & { reason?: 'invalid_shipping_address' | 'address_unserviceable' | 'fail' }> => {
    const w = walletAddress(contact);
    setWalletNotice('');
    setSubmitError('');
    // What the wallet gave fills checkout (the customer sees it, and can correct it).
    if (w.fullName) setFullName(w.fullName);
    if (w.email) setEmail(w.email);
    if (w.streetAddress) setStreetAddress(w.streetAddress);
    if (w.buildingVilla) setBuildingVilla(w.buildingVilla);
    if (w.flatVillaNo) setFlatVillaNo(w.flatVillaNo);
    const walletEmirate = w.emirate ?? emirate;
    if (w.emirate) setEmirate(w.emirate);
    // The area: the wallet's, or the one chosen in checkout for the same emirate. Never a guess.
    const typed = area.trim() ? resolveArea(area, walletEmirate) : null;
    const chosenArea = w.area ?? (typed && typed.emirate === walletEmirate ? typed.name : null);
    if (w.area) setArea(w.area);
    if (!chosenArea) {
      setWalletNotice('Your wallet gave us your address, but not an area we know. Please choose your area below, then tap the button again.');
      setTimeout(() => document.getElementById('checkout-area')?.focus(), 50);
      return { ok: false, reason: 'invalid_shipping_address', message: 'Please choose your area in checkout, then try again.' };
    }
    // The phone: the wallet's if it is a UAE mobile, else the one typed in checkout.
    const walletPhone = classifyPhone(w.phone);
    const mobile = walletPhone.kind === 'uae' ? walletPhone.e164 : classifyPhone(phone).kind === 'uae' ? classifyPhone(phone).e164 : '';
    if (walletPhone.kind === 'uae') setPhone(walletPhone.e164);
    if (!mobile) {
      setWalletNotice('Couriers need a UAE mobile number: your wallet gave another one. Please type a UAE mobile below, then tap the button again.');
      setTimeout(() => document.getElementById('checkout-phone')?.focus(), 50);
      return { ok: false, reason: 'fail', message: 'Please add a UAE mobile number in checkout, then try again.' };
    }
    if (!deliveryCheck({ emirate: walletEmirate, area: chosenArea }, deliverySettings).serviceable) {
      return { ok: false, reason: 'address_unserviceable', message: 'Sorry, we don’t deliver to that address yet.' };
    }
    return startCardOrder({
      customer: {
        fullName: w.fullName || fullName,
        email: w.email || email || '',
        phone: mobile,
        emirate: walletEmirate,
        area: chosenArea,
        streetAddress: w.streetAddress || streetAddress,
        buildingVilla: w.buildingVilla || buildingVilla,
        flatVillaNo: w.flatVillaNo || flatVillaNo,
      },
      deliveryOption,
    });
  };

  const celebrate = () => {
    try {
      // A light shower of gold (none for people who asked their device for less motion).
      confetti({
        particleCount: 36,
        spread: 60,
        startVelocity: 28,
        scalar: 0.8,
        origin: { y: 0.55 },
        colors: [PALETTE.gold, PALETTE['gold-light'], PALETTE.ivory, PALETTE['rose']],
        disableForReducedMotion: true,
      });
    } catch {
      // ignore
    }
  };

  // Submit Order: the server checks the phone proof, prices, stock and totals.
  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!fullName || !phone || !area || !streetAddress || !buildingVilla || !flatVillaNo) {
      alert('Please fill in all mandatory delivery address fields.');
      return;
    }

    // Card switched off while checkout was open: say so (never quietly another way to pay).
    if (paymentMethod === 'online_card' && !card) {
      setSubmitError('Card payment is not available right now. Please choose another way to pay.');
      return;
    }
    // Card: the courier still needs a UAE mobile, but no SMS code (paying is the proof).
    if (byCard) {
      if (!phoneOk) {
        document.getElementById('checkout-phone')?.focus();
        alert('Please enter your UAE mobile number for the courier.');
        return;
      }
      if (!cardPay.current) return;
      setSubmitError('');
      setIsSubmitting(true);
      const result = await cardPay.current(() => startCardOrder());
      await cardFinished(result);
      setIsSubmitting(false);
      return;
    }

    // Orders are only taken from a verified UAE mobile number.
    if (!isPhoneVerified || !phoneToken) {
      document.getElementById('checkout-phone')?.focus();
      alert('Please verify your UAE mobile number with the SMS code before placing your order.');
      return;
    }

    setSubmitError('');
    setIsSubmitting(true);
    const { ok, status, data } = await postJson<{ order?: Order; message?: string; code?: string }>('/api/orders', orderBody(paymentMethod));
    setIsSubmitting(false);

    if (!ok || !data.order) {
      setSubmitError(await orderRefused(status, data));
      return;
    }
    setConfirmedOrder(data.order);
    onOrderPlaced(data.order);
    celebrate();
  };

  // SUCCESS CONFIRMATION SCREEN
  if (confirmedOrder) {
    const askWhatsApp = Boolean(confirmedOrder.whatsappCheck && shopWhatsApp);
    const paidByCard = confirmedOrder.paymentMethod === 'online_card';
    const cardPaid = paidByCard && cardShown?.state === 'paid';
    const cardOver = paidByCard && (cardShown?.state === 'canceled' || cardShown?.state === 'refunded');
    const byTransfer = confirmedOrder.paymentMethod === 'bank_transfer';
    const payPath = confirmedOrder.bankTransfer?.payPath;
    const whatsappMessage = encodeURIComponent(
      `Hello Beautiful UAE Home! I have placed Order #${confirmedOrder.id} (${confirmedOrder.customer.fullName}) for AED ${confirmedOrder.total}. Payment method: ${confirmedOrder.paymentMethod === 'cod' ? 'Cash on Delivery' : paidByCard ? 'Card' : 'Bank Transfer'}. ${byTransfer ? 'Please send me the bank details.' : 'Please confirm dispatch.'}`
    );

    return (
      <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-ink/45 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="order-confirmed-title">
        <div className="bg-surface sm:rounded-3xl max-w-lg w-full h-[100dvh] sm:h-auto sm:max-h-[92dvh] flex flex-col border border-line pt-safe sm:pt-0 overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-6 text-center space-y-5">
          <div className="w-14 h-14 rounded-full border border-gold text-gold-deep flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-7 h-7" strokeWidth={1.25} />
          </div>

          <div>
            <span className="label-caps text-gold-deep">{cardOver ? 'Payment not taken' : paidByCard && !cardPaid ? 'Order received' : askWhatsApp && confirmedOrder.whatsappCheck?.hold ? 'Order received' : 'Order confirmed'}</span>
            <h2 id="order-confirmed-title" className="font-serif text-3xl text-ink mt-2">
              Thank you for your order
            </h2>
            <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
              Your linens are being prepared with care in Dubai. We will send a tracking link as soon as they ship.
            </p>
          </div>

          {/* Confirm on WhatsApp (Settings → Store & contact): one message from the customer's own WhatsApp. */}
          {askWhatsApp && <WhatsAppConfirm orderId={confirmedOrder.id} phone={confirmedOrder.customer.phone} check={confirmedOrder.whatsappCheck!} bankDetails={byTransfer} />}

          {/* Bank transfer: the details come privately (email, WhatsApp, the order's own page), never on the website. */}
          {byTransfer && payPath && (
            <section aria-labelledby="transfer-next" className="rounded-2xl border border-line bg-ivory p-4 space-y-3 text-left">
              <h3 id="transfer-next" className="text-sm font-semibold text-ink">Paying by bank transfer</h3>
              <p className="text-xs text-ink-soft leading-relaxed">
                {confirmedOrder.customer.email ? 'We’ve sent our bank details to your email' : 'We’ll send you our bank details on WhatsApp'}, with a private link to upload your transfer screenshot. They are also on your order’s private page:
              </p>
              <a
                href={payPath}
                target="_blank"
                rel="noopener"
                className="w-full min-h-12 bg-ink hover:bg-ink-2 text-ivory font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
              >
                <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>Upload your transfer screenshot</span>
              </a>
              <p className="text-[11px] text-ink-muted text-center">Please use <span className="font-mono">{confirmedOrder.id}</span> as the transfer reference.</p>
            </section>
          )}

          {/* Order Details Card */}
          <div className="bg-ivory rounded-2xl p-4 text-left border border-line space-y-2 text-xs">
            <div className="flex justify-between items-center pb-2 border-b border-line">
              <span className="text-ink-muted font-medium">Order Number</span>
              <span className="font-mono text-sm text-ink break-anywhere text-right">{confirmedOrder.id}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-ink-muted font-medium">Delivery Destination</span>
              <span className="text-ink text-right break-anywhere">{confirmedOrder.customer.emirate} ({confirmedOrder.customer.area})</span>
            </div>

            {confirmedOrder.customer.gpsCoordinates && (
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-ink-muted font-medium">GPS Coordinates</span>
                <span className="font-mono text-success bg-success-soft px-2 py-0.5 rounded border border-success-line">
                  {confirmedOrder.customer.gpsCoordinates.lat.toFixed(4)}°N, {confirmedOrder.customer.gpsCoordinates.lng.toFixed(4)}°E
                </span>
              </div>
            )}

            <div className="flex justify-between items-center">
              <span className="text-ink-muted font-medium">Delivery</span>
              <span className="text-gold-deep flex items-center gap-1">
                <span>{confirmedOrder.deliveryOption === 'same_day' ? `Same day (AED ${confirmedOrder.deliveryFee})` : `${confirmedOrder.courier.serviceability?.deliverySpeed || deliverySettings.standardDays}, free`}</span>
              </span>
            </div>


            <div className="flex justify-between items-center gap-3">
              <span className="text-ink-muted font-medium">Payment Mode</span>
              {paidByCard ? (
                <span data-testid="card-payment-status" role="status" aria-live="polite" className={`font-semibold text-right break-anywhere ${cardPaid ? 'text-success' : cardOver ? 'text-danger' : 'text-ink'}`}>
                  {cardPaid ? (
                    `Paid by card${cardShown?.label ? ` · ${cardShown.label}` : ''}`
                  ) : cardOver ? (
                    'The card payment did not go through: nothing was charged'
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Payment is being confirmed…
                    </span>
                  )}
                </span>
              ) : (
                <span className="font-semibold text-ink capitalize">
                  {confirmedOrder.paymentMethod === 'cod' ? `Cash on Delivery (AED ${confirmedOrder.total})` : 'Direct Bank Transfer'}
                </span>
              )}
            </div>

            <div className="flex justify-between items-center pt-2 border-t border-line">
              <span className="font-semibold text-ink">{cardPaid ? 'Total Paid' : 'Total Payable'}</span>
              <span className="font-semibold text-base text-ink">AED {confirmedOrder.total}</span>
            </div>
          </div>

          </div>
          {/* WhatsApp Direct Notification, and Done: always on the screen */}
          <div className="shrink-0 border-t border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col sm:flex-row gap-2">
            {/* The shop's WhatsApp number from Settings → Store & contact (hidden when none is set). */}
            {shopWhatsApp && !askWhatsApp && (
              <a
                href={`https://wa.me/${shopWhatsApp}?text=${whatsappMessage}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 bg-whatsapp hover:brightness-110 text-white font-medium text-xs py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all"
              >
                <MessageCircle className="w-4 h-4" />
                <span>Send WhatsApp Order Update</span>
              </a>
            )}

            <button
              onClick={onClose}
              className="bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.04em] text-sm py-3 px-6 rounded-xl transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-ink/45 p-0 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <div className="bg-surface text-ink w-full max-w-xl sm:rounded-3xl h-[100dvh] sm:h-auto sm:max-h-[92dvh] flex flex-col overflow-hidden border border-line pt-safe sm:pt-0 sheet-up sm:[animation-name:sheet-fade]">
        
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-line flex items-center justify-between gap-3 bg-surface">
          <div className="min-w-0">
            <h2 id="checkout-title" className="font-serif text-2xl text-ink leading-tight">
              Checkout
            </h2>
            <p className="text-[11px] text-ink-muted tracking-[0.02em]">
              {card ? 'Free delivery across the UAE · Card, Apple Pay, Google Pay or cash on delivery' : 'Free delivery across the UAE · Cash on delivery or bank transfer'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close checkout"
            className="shrink-0 w-10 h-10 -mr-1.5 flex items-center justify-center text-ink rounded-full hover:bg-sand transition-colors"
          >
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>

        {/* Scrollable Form */}
        <form onSubmit={handleSubmitOrder} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-6">
          {/* Order Summary Strip */}
          <div className="bg-ivory rounded-2xl p-3 border border-line flex items-center justify-between text-xs">
            <div>
              <span className="font-semibold text-ink">{items.length} Bedding Sets in Bag</span>
              <div className="text-[10px] text-ink-soft mt-0.5">
                {items.map((i) => `${i.quantity}x ${i.selectedProfile.name.split(' ')[0]}`).join(' • ')}
              </div>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-ink-muted block">Total Due</span>
              <span id="checkout-total" className="text-base font-semibold text-ink">AED {grandTotal}</span>
              {sameDayChosen && <span className="text-[10px] text-ink-muted block">incl. same-day AED {formatAed(deliveryFils)}</span>}
            </div>
          </div>

          {/* Apple Pay / Google Pay / Link: the wallet fills in name, phone and address (only with card payments on) */}
          {card && (
            <ExpressCheckout
              publishableKey={card.publishableKey}
              amountFils={totalFils}
              shippingRate={sameDayChosen ? { id: 'same_day', displayName: 'Same-day delivery', amount: deliveryFils } : { id: 'standard', displayName: `Free delivery in ${deliverySettings.standardDays}`, amount: 0 }}
              servesEmirate={(state, city) => {
                const em = emirateFrom(state) ?? emirateFrom(city);
                return !em || deliverySettings.emirates.includes(em);
              }}
              onWallet={payFromWallet}
              onDone={(r) => void cardFinished(r)}
            />
          )}
          {walletNotice && (
            <p role="alert" className="text-[11px] p-2.5 rounded-xl border bg-warning-soft text-warning border-warning-line font-semibold">
              {walletNotice}
            </p>
          )}

          {/* Section 1: Contact Details & Customer OTP Verification */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-line pb-1.5">
              <h3 className="label-caps text-ink flex items-center gap-1.5">
                <span>1. Your details</span>
              </h3>
              {byCard && !isPhoneVerified ? (
                <span className="text-[10px] text-ink-soft bg-sand px-2 py-0.5 rounded-full border border-line">Card: no SMS code needed</span>
              ) : isPhoneVerified ? (
                <span className="text-[10px] font-semibold text-success bg-success-soft px-2.5 py-0.5 rounded-full flex items-center gap-1 border border-success-line">
                  <Check className="w-3 h-3 text-success" />
                  <span>Mobile Verified</span>
                </span>
              ) : (
                <span className="text-[10px] text-warning bg-warning-soft px-2 py-0.5 rounded-full border border-warning-line">
                  UAE Mobile Verification
                </span>
              )}
            </div>

            {hasSavedDetails && (
              <p className="text-[11px] text-ink-muted">
                Your details from last time are filled in.{' '}
                <button type="button" className="underline font-semibold" onClick={forgetDetails}>
                  Not you? Clear them
                </button>
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-ink font-semibold mb-1">
                  Full Name <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Fatima Al Mansoori"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <PhoneVerification
                supportEmail={supportEmail}
                verification={phoneVerification}
                codeOptional={byCard}
                phone={phone}
                onPhoneChange={setPhone}
                verified={isPhoneVerified}
                onVerifiedChange={(verified, token) => {
                  setIsPhoneVerified(verified);
                  setPhoneToken(verified ? token || '' : '');
                }}
                orderSummary={items
                  .map((i) => `- ${i.quantity} x ${i.product.title} (${i.selectedProfile.name}, ${i.selectedColor})`)
                  .join('\n')}
              />

              <div className="sm:col-span-2">
                <label className="block text-ink font-semibold mb-1">
                  Email Address <span className="text-ink-muted font-normal">(Optional for order tracking receipt)</span>
                </label>
                <input
                  type="email"
                  placeholder="name@domain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>
            </div>
          </div>

          {/* Section 2: UAE Delivery Address with GPS Pin Drop & Map Selector */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-1.5">
              <h3 className="label-caps text-ink flex items-center gap-1.5">
                <span>2. Delivery address</span>
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUseCurrentLocation}
                  disabled={isLocating}
                  className="text-[11px] font-semibold text-ink bg-warning-soft hover:bg-warning-line border border-warning-line px-2.5 py-1 rounded-lg flex items-center gap-1 whitespace-nowrap transition-colors"
                >
                  <Navigation className={`w-3 h-3 text-warning ${isLocating ? 'animate-spin' : ''}`} />
                  <span>{isLocating ? 'Locating...' : 'Use My GPS'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowMapPicker(!showMapPicker)}
                  className="text-[11px] font-semibold text-ink bg-surface hover:bg-sand border border-line-strong px-2.5 py-1 rounded-lg flex items-center gap-1 whitespace-nowrap transition-colors"
                >
                  <MapPin className="w-3 h-3 text-gold" />
                  <span>{showMapPicker ? 'Close Map' : 'Drop Pin on Map'}</span>
                </button>
              </div>
            </div>

            {/* GPS Location Notice Pill */}
            {locationNotice && (
              <div role="status" className={`text-[11px] p-2.5 rounded-xl border ${locationProblem ? 'bg-warning-soft text-warning border-warning-line' : 'bg-success-soft text-success border-success-line'}`}>
                <span className="font-semibold">{locationNotice}</span>
              </div>
            )}

            {/* INTERACTIVE UAE MAP PIN DROP SELECTOR */}
            {showMapPicker && (
              <div className="bg-gradient-to-b from-ivory to-sand p-3.5 rounded-2xl border border-line-strong space-y-3 animate-in fade-in-50 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Crosshair className="w-4 h-4 text-gold" />
                    <strong className="text-ink text-xs">UAE Delivery Map Pin Selector</strong>
                  </div>
                  <span className="text-[11px] text-ink-soft">Tap your community</span>
                </div>

                <input
                  type="search"
                  aria-label="Search communities"
                  placeholder="Search, e.g. Discovery Gardens, JLT, Yas"
                  value={pinQuery}
                  onChange={(e) => setPinQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape clears the search first; a second Escape closes checkout.
                    if (e.key === 'Escape' && pinQuery) e.stopPropagation();
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold text-xs"
                />

                {/* Quick Presets for Popular UAE Communities */}
                <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto p-1 bg-surface rounded-xl border border-line">
                  {pinMatches.length === 0 && (
                    <p className="p-1.5 text-[11px] text-ink-soft">No pin for that community yet. Type your area below, and use “Use My GPS” or a landmark for the driver.</p>
                  )}
                  {pinMatches.map((loc) => {
                    const isSelected = area === loc.name;
                    return (
                      <button
                        key={`${loc.emirate}|${loc.name}`}
                        type="button"
                        onClick={() => handleSelectMapLocation(loc)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1 ${
                          isSelected
                            ? 'bg-ink text-white '
                            : 'bg-ivory text-ink-soft hover:bg-warning-soft hover:text-warning border border-line'
                        }`}
                      >
                        <MapPin className={`w-3 h-3 ${isSelected ? 'text-gold-light' : 'text-gold'}`} />
                        <span>{loc.name}</span>
                        <span className="text-[10px]">({loc.emirate})</span>
                      </button>
                    );
                  })}
                </div>

                {/* Visual UAE Coordinate Display */}
                <div className="bg-surface p-2.5 rounded-xl border border-line flex items-center justify-between text-[11px]">
                  <span className="text-ink-muted font-medium">Selected GPS Coordinates:</span>
                  <span className="font-mono font-semibold text-ink">
                    {gpsCoordinates
                      ? `${gpsCoordinates.lat.toFixed(4)}°N, ${gpsCoordinates.lng.toFixed(4)}°E`
                      : 'None yet'}
                  </span>
                </div>
              </div>
            )}

            {/* Address Input Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label htmlFor="checkout-emirate" className="block text-ink font-semibold mb-1">
                  Emirate <span className="text-danger">*</span>
                </label>
                <select
                  id="checkout-emirate"
                  value={emirate}
                  onChange={(e) => {
                    setEmirate(e.target.value as Emirate);
                    setAreaNote('');
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                >
                  {UAE_EMIRATES.map((em) => (
                    <option key={em} value={em}>
                      {em}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="checkout-area" className="block text-ink font-semibold mb-1">
                  Area / Neighborhood <span className="text-danger">*</span>
                </label>
                <AreaCombobox
                  id="checkout-area"
                  required
                  emirate={emirate}
                  placeholder="e.g. Dubai Marina, Saadiyat, JVC"
                  value={area}
                  onChange={(t) => {
                    setArea(t);
                    setAreaNote('');
                  }}
                  onPick={handlePickArea}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
                {areaNote && (
                  <p role="status" className="mt-1 text-[11px] text-ink-soft">
                    {areaNote}
                  </p>
                )}
              </div>

              <div className="sm:col-span-2">
                <label className="block text-ink font-semibold mb-1">
                  Street Address <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Street name, road, or community number"
                  value={streetAddress}
                  onChange={(e) => setStreetAddress(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <div>
                <label className="block text-ink font-semibold mb-1">
                  Building / Villa Name <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Marina Gate 1 or Villa 24"
                  value={buildingVilla}
                  onChange={(e) => setBuildingVilla(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <div>
                <label className="block text-ink font-semibold mb-1">
                  Flat / Apartment / Villa # <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Apt 1402 or Villa 24"
                  value={flatVillaNo}
                  onChange={(e) => setFlatVillaNo(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-ink font-semibold mb-1">
                  Nearest Landmark <span className="text-ink-muted font-normal">(Crucial for courier driver pinpoint)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Near Spinneys, Behind Mall of the Emirates, Opposite Park"
                  value={landmark}
                  onChange={(e) => setLandmark(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>
            </div>

            {/* Delivery: from the address; the courier is chosen behind the scenes */}
            <div className={`p-3.5 rounded-2xl border text-xs space-y-2.5 ${delivery.serviceable ? 'bg-success-soft/80 border-success-line' : 'bg-danger-soft border-danger-line'}`} role="status" aria-live="polite">
              <div className="flex items-center gap-2">
                {delivery.serviceable ? (
                  <span className="w-6 h-6 rounded-full bg-success text-white flex items-center justify-center shrink-0"><Check className="w-4 h-4" /></span>
                ) : (
                  <AlertCircle className="w-5 h-5 text-danger shrink-0" />
                )}
                <div>
                  <div className={`font-semibold ${delivery.serviceable ? 'text-success' : 'text-danger'}`}>{delivery.message}</div>
                  {delivery.serviceable && <div className="text-ink-soft">Delivery in {delivery.days}, free</div>}
                </div>
              </div>
              {delivery.serviceable && deliverySettings.sameDayEnabled && (
                <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <legend className="sr-only">Delivery speed</legend>
                  <label className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer ${!sameDayChosen ? 'border-ink bg-surface' : 'border-line bg-surface/60'}`}>
                    <input type="radio" name="delivery-option" className="mt-0.5" checked={!sameDayChosen} onChange={() => setDeliveryOption('standard')} />
                    <span>
                      <strong className="block text-ink">Standard · free</strong>
                      <span className="text-ink-muted">{delivery.days}</span>
                    </span>
                  </label>
                  <label className={`flex items-start gap-2 p-2.5 rounded-xl border ${delivery.sameDay.available ? 'cursor-pointer' : 'opacity-60'} ${sameDayChosen ? 'border-ink bg-surface' : 'border-line bg-surface/60'}`}>
                    <input type="radio" name="delivery-option" className="mt-0.5" checked={sameDayChosen} disabled={!delivery.sameDay.available} onChange={() => setDeliveryOption('same_day')} />
                    <span>
                      <strong className="block text-ink">Same day · +AED {formatAed(toFils(delivery.sameDay.fee))}</strong>
                      <span className="text-ink-muted">{delivery.sameDay.available ? `Order before ${delivery.sameDay.cutoff}` : delivery.sameDay.reason}</span>
                    </span>
                  </label>
                </fieldset>
              )}
            </div>
          </div>

          {/* Section 3: Payment Method Selection */}
          <div className="space-y-3">
            <h3 className="label-caps text-ink flex items-center gap-1.5 border-b border-line pb-2">
              <span>3. Payment</span>
            </h3>

            <div role="radiogroup" aria-label="Payment" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Option 1: Cash On Delivery */}
              <button
                type="button"
                role="radio"
                aria-checked={paymentMethod === 'cod'}
                onClick={() => setPaymentMethod('cod')}
                className={`text-left p-3.5 rounded-2xl border transition-colors min-w-0 ${
                  paymentMethod === 'cod'
                    ? 'border-ink bg-ivory ring-1 ring-ink text-ink'
                    : 'border-line bg-surface text-ink hover:border-line-strong'
                }`}
              >
                <span className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <Banknote className="w-5 h-5 shrink-0 text-gold-deep" strokeWidth={1.5} />
                    <span className="text-sm">Cash on delivery</span>
                  </span>
                  {paymentMethod === 'cod' && <Check className="w-4 h-4 shrink-0 text-ink" />}
                </span>
                <span className="block text-[11px] leading-relaxed text-ink-soft">
                  Pay the courier in cash at your door, in any of the seven emirates.
                </span>
              </button>

              {/* Option 2: Bank transfer (only once the shop's real account is entered) */}
              {bankReady && <button
                type="button"
                role="radio"
                aria-checked={paymentMethod === 'bank_transfer'}
                onClick={() => setPaymentMethod('bank_transfer')}
                className={`text-left p-3.5 rounded-2xl border transition-colors min-w-0 ${
                  paymentMethod === 'bank_transfer'
                    ? 'border-ink bg-ivory ring-1 ring-ink text-ink'
                    : 'border-line bg-surface text-ink hover:border-line-strong'
                }`}
              >
                <span className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <Building2 className="w-5 h-5 shrink-0 text-gold-deep" strokeWidth={1.5} />
                    <span className="text-sm">Bank transfer</span>
                  </span>
                  {paymentMethod === 'bank_transfer' && <Check className="w-4 h-4 shrink-0 text-ink" />}
                </span>
                <span className="block text-[11px] leading-relaxed text-ink-soft break-anywhere">
                  Transfer to our UAE bank account; we dispatch as soon as it arrives.
                </span>
              </button>}

              {/* Option 3: Card through Stripe (only when switched on in Settings → Payments) */}
              {card && <button
                type="button"
                role="radio"
                aria-checked={paymentMethod === 'online_card'}
                onClick={() => setPaymentMethod('online_card')}
                className={`text-left p-3.5 rounded-2xl border transition-colors min-w-0 ${
                  paymentMethod === 'online_card'
                    ? 'border-ink bg-ivory ring-1 ring-ink text-ink'
                    : 'border-line bg-surface text-ink hover:border-line-strong'
                }`}
              >
                <span className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <CreditCard className="w-5 h-5 shrink-0 text-gold-deep" strokeWidth={1.5} />
                    <span className="text-sm">Card</span>
                  </span>
                  {paymentMethod === 'online_card' && <Check className="w-4 h-4 shrink-0 text-ink" />}
                </span>
                <span className="block text-[11px] leading-relaxed text-ink-soft">
                  Visa, Mastercard and more, paid securely through Stripe. No SMS code needed.
                </span>
              </button>}
            </div>

            {/* Card: Stripe's own fields (the number never touches this shop) */}
            {byCard && card && (
              <div className="rounded-2xl border border-line bg-surface p-3 min-w-0">
                <CardFields publishableKey={card.publishableKey} amountFils={totalFils} onReady={onCardReady} />
                <p className="mt-2 text-[10px] text-ink-muted flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-gold" aria-hidden="true" /> Secured by Stripe. Your card details go straight to Stripe, never to us.
                </p>
              </div>
            )}

            {/* Bank transfer: the account is never shown on the website; it is sent privately after the order. */}
            {paymentMethod === 'bank_transfer' && bankReady && (
              <div data-testid="bank-transfer-note" className="bg-ivory rounded-2xl p-4 border border-line space-y-1.5 animate-in fade-in-50 text-xs">
                <p className="font-semibold text-ink flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 shrink-0 text-gold" aria-hidden="true" />
                  <span>How bank transfer works</span>
                </p>
                <p className="text-ink-soft leading-relaxed">
                  After you order, we&apos;ll send our bank details by email and WhatsApp, with a private link to upload your transfer screenshot.
                </p>
                {!email && <p className="text-[11px] text-ink-muted leading-relaxed">Add your email above to get them by email too.</p>}
              </div>
            )}
          </div>

          </div>
          {/* The order button: always on the screen, above the keyboard and the home bar */}
          <div className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-1.5">
            {submitError && (
              <p role="alert" className="text-[11px] text-danger bg-danger-soft border border-danger-line rounded-lg px-2.5 py-1.5 font-medium">
                {submitError}
              </p>
            )}
            <button
              type="submit"
              disabled={isSubmitting || !delivery.serviceable || (byCard ? !cardReady : !isPhoneVerified)}
              className="w-full bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.03em] text-sm py-3.5 px-3 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50 text-center"
            >
              {isSubmitting ? (
                <span>{byCard ? 'Paying securely…' : 'Placing your order…'}</span>
              ) : byCard ? (
                <>
                  <CreditCard className="w-4 h-4 text-gold-light" />
                  <span>Pay AED {grandTotal}</span>
                </>
              ) : !isPhoneVerified ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-gold-light" />
                  <span>Verify your UAE mobile to place order</span>
                </>
              ) : (
                <>
                  <span>
                    Place order · AED {grandTotal}
                  </span>
                  <ArrowRight className="w-4 h-4 text-gold-light" />
                </>
              )}
            </button>
            <p className="text-[10px] text-center text-ink-muted">
              Delivered to your door, with a tracking link as soon as it ships.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};
