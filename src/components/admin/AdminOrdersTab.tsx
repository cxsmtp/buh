'use client';

import React, { useState } from 'react';
import { BankTransferDetails, Order, CourierProvider, CourierSettings } from '@/types';
import { ShippingLabelModal } from './ShippingLabelModal';
import { 
  CheckCircle2, 
  Truck, 
  Printer, 
  MessageCircle, 
  Clock, 
  AlertCircle, 
  Calendar, 
  ExternalLink, 
  Package, 
  Eye, 
  ChevronRight,
  ShieldCheck,
  Building2,
  Banknote,
  CreditCard,
  X,
} from 'lucide-react';
import { postJson, safeHref, safeLinkHref, sendJson } from '@/lib/apiClient';
import { awaitingWhatsApp, heldForWhatsApp, OrderTimeline, OrderWhatsAppCheck } from './OrderWhatsAppCheck';
import { OrderBankTransfer, transferToCheck } from './OrderBankTransfer';
import { DEFAULT_PACKAGING_GRAMS, shipmentWeight } from '@/lib/shipmentWeight';
import { aed2, BLOCKED_MESSAGE, carrierLabel, ECO_LIVE_NOT_CONNECTED, jeeblyMode, LIVE_OFF_WARNING } from '@/lib/courierMode';
import { EnterTrackingDialog } from './EnterTrackingDialog';

interface AdminOrdersTabProps {
  orders: Order[];
  /** An order changed on the server (status, payment, courier): replace it in the list. */
  onOrderChanged: (order: Order) => void;
  courierSettings: CourierSettings;
  /** The shop's bank account (Settings), for the "Send bank details on WhatsApp" message. */
  bank?: BankTransferDetails;
  shopName?: string;
  /** Which courier keys are saved (Couriers), to say whether a booking is real or a test. */
  courierSecretsSet?: Record<string, boolean>;
}

/** How a booking with this courier goes now (src/lib/courierMode.ts), for the dispatch dialog. */
export type BookingMode = 'live' | 'sandbox' | 'practice' | 'blocked' | 'not_connected';
export function bookingModeOf(provider: CourierProvider, settings: CourierSettings, secretsSet: Record<string, boolean> = {}): BookingMode {
  if (provider === 'echo') return settings.echo.isLive ? 'not_connected' : 'practice';
  return jeeblyMode({
    isLive: settings.jeebly.isLive,
    hasLiveKeys: Boolean(secretsSet['jeebly.apiKey'] && secretsSet['jeebly.clientKey']),
    hasSandboxKeys: Boolean(secretsSet['jeebly.sandboxApiKey'] && secretsSet['jeebly.sandboxClientKey']),
  });
}

/** A booking the carrier really has (not a test, not an unanswered attempt). */
export function realBooking(order: Order): boolean {
  return order.courier.bookingState === 'booked' && !order.courier.simulated && Boolean(order.courier.awbNumber);
}

/** The customer's WhatsApp update, from what is real: an AWB and link only for a real booking. */
export function whatsAppUpdateText(order: Order, shopName = 'Beautiful UAE Home'): string {
  const c = order.courier;
  const pay = order.paymentMethod === 'cod' ? `Cash on delivery: AED ${aed2(order.total)}` : `Total: AED ${aed2(order.total)} (prepaid${order.cardFee ? `, incl. card payment fee AED ${aed2(order.cardFee)}` : ''})`;
  const lines = [`Dear ${order.customer.fullName}, greetings from ${shopName}!`, ''];
  if (realBooking(order)) {
    lines.push(`Your order ${order.id} is booked with ${carrierLabel(c.provider, c.carrierName)}.`, `Tracking number (AWB): ${c.awbNumber}`);
    if (c.trackingUrl) lines.push(`Track it: ${c.trackingUrl}`);
  } else if (order.status === 'dispatched' || order.status === 'out_for_delivery') {
    lines.push(`Your order ${order.id} is with our delivery team. We will send the tracking number as soon as the courier has it.`);
  } else {
    lines.push(`Your order ${order.id} is confirmed and being prepared for delivery. We will send the tracking number once it is booked with the courier.`);
  }
  lines.push(pay, '', `Thank you for shopping with ${shopName}!`);
  return lines.join('\n');
}

const MODE_TEXT: Record<BookingMode, { tone: 'success' | 'warning' | 'danger'; label: string; text: string }> = {
  live: { tone: 'success', label: 'Live', text: 'Live mode: this books a real shipment with the courier.' },
  sandbox: { tone: 'warning', label: 'Test (sandbox)', text: "Test mode: a test shipment in Jeebly's sandbox. Not a real shipment, and the customer sees no tracking." },
  practice: { tone: 'warning', label: 'Test (practice)', text: 'Test mode: a practice booking. Nothing is sent to the courier, and the customer sees no tracking.' },
  blocked: { tone: 'danger', label: 'Test – no test keys', text: BLOCKED_MESSAGE },
  not_connected: { tone: 'danger', label: 'Not connected', text: ECO_LIVE_NOT_CONNECTED },
};

/** Statuses where a courier can be booked or a tracking number entered (src/lib/server/orders.ts). */
const SHIPPING_STATUSES: Order['status'][] = ['confirmed', 'dispatched', 'out_for_delivery'];

/** A card order's payment, as the hub shows it (only Stripe's word moves it: src/lib/server/payments.ts). */
export function cardBadge(order: Order): { text: string; tone: 'success' | 'warning' | 'danger' | 'muted' } | null {
  const c = order.card;
  if (order.paymentMethod !== 'online_card' || !c) return null;
  if (c.state === 'paid' && c.refundOutsideAt) return { text: `Paid by card · cancelled without a Stripe refund: refund AED ${cardLeft(order)} in the Stripe dashboard`, tone: 'danger' };
  if (c.state === 'paid') return { text: `Paid by card${c.label ? ` · ${c.label}` : ''}${c.refundedAmount ? ` · AED ${c.refundedAmount} refunded in Stripe` : ''}`, tone: 'success' };
  if (c.state === 'pending') return { text: 'Waiting for the card payment', tone: 'warning' };
  if (c.state === 'failed') return { text: 'Card declined: the customer may try again', tone: 'warning' };
  if (c.state === 'refund_pending') return { text: `Refund of AED ${c.paidAmount ?? order.total} on its way to the card`, tone: 'warning' };
  if (c.state === 'refunded') return { text: `Refunded AED ${c.paidAmount ?? order.total} to the card`, tone: 'muted' };
  return { text: 'Card payment not taken (cancelled)', tone: 'muted' };
}

/** What is left to refund of a card payment (paid, less a partial refund made in Stripe's dashboard), in AED. */
export function cardLeft(order: Order): number {
  return Math.max(0, Math.round(((order.card?.paidAmount ?? order.total) - (order.card?.refundedAmount ?? 0)) * 100)) / 100;
}

const TONES = {
  success: 'bg-success-soft text-success border-success-line',
  warning: 'bg-warning-soft text-warning border-warning-line',
  danger: 'bg-danger-soft text-danger border-danger-line',
  muted: 'bg-sand text-ink-soft border-line',
};

/** Status moves the server allows (src/lib/server/orders.ts), with their button labels. */
const NEXT_ACTIONS: Partial<Record<Order['status'], Array<{ to: Order['status']; label: string }>>> = {
  confirmed: [{ to: 'dispatched', label: 'Mark dispatched' }],
  dispatched: [
    { to: 'out_for_delivery', label: 'Out for delivery' },
    { to: 'delivered', label: 'Mark delivered' },
  ],
  out_for_delivery: [{ to: 'delivered', label: 'Mark delivered' }],
};

export const AdminOrdersTab: React.FC<AdminOrdersTabProps> = ({
  orders,
  onOrderChanged,
  courierSettings,
  bank,
  shopName,
  courierSecretsSet = {},
}) => {
  const [busyOrderId, setBusyOrderId] = useState('');

  const patchOrder = async (order: Order, changes: Partial<Pick<Order, 'status' | 'paymentStatus' | 'adminNotes'>> & { clearAttention?: true; shipUnconfirmed?: true }, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyOrderId(order.id);
    let { ok, data } = await sendJson<{ order?: Order; message?: string; code?: string }>('PATCH', `/api/admin/orders/${encodeURIComponent(order.id)}`, changes);
    // Not confirmed on WhatsApp yet: only on the owner's explicit "ship anyway" (the server records it).
    if (!ok && data.code === 'whatsapp_unconfirmed' && window.confirm(data.message || "This customer hasn't confirmed on WhatsApp yet — ship anyway?")) {
      ({ ok, data } = await sendJson<{ order?: Order; message?: string; code?: string }>('PATCH', `/api/admin/orders/${encodeURIComponent(order.id)}`, { ...changes, shipUnconfirmed: true }));
    } else if (!ok && data.code === 'whatsapp_unconfirmed') {
      setBusyOrderId('');
      return;
    }
    setBusyOrderId('');
    if (ok && data.order) onOrderChanged(data.order);
    else alert(data.message || 'The order could not be updated.');
    // Cancelled with a Jeebly booking: what Jeebly said (a refusal means: cancel it in the portal).
    const carrier = (data as { carrierCancel?: { message?: string } }).carrierCancel;
    if (ok && carrier?.message) alert(carrier.message);
  };

  /** "Refresh tracking": Jeebly's status and events now (shown only; the owner marks delivered). */
  const [tracking, setTracking] = useState<Record<string, { lastStatus: string; events: Array<{ status: string; desc: string; hub: string; at: string }> } | { error: string }>>({});
  const refreshTracking = async (order: Order) => {
    setBusyOrderId(order.id);
    const res = await fetch(`/api/admin/orders/${encodeURIComponent(order.id)}/carrier-tracking`, { credentials: 'same-origin' }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setBusyOrderId('');
    setTracking((t) => ({ ...t, [order.id]: res?.ok && data.tracking ? data.tracking : { error: data.message || 'Could not reach Jeebly.' } }));
  };

  /** "Cancel & refund AED X": refunds what is left through Stripe, recorded from Stripe's answer; the order is cancelled. */
  const refundOrder = async (order: Order) => {
    const amount = cardLeft(order);
    const left = ['dispatched', 'out_for_delivery'].includes(order.status);
    if (
      !window.confirm(
        `Refund AED ${amount} to the customer's card and cancel ${order.id}?` +
          (order.status === 'cancelled' ? '' : left ? ' It has left with the courier, so its pieces are NOT put back on sale.' : ' Its items go back into stock.') +
          ' This cannot be undone.'
      )
    )
      return;
    setBusyOrderId(order.id);
    const { ok, data } = await postJson<{ order?: Order; message?: string; code?: string; carrierCancel?: { message?: string } }>(`/api/admin/orders/${encodeURIComponent(order.id)}/refund`, { amount });
    setBusyOrderId('');
    if (ok && data.carrierCancel?.message) alert(data.carrierCancel.message);
    if (ok && data.order) return onOrderChanged(data.order);
    // The keys now saved can't reach this payment (switched between test and live): the owner may
    // cancel it here and refund it in the Stripe dashboard of the account it was paid to.
    if (data.code === 'card_unreachable') {
      if (
        !window.confirm(
          `${data.message}\n\nCancel ${order.id} without a Stripe refund? You then refund AED ${amount} yourself in the Stripe dashboard of the account it was paid to${order.card?.mode ? ` (${order.card.mode} mode)` : ''}.`
        )
      )
        return;
      setBusyOrderId(order.id);
      const second = await postJson<{ order?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/refund`, { amount, withoutStripeRefund: true, confirm: 'refund-in-stripe-dashboard' });
      setBusyOrderId('');
      if (second.ok && second.data.order) return onOrderChanged(second.data.order);
      return alert(second.data.message || 'The order could not be cancelled.');
    }
    alert(data.message || 'The refund could not be made.');
  };

  /** "Mark payment received" on a bank transfer: the server's checked, audited "Payment received". */
  const bankReceived = async (order: Order) => {
    if (!window.confirm(`Confirm that AED ${order.total} for ${order.id} has arrived in the bank account?`)) return;
    setBusyOrderId(order.id);
    const { ok, data } = await postJson<{ order?: Order; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/bank`, { result: 'received' });
    setBusyOrderId('');
    if (ok && data.order) onOrderChanged(data.order);
    else alert(data.message || 'Not saved. Please try again.');
  };

  /** "Mark as handled" on a note that needed the owner (a failed refund, a booking after a cancel…). */
  const handled = (order: Order) => patchOrder(order, { clearAttention: true });

  const [filter, setFilter] = useState<'all' | 'pending' | 'whatsapp' | 'transfer' | 'card' | 'confirmed' | 'dispatched'>('all');
  // Orders the owner has just answered stay in "Awaiting WhatsApp" (or "Transfer to check") for now, so the reply link is right there.
  const [justChecked, setJustChecked] = useState<string[]>([]);
  const whatsappChecked = (o: Order) => {
    setJustChecked((ids) => (ids.includes(o.id) ? ids : [...ids, o.id]));
    onOrderChanged(o);
  };
  const [selectedOrderForConfirm, setSelectedOrderForConfirm] = useState<Order | null>(null);
  const [labelOrder, setLabelOrder] = useState<Order | null>(null);
  const [trackingOrder, setTrackingOrder] = useState<Order | null>(null);
  const modeFor = (provider: CourierProvider) => bookingModeOf(provider, courierSettings, courierSecretsSet);
  const liveKeysSaved = Boolean(courierSecretsSet['jeebly.apiKey'] && courierSecretsSet['jeebly.clientKey']);

  // Confirmation Modal Form State
  const [chosenCourier, setChosenCourier] = useState<CourierProvider>('jeebly');
  const [pickupDate, setPickupDate] = useState<string>('');
  // Kilograms as typed ('' while unknown: a size has no weight, never a silent default).
  const [weightKg, setWeightKg] = useState<string>('');
  const [pieces, setPieces] = useState<number>(1);
  const [adminNotes, setAdminNotes] = useState<string>('');
  const [isDispatching, setIsDispatching] = useState<boolean>(false);

  const filteredOrders = orders.filter((o) => {
    if (filter === 'pending') return o.status === 'pending_confirmation';
    if (filter === 'whatsapp') return awaitingWhatsApp(o) || justChecked.includes(o.id);
    if (filter === 'transfer') return transferToCheck(o) || justChecked.includes(o.id);
    if (filter === 'card') return o.paymentMethod === 'online_card';
    if (filter === 'confirmed') return o.status === 'confirmed';
    if (filter === 'dispatched') return o.status === 'dispatched';
    return true;
  });

  const openConfirmationModal = (order: Order) => {
    setSelectedOrderForConfirm(order);
    
    // Auto-select smart courier:
    // COD -> Jeebly
    // Prepaid -> Eco Express
    const defaultProvider: CourierProvider = order.deliveryOption === 'same_day'
      ? 'jeebly' // Eco Express books next-day only
      : order.paymentMethod === 'cod'
      ? courierSettings.autoAssignRules.codCourier || 'jeebly'
      : courierSettings.autoAssignRules.prepaidCourier || 'echo';

    setChosenCourier(defaultProvider);
    setPickupDate(order.courier.pickupDate || new Date(Date.now() + 86400000).toISOString().split('T')[0]);
    const w = shipmentWeight(order, courierSettings.packagingGrams ?? DEFAULT_PACKAGING_GRAMS);
    setWeightKg(w.kg !== null ? String(w.kg) : order.courier.weightKg > 0 ? String(order.courier.weightKg) : '');
    setPieces(order.courier.pieces || 1);
    setAdminNotes(order.adminNotes || '');
  };

  const handleConfirmAndDispatch = async () => {
    if (!selectedOrderForConfirm) return;
    const o = selectedOrderForConfirm;
    // The weight goes to Jeebly: never a guess (a practice booking sends nothing).
    if (chosenCourier === 'jeebly' && ['live', 'sandbox'].includes(modeFor('jeebly')) && !(Number(weightKg) > 0)) {
      alert('Enter the parcel weight (kg) first: some sizes in this order have no weight yet.');
      return;
    }
    if (
      o.paymentMethod === 'bank_transfer' &&
      o.paymentStatus !== 'verified' &&
      o.paymentStatus !== 'paid' &&
      !window.confirm(`The bank transfer for ${o.id} (AED ${o.total}) is not marked as received yet. Book the courier anyway?`)
    ) {
      return;
    }
    setIsDispatching(true);

    // The server reads the order and the courier keys itself; only the booking details go up.
    const request = {
      orderId: selectedOrderForConfirm.id,
      provider: chosenCourier,
      pickupDate,
      weightKg: weightKg.trim() === '' ? undefined : Number(weightKg),
      pieces,
      adminNotes,
    };
    type DispatchReply = { success?: boolean; message?: string; code?: string; awbNumber?: string; isSimulated?: boolean; testKind?: string; needsConfirm?: boolean; needsTestConfirm?: boolean; alreadyBooked?: boolean; order?: Order };
    const mode = modeFor(chosenCourier);
    const courierName = carrierLabel(chosenCourier);
    // Not Live: a test booking only on the owner's explicit yes (the server asks again if not given).
    const confirmTest = () =>
      window.confirm(
        `${MODE_TEXT[mode === 'sandbox' ? 'sandbox' : 'practice'].text}\n\nMake a TEST booking for ${o.id}? Nothing reaches ${courierName} for real.` +
          (chosenCourier === 'jeebly' && liveKeysSaved ? `\n\n${LIVE_OFF_WARNING}` : '')
      );
    if (mode === 'sandbox' || mode === 'practice') {
      if (!confirmTest()) {
        setIsDispatching(false);
        return;
      }
      Object.assign(request, { testBooking: true });
    }
    let { ok, status, data } = await postJson<DispatchReply>('/api/courier/dispatch', request);
    if (status === 409 && data.needsTestConfirm) {
      if (!confirmTest()) {
        setIsDispatching(false);
        return;
      }
      Object.assign(request, { testBooking: true });
      ({ ok, status, data } = await postJson<DispatchReply>('/api/courier/dispatch', request));
    }
    // The customer hasn't confirmed on WhatsApp (cash on delivery, no code): the owner may have
    // confirmed by phone, so ask; "ship anyway" is recorded in the order's history and the audit log.
    if (status === 409 && data.code === 'whatsapp_unconfirmed') {
      if (!window.confirm(`${data.message || "This customer hasn't confirmed on WhatsApp yet — ship anyway?"}\n\nTip: if you confirmed by phone, tap “Confirmed by phone call” on the order instead.`)) {
        setIsDispatching(false);
        return;
      }
      Object.assign(request, { shipUnconfirmed: true });
      ({ ok, status, data } = await postJson<DispatchReply>('/api/courier/dispatch', request));
    }
    // The last attempt got no answer from the carrier: only re-book once the owner has checked the portal.
    if (status === 409 && data.needsConfirm) {
      if (!window.confirm(`${data.message}\n\nBook again now?`)) {
        setIsDispatching(false);
        return;
      }
      ({ ok, status, data } = await postJson<DispatchReply>('/api/courier/dispatch', { ...request, rebook: true }));
    }
    setIsDispatching(false);
    if (data.order) onOrderChanged(data.order);
    if (data.alreadyBooked) alert(data.message);

    // Never treat an order as booked without a real AWB from the server.
    if (!ok || !data.success || !data.awbNumber || !data.order) {
      alert(`Courier booking failed: ${data.message || 'please check the courier settings and try again.'}`);
      return;
    }
    setSelectedOrderForConfirm(null);
    if (data.isSimulated) {
      alert(
        `TEST booking made (${data.awbNumber}). It was NOT sent to ${courierName}: nobody will collect the parcel, and the customer sees no tracking.` +
          (chosenCourier === 'jeebly'
            ? '\n\nTo ship for real: run the Sandbox check and turn on Live mode in Couriers, then use “Book for real” on the order; or book in the Jeebly portal and use “Enter tracking number”.'
            : '\n\nTo ship: book in the Eco Express portal and use “Enter tracking number” on the order.')
      );
    }
    setLabelOrder(data.order);
  };

  const sendWhatsAppUpdate = (order: Order) => {
    const text = encodeURIComponent(whatsAppUpdateText(order, shopName || undefined));
    window.open(`https://wa.me/${order.customer.phone.replace(/[^0-9]/g, '')}?text=${text}`, '_blank');
  };

  return (
    <div className="space-y-4">
      {/* Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
        {[
          { id: 'all', label: 'All Orders' },
          { id: 'pending', label: 'Needs Confirmation' },
          { id: 'whatsapp', label: 'Awaiting WhatsApp' },
          { id: 'transfer', label: 'Transfer to check' },
          { id: 'card', label: 'Card payments' },
          { id: 'confirmed', label: 'Confirmed & AWB Ready' },
          { id: 'dispatched', label: 'Dispatched / In Transit' },
        ].filter((tab) => (tab.id !== 'whatsapp' || orders.some((o) => o.whatsappCheck)) && (tab.id !== 'transfer' || orders.some((o) => o.bankTransfer)) && (tab.id !== 'card' || orders.some((o) => o.paymentMethod === 'online_card'))).map((tab) => {
          const count = orders.filter((o) => {
            if (tab.id === 'pending') return o.status === 'pending_confirmation';
            if (tab.id === 'whatsapp') return awaitingWhatsApp(o);
            if (tab.id === 'transfer') return transferToCheck(o);
            if (tab.id === 'card') return o.paymentMethod === 'online_card';
            if (tab.id === 'confirmed') return o.status === 'confirmed';
            if (tab.id === 'dispatched') return o.status === 'dispatched';
            return true;
          }).length;

          return (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id as typeof filter)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                filter === tab.id
                  ? 'bg-ink text-paper shadow-sm'
                  : 'bg-surface text-ink-soft hover:bg-sand border border-line'
              }`}
            >
              <span>{tab.label}</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                filter === tab.id ? 'bg-gold text-ink font-bold' : 'bg-sand-deep text-ink-soft'
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Orders List */}
      <div className="space-y-3">
        {filteredOrders.length === 0 ? (
          <div className="bg-surface rounded-2xl p-8 text-center border border-line text-ink-muted text-xs">
            No orders found under this filter.
          </div>
        ) : (
          filteredOrders.map((order) => {
            const isPending = order.status === 'pending_confirmation';
            const isCod = order.paymentMethod === 'cod';
            const isCard = order.paymentMethod === 'online_card';
            const card = cardBadge(order);
            const cardPaid = order.card?.state === 'paid';
            const cardUnpaid = order.card?.state === 'pending' || order.card?.state === 'failed';

            return (
              <div
                key={order.id}
                className="bg-surface rounded-2xl p-4 border border-line hover:border-line-strong shadow-sm space-y-3 transition-all"
              >
                {/* Top Strip */}
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line pb-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-sm text-ink">
                        {order.id}
                      </span>
                      {order.deliveryOption === 'same_day' && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-danger-soft text-danger border border-danger-line" title={`Same-day delivery (customer paid AED ${order.deliveryFee})`}>
                          Same day
                        </span>
                      )}
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          isPending
                            ? 'bg-warning-soft text-warning border border-warning-line'
                            : order.status === 'confirmed'
                            ? 'bg-success-soft text-success border border-success-line'
                            : 'bg-sand text-ink border border-line-strong'
                        }`}
                      >
                        {order.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      {new Date(order.createdAt).toLocaleString()} • {order.customer.fullName}
                      {order.source && order.source.source !== 'direct' && (
                        <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-sand text-ink-soft text-[10px] font-semibold capitalize" title={order.source.campaign ? `Campaign: ${order.source.campaign}` : 'Where the customer came from'}>
                          via {order.source.source}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Payment Mode Badge */}
                  <div className="text-right shrink-0 ml-auto">
                    <span className="text-base font-bold text-ink block">
                      AED {order.total}
                    </span>
                    {Boolean(order.cardFee) && (
                      <span data-testid="order-card-fee" className="text-[10px] text-ink-muted block">
                        incl. card fee{order.cardFeePercent ? ` ${order.cardFeePercent}%` : ''} AED {aed2(order.cardFee ?? 0)}
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md ${
                        isCod
                          ? 'bg-warning-soft text-warning border border-warning-line'
                          : 'bg-success-soft text-success border border-success-line'
                      }`}
                    >
                      {isCod ? <Banknote className="w-3 h-3" /> : isCard ? <CreditCard className="w-3 h-3" /> : <Building2 className="w-3 h-3" />}
                      <span>{isCod ? 'Cash on Delivery' : isCard ? 'Card (Stripe)' : 'Bank Transfer'}</span>
                    </span>
                  </div>
                </div>

                {/* Confirm on WhatsApp, and the bank transfer: first, so the owner sees them on the phone */}
                <OrderWhatsAppCheck order={order} onOrderChanged={whatsappChecked} shopName={shopName} />
                {bank && <OrderBankTransfer order={order} bank={bank} shopName={shopName} onOrderChanged={whatsappChecked} />}

                {/* Items & Delivery Info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {/* Items */}
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider block">
                      Bedding Ordered:
                    </span>
                    {order.items.map((i, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-ink">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={i.image} alt={i.title} className="w-6 h-6 rounded object-cover" />
                        <span className="truncate">
                          <strong>{i.quantity}x</strong> {i.title} ({i.mattressSize ? i.profileName.split(' ')[0] : i.profileName})
                          {i.sku && <span className="text-ink-muted font-mono text-[11px]"> · {i.sku}</span>}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Destination */}
                  <div className="space-y-1 sm:border-l sm:border-line sm:pl-3">
                    <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider block">
                      UAE Delivery Destination:
                    </span>
                    <div className="text-ink font-medium">
                      {order.customer.buildingVilla}, {order.customer.flatVillaNo}, {order.customer.area}
                    </div>
                    <div className="text-ink-muted text-[11px]">
                      Emirate: <strong>{order.customer.emirate}</strong> • Tel: {order.customer.phone}
                    </div>
                  </div>
                </div>

                {/* Courier Assignment Bar */}
                <div className="bg-ivory rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-2 text-xs border border-line/80">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <Truck className="w-4 h-4 text-gold" />
                    <span className="text-ink-soft">Courier:</span>
                    <strong className="text-ink">
                      {carrierLabel(order.courier.provider, order.courier.carrierName)}
                    </strong>
                    {order.courier.awbNumber && (
                      <span className={`font-mono text-[11px] px-2 py-0.5 rounded font-bold break-anywhere ${order.courier.simulated ? 'text-ink-soft bg-sand line-through decoration-1' : 'text-warning bg-warning-soft'}`}>
                        AWB: {order.courier.awbNumber}
                      </span>
                    )}
                    {order.courier.simulated && (
                      <span data-testid="test-booking-badge" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-danger-soft text-danger border border-danger-line">
                        Test booking – not sent to the courier
                      </span>
                    )}
                    {realBooking(order) && order.courier.enteredByHand && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sand text-ink-soft border border-line">Entered by hand</span>
                    )}
                    {order.courier.bookingState === 'uncertain' && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-warning-soft text-warning border border-warning-line">No answer from the courier – check its portal</span>
                    )}
                  </div>

                  {/* Status */}
                  <div className="text-[11px] text-ink-muted">
                    Pickup: <strong>{order.courier.pickupDate || 'Tomorrow'}</strong>
                  </div>
                </div>

                {/* Booked, or not yet: book with the courier, or type in a number from its portal */}
                {SHIPPING_STATUSES.includes(order.status) && !realBooking(order) && (
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    {order.courier.simulated && modeFor('jeebly') !== 'live' ? (
                      <span className="text-ink-muted">To book for real, run the Sandbox check and turn on Live mode in Couriers.</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openConfirmationModal(order)}
                        className="px-2 py-1 rounded-lg font-semibold border border-line-strong bg-ink text-paper hover:bg-ink-2"
                      >
                        {order.courier.simulated ? 'Book for real' : 'Book courier'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setTrackingOrder(order)}
                      className="px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand"
                    >
                      Enter tracking number
                    </button>
                  </div>
                )}
                {SHIPPING_STATUSES.includes(order.status) && realBooking(order) && (
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    {order.courier.provider === 'jeebly' && (
                      <button
                        type="button"
                        disabled={busyOrderId === order.id}
                        onClick={() => void refreshTracking(order)}
                        className="px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand disabled:opacity-50"
                      >
                        Refresh tracking
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setTrackingOrder(order)}
                      className="px-2 py-1 rounded-lg font-semibold border border-line bg-surface text-ink-soft hover:bg-sand"
                    >
                      Change tracking number
                    </button>
                    {safeHref(order.courier.trackingUrl) && (
                      <a href={safeHref(order.courier.trackingUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 rounded-lg font-semibold border border-line bg-surface text-ink-soft hover:bg-sand">
                        Tracking page <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                )}

                {tracking[order.id] && (
                  <div data-testid="carrier-tracking" role="status" className="rounded-xl border border-line bg-ivory p-2.5 text-[11px] space-y-1">
                    {'error' in tracking[order.id] ? (
                      <span className="text-danger font-semibold">{(tracking[order.id] as { error: string }).error}</span>
                    ) : (
                      (() => {
                        const t = tracking[order.id] as { lastStatus: string; events: Array<{ status: string; desc: string; hub: string; at: string }> };
                        return (
                          <>
                            <div className="font-semibold text-ink">
                              Jeebly: {t.lastStatus || 'no status yet'}
                              {/^delivered$/i.test(t.lastStatus) && order.status !== 'delivered' ? ' — check it, then tap “Mark delivered”.' : ''}
                            </div>
                            <ul className="space-y-0.5 text-ink-soft">
                              {t.events.slice(0, 4).map((e, i) => (
                                <li key={i}>
                                  {e.at ? new Date(e.at).toLocaleString() : ''} · {e.status}
                                  {e.hub ? ` · ${e.hub}` : ''}
                                </li>
                              ))}
                            </ul>
                          </>
                        );
                      })()
                    )}
                  </div>
                )}

                {/* Something the owner must look at (a refund that failed, a booking after a cancel…) */}
                {order.attention && order.attention.kind !== 'call_customer' && (
                  <div data-testid="order-attention" role="alert" className="flex flex-wrap items-start gap-2 rounded-xl border border-danger-line bg-danger-soft p-2.5 text-[11px] text-danger">
                    <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-0 font-semibold break-anywhere">{order.attention.text}</span>
                    <button
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => void handled(order)}
                      className="px-2 py-1 rounded-lg font-semibold border border-danger-line bg-surface text-danger hover:bg-ivory disabled:opacity-50"
                    >
                      Mark as handled
                    </button>
                  </div>
                )}

                {/* Payment & progress */}
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  {card && (
                    <span data-testid="card-badge" className={`px-2 py-1 rounded-lg font-semibold border break-anywhere ${TONES[card.tone]}`}>
                      {card.text}
                    </span>
                  )}
                  {!isCod && !isCard && !(bank && order.bankTransfer) && (
                    <>
                      <span
                        className={`px-2 py-1 rounded-lg font-semibold border ${
                          order.paymentStatus === 'verified' || order.paymentStatus === 'paid'
                            ? 'bg-success-soft text-success border-success-line'
                            : 'bg-warning-soft text-warning border-warning-line'
                        }`}
                      >
                        Payment: {order.paymentStatus.replace(/_/g, ' ')}
                        {order.bankTransferRef ? ` • Ref ${order.bankTransferRef}` : ''}
                      </span>
                      {safeLinkHref(order.paymentReceiptUrl) && (
                        <a
                          href={safeLinkHref(order.paymentReceiptUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand"
                        >
                          View receipt
                        </a>
                      )}
                      {order.paymentStatus !== 'verified' && order.paymentStatus !== 'paid' && order.status !== 'cancelled' && (
                        <button
                          type="button"
                          disabled={busyOrderId === order.id}
                          onClick={() => void bankReceived(order)}
                          className="px-2 py-1 rounded-lg font-semibold border border-success-line bg-success-soft text-success hover:bg-success-soft disabled:opacity-50"
                        >
                          Mark payment received
                        </button>
                      )}
                    </>
                  )}
                  {(heldForWhatsApp(order) ? [] : NEXT_ACTIONS[order.status] || []).map((action) => (
                    <button
                      key={action.to}
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => patchOrder(order, { status: action.to })}
                      className="px-2 py-1 rounded-lg font-semibold border border-line bg-ivory text-ink hover:bg-sand disabled:opacity-50"
                    >
                      {action.label}
                    </button>
                  ))}
                  {isCard && cardPaid && order.status !== 'delivered' && !order.card?.refundOutsideAt ? (
                    <button
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => void refundOrder(order)}
                      className="px-2 py-1 rounded-lg font-semibold border border-danger-line bg-surface text-danger hover:bg-danger-soft disabled:opacity-50 ml-auto"
                    >
                      {order.status === 'cancelled' ? `Refund AED ${cardLeft(order)} to the card` : `Cancel & refund AED ${cardLeft(order)} to the card`}
                    </button>
                  ) : order.status !== 'cancelled' && order.status !== 'delivered' && order.card?.state !== 'refund_pending' && (
                    <button
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() =>
                        patchOrder(
                          order,
                          { status: 'cancelled' },
                          (['dispatched', 'out_for_delivery'].includes(order.status)
                            ? `Cancel order ${order.id}? It has left with the courier, so its pieces are NOT put back on sale: add them back in Inventory (+) when the parcel returns. This cannot be undone.`
                            : cardUnpaid
                            ? `Cancel order ${order.id}? Its card payment is stopped at Stripe (nothing was charged) and its items go back into stock. This cannot be undone.`
                            : `Cancel order ${order.id}? Its items go back into stock. This cannot be undone.`) +
                            (order.courier.awbNumber && !order.courier.simulated
                              ? `\n\nIt is booked with the courier (AWB ${order.courier.awbNumber}): cancel that booking in the carrier's portal too.`
                              : '')
                        )
                      }
                      className="px-2 py-1 rounded-lg font-semibold border border-danger-line bg-surface text-danger hover:bg-danger-soft disabled:opacity-50 ml-auto"
                    >
                      Cancel order
                    </button>
                  )}
                </div>

                <OrderTimeline orderId={order.id} />

                {/* Action Buttons */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* The order's printable receipt (a tax invoice with VAT on): the server decides which. */}
                    <a
                      href={`/api/admin/orders/${order.id}/invoice`}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="order-invoice-link"
                      className="flex items-center gap-1.5 text-xs text-ink bg-surface hover:bg-sand border border-line-strong font-semibold px-3 py-1.5 rounded-xl"
                    >
                      <Printer className="w-3.5 h-3.5 text-gold" aria-hidden="true" />
                      <span>Receipt / invoice</span>
                    </a>
                    {/* Print Label only once the carrier has issued the AWB */}
                    {order.courier.awbNumber && order.courier.labelGenerated && (
                      <button
                        onClick={() => setLabelOrder(order)}
                        className="flex items-center gap-1.5 text-xs text-ink bg-sand hover:bg-sand-deep border border-line-strong font-semibold px-3 py-1.5 rounded-xl transition-colors"
                        title={order.courier.simulated ? 'Test label: not a real shipment' : 'Print the 4 × 6 in shipping label'}
                      >
                        <Printer className="w-3.5 h-3.5 text-gold" />
                        <span>{order.courier.simulated ? 'Test label' : 'Print Shipping Label'}</span>
                      </button>
                    )}

                    {/* WhatsApp notification */}
                    <button
                      onClick={() => sendWhatsAppUpdate(order)}
                      className="flex items-center gap-1.5 text-xs text-success bg-success-soft hover:bg-success-soft border border-success-line font-semibold px-3 py-1.5 rounded-xl transition-colors"
                      title="Send WhatsApp update to customer"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      <span>WhatsApp Customer</span>
                    </button>
                  </div>

                  {/* Confirm Order Action (Primary) */}
                  {isCard && cardUnpaid ? (
                    <span className="text-[11px] text-warning font-semibold text-right">Not paid yet: nothing to confirm until Stripe says paid</span>
                  ) : isPending && heldForWhatsApp(order) ? (
                    <span className="text-[11px] text-warning font-semibold text-right">Held until confirmed on WhatsApp</span>
                  ) : isPending ? (
                    <button
                      onClick={() => openConfirmationModal(order)}
                      className="flex items-center gap-1.5 bg-ink hover:bg-ink text-paper font-bold text-xs px-4 py-2 rounded-xl transition-all shadow active:scale-95"
                    >
                      <CheckCircle2 className="w-4 h-4 text-gold-light" />
                      <span>Confirm & Assign Courier</span>
                    </button>
                  ) : order.status === 'confirmed' ? (
                    <span className="text-[11px] text-success font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Ready for Dispatch
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ORDER CONFIRMATION & SMART COURIER ASSIGNMENT MODAL */}
      {selectedOrderForConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/45 p-3 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="confirm-order-title">
          <div className="bg-surface rounded-3xl max-w-lg w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain p-5 border border-line space-y-4">
            {/* Header (stays in view) */}
            <div className="sticky top-0 z-10 -mx-5 -mt-5 px-5 pt-4 pb-3 bg-surface flex items-start justify-between gap-2 border-b border-line">
              <div className="min-w-0">
                <h3 id="confirm-order-title" className="font-serif text-xl text-ink">
                  {selectedOrderForConfirm.status === 'pending_confirmation' ? 'Confirm order & book the courier' : 'Book the courier'}
                </h3>
                <p className="text-xs text-ink-muted">
                  Order #{selectedOrderForConfirm.id} • {selectedOrderForConfirm.customer.fullName}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrderForConfirm(null)}
                aria-label="Close"
                className="shrink-0 w-10 h-10 flex items-center justify-center text-ink rounded-full hover:bg-sand"
              >
                <X className="w-5 h-5" strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>

            {/* Smart Routing Callout */}
            <div className={`p-3 rounded-2xl border text-xs space-y-1 ${
              selectedOrderForConfirm.paymentMethod === 'cod'
                ? 'bg-danger-soft/70 border-danger-line text-danger'
                : 'bg-success-soft/70 border-success-line text-success'
            }`}>
              <div className="flex items-center justify-between font-bold">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-gold" />
                  <span>
                    {selectedOrderForConfirm.paymentMethod === 'cod'
                      ? 'Payment: Cash on Delivery (COD)'
                      : selectedOrderForConfirm.paymentMethod === 'online_card'
                      ? 'Payment: Paid by card (Prepaid)'
                      : 'Payment: Direct Bank Transfer (Prepaid)'}
                  </span>
                </span>
                <span className="text-sm">AED {selectedOrderForConfirm.total}</span>
              </div>
              <p className="text-[11px] text-ink-soft">
                {selectedOrderForConfirm.paymentMethod === 'cod'
                  ? 'Smart Routing Rule: Cash on Delivery orders default to Jeebly Logistics (UAE COD specialist).'
                  : 'Smart Routing Rule: Prepaid orders default to Eco Express Courier Services (Priority Express).'}
              </p>
            </div>

            {/* Courier Selection (With 1-Click Override) */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-ink uppercase tracking-wider block">
                Select Courier Service Provider:
              </label>

              <div className="grid grid-cols-2 gap-2">
                {/* Jeebly Option */}
                <button
                  type="button"
                  onClick={() => setChosenCourier('jeebly')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    chosenCourier === 'jeebly'
                      ? 'border-ink bg-ink text-paper shadow-md'
                      : 'border-line bg-surface text-ink-soft hover:border-line-strong'
                  }`}
                >
                  <div className="font-bold text-xs flex items-center justify-between">
                    <span>Jeebly Logistics</span>
                    {chosenCourier === 'jeebly' && <span className="text-gold-light">✓</span>}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${chosenCourier === 'jeebly' ? 'text-gold-light' : 'text-ink-muted'}`}>
                    Default for COD · {MODE_TEXT[modeFor('jeebly')].label}
                  </div>
                </button>

                {/* Eco Express Option */}
                <button
                  type="button"
                  onClick={() => setChosenCourier('echo')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    chosenCourier === 'echo'
                      ? 'border-ink bg-ink text-paper shadow-md'
                      : 'border-line bg-surface text-ink-soft hover:border-line-strong'
                  }`}
                >
                  <div className="font-bold text-xs flex items-center justify-between">
                    <span>Eco Express Courier</span>
                    {chosenCourier === 'echo' && <span className="text-gold-light">✓</span>}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${chosenCourier === 'echo' ? 'text-gold-light' : 'text-ink-muted'}`}>
                    Default for Prepaid · {MODE_TEXT[modeFor('echo')].label}
                  </div>
                </button>
              </div>
            </div>

            {/* Live or Test: said plainly, before anything is booked */}
            {(() => {
              const mode = modeFor(chosenCourier);
              const m = MODE_TEXT[mode];
              return (
                <div data-testid="booking-mode" role={m.tone === 'success' ? 'status' : 'alert'} className={`p-3 rounded-2xl border text-xs space-y-1 ${TONES[m.tone]}`}>
                  <div className="font-bold">{carrierLabel(chosenCourier)}: {m.label} mode</div>
                  <p>{m.text}</p>
                  {chosenCourier === 'jeebly' && mode !== 'live' && liveKeysSaved && <p className="font-semibold">{LIVE_OFF_WARNING}</p>}
                  {chosenCourier === 'jeebly' && (mode === 'live' || mode === 'sandbox') && (() => {
                    const j = courierSettings.jeebly;
                    const missing = [!j.pickupPhone && 'phone', !j.pickupUnit && 'unit', !j.pickupBuilding && 'building', !j.pickupArea && 'area', !j.pickupLandmark && 'landmark'].filter(Boolean);
                    return missing.length ? <p className="font-semibold">Add your pickup {missing.join(', ')} in Couriers first: Jeebly needs them to collect the parcel.</p> : null;
                  })()}
                </div>
              );
            })()}

            {/* Shipment Dispatch Parameters */}
            {/* A phone: the date on its own row (iPhone's date box will not shrink below its text), weight and parcels side by side. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="col-span-2 sm:col-span-1 min-w-0">
                <label htmlFor="dispatch-pickup-date" className="block text-ink-soft font-semibold mb-1">
                  Pickup Date
                </label>
                <input
                  id="dispatch-pickup-date"
                  type="date"
                  value={pickupDate}
                  onChange={(e) => setPickupDate(e.target.value)}
                  className="block w-full min-w-0 appearance-none px-2.5 py-1.5 rounded-xl border border-line-strong bg-surface text-xs"
                />
              </div>

              <div className="min-w-0">
                <label htmlFor="dispatch-weight" className="block text-ink-soft font-semibold mb-1">
                  Weight (kg)
                </label>
                <input
                  id="dispatch-weight"
                  type="number"
                  step="0.1"
                  min={0.1}
                  inputMode="decimal"
                  value={weightKg}
                  placeholder="kg"
                  aria-describedby="dispatch-weight-breakdown"
                  onChange={(e) => setWeightKg(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-line-strong text-xs"
                />
              </div>

              <div className="min-w-0">
                <label htmlFor="dispatch-parcels" className="block text-ink-soft font-semibold mb-1">
                  Parcels
                </label>
                <input
                  id="dispatch-parcels"
                  type="number"
                  value={pieces}
                  onChange={(e) => setPieces(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-line-strong text-xs"
                />
              </div>

              {(() => {
                const w = shipmentWeight(selectedOrderForConfirm, courierSettings.packagingGrams ?? DEFAULT_PACKAGING_GRAMS);
                const typed = Number(weightKg);
                return (
                  <p id="dispatch-weight-breakdown" data-testid="weight-breakdown" className={`col-span-2 sm:col-span-3 text-[11px] ${w.missing.length ? 'text-warning font-semibold' : 'text-ink-soft'}`}>
                    {w.missing.length ? `${w.breakdown}. Enter the weight above for now.` : w.breakdown}
                    {weightKg.trim() !== '' && typed > 0 && (w.kg === null || Math.abs(typed - w.kg) > 0.001) ? ` · Booking with ${typed} kg → ${Math.max(1, Math.ceil(typed))} kg for Jeebly.` : ''}
                  </p>
                );
              })()}

              <div className="col-span-2 sm:col-span-3">
                <label className="block text-ink-soft font-semibold mb-1">
                  Driver Instructions & Notes
                </label>
                <input
                  type="text"
                  placeholder="e.g. Call before delivery, handle luxury bedding with care"
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-xl border border-line-strong text-xs"
                />
              </div>
            </div>

            {/* Submit Action */}
            <div className="pt-2">
              {(() => {
                const mode = modeFor(chosenCourier);
                const cannot = mode === 'blocked' || mode === 'not_connected';
                const test = mode === 'sandbox' || mode === 'practice';
                return (
                  <button
                    type="button"
                    disabled={isDispatching || cannot}
                    onClick={handleConfirmAndDispatch}
                    className={`w-full text-paper font-bold text-xs py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 ${test ? 'bg-warning' : 'bg-ink'}`}
                  >
                    {isDispatching ? (
                      <span>Booking with {carrierLabel(chosenCourier)}…</span>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-gold-light" />
                        <span>
                          {cannot
                            ? `Cannot book with ${carrierLabel(chosenCourier)} here`
                            : test
                            ? `Make a TEST booking (not sent to ${carrierLabel(chosenCourier)})`
                            : `${selectedOrderForConfirm.status === 'pending_confirmation' ? 'Confirm & book' : 'Book'} with ${carrierLabel(chosenCourier)} (real shipment)`}
                        </span>
                      </>
                    )}
                  </button>
                );
              })()}
              {SHIPPING_STATUSES.includes(selectedOrderForConfirm.status) && (
                <button
                  type="button"
                  onClick={() => {
                    setTrackingOrder(selectedOrderForConfirm);
                    setSelectedOrderForConfirm(null);
                  }}
                  className="mt-2 w-full min-h-10 text-xs font-semibold text-ink-soft underline rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                >
                  Booked it in the courier&apos;s portal? Enter tracking number
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* PRINTABLE SHIPPING LABEL MODAL */}
      {labelOrder && (
        <ShippingLabelModal
          order={labelOrder}
          onClose={() => setLabelOrder(null)}
          shopName={shopName}
          pickup={courierSettings.jeebly}
        />
      )}

      {trackingOrder && (
        <EnterTrackingDialog
          order={trackingOrder}
          onClose={() => setTrackingOrder(null)}
          onSaved={(o) => {
            onOrderChanged(o);
            setTrackingOrder(null);
          }}
        />
      )}
    </div>
  );
};
