'use client';

import React, { useState, useEffect } from 'react';
import { BankTransferDetails, CartItem, Emirate, Order, PaymentMethod, PhoneVerificationConfig } from '@/types';
import { UAE_EMIRATES, UAE_POPULAR_AREAS } from '@/data/initialData';
import { cartFils, formatAed, toFils } from '@/lib/money';
import { useShop } from '@/lib/client/shop';
import { postJson } from '@/lib/apiClient';
import { nearestUAELocation, UAE_KEY_LOCATIONS } from '@/lib/uaeLocations';
import { deliveryCheck, inUAE } from '@/lib/delivery';
import { 
  X, 
  CheckCircle2, 
  Copy, 
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
  Truck
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { classifyPhone, PhoneVerification } from './PhoneVerification';

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  /** The shop's bank details for transfers (from the server). */
  bank: BankTransferDetails;
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
}

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
  bank,
  onOrderPlaced,
  onPricesChanged,
  supportEmail,
  landing,
  phoneVerification,
}) => {
  // One checkout attempt = one order, even if "Confirm" is sent twice (double tap, retry).
  const [idempotencyKey] = useState(() => crypto.randomUUID());
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

  // Customer Mobile OTP State
  const [isPhoneVerified, setIsPhoneVerified] = useState(false);

  // Delivery: decided by the address (the server checks again and charges any same-day fee).
  const { delivery: deliverySettings } = useShop();
  // Same day is chosen for one address: changing the emirate or area goes back to standard.
  const [deliveryChoice, setDeliveryChoice] = useState<{ option: 'standard' | 'same_day'; key: string }>({ option: 'standard', key: '' });
  const setDeliveryOption = (option: 'standard' | 'same_day') => setDeliveryChoice({ option, key: `${emirate}|${area}` });
  const [locationProblem, setLocationProblem] = useState(false);

  // Payment Method & Bank Transfer
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cod');
  const [bankRef, setBankRef] = useState('');
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [copiedIban, setCopiedIban] = useState(false);

  // Submission State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<Order | null>(null);
  const [submitError, setSubmitError] = useState('');

  // Financial Calculations
  // In fils, like the server. Standard delivery and COD are free (same day adds Settings → Delivery's charge); the server is the source of truth and
  // refuses the order if its total differs from the one shown here (a price changed meanwhile).
  const delivery = deliveryCheck({ emirate, area }, deliverySettings);
  const sameDayChosen = deliveryChoice.option === 'same_day' && deliveryChoice.key === `${emirate}|${area}` && delivery.sameDay.available;
  const deliveryFils = sameDayChosen ? toFils(delivery.sameDay.fee) : 0;
  const totalFils = cartFils(items) + deliveryFils;
  const grandTotal = formatAed(totalFils);
  const bankReady = Boolean(bank.iban && bank.accountName && bank.bankName);
  const shopWhatsApp = useShop().store.whatsappNumber.replace(/\D/g, '');



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
        // Laptops and some phones report a network location (often another country, e.g. through a VPN):
        // only a reading inside the UAE is used, and the address fields are only suggested, never forced.
        if (!inUAE(latitude, longitude)) {
          setGpsCoordinates(null);
          setLocationProblem(true);
          setLocationNotice('Your device’s location doesn’t look like the UAE (this happens with network or VPN locations). Please choose your emirate and area below.');
          return;
        }
        setGpsCoordinates({ lat: latitude, lng: longitude });
        const near = nearestUAELocation(latitude, longitude);
        const approx = accuracy > 1000 ? ` (about ${Math.round(accuracy / 1000)} km accuracy, please check)` : '';
        if (near && !area) {
          setEmirate(near.location.emirate);
          setArea(near.location.name);
          setLocationNotice(`📍 Location saved for the driver, near ${near.location.name}, ${near.location.emirate}${approx}.`);
        } else if (near) {
          // The customer already typed an area: never switch the emirate under it.
          setLocationNotice(`📍 Location saved for the driver (near ${near.location.name}, ${near.location.emirate}${approx}). Your address above is kept.`);
        } else {
          setLocationNotice(`📍 Location saved for the driver${approx}. Please choose your emirate and area below.`);
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
    setLocationNotice(`📍 Pin dropped on: ${loc.name}, ${loc.emirate} (${loc.lat.toFixed(4)}°N, ${loc.lng.toFixed(4)}°E)`);
    setShowMapPicker(false);
  };

  // Copy IBAN
  const handleCopyIban = () => {
    navigator.clipboard.writeText(bank.iban.replace(/\s+/g, ''));
    setCopiedIban(true);
    setTimeout(() => setCopiedIban(false), 2500);
  };

  const handleReceiptUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.size > 5 * 1024 * 1024) {
      alert('That file is larger than 5 MB. Please upload a smaller screenshot or PDF.');
      e.target.value = '';
      return;
    }
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setReceiptUrl(event.target?.result as string);
      };
      reader.readAsDataURL(file);
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

    // Orders are only taken from a verified UAE mobile number.
    if (!isPhoneVerified || !phoneToken) {
      document.getElementById('checkout-phone')?.focus();
      alert('Please verify your UAE mobile number with the SMS code before placing your order.');
      return;
    }

    setSubmitError('');
    setIsSubmitting(true);
    const { ok, status, data } = await postJson<{ order?: Order; message?: string }>('/api/orders', {
      idempotencyKey,
      verificationToken: phoneToken,
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
      },
      items: items.map((item) => ({
        productId: item.product.id,
        profileId: item.selectedProfile.id,
        color: item.selectedColor,
        quantity: item.quantity,
      })),
      paymentMethod,
      deliveryOption: sameDayChosen ? 'same_day' : 'standard',
      expectedTotal: totalFils / 100,
      source: landing ?? undefined,
      bankTransferRef: paymentMethod === 'bank_transfer' ? bankRef || undefined : undefined,
      receipt: paymentMethod === 'bank_transfer' ? receiptUrl || undefined : undefined,
    });
    setIsSubmitting(false);

    if (!ok || !data.order) {
      if (status === 401) {
        // The phone check expired (30 minutes): verify again.
        setIsPhoneVerified(false);
        setPhoneToken('');
      }
      // A price changed since the bag was filled: reload it, so the new total is shown before confirming.
      if (status === 409 && (data as { code?: string }).code === 'price_changed') await onPricesChanged();
      // Same-day closed while they were at checkout (past the cut-off): back to standard, total shown again.
      if (status === 409 && (data as { code?: string }).code === 'same_day_unavailable') setDeliveryOption('standard');
      setSubmitError(data.message || 'We could not place your order. Nothing was charged. Please try again.');
      return;
    }
    setConfirmedOrder(data.order);
    onOrderPlaced(data.order);
    try {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#c5a059', '#dfc082', '#0f1c2e', '#10b981'],
      });
    } catch {
      // ignore
    }
  };

  // SUCCESS CONFIRMATION SCREEN
  if (confirmedOrder) {
    const whatsappMessage = encodeURIComponent(
      `Hello Beautiful UAE Home! I have placed Order #${confirmedOrder.id} (${confirmedOrder.customer.fullName}) for AED ${confirmedOrder.total}. Payment method: ${confirmedOrder.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Bank Transfer'}. Please confirm dispatch.`
    );

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
        <div className="bg-white rounded-3xl max-w-lg w-full p-6 text-center shadow-2xl space-y-4 animate-in zoom-in-95 duration-200 border border-stone-200">
          <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto shadow-inner">
            <CheckCircle2 className="w-10 h-10" />
          </div>

          <div>
            <span className="text-xs font-semibold text-amber-800 bg-amber-100 px-3 py-1 rounded-full border border-amber-300">
              Order Confirmed & Logged
            </span>
            <h2 className="font-serif text-2xl font-bold text-[#0f1c2e] mt-2">
              Thank You for Your Order!
            </h2>
            <p className="text-xs text-stone-600 mt-1">
              Your luxury block linens are being prepared for fulfillment at our Dubai central warehouse.
            </p>
          </div>

          {/* Order Details Card */}
          <div className="bg-stone-50 rounded-2xl p-4 text-left border border-stone-200 space-y-2 text-xs">
            <div className="flex justify-between items-center pb-2 border-b border-stone-200">
              <span className="text-stone-500 font-medium">Order Number</span>
              <span className="font-mono font-bold text-sm text-[#0f1c2e]">{confirmedOrder.id}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-stone-500 font-medium">Delivery Destination</span>
              <span className="font-semibold text-stone-900">{confirmedOrder.customer.emirate} ({confirmedOrder.customer.area})</span>
            </div>

            {confirmedOrder.customer.gpsCoordinates && (
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-stone-500 font-medium">GPS Coordinates</span>
                <span className="font-mono text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                  {confirmedOrder.customer.gpsCoordinates.lat.toFixed(4)}°N, {confirmedOrder.customer.gpsCoordinates.lng.toFixed(4)}°E
                </span>
              </div>
            )}

            <div className="flex justify-between items-center">
              <span className="text-stone-500 font-medium">Delivery</span>
              <span className="font-bold text-[#c5a059] flex items-center gap-1">
                <span>{confirmedOrder.deliveryOption === 'same_day' ? `Same day (AED ${confirmedOrder.deliveryFee})` : `${confirmedOrder.courier.serviceability?.deliverySpeed || deliverySettings.standardDays}, free`}</span>
              </span>
            </div>


            <div className="flex justify-between items-center">
              <span className="text-stone-500 font-medium">Payment Mode</span>
              <span className="font-semibold text-stone-900 capitalize">
                {confirmedOrder.paymentMethod === 'cod' ? `Cash on Delivery (AED ${confirmedOrder.total})` : 'Direct Bank Transfer'}
              </span>
            </div>

            <div className="flex justify-between items-center pt-2 border-t border-stone-200">
              <span className="font-bold text-stone-800">Total Payable</span>
              <span className="font-bold text-base text-[#0f1c2e]">AED {confirmedOrder.total}</span>
            </div>
          </div>

          {/* WhatsApp Direct Notification */}
          <div className="pt-2 flex flex-col sm:flex-row gap-2">
            {/* The shop's WhatsApp number from Settings → Store & contact (hidden when none is set). */}
            {shopWhatsApp && (
              <a
                href={`https://wa.me/${shopWhatsApp}?text=${whatsappMessage}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all shadow"
              >
                <MessageCircle className="w-4 h-4" />
                <span>Send WhatsApp Order Update</span>
              </a>
            )}

            <button
              onClick={onClose}
              className="bg-stone-900 hover:bg-stone-800 text-white font-semibold text-xs py-3 px-5 rounded-xl transition-all"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-md p-0 sm:p-4 overflow-y-auto">
      <div className="bg-white text-stone-900 w-full max-w-xl sm:rounded-3xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl border border-stone-200">
        
        {/* Header */}
        <div className="px-4 py-3.5 border-b border-stone-200 flex items-center justify-between bg-stone-50">
          <div>
            <h2 className="font-serif font-bold text-base text-[#0f1c2e]">
              Fast UAE Checkout
            </h2>
            <p className="text-[11px] text-stone-600">
              Handprinted & Machine-Printed Bed Linens • Delivery across the UAE
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close checkout"
            className="p-1.5 text-stone-500 hover:text-stone-800 rounded-full hover:bg-stone-200 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Form */}
        <form onSubmit={handleSubmitOrder} className="p-4 overflow-y-auto space-y-5 flex-1">
          {/* Order Summary Strip */}
          <div className="bg-stone-50 rounded-2xl p-3 border border-stone-200 flex items-center justify-between text-xs">
            <div>
              <span className="font-bold text-stone-900">{items.length} Bedding Sets in Bag</span>
              <div className="text-[10px] text-stone-600 mt-0.5">
                {items.map((i) => `${i.quantity}x ${i.selectedProfile.name.split(' ')[0]}`).join(' • ')}
              </div>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-stone-500 block">Total Due</span>
              <span id="checkout-total" className="text-base font-bold text-[#0f1c2e]">AED {grandTotal}</span>
              {sameDayChosen && <span className="text-[10px] text-stone-500 block">incl. same-day AED {formatAed(deliveryFils)}</span>}
            </div>
          </div>

          {/* Section 1: Contact Details & Customer OTP Verification */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-stone-200 pb-1.5">
              <h3 className="text-xs font-bold text-stone-900 uppercase tracking-wider flex items-center gap-1.5">
                <span>1. Customer & Phone OTP</span>
              </h3>
              {isPhoneVerified ? (
                <span className="text-[10px] font-bold text-emerald-800 bg-emerald-100 px-2.5 py-0.5 rounded-full flex items-center gap-1 border border-emerald-300">
                  <Check className="w-3 h-3 text-emerald-600" />
                  <span>Mobile Verified</span>
                </span>
              ) : (
                <span className="text-[10px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                  UAE Mobile Verification
                </span>
              )}
            </div>

            {hasSavedDetails && (
              <p className="text-[11px] text-stone-500">
                Your details from last time are filled in.{' '}
                <button type="button" className="underline font-semibold" onClick={forgetDetails}>
                  Not you? Clear them
                </button>
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-stone-800 font-semibold mb-1">
                  Full Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Fatima Al Mansoori"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                />
              </div>

              <PhoneVerification
                supportEmail={supportEmail}
                verification={phoneVerification}
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
                <label className="block text-stone-800 font-semibold mb-1">
                  Email Address <span className="text-stone-500 font-normal">(Optional for order tracking receipt)</span>
                </label>
                <input
                  type="email"
                  placeholder="name@domain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                />
              </div>
            </div>
          </div>

          {/* Section 2: UAE Delivery Address with GPS Pin Drop & Map Selector */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-stone-200 pb-1.5">
              <h3 className="text-xs font-bold text-stone-900 uppercase tracking-wider flex items-center gap-1.5">
                <span>2. UAE Delivery Address & GPS Pin</span>
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUseCurrentLocation}
                  disabled={isLocating}
                  className="text-[11px] font-bold text-[#0f1c2e] bg-amber-100 hover:bg-amber-200 border border-amber-300 px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors"
                >
                  <Navigation className={`w-3 h-3 text-amber-700 ${isLocating ? 'animate-spin' : ''}`} />
                  <span>{isLocating ? 'Locating...' : 'Use My GPS'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowMapPicker(!showMapPicker)}
                  className="text-[11px] font-bold text-stone-800 bg-white hover:bg-stone-100 border border-stone-300 px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors"
                >
                  <MapPin className="w-3 h-3 text-[#c5a059]" />
                  <span>{showMapPicker ? 'Close Map' : 'Drop Pin on Map'}</span>
                </button>
              </div>
            </div>

            {/* GPS Location Notice Pill */}
            {locationNotice && (
              <div role="status" className={`text-[11px] p-2.5 rounded-xl border ${locationProblem ? 'bg-amber-50 text-amber-900 border-amber-200' : 'bg-emerald-50 text-emerald-900 border-emerald-200'}`}>
                <span className="font-semibold">{locationNotice}</span>
              </div>
            )}

            {/* INTERACTIVE UAE MAP PIN DROP SELECTOR */}
            {showMapPicker && (
              <div className="bg-gradient-to-b from-stone-50 to-stone-100 p-3.5 rounded-2xl border border-stone-300 space-y-3 animate-in fade-in-50 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Crosshair className="w-4 h-4 text-[#c5a059]" />
                    <strong className="text-stone-900 text-xs">UAE Delivery Map Pin Selector</strong>
                  </div>
                  <span className="text-[10px] text-stone-500">Tap any community or drop pin</span>
                </div>

                {/* Quick Presets for Popular UAE Communities */}
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-1 bg-white rounded-xl border border-stone-200">
                  {UAE_KEY_LOCATIONS.map((loc) => {
                    const isSelected = area === loc.name;
                    return (
                      <button
                        key={loc.name}
                        type="button"
                        onClick={() => handleSelectMapLocation(loc)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1 ${
                          isSelected
                            ? 'bg-[#0f1c2e] text-white shadow-xs'
                            : 'bg-stone-50 text-stone-700 hover:bg-amber-50 hover:text-amber-900 border border-stone-200'
                        }`}
                      >
                        <MapPin className={`w-3 h-3 ${isSelected ? 'text-amber-300' : 'text-[#c5a059]'}`} />
                        <span>{loc.name}</span>
                        <span className="text-[9px] opacity-70">({loc.emirate})</span>
                      </button>
                    );
                  })}
                </div>

                {/* Visual UAE Coordinate Display */}
                <div className="bg-white p-2.5 rounded-xl border border-stone-200 flex items-center justify-between text-[11px]">
                  <span className="text-stone-500 font-medium">Selected GPS Coordinates:</span>
                  <span className="font-mono font-bold text-stone-900">
                    {gpsCoordinates
                      ? `${gpsCoordinates.lat.toFixed(4)}°N, ${gpsCoordinates.lng.toFixed(4)}°E`
                      : '25.1972°N, 55.2744°E (Dubai Central)'}
                  </span>
                </div>
              </div>
            )}

            {/* Address Input Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-stone-800 font-semibold mb-1">
                  Emirate <span className="text-red-500">*</span>
                </label>
                <select
                  value={emirate}
                  onChange={(e) => setEmirate(e.target.value as Emirate)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                >
                  {UAE_EMIRATES.map((em) => (
                    <option key={em} value={em}>
                      {em}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-stone-800 font-semibold mb-1">
                  Area / Neighborhood <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  list="area-suggestions"
                  placeholder="e.g. Dubai Marina, Saadiyat, JVC"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                />
                <datalist id="area-suggestions">
                  {(UAE_POPULAR_AREAS[emirate] || []).map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
              </div>

              <div className="sm:col-span-2">
                <label className="block text-stone-800 font-semibold mb-1">
                  Street Address <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Street name, road, or community number"
                  value={streetAddress}
                  onChange={(e) => setStreetAddress(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                />
              </div>

              <div>
                <label className="block text-stone-800 font-semibold mb-1">
                  Building / Villa Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Marina Gate 1 or Villa 24"
                  value={buildingVilla}
                  onChange={(e) => setBuildingVilla(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                />
              </div>

              <div>
                <label className="block text-stone-800 font-semibold mb-1">
                  Flat / Apartment / Villa # <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Apt 1402 or Villa 24"
                  value={flatVillaNo}
                  onChange={(e) => setFlatVillaNo(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-stone-800 font-semibold mb-1">
                  Nearest Landmark <span className="text-stone-500 font-normal">(Crucial for courier driver pinpoint)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Near Spinneys, Behind Mall of the Emirates, Opposite Park"
                  value={landmark}
                  onChange={(e) => setLandmark(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
                />
              </div>
            </div>

            {/* Delivery: from the address; the courier is chosen behind the scenes */}
            <div className={`p-3.5 rounded-2xl border text-xs space-y-2.5 ${delivery.serviceable ? 'bg-emerald-50/80 border-emerald-200' : 'bg-red-50 border-red-200'}`} role="status" aria-live="polite">
              <div className="flex items-center gap-2">
                {delivery.serviceable ? (
                  <span className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0"><Check className="w-4 h-4" /></span>
                ) : (
                  <AlertCircle className="w-5 h-5 text-red-600 shrink-0" />
                )}
                <div>
                  <div className={`font-bold ${delivery.serviceable ? 'text-emerald-900' : 'text-red-800'}`}>{delivery.message}</div>
                  {delivery.serviceable && <div className="text-stone-600">Delivery in {delivery.days}, free</div>}
                </div>
              </div>
              {delivery.serviceable && deliverySettings.sameDayEnabled && (
                <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <legend className="sr-only">Delivery speed</legend>
                  <label className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer ${!sameDayChosen ? 'border-[#0f1c2e] bg-white' : 'border-stone-200 bg-white/60'}`}>
                    <input type="radio" name="delivery-option" className="mt-0.5" checked={!sameDayChosen} onChange={() => setDeliveryOption('standard')} />
                    <span>
                      <strong className="block text-stone-900">Standard · free</strong>
                      <span className="text-stone-500">{delivery.days}</span>
                    </span>
                  </label>
                  <label className={`flex items-start gap-2 p-2.5 rounded-xl border ${delivery.sameDay.available ? 'cursor-pointer' : 'opacity-60'} ${sameDayChosen ? 'border-[#0f1c2e] bg-white' : 'border-stone-200 bg-white/60'}`}>
                    <input type="radio" name="delivery-option" className="mt-0.5" checked={sameDayChosen} disabled={!delivery.sameDay.available} onChange={() => setDeliveryOption('same_day')} />
                    <span>
                      <strong className="block text-stone-900">Same day · +AED {formatAed(toFils(delivery.sameDay.fee))}</strong>
                      <span className="text-stone-500">{delivery.sameDay.available ? `Order before ${delivery.sameDay.cutoff}` : delivery.sameDay.reason}</span>
                    </span>
                  </label>
                </fieldset>
              )}
            </div>
          </div>

          {/* Section 3: Payment Method Selection */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-stone-900 uppercase tracking-wider flex items-center gap-1.5 border-b border-stone-200 pb-1.5">
              <span>3. Payment Options</span>
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Option 1: Cash On Delivery */}
              <div
                onClick={() => setPaymentMethod('cod')}
                className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                  paymentMethod === 'cod'
                    ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-md'
                    : 'border-stone-300 bg-white text-stone-800 hover:border-stone-400'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Banknote className={`w-5 h-5 ${paymentMethod === 'cod' ? 'text-amber-300' : 'text-[#c5a059]'}`} />
                    <span className="text-xs font-bold">Cash on Delivery</span>
                  </div>
                  {paymentMethod === 'cod' && <Check className="w-4 h-4 text-amber-300" />}
                </div>
                <p className={`text-[11px] leading-relaxed ${paymentMethod === 'cod' ? 'text-stone-300' : 'text-stone-600'}`}>
                  Pay conveniently in cash to our courier driver upon doorstep delivery across all 7 Emirates.
                </p>
                <div className="mt-2 text-[10px] text-amber-300 font-medium">
                  Doorstep Cash Collection Available
                </div>
              </div>

              {/* Option 2: Account / Bank Transfer (only once the shop's real account is entered) */}
              {bankReady && <div
                onClick={() => setPaymentMethod('bank_transfer')}
                className={`p-3.5 rounded-2xl border cursor-pointer transition-all ${
                  paymentMethod === 'bank_transfer'
                    ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-md'
                    : 'border-stone-300 bg-white text-stone-800 hover:border-stone-400'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Building2 className={`w-5 h-5 ${paymentMethod === 'bank_transfer' ? 'text-amber-300' : 'text-[#c5a059]'}`} />
                    <span className="text-xs font-bold">Account / Bank Transfer</span>
                  </div>
                  {paymentMethod === 'bank_transfer' && <Check className="w-4 h-4 text-amber-300" />}
                </div>
                <p className={`text-[11px] leading-relaxed ${paymentMethod === 'bank_transfer' ? 'text-stone-300' : 'text-stone-600'}`}>
                  Transfer directly to our {bank.bankName} account with fast receipt verification.
                </p>
                <div className="mt-2 text-[10px] text-amber-300 font-medium">
                  Prepaid Express Priority Dispatch
                </div>
              </div>}
            </div>

            {/* If Bank Transfer Selected: Show UAE Bank Details & Receipt Uploader */}
            {paymentMethod === 'bank_transfer' && bankReady && (
              <div className="bg-amber-50/70 rounded-2xl p-4 border border-amber-200/90 space-y-3 animate-in fade-in-50 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-stone-900 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-[#c5a059]" />
                    <span>{bank.bankName} Bank Details</span>
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyIban}
                    className="flex items-center gap-1 text-[11px] text-[#0f1c2e] font-semibold bg-white border border-stone-300 px-2.5 py-1 rounded-lg hover:bg-stone-50 transition-colors"
                  >
                    {copiedIban ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedIban ? 'IBAN Copied!' : 'Copy IBAN'}</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-white p-3 rounded-xl border border-amber-200 text-[11px]">
                  <div>
                    <span className="text-stone-400 block">Bank Name</span>
                    <strong className="text-stone-800">{bank.bankName}</strong>
                  </div>
                  <div>
                    <span className="text-stone-400 block">Account Name</span>
                    <strong className="text-stone-800">{bank.accountName}</strong>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-stone-400 block">IBAN Number</span>
                    <strong className="font-mono text-stone-900 text-xs">{bank.iban}</strong>
                  </div>
                  <div>
                    <span className="text-stone-400 block">Account Number</span>
                    <strong className="font-mono text-stone-800">{bank.accountNumber}</strong>
                  </div>
                  <div>
                    <span className="text-stone-400 block">SWIFT Code</span>
                    <strong className="font-mono text-stone-800">{bank.swiftCode}</strong>
                  </div>
                </div>

                {bank.instructions && <p className="text-[11px] text-stone-700 leading-relaxed">{bank.instructions}</p>}

                {/* Optional Reference or Receipt Upload */}
                <div className="space-y-2 pt-1">
                  <div>
                    <label className="block text-stone-800 font-semibold mb-1">
                      Bank Transfer Reference / Transaction ID:
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. ENBD-TX-849201948"
                      value={bankRef}
                      onChange={(e) => setBankRef(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 font-medium focus:outline-none focus:ring-1 focus:ring-[#c5a059] text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-stone-800 font-semibold mb-1">
                      Attach Transfer Receipt / Screenshot:
                    </label>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-1.5 px-3 py-2 bg-white border border-stone-300 rounded-xl cursor-pointer hover:bg-stone-50 text-stone-700 text-xs font-semibold">
                        <Upload className="w-3.5 h-3.5 text-[#c5a059]" />
                        <span>Upload Screenshot</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,application/pdf"
                          onChange={handleReceiptUpload}
                          className="hidden"
                        />
                      </label>
                      {receiptUrl && (
                        <span className="text-emerald-700 font-bold text-xs flex items-center gap-1">
                          <Check className="w-3.5 h-3.5" />
                          Receipt Attached
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sticky Checkout Button */}
          <div className="pt-2 space-y-2">
            {submitError && (
              <p role="alert" className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 font-medium">
                {submitError}
              </p>
            )}
            <button
              type="submit"
              disabled={isSubmitting || !delivery.serviceable || !isPhoneVerified}
              className="w-full bg-[#0f1c2e] hover:bg-stone-800 active:scale-95 text-white font-bold text-sm py-4 rounded-xl shadow-xl flex items-center justify-center gap-2 transition-all disabled:opacity-50"
            >
              {isSubmitting ? (
                <span>Generating Order Requisition...</span>
              ) : !isPhoneVerified ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-amber-300" />
                  <span>Verify your UAE mobile to place order</span>
                </>
              ) : (
                <>
                  <span>
                    Confirm & Raise Order • AED {grandTotal}
                  </span>
                  <ArrowRight className="w-4 h-4 text-amber-300" />
                </>
              )}
            </button>
            <p className="text-[10px] text-center text-stone-600 mt-2">
              Delivered to your door, with a tracking link as soon as it ships.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};
