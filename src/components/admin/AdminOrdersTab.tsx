'use client';

import React, { useState } from 'react';
import { Order, CourierProvider, CourierSettings } from '@/types';
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
import { postJson, sendJson } from '@/lib/apiClient';
import { awaitingWhatsApp, heldForWhatsApp, OrderTimeline, OrderWhatsAppCheck } from './OrderWhatsAppCheck';

interface AdminOrdersTabProps {
  orders: Order[];
  /** An order changed on the server (status, payment, courier): replace it in the list. */
  onOrderChanged: (order: Order) => void;
  courierSettings: CourierSettings;
}

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
}) => {
  const [busyOrderId, setBusyOrderId] = useState('');

  const patchOrder = async (order: Order, changes: Partial<Pick<Order, 'status' | 'paymentStatus' | 'adminNotes'>> & { clearAttention?: true }, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyOrderId(order.id);
    const { ok, data } = await sendJson<{ order?: Order; message?: string }>('PATCH', `/api/admin/orders/${encodeURIComponent(order.id)}`, changes);
    setBusyOrderId('');
    if (ok && data.order) onOrderChanged(data.order);
    else alert(data.message || 'The order could not be updated.');
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
    const { ok, data } = await postJson<{ order?: Order; message?: string; code?: string }>(`/api/admin/orders/${encodeURIComponent(order.id)}/refund`, { amount });
    setBusyOrderId('');
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

  /** "Mark as handled" on a note that needed the owner (a failed refund, a booking after a cancel…). */
  const handled = (order: Order) => patchOrder(order, { clearAttention: true });

  const [filter, setFilter] = useState<'all' | 'pending' | 'whatsapp' | 'card' | 'confirmed' | 'dispatched'>('all');
  // Orders the owner has just answered stay in "Awaiting WhatsApp" for now, so the reply link is right there.
  const [justChecked, setJustChecked] = useState<string[]>([]);
  const whatsappChecked = (o: Order) => {
    setJustChecked((ids) => (ids.includes(o.id) ? ids : [...ids, o.id]));
    onOrderChanged(o);
  };
  const [selectedOrderForConfirm, setSelectedOrderForConfirm] = useState<Order | null>(null);
  const [labelOrder, setLabelOrder] = useState<Order | null>(null);

  // Confirmation Modal Form State
  const [chosenCourier, setChosenCourier] = useState<CourierProvider>('jeebly');
  const [pickupDate, setPickupDate] = useState<string>('');
  const [weightKg, setWeightKg] = useState<number>(2.5);
  const [pieces, setPieces] = useState<number>(1);
  const [adminNotes, setAdminNotes] = useState<string>('');
  const [isDispatching, setIsDispatching] = useState<boolean>(false);

  const filteredOrders = orders.filter((o) => {
    if (filter === 'pending') return o.status === 'pending_confirmation';
    if (filter === 'whatsapp') return awaitingWhatsApp(o) || justChecked.includes(o.id);
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
    setWeightKg(order.courier.weightKg || 2.5);
    setPieces(order.courier.pieces || 1);
    setAdminNotes(order.adminNotes || '');
  };

  const handleConfirmAndDispatch = async () => {
    if (!selectedOrderForConfirm) return;
    const o = selectedOrderForConfirm;
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
      weightKg,
      pieces,
      adminNotes,
    };
    type DispatchReply = { success?: boolean; message?: string; awbNumber?: string; isSimulated?: boolean; needsConfirm?: boolean; alreadyBooked?: boolean; order?: Order };
    let { ok, status, data } = await postJson<DispatchReply>('/api/courier/dispatch', request);
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
    setLabelOrder(data.order);
  };

  const sendWhatsAppUpdate = (order: Order) => {
    const courierName = order.courier.provider === 'jeebly' ? 'Jeebly Logistics' : 'Eco Express Courier';
    const text = encodeURIComponent(
      `Dear ${order.customer.fullName}, Greetings from Beautiful UAE Home!\n\nYour luxury bedding order #${order.id} has been confirmed and scheduled for dispatch via ${courierName}.\n\nAirway Bill (AWB): ${order.courier.awbNumber}\nTrack shipment: ${order.courier.trackingUrl}\nTotal: AED ${order.total} (${order.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Prepaid'})\n\nThank you for shopping with Beautiful UAE Home!`
    );
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
          { id: 'card', label: 'Card payments' },
          { id: 'confirmed', label: 'Confirmed & AWB Ready' },
          { id: 'dispatched', label: 'Dispatched / In Transit' },
        ].filter((tab) => (tab.id !== 'whatsapp' || orders.some((o) => o.whatsappCheck)) && (tab.id !== 'card' || orders.some((o) => o.paymentMethod === 'online_card'))).map((tab) => {
          const count = orders.filter((o) => {
            if (tab.id === 'pending') return o.status === 'pending_confirmation';
            if (tab.id === 'whatsapp') return awaitingWhatsApp(o);
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
                  ? 'bg-ink text-white shadow-sm'
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

                {/* Confirm on WhatsApp: first, so the owner sees it on the phone */}
                <OrderWhatsAppCheck order={order} onOrderChanged={whatsappChecked} />

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
                          <strong>{i.quantity}x</strong> {i.title} ({i.profileName.split(' ')[0]})
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
                  <div className="flex items-center gap-2">
                    <Truck className="w-4 h-4 text-gold" />
                    <span className="text-ink-soft">Assigned Courier:</span>
                    <strong className="text-ink capitalize">
                      {order.courier.provider === 'jeebly' ? 'Jeebly Logistics' : 'Eco Express'}
                    </strong>
                    {order.courier.awbNumber && (
                      <span className="font-mono text-[11px] text-warning bg-warning-soft px-2 py-0.5 rounded font-bold">
                        AWB: {order.courier.awbNumber}
                      </span>
                    )}
                  </div>

                  {/* Status */}
                  <div className="text-[11px] text-ink-muted">
                    Pickup: <strong>{order.courier.pickupDate || 'Tomorrow'}</strong>
                  </div>
                </div>

                {/* Something the owner must look at (a refund that failed, a booking after a cancel…) */}
                {order.attention && (
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
                  {!isCod && !isCard && (
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
                      {order.paymentReceiptUrl && (
                        <a
                          href={order.paymentReceiptUrl}
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
                          onClick={() => patchOrder(order, { paymentStatus: 'verified' }, `Confirm that AED ${order.total} for ${order.id} has arrived in the bank account?`)}
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
                  <div className="flex items-center gap-2">
                    {/* Print Label only once the carrier has issued the AWB */}
                    {order.courier.awbNumber && order.courier.labelGenerated && (
                      <button
                        onClick={() => setLabelOrder(order)}
                        className="flex items-center gap-1.5 text-xs text-ink bg-sand hover:bg-sand-deep border border-line-strong font-semibold px-3 py-1.5 rounded-xl transition-colors"
                        title="Print Courier AWB Label"
                      >
                        <Printer className="w-3.5 h-3.5 text-gold" />
                        <span>Print Shipping Label</span>
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
                      className="flex items-center gap-1.5 bg-ink hover:bg-ink text-white font-bold text-xs px-4 py-2 rounded-xl transition-all shadow active:scale-95"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-3 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="confirm-order-title">
          <div className="bg-surface rounded-3xl max-w-lg w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain p-5 border border-line space-y-4">
            {/* Header (stays in view) */}
            <div className="sticky top-0 z-10 -mx-5 -mt-5 px-5 pt-4 pb-3 bg-surface flex items-start justify-between gap-2 border-b border-line">
              <div className="min-w-0">
                <h3 id="confirm-order-title" className="font-serif text-xl text-ink">
                  Confirm Order & Generate AWB Label
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
                      ? 'border-ink bg-ink text-white shadow-md'
                      : 'border-line bg-surface text-ink-soft hover:border-line-strong'
                  }`}
                >
                  <div className="font-bold text-xs flex items-center justify-between">
                    <span>Jeebly Logistics</span>
                    {chosenCourier === 'jeebly' && <span className="text-gold-light">✓</span>}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${chosenCourier === 'jeebly' ? 'text-gold-light' : 'text-ink-muted'}`}>
                    Default for COD
                  </div>
                </button>

                {/* Eco Express Option */}
                <button
                  type="button"
                  onClick={() => setChosenCourier('echo')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    chosenCourier === 'echo'
                      ? 'border-ink bg-ink text-white shadow-md'
                      : 'border-line bg-surface text-ink-soft hover:border-line-strong'
                  }`}
                >
                  <div className="font-bold text-xs flex items-center justify-between">
                    <span>Eco Express Courier</span>
                    {chosenCourier === 'echo' && <span className="text-gold-light">✓</span>}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${chosenCourier === 'echo' ? 'text-gold-light' : 'text-ink-muted'}`}>
                    Default for Prepaid
                  </div>
                </button>
              </div>
            </div>

            {/* Shipment Dispatch Parameters */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Pickup Date
                </label>
                <input
                  type="date"
                  value={pickupDate}
                  onChange={(e) => setPickupDate(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-line-strong text-xs"
                />
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Weight (KG)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={weightKg}
                  onChange={(e) => setWeightKg(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-line-strong text-xs"
                />
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Parcels
                </label>
                <input
                  type="number"
                  value={pieces}
                  onChange={(e) => setPieces(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-line-strong text-xs"
                />
              </div>

              <div className="col-span-3">
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
              <button
                type="button"
                disabled={isDispatching}
                onClick={handleConfirmAndDispatch}
                className="w-full bg-ink hover:bg-ink text-white font-bold text-xs py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50"
              >
                {isDispatching ? (
                  <span>Connecting to Courier API & Booking Dispatch...</span>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-gold-light" />
                    <span>Confirm Order & Dispatch to {chosenCourier === 'jeebly' ? 'Jeebly' : 'Eco Express'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PRINTABLE SHIPPING LABEL MODAL */}
      {labelOrder && (
        <ShippingLabelModal
          order={labelOrder}
          onClose={() => setLabelOrder(null)}
        />
      )}
    </div>
  );
};
