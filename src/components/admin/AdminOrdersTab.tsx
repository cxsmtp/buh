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
  Banknote
} from 'lucide-react';
import { postJson, sendJson } from '@/lib/apiClient';

interface AdminOrdersTabProps {
  orders: Order[];
  /** An order changed on the server (status, payment, courier): replace it in the list. */
  onOrderChanged: (order: Order) => void;
  courierSettings: CourierSettings;
}

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

  const patchOrder = async (order: Order, changes: Partial<Pick<Order, 'status' | 'paymentStatus' | 'adminNotes'>>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyOrderId(order.id);
    const { ok, data } = await sendJson<{ order?: Order; message?: string }>('PATCH', `/api/admin/orders/${encodeURIComponent(order.id)}`, changes);
    setBusyOrderId('');
    if (ok && data.order) onOrderChanged(data.order);
    else alert(data.message || 'The order could not be updated.');
  };

  const [filter, setFilter] = useState<'all' | 'pending' | 'confirmed' | 'dispatched'>('all');
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
    if (filter === 'confirmed') return o.status === 'confirmed';
    if (filter === 'dispatched') return o.status === 'dispatched';
    return true;
  });

  const openConfirmationModal = (order: Order) => {
    setSelectedOrderForConfirm(order);
    
    // Auto-select smart courier:
    // COD -> Jeebly
    // Prepaid -> Eco Express
    const defaultProvider: CourierProvider = order.paymentMethod === 'cod'
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
          { id: 'confirmed', label: 'Confirmed & AWB Ready' },
          { id: 'dispatched', label: 'Dispatched / In Transit' },
        ].map((tab) => {
          const count = orders.filter((o) => {
            if (tab.id === 'pending') return o.status === 'pending_confirmation';
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
                  ? 'bg-[#0f1c2e] text-white shadow-sm'
                  : 'bg-white text-stone-700 hover:bg-stone-100 border border-stone-200'
              }`}
            >
              <span>{tab.label}</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                filter === tab.id ? 'bg-amber-400 text-stone-900 font-bold' : 'bg-stone-200 text-stone-700'
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
          <div className="bg-white rounded-2xl p-8 text-center border border-stone-200 text-stone-500 text-xs">
            No orders found under this filter.
          </div>
        ) : (
          filteredOrders.map((order) => {
            const isPending = order.status === 'pending_confirmation';
            const isCod = order.paymentMethod === 'cod';

            return (
              <div
                key={order.id}
                className="bg-white rounded-2xl p-4 border border-stone-200 hover:border-stone-300 shadow-sm space-y-3 transition-all"
              >
                {/* Top Strip */}
                <div className="flex items-start justify-between gap-2 border-b border-stone-100 pb-2.5">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-sm text-[#0f1c2e]">
                        {order.id}
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          isPending
                            ? 'bg-amber-100 text-amber-900 border border-amber-300'
                            : order.status === 'confirmed'
                            ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                            : 'bg-blue-100 text-blue-900 border border-blue-300'
                        }`}
                      >
                        {order.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-stone-500 mt-0.5">
                      {new Date(order.createdAt).toLocaleString()} • {order.customer.fullName}
                    </div>
                  </div>

                  {/* Payment Mode Badge */}
                  <div className="text-right">
                    <span className="text-base font-bold text-[#0f1c2e] block">
                      AED {order.total}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md ${
                        isCod
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      }`}
                    >
                      {isCod ? <Banknote className="w-3 h-3" /> : <Building2 className="w-3 h-3" />}
                      <span>{isCod ? 'Cash on Delivery' : 'Bank Transfer'}</span>
                    </span>
                  </div>
                </div>

                {/* Items & Delivery Info */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {/* Items */}
                  <div className="space-y-1">
                    <span className="text-[10px] font-bold text-stone-500 uppercase tracking-wider block">
                      Bedding Ordered:
                    </span>
                    {order.items.map((i, idx) => (
                      <div key={idx} className="flex items-center gap-2 text-stone-800">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={i.image} alt={i.title} className="w-6 h-6 rounded object-cover" />
                        <span className="truncate">
                          <strong>{i.quantity}x</strong> {i.title} ({i.profileName.split(' ')[0]})
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Destination */}
                  <div className="space-y-1 sm:border-l sm:border-stone-100 sm:pl-3">
                    <span className="text-[10px] font-bold text-stone-500 uppercase tracking-wider block">
                      UAE Delivery Destination:
                    </span>
                    <div className="text-stone-800 font-medium">
                      {order.customer.buildingVilla}, {order.customer.flatVillaNo}, {order.customer.area}
                    </div>
                    <div className="text-stone-500 text-[11px]">
                      Emirate: <strong>{order.customer.emirate}</strong> • Tel: {order.customer.phone}
                    </div>
                  </div>
                </div>

                {/* Courier Assignment Bar */}
                <div className="bg-stone-50 rounded-xl p-2.5 flex flex-wrap items-center justify-between gap-2 text-xs border border-stone-200/80">
                  <div className="flex items-center gap-2">
                    <Truck className="w-4 h-4 text-[#c5a059]" />
                    <span className="text-stone-600">Assigned Courier:</span>
                    <strong className="text-stone-900 capitalize">
                      {order.courier.provider === 'jeebly' ? 'Jeebly Logistics' : 'Eco Express'}
                    </strong>
                    {order.courier.awbNumber && (
                      <span className="font-mono text-[11px] text-amber-700 bg-amber-100 px-2 py-0.5 rounded font-bold">
                        AWB: {order.courier.awbNumber}
                      </span>
                    )}
                  </div>

                  {/* Status */}
                  <div className="text-[11px] text-stone-500">
                    Pickup: <strong>{order.courier.pickupDate || 'Tomorrow'}</strong>
                  </div>
                </div>

                {/* Payment & progress */}
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  {!isCod && (
                    <>
                      <span
                        className={`px-2 py-1 rounded-lg font-semibold border ${
                          order.paymentStatus === 'verified' || order.paymentStatus === 'paid'
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : 'bg-amber-50 text-amber-900 border-amber-200'
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
                          className="px-2 py-1 rounded-lg font-semibold border border-stone-300 bg-white text-stone-800 hover:bg-stone-100"
                        >
                          View receipt
                        </a>
                      )}
                      {order.paymentStatus !== 'verified' && order.paymentStatus !== 'paid' && order.status !== 'cancelled' && (
                        <button
                          type="button"
                          disabled={busyOrderId === order.id}
                          onClick={() => patchOrder(order, { paymentStatus: 'verified' }, `Confirm that AED ${order.total} for ${order.id} has arrived in the bank account?`)}
                          className="px-2 py-1 rounded-lg font-semibold border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Mark payment received
                        </button>
                      )}
                    </>
                  )}
                  {(NEXT_ACTIONS[order.status] || []).map((action) => (
                    <button
                      key={action.to}
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() => patchOrder(order, { status: action.to })}
                      className="px-2 py-1 rounded-lg font-semibold border border-blue-200 bg-blue-50 text-blue-900 hover:bg-blue-100 disabled:opacity-50"
                    >
                      {action.label}
                    </button>
                  ))}
                  {order.status !== 'cancelled' && order.status !== 'delivered' && (
                    <button
                      type="button"
                      disabled={busyOrderId === order.id}
                      onClick={() =>
                        patchOrder(order, { status: 'cancelled' }, `Cancel order ${order.id}? Its items go back into stock. This cannot be undone.`)
                      }
                      className="px-2 py-1 rounded-lg font-semibold border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50 ml-auto"
                    >
                      Cancel order
                    </button>
                  )}
                </div>

                {/* Action Buttons */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    {/* Print Label only once the carrier has issued the AWB */}
                    {order.courier.awbNumber && order.courier.labelGenerated && (
                      <button
                        onClick={() => setLabelOrder(order)}
                        className="flex items-center gap-1.5 text-xs text-stone-800 bg-stone-100 hover:bg-stone-200 border border-stone-300 font-semibold px-3 py-1.5 rounded-xl transition-colors"
                        title="Print Courier AWB Label"
                      >
                        <Printer className="w-3.5 h-3.5 text-[#c5a059]" />
                        <span>Print Shipping Label</span>
                      </button>
                    )}

                    {/* WhatsApp notification */}
                    <button
                      onClick={() => sendWhatsAppUpdate(order)}
                      className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 font-semibold px-3 py-1.5 rounded-xl transition-colors"
                      title="Send WhatsApp update to customer"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      <span>WhatsApp Customer</span>
                    </button>
                  </div>

                  {/* Confirm Order Action (Primary) */}
                  {isPending ? (
                    <button
                      onClick={() => openConfirmationModal(order)}
                      className="flex items-center gap-1.5 bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold text-xs px-4 py-2 rounded-xl transition-all shadow active:scale-95"
                    >
                      <CheckCircle2 className="w-4 h-4 text-amber-300" />
                      <span>Confirm & Assign Courier</span>
                    </button>
                  ) : (
                    <span className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Ready for Dispatch
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ORDER CONFIRMATION & SMART COURIER ASSIGNMENT MODAL */}
      {selectedOrderForConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white rounded-3xl max-w-lg w-full p-5 shadow-2xl space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-200">
              <div>
                <h3 className="font-serif font-bold text-base text-[#0f1c2e]">
                  Confirm Order & Generate AWB Label
                </h3>
                <p className="text-xs text-stone-500">
                  Order #{selectedOrderForConfirm.id} • {selectedOrderForConfirm.customer.fullName}
                </p>
              </div>
              <button
                onClick={() => setSelectedOrderForConfirm(null)}
                className="p-1.5 text-stone-400 hover:text-stone-700 rounded-full hover:bg-stone-100"
              >
                ✕
              </button>
            </div>

            {/* Smart Routing Callout */}
            <div className={`p-3 rounded-2xl border text-xs space-y-1 ${
              selectedOrderForConfirm.paymentMethod === 'cod'
                ? 'bg-red-50/70 border-red-200 text-red-950'
                : 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
            }`}>
              <div className="flex items-center justify-between font-bold">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-[#c5a059]" />
                  <span>
                    {selectedOrderForConfirm.paymentMethod === 'cod'
                      ? 'Payment: Cash on Delivery (COD)'
                      : 'Payment: Direct Bank Transfer (Prepaid)'}
                  </span>
                </span>
                <span className="text-sm">AED {selectedOrderForConfirm.total}</span>
              </div>
              <p className="text-[11px] text-stone-600">
                {selectedOrderForConfirm.paymentMethod === 'cod'
                  ? 'Smart Routing Rule: Cash on Delivery orders default to Jeebly Logistics (UAE COD specialist).'
                  : 'Smart Routing Rule: Prepaid orders default to Eco Express Courier Services (Priority Express).'}
              </p>
            </div>

            {/* Courier Selection (With 1-Click Override) */}
            <div className="space-y-2">
              <label className="text-xs font-bold text-stone-900 uppercase tracking-wider block">
                Select Courier Service Provider:
              </label>

              <div className="grid grid-cols-2 gap-2">
                {/* Jeebly Option */}
                <button
                  type="button"
                  onClick={() => setChosenCourier('jeebly')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    chosenCourier === 'jeebly'
                      ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-md'
                      : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300'
                  }`}
                >
                  <div className="font-bold text-xs flex items-center justify-between">
                    <span>Jeebly Logistics</span>
                    {chosenCourier === 'jeebly' && <span className="text-amber-300">✓</span>}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${chosenCourier === 'jeebly' ? 'text-amber-200' : 'text-stone-500'}`}>
                    Default for COD
                  </div>
                </button>

                {/* Eco Express Option */}
                <button
                  type="button"
                  onClick={() => setChosenCourier('echo')}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    chosenCourier === 'echo'
                      ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-md'
                      : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300'
                  }`}
                >
                  <div className="font-bold text-xs flex items-center justify-between">
                    <span>Eco Express Courier</span>
                    {chosenCourier === 'echo' && <span className="text-amber-300">✓</span>}
                  </div>
                  <div className={`text-[10px] mt-0.5 ${chosenCourier === 'echo' ? 'text-amber-200' : 'text-stone-500'}`}>
                    Default for Prepaid
                  </div>
                </button>
              </div>
            </div>

            {/* Shipment Dispatch Parameters */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <label className="block text-stone-600 font-semibold mb-1">
                  Pickup Date
                </label>
                <input
                  type="date"
                  value={pickupDate}
                  onChange={(e) => setPickupDate(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-stone-600 font-semibold mb-1">
                  Weight (KG)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={weightKg}
                  onChange={(e) => setWeightKg(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-stone-600 font-semibold mb-1">
                  Parcels
                </label>
                <input
                  type="number"
                  value={pieces}
                  onChange={(e) => setPieces(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 rounded-xl border border-stone-300 text-xs"
                />
              </div>

              <div className="col-span-3">
                <label className="block text-stone-600 font-semibold mb-1">
                  Driver Instructions & Notes
                </label>
                <input
                  type="text"
                  placeholder="e.g. Call before delivery, handle luxury bedding with care"
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-xl border border-stone-300 text-xs"
                />
              </div>
            </div>

            {/* Submit Action */}
            <div className="pt-2">
              <button
                type="button"
                disabled={isDispatching}
                onClick={handleConfirmAndDispatch}
                className="w-full bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold text-xs py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all disabled:opacity-50"
              >
                {isDispatching ? (
                  <span>Connecting to Courier API & Booking Dispatch...</span>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-amber-300" />
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
