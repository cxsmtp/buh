'use client';

import React, { useEffect, useRef, useState } from 'react';
import { BankTransferDetails, Order, CourierProvider, CourierSettings } from '@/types';
import { ShippingLabelModal } from './ShippingLabelModal';
import { OrderPackCheck } from './OrderPackCheck';
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
import { getJson, postJson, safeHref, safeLinkHref, sendJson } from '@/lib/apiClient';
import { orderMatchesSearch, orderSearchTerms, type HubTotals } from '@/lib/hubToday';
import { awaitingWhatsApp, heldForWhatsApp, OrderTimeline, OrderWhatsAppCheck } from './OrderWhatsAppCheck';
import { OrderBankTransfer, transferToCheck } from './OrderBankTransfer';
import { OrderPhotoCheck } from './OrderPhotoCheck';
import { PhotoDeals } from './PhotoDeals';
import { creditInFils, dueOnDeliveryFils } from '@/lib/orderMoney';
import { OrderCredit } from './OrderCredit';
import { OrderEdit, orderEditable } from './OrderEdit';
import { OrderInvoice } from './OrderInvoice';
import { trackLinkOf } from '@/lib/whatsappConfirm';
import { DEFAULT_PACKAGING_GRAMS, shipmentWeight } from '@/lib/shipmentWeight';
import { aed2, BLOCKED_MESSAGE, carrierLabel, ECO_LIVE_NOT_CONNECTED, jeeblyMode, LIVE_OFF_WARNING } from '@/lib/courierMode';
import { EnterTrackingDialog } from './EnterTrackingDialog';

interface AdminOrdersTabProps {
  /** The hub's list: EVERY open order (not delivered, not cancelled) and the newest finished ones. */
  orders: Order[];
  /** Where the finished orders continue on the server (/api/admin/orders/search), or null: the list has them all. */
  older?: string | null;
  /** The server's counts over every order (the chips' numbers). */
  totals?: HubTotals | null;
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
/** A real courier booking still stands (kept in step with courierStillBooked in src/lib/server/orders.ts). */
export function courierBooked(order: Order): boolean {
  const c = order.courier;
  if (c.simulated || c.status === 'Cancelled with the carrier') return false;
  if (c.bookingState === 'uncertain') return true;
  if (!c.awbNumber) return false;
  return c.bookingState === 'booked' || Boolean(c.enteredByHand);
}

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
  // The order's private tracking page: status and courier tracking any time, without asking.
  const track = trackLinkOf(order);
  if (track) lines.push(`Track your order any time: ${track}`);
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

type OrderFilter = 'all' | 'pending' | 'whatsapp' | 'transfer' | 'card' | 'photo' | 'confirmed' | 'dispatched' | 'delivered' | 'cancelled';
/**
 * The finished orders a filter can also show, asked from the server a page at a time (the hub's own
 * list holds every open order, so filters of open orders need nothing more).
 */
const OLDER_OF: Partial<Record<OrderFilter, { status: string; kind?: 'card' | 'photo' }>> = {
  all: { status: 'finished' },
  delivered: { status: 'delivered' },
  cancelled: { status: 'cancelled' },
  card: { status: 'finished', kind: 'card' },
  photo: { status: 'finished', kind: 'photo' },
};
/** Order cards drawn at a time (the rest behind "Show more orders"). */
export const ORDERS_PAGE = 30;
/** A tap target 44 px tall on a phone; compact (as the owner asked) from 768 px, where a mouse is used. */
const TAP = 'min-h-11 md:min-h-0';

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
  // Less what was moved to other orders (src/lib/orderMoney.ts): that part is not refunded.
  const moved = (order.creditsOut ?? []).reduce((s, c) => s + c.amount, 0);
  return Math.max(0, Math.round(((order.card?.paidAmount ?? order.total) - (order.card?.refundedAmount ?? 0) - moved) * 100)) / 100;
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
  older = null,
  totals = null,
  onOrderChanged: tellHub,
  courierSettings,
  bank,
  shopName,
  courierSecretsSet = {},
}) => {
  const [busyOrderId, setBusyOrderId] = useState('');

  /** "Handed over in person": delivered without a courier; for cash on delivery, the cash taken now. */
  const handOver = async (order: Order) => {
    const due = order.paymentMethod === 'cod' ? dueOnDeliveryFils(order) : 0;
    const money = due ? ` and AED ${(due / 100).toFixed(2)} cash received` : '';
    const booked = courierBooked(order);
    const courier = booked
      ? !order.courier.awbNumber
        ? ' It was sent to the courier and no answer came back, so it may be booked: you will be asked to check the courier’s portal.'
        : order.courier.provider === 'jeebly'
        ? ` Its Jeebly booking (AWB ${order.courier.awbNumber}) is cancelled with Jeebly first, so nobody comes to collect it.`
        : ` It is booked with ${carrierLabel(order.courier.provider, order.courier.carrierName)} (AWB ${order.courier.awbNumber}): cancel that in their portal too.`
      : ' No courier is booked.';
    if (!window.confirm(`${order.id}: handed over to the customer in person${money}? It is marked delivered.${courier}`)) {
      if (!due || !window.confirm(`Handed over, but the cash (AED ${(due / 100).toFixed(2)}) is not received yet? It is marked delivered and stays unpaid.`)) return;
      return void sendHandOver(order, false, booked);
    }
    return void sendHandOver(order, true, booked);
  };
  const sendHandOver = async (order: Order, cashReceived: boolean, booked: boolean) => {
    setBusyOrderId(order.id);
    const url = `/api/admin/orders/${encodeURIComponent(order.id)}/handover`;
    const body = { ...(order.paymentMethod === 'cod' ? { cashReceived } : {}), ...(booked ? { cancelCourier: true } : {}) };
    let { ok, data } = await postJson<{ order?: Order; message?: string; code?: string }>(url, body);
    // The courier could not be cancelled from here: only on the owner's word that it is cancelled in the portal.
    if (!ok && data.code === 'courier_not_cancelled' && window.confirm(`${data.message}\n\nDid you cancel it in the courier's portal yourself? OK marks the order delivered (handed over in person).`)) {
      ({ ok, data } = await postJson<{ order?: Order; message?: string; code?: string }>(url, { ...body, courierCancelled: true }));
    } else if (!ok && data.code === 'courier_not_cancelled') {
      setBusyOrderId('');
      return;
    }
    setBusyOrderId('');
    if (ok && data.order) onOrderChanged(data.order);
    else alert(data.message || 'The order could not be updated.');
  };

  const patchOrder = async (order: Order, changes: Partial<Pick<Order, 'status' | 'paymentStatus' | 'adminNotes'>> & { clearAttention?: true; shipUnconfirmed?: true }, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyOrderId(order.id);
    let { ok, data } = await sendJson<{ order?: Order; message?: string; code?: string }>('PATCH', `/api/admin/orders/${encodeURIComponent(order.id)}`, changes);
    // Not confirmed on WhatsApp yet: only on the owner's explicit "ship anyway" (the server records it).
    const ask = data.code === 'whatsapp_unconfirmed' || data.code === 'bank_unpaid';
    if (!ok && ask && window.confirm(data.message || "This customer hasn't confirmed on WhatsApp yet — ship anyway?")) {
      ({ ok, data } = await sendJson<{ order?: Order; message?: string; code?: string }>('PATCH', `/api/admin/orders/${encodeURIComponent(order.id)}`, { ...changes, shipUnconfirmed: true }));
    } else if (!ok && ask) {
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

  // The order being checked with the scanner (one at a time).
  const [packing, setPacking] = useState('');
  const [filter, setFilterNow] = useState<OrderFilter>('all');
  // Search (order number, name, phone): the hub's own list at once, older finished orders from the server.
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(ORDERS_PAGE);
  // Older finished orders fetched for this filter and search. next: undefined = not asked yet, null = no more.
  const [found, setFound] = useState<{ orders: Order[]; next?: string | null; loading: boolean; error: string }>({ orders: [], loading: false, error: '' });
  const view = useRef({ key: 'all|', timer: undefined as ReturnType<typeof setTimeout> | undefined });
  useEffect(() => {
    const v = view.current;
    return () => clearTimeout(v.timer);
  }, []);
  const terms = orderSearchTerms(query);

  /** The next page of older finished orders for a filter and search (from where the hub's own list ends). */
  const fetchOlder = async (f: OrderFilter, q: string, before: string | null | undefined) => {
    const scope = OLDER_OF[f];
    const key = `${f}|${q}`;
    if (!scope || !before || view.current.key !== key) return;
    setFound((x) => ({ ...x, loading: true, error: '' }));
    const params = new URLSearchParams({ status: scope.status, before, limit: String(ORDERS_PAGE) });
    if (scope.kind) params.set('kind', scope.kind);
    if (q) params.set('q', q);
    const { ok, data } = await getJson<{ orders?: Order[]; next?: string | null; message?: string }>(`/api/admin/orders/search?${params.toString()}`);
    if (view.current.key !== key) return; // the filter or search changed meanwhile
    if (!ok || !data.orders) return setFound((x) => ({ ...x, loading: false, error: data.message || 'Older orders could not be loaded. Please try again.' }));
    const more = data.orders;
    setFound((x) => ({ orders: [...x.orders, ...more.filter((o) => !x.orders.some((y) => y.id === o.id))], next: data.next ?? null, loading: false, error: '' }));
  };
  /** A new filter or search: the list starts again; a search also asks the server (after a pause in typing). */
  const show = (f: OrderFilter, q: string) => {
    const searchText = orderSearchTerms(q) ? q.trim() : '';
    const key = `${f}|${searchText}`;
    setFilterNow(f);
    setQuery(q);
    if (key === view.current.key) return;
    clearTimeout(view.current.timer);
    view.current.key = key;
    setVisible(ORDERS_PAGE);
    setFound({ orders: [], loading: Boolean(searchText && OLDER_OF[f] && older), error: '' });
    if (searchText) view.current.timer = setTimeout(() => void fetchOlder(f, searchText, older), 300);
  };
  const setFilter = (f: OrderFilter) => show(f, query);
  /** An order changed: also in the older ones fetched here, then the hub's list. */
  const onOrderChanged = (o: Order) => {
    setFound((x) => (x.orders.some((y) => y.id === o.id) ? { ...x, orders: x.orders.map((y) => (y.id === o.id ? o : y)) } : x));
    tellHub(o);
  };
  // Orders the owner has just answered stay in "Awaiting WhatsApp" (or "Transfer to check") for now, so the reply link is right there.
  const [justChecked, setJustChecked] = useState<string[]>([]);
  const whatsappChecked = (o: Order) => {
    setJustChecked((ids) => (ids.includes(o.id) ? ids : [...ids, o.id]));
    onOrderChanged(o);
  };
  const [selectedOrderForConfirm, setSelectedOrderForConfirm] = useState<Order | null>(null);
  const [labelOrder, setLabelOrder] = useState<Order | null>(null);
  // "Edit order" (before the label) and "Recreate order" (a cancelled cash order).
  const [editing, setEditing] = useState<Order | null>(null);
  const [recreating, setRecreating] = useState('');
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
  // "Extra to collect" (AED): 0 unless the owner adds money still to take from the customer.
  const [extraCharge, setExtraCharge] = useState<string>('0');
  const [extraNote, setExtraNote] = useState<string>('');
  const [isDispatching, setIsDispatching] = useState<boolean>(false);

  const inFilter = (o: Order, f: OrderFilter) => {
    if (f === 'pending') return o.status === 'pending_confirmation';
    if (f === 'whatsapp') return awaitingWhatsApp(o) || justChecked.includes(o.id);
    if (f === 'transfer') return transferToCheck(o) || justChecked.includes(o.id);
    if (f === 'card') return o.paymentMethod === 'online_card';
    if (f === 'photo') return Boolean(o.photoOrder);
    if (f === 'confirmed') return o.status === 'confirmed';
    if (f === 'dispatched') return o.status === 'dispatched';
    if (f === 'delivered') return o.status === 'delivered';
    if (f === 'cancelled') return o.status === 'cancelled';
    return true;
  };
  // The hub's own list first (its copy of an order is the freshest), then the older ones fetched; newest first.
  const own = orders.filter((o) => inFilter(o, filter) && (!terms || orderMatchesSearch(o, terms)));
  const filteredOrders = [...own, ...found.orders.filter((o) => inFilter(o, filter) && !orders.some((y) => y.id === o.id))].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  // More on the server? (Only finished orders: every open one is already here.)
  const olderFrom = OLDER_OF[filter] ? (found.next === undefined ? older : found.next) : null;
  const shownOrders = filteredOrders.slice(0, visible);
  const showMore = () => {
    if (visible >= filteredOrders.length && olderFrom) void fetchOlder(filter, terms ? query.trim() : '', olderFrom);
    setVisible((n) => n + ORDERS_PAGE);
  };
  /** The number on a chip: the server's count of every order where it has one. */
  const chipCount = (f: OrderFilter): number => {
    const s = totals?.byStatus;
    if (f === 'all') return totals?.orders ?? orders.length;
    if (f === 'card' && totals) return totals.card;
    if (f === 'photo' && totals) return totals.photo;
    if (s && f === 'pending') return s.pending_confirmation;
    if (s && (f === 'confirmed' || f === 'dispatched' || f === 'delivered' || f === 'cancelled')) return s[f];
    return orders.filter((o) => (f === 'whatsapp' ? awaitingWhatsApp(o) : f === 'transfer' ? transferToCheck(o) : inFilter(o, f))).length;
  };

  // How many there are in all: the server's count where it has one; unknown while a search still has older pages.
  const knownTotal = !terms && totals && OLDER_OF[filter] ? Math.max(chipCount(filter), filteredOrders.length) : olderFrom ? null : filteredOrders.length;

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
    setExtraCharge(String(order.extraCharge?.amount ?? 0));
    setExtraNote(order.extraCharge?.note ?? '');
  };

  // What the courier will collect, worked out like the server (src/lib/orderMoney.ts), shown before booking.
  const extraValue = Number(extraCharge.replace(/,/g, '') || '0');
  const extraOk = Number.isFinite(extraValue) && extraValue >= 0 && extraValue <= 10_000 && Math.abs(extraValue * 100 - Math.round(extraValue * 100)) < 1e-6;
  const collectPreview = selectedOrderForConfirm
    ? dueOnDeliveryFils({
        ...selectedOrderForConfirm,
        total: Math.round((selectedOrderForConfirm.total - (selectedOrderForConfirm.extraCharge?.amount ?? 0) + (extraOk ? extraValue : 0)) * 100) / 100,
        extraCharge: extraOk && extraValue > 0 ? { amount: extraValue, at: '', by: '' } : undefined,
      })
    : 0;

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
    if (!extraOk) {
      alert('Extra to collect: an amount in AED from 0 to 10,000 (e.g. 50 or 12.50).');
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
      extraCharge: extraValue,
      extraNote: extraNote.trim(),
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
    if (status === 409 && (data.code === 'whatsapp_unconfirmed' || data.code === 'bank_unpaid')) {
      if (!window.confirm(`${data.message || "This customer hasn't confirmed on WhatsApp yet — ship anyway?"}${data.code === 'bank_unpaid' ? '\n\nTip: if the money has arrived, tap “Payment received” on the order first.' : '\n\nTip: if you confirmed by phone, tap “Confirmed by phone call” on the order instead.'}`)) {
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

  const recreate = async (order: Order) => {
    if (!window.confirm(`Recreate ${order.id} as a new order for ${order.customer.fullName}? The same items and prices, their stock taken again; you can edit it before booking the courier.`)) return;
    setRecreating(order.id);
    const { ok, data } = await postJson<{ order?: Order; created?: boolean; message?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/recreate`, {});
    setRecreating('');
    if (!ok || !data.order) return alert(data.message || 'Not recreated. Please try again.');
    onOrderChanged(data.order);
    alert(data.created ? `New order ${data.order.id} made (confirmed). Use "Edit order" on it to change anything before booking the courier.` : `${order.id} was already recreated as ${data.order.id}.`);
  };

  const sendWhatsAppUpdate = (order: Order) => {
    const text = encodeURIComponent(whatsAppUpdateText(order, shopName || undefined));
    window.open(`https://wa.me/${order.customer.phone.replace(/[^0-9]/g, '')}?text=${text}`, '_blank');
  };

  return (
    <div className="space-y-4">
      {/* The owner's photo deal links (pictures, fixed price, allowed payments): the latest 3 here, all of them under Photo orders */}
      {filter === 'photo' ? <PhotoDeals key="all" /> : <PhotoDeals key="latest" limit={3} onShowAll={() => setFilter('photo')} />}
      {/* Search: any order, however old */}
      <div role="search">
        <label htmlFor="order-search" className="sr-only">Search orders</label>
        <input
          id="order-search"
          type="search"
          inputMode="search"
          autoComplete="off"
          maxLength={60}
          value={query}
          onChange={(e) => show(filter, e.target.value)}
          placeholder="Search: order number, name or phone"
          data-testid="order-search"
          className="w-full min-h-11 px-3.5 rounded-xl border border-line-strong bg-surface text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold"
        />
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1" role="group" aria-label="Show orders">
        {(
          [
            { id: 'all', label: 'All Orders' },
            { id: 'pending', label: 'Needs Confirmation' },
            { id: 'whatsapp', label: 'Awaiting WhatsApp' },
            { id: 'transfer', label: 'Transfer to check' },
            { id: 'card', label: 'Card payments' },
            { id: 'photo', label: 'Photo orders' },
            { id: 'confirmed', label: 'Confirmed & AWB Ready' },
            { id: 'dispatched', label: 'Dispatched / In Transit' },
            { id: 'delivered', label: 'Delivered' },
            { id: 'cancelled', label: 'Cancelled' },
          ] as Array<{ id: OrderFilter; label: string }>
        )
          .filter((tab) => (tab.id !== 'whatsapp' || orders.some((o) => o.whatsappCheck)) && (tab.id !== 'transfer' || orders.some((o) => o.bankTransfer)) && (tab.id !== 'card' || (totals ? totals.card > 0 : orders.some((o) => o.paymentMethod === 'online_card'))))
          .map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              aria-pressed={filter === tab.id}
              data-testid={`order-filter-${tab.id}`}
              className={`${TAP} px-3 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                filter === tab.id ? 'bg-ink text-paper shadow-sm' : 'bg-surface text-ink-soft hover:bg-sand border border-line'
              }`}
            >
              <span>{tab.label}</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${filter === tab.id ? 'bg-gold text-ink font-bold' : 'bg-sand-deep text-ink-soft'}`}>{chipCount(tab.id)}</span>
            </button>
          ))}
      </div>

      {/* Every label waiting for dispatch in one PDF (A4: two per sheet), or straight to the printer's email */}
      {(() => {
        const waiting = orders.filter((o) => o.status === 'confirmed' && o.courier?.awbNumber).length;
        if (!waiting) return null;
        const paper = courierSettings.labelPaper ?? 'a5';
        return (
          <div data-testid="batch-labels" className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-2.5 text-xs">
            <span className="text-ink-soft font-semibold">{waiting} label{waiting === 1 ? '' : 's'} waiting for dispatch</span>
            {paper !== 'a4' && (
              <a href={`/api/admin/labels?paper=${paper}`} target="_blank" rel="noopener" data-testid="batch-labels-home" className="ml-auto min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-xl border border-line-strong bg-surface hover:bg-sand font-semibold text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                All labels PDF ({paper === '4x6' ? '4 × 6 in' : 'A5'})
              </a>
            )}
            <a href="/api/admin/labels?paper=a4" target="_blank" rel="noopener" data-testid="batch-labels-pdf" className={`${paper === 'a4' ? 'ml-auto ' : ''}min-h-11 md:min-h-0 inline-flex items-center px-3 py-1.5 rounded-xl border border-line-strong bg-surface hover:bg-sand font-semibold text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-gold`}>
              All labels A4 PDF (2 per sheet)
            </a>
            {courierSettings.printerEmail && (
              <button
                type="button"
                data-testid="batch-labels-email"
                onClick={async () => {
                  const { ok, data } = await postJson<{ to?: string; count?: number; message?: string }>('/api/admin/labels', { paper: 'a4' });
                  alert(ok ? `${data.count} label${data.count === 1 ? '' : 's'} sent to ${data.to}.` : data.message || 'Not sent. Please try again.');
                }}
                className="min-h-11 md:min-h-0 px-3 py-1.5 rounded-xl bg-ink text-paper font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                Email all to printer (A4)
              </button>
            )}
          </div>
        );
      })()}

      {/* Orders List */}
      <div className="space-y-3">
        {filteredOrders.length === 0 ? (
          <div className="bg-surface rounded-2xl p-8 text-center border border-line text-ink-muted text-xs" data-testid="orders-empty" role="status">
            {found.loading ? 'Searching…' : terms ? `No order matches “${query.trim()}”${filter === 'all' ? '' : ' under this filter'}.` : 'No orders found under this filter.'}
          </div>
        ) : (
          shownOrders.map((order) => {
            const isPending = order.status === 'pending_confirmation';
            const isCod = order.paymentMethod === 'cod';
            const isCard = order.paymentMethod === 'online_card';
            const card = cardBadge(order);
            const cardPaid = order.card?.state === 'paid';
            const cardUnpaid = order.card?.state === 'pending' || order.card?.state === 'failed';

            return (
              <div
                key={order.id}
                data-testid="order-card"
                data-order-id={order.id}
                className="bg-surface rounded-2xl p-2.5 sm:p-3 border border-line hover:border-line-strong shadow-sm space-y-1.5 transition-all"
              >
                {/* Top Strip */}
                <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line pb-1.5">
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
                {order.photoOrder && <OrderPhotoCheck order={order} onOrderChanged={whatsappChecked} />}
                <OrderInvoice key={`${order.id}-${order.invoice?.number ?? ''}`} order={order} shopName={shopName} />
                <OrderCredit order={order} orders={orders} onOrderChanged={onOrderChanged} />

                {/* Items & Delivery Info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  {/* Items */}
                  <div className="space-y-1">
                    <span className="sr-only">Bedding ordered:</span>
                    {order.items.map((i, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-ink">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {i.image ? <img src={i.image} alt={i.title} className="w-6 h-6 rounded object-cover" /> : <span className="w-6 h-6 rounded bg-sand shrink-0" aria-hidden="true" />}
                        <span className="truncate">
                          <strong>{i.quantity}x</strong> {i.title} ({i.mattressSize ? i.profileName.split(' ')[0] : i.profileName})
                          {i.sku && <span className="text-ink-muted font-mono text-[11px]"> · {i.sku}</span>}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Destination */}
                  <div className="space-y-1 sm:border-l sm:border-line sm:pl-3">
                    <span className="sr-only">Delivery address:</span>
                    <div className="text-ink">
                      {order.customer.buildingVilla}, {order.customer.flatVillaNo}, {order.customer.area}, <strong>{order.customer.emirate}</strong>
                      <span className="text-ink-muted"> · {order.customer.phone}</span>
                    </div>
                  </div>
                </div>

                {/* Courier Assignment Bar */}
                <div className="bg-ivory rounded-xl px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs border border-line/80">
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
                    {order.handedOver && (
                      <span data-testid="handed-over-badge" className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-success-soft text-success border border-success-line">
                        Handed over in person {new Date(order.handedOver.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        {order.handedOver.cash ? ` · AED ${order.handedOver.cash.toFixed(2)} cash` : ''}
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
                      className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-danger-line bg-surface text-danger hover:bg-ivory disabled:opacity-50"
                    >
                      Mark as handled
                    </button>
                  </div>
                )}


                {/* Every action in one wrapping line (asked by the owner: compact) */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="order-actions">
                  {['pending_confirmation', 'confirmed', 'dispatched'].includes(order.status) && order.items.some((i) => i.productId) && (
                    <button type="button" onClick={() => setPacking(packing === order.id ? '' : order.id)} aria-expanded={packing === order.id} data-testid="order-pack-check" className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand">
                      Scan to check
                    </button>
                  )}
                {/* Booked, or not yet: book with the courier, or type in a number from its portal */}
                {SHIPPING_STATUSES.includes(order.status) && !realBooking(order) && (
                  <>
                    {order.courier.simulated && modeFor('jeebly') !== 'live' ? (
                      <span className="text-ink-muted">To book for real, run the Sandbox check and turn on Live mode in Couriers.</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openConfirmationModal(order)}
                        className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line-strong bg-ink text-paper hover:bg-ink-2"
                      >
                        {order.courier.simulated ? 'Book for real' : 'Book courier'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setTrackingOrder(order)}
                      className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand"
                    >
                      Enter tracking number
                    </button>
                  </>
                )}
                {SHIPPING_STATUSES.includes(order.status) && realBooking(order) && (
                  <>
                    {order.courier.provider === 'jeebly' && (
                      <button
                        type="button"
                        disabled={busyOrderId === order.id}
                        onClick={() => void refreshTracking(order)}
                        className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand disabled:opacity-50"
                      >
                        Refresh tracking
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setTrackingOrder(order)}
                      className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line bg-surface text-ink-soft hover:bg-sand"
                    >
                      Change AWB
                    </button>
                    {safeHref(order.courier.trackingUrl) && (
                      <a href={safeHref(order.courier.trackingUrl)} target="_blank" rel="noopener noreferrer" className="min-h-11 md:min-h-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg font-semibold border border-line bg-surface text-ink-soft hover:bg-sand">
                        Tracking page <ExternalLink className="w-3 h-3" aria-hidden="true" />
                      </a>
                    )}
                  </>
                )}

                {/* Edit before the label; recreate a cancelled cash order (asked by the owner). */}
                {(orderEditable(order) || (order.status === 'cancelled' && order.paymentMethod === 'cod')) && (
                  <span className="contents" data-testid="order-edit-actions">
                    {orderEditable(order) && (
                      <button type="button" onClick={() => setEditing(order)} className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand">
                        Edit order
                      </button>
                    )}
                    {order.status === 'cancelled' && order.paymentMethod === 'cod' && (
                      <>
                        <button type="button" disabled={recreating === order.id} onClick={() => void recreate(order)} className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand disabled:opacity-50">
                          {order.recreatedAs ? `Recreated as ${order.recreatedAs} · recreate again` : 'Recreate order'}
                        </button>
                      </>
                    )}
                    {order.recreatedFrom && <span className="text-ink-muted">Recreated from {order.recreatedFrom}</span>}
                  </span>
                )}

                {/* Action Buttons */}
                    {/* The order's printable receipt (a tax invoice with VAT on): the server decides which. */}
                    <a
                      href={`/api/admin/orders/${order.id}/invoice`}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="order-invoice-link"
                      className="min-h-11 md:min-h-0 flex items-center gap-1.5 text-[11px] text-ink bg-surface hover:bg-sand border border-line-strong font-semibold px-2 py-1 rounded-lg"
                    >
                      <Printer className="w-3 h-3 text-gold" aria-hidden="true" />
                      <span>Receipt / invoice</span>
                    </a>
                    {/* Print Label only once the carrier has issued the AWB */}
                    {order.courier.awbNumber && order.courier.labelGenerated && (
                      <button
                        onClick={() => setLabelOrder(order)}
                        className="min-h-11 md:min-h-0 flex items-center gap-1.5 text-[11px] text-ink bg-sand hover:bg-sand-deep border border-line-strong font-semibold px-2 py-1 rounded-lg transition-colors"
                        title={order.courier.simulated ? 'Test label: not a real shipment' : 'Print the 4 × 6 in shipping label'}
                      >
                        <Printer className="w-3 h-3 text-gold" />
                        <span>{order.courier.simulated ? 'Test label' : 'Print label'}</span>
                      </button>
                    )}

                    {/* WhatsApp notification */}
                    <button
                      onClick={() => sendWhatsAppUpdate(order)}
                      className="min-h-11 md:min-h-0 flex items-center gap-1.5 text-[11px] text-success bg-success-soft hover:bg-success-soft border border-success-line font-semibold px-2 py-1 rounded-lg transition-colors"
                      title="Send WhatsApp update to customer"
                    >
                      <MessageCircle className="w-3 h-3" />
                      <span>WhatsApp Customer</span>
                    </button>
                  {/* Confirm Order Action (Primary) */}
                  {isCard && cardUnpaid ? (
                    <span className="text-warning font-semibold">Not paid yet: nothing to confirm until Stripe says paid</span>
                  ) : isPending && heldForWhatsApp(order) ? (
                    <span className="text-warning font-semibold">Held until confirmed on WhatsApp</span>
                  ) : isPending ? (
                    <button
                      onClick={() => openConfirmationModal(order)}
                      className="min-h-11 md:min-h-0 flex items-center gap-1.5 bg-ink hover:bg-ink text-paper font-bold text-[11px] px-3 py-1 rounded-lg transition-all shadow active:scale-95"
                    >
                      <CheckCircle2 className="w-4 h-4 text-gold-light" />
                      <span>Confirm & Assign Courier</span>
                    </button>
                  ) : order.status === 'confirmed' ? (
                    <span className="text-success font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Ready for Dispatch
                    </span>
                  ) : null}
                {/* Payment & progress */}
                <>
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
                          className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line-strong bg-surface text-ink hover:bg-sand"
                        >
                          View receipt
                        </a>
                      )}
                      {order.paymentStatus !== 'verified' && order.paymentStatus !== 'paid' && order.status !== 'cancelled' && (
                        <button
                          type="button"
                          disabled={busyOrderId === order.id}
                          onClick={() => void bankReceived(order)}
                          className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-success-line bg-success-soft text-success hover:bg-success-soft disabled:opacity-50"
                        >
                          Mark payment received
                        </button>
                      )}
                    </>
                  )}
                  {!['delivered', 'cancelled', 'pending_payment'].includes(order.status) && (
                    <button
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => void handOver(order)}
                      data-testid="order-handover"
                      title={courierBooked(order) ? 'Collected by the customer or brought by hand: the courier booking is cancelled, then the order is delivered' : 'Collected by the customer or brought by hand: delivered without a courier'}
                      className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-success-line bg-success-soft text-success hover:opacity-90 disabled:opacity-50"
                    >
                      Handed over in person
                    </button>
                  )}
                  {(heldForWhatsApp(order) ? [] : NEXT_ACTIONS[order.status] || []).map((action) => (
                    <button
                      key={action.to}
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => patchOrder(order, { status: action.to })}
                      className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-line bg-ivory text-ink hover:bg-sand disabled:opacity-50"
                    >
                      {action.label}
                    </button>
                  ))}
                  {isCard && cardPaid && order.status !== 'delivered' && !order.card?.refundOutsideAt ? (
                    <button
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => void refundOrder(order)}
                      className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-danger-line bg-surface text-danger hover:bg-danger-soft disabled:opacity-50 ml-auto"
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
                      className="min-h-11 md:min-h-0 inline-flex items-center px-2 py-1 rounded-lg font-semibold border border-danger-line bg-surface text-danger hover:bg-danger-soft disabled:opacity-50 ml-auto"
                    >
                      Cancel order
                    </button>
                  )}
                </>
                </div>

                {packing === order.id && <OrderPackCheck order={order} onClose={() => setPacking('')} />}

                <OrderTimeline orderId={order.id} />
              </div>
            );
          })
        )}
        {/* A page at a time: never hundreds of cards at once; older finished orders come from the server */}
        {found.error && <p role="alert" className="text-xs text-danger">{found.error}</p>}
        {filteredOrders.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-soft" data-testid="orders-paging">
            <span role="status" data-testid="orders-shown">
              Showing {shownOrders.length}
              {knownTotal !== null ? ` of ${knownTotal}` : ''}
            </span>
            {(visible < filteredOrders.length || olderFrom) && (
              <button type="button" onClick={showMore} disabled={found.loading} data-testid="orders-more" className="min-h-11 px-4 rounded-xl border border-line-strong bg-surface text-ink font-semibold hover:bg-sand disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
                {found.loading ? 'Loading…' : visible < filteredOrders.length ? 'Show more orders' : 'Load older orders'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ORDER CONFIRMATION & SMART COURIER ASSIGNMENT MODAL */}
      {editing && <OrderEdit order={editing} onClose={() => setEditing(null)} onSaved={(o) => onOrderChanged(o)} />}

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

              {/* Extra to collect (asked by the owner): 0 unless money is still to be taken from the customer. */}
              <div className="col-span-2 sm:col-span-3 grid grid-cols-1 min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-2" data-testid="extra-charge">
                <div>
                  <label htmlFor="dispatch-extra" className="block text-ink-soft font-semibold mb-1">Extra to collect (AED)</label>
                  <input id="dispatch-extra" type="number" inputMode="decimal" min={0} max={10000} step="0.01" value={extraCharge} onChange={(e) => setExtraCharge(e.target.value)} className="w-full px-3 py-1.5 rounded-xl border border-line-strong text-xs" aria-describedby="dispatch-collect" />
                </div>
                <div>
                  <label htmlFor="dispatch-extra-note" className="block text-ink-soft font-semibold mb-1">Reason <span className="font-normal">(optional)</span></label>
                  <input id="dispatch-extra-note" type="text" maxLength={120} placeholder="e.g. 1 extra pillow cover" value={extraNote} onChange={(e) => setExtraNote(e.target.value)} className="w-full px-3 py-1.5 rounded-xl border border-line-strong text-xs" />
                </div>
                <p id="dispatch-collect" data-testid="collect-preview" role="status" className={`col-span-full text-[11px] ${collectPreview > 0 ? 'text-ink font-semibold' : 'text-ink-soft'}`}>
                  {collectPreview > 0 ? `The courier collects AED ${(collectPreview / 100).toFixed(2)} from the customer` : 'Nothing to collect: prepaid'}
                  {creditInFils(selectedOrderForConfirm) ? ` (after AED ${(creditInFils(selectedOrderForConfirm) / 100).toFixed(2)} paid on ${selectedOrderForConfirm.creditsIn!.map((c) => c.fromOrderId).join(', ')})` : ''}.
                </p>
              </div>

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
          paper={courierSettings.labelPaper ?? 'a5'}
          printerEmail={courierSettings.printerEmail}
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
