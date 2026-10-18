'use client';

import React, { useState } from 'react';
import type { BankTransferCheck, Order, WhatsAppCheck } from '@/types';
import { X, Search, Truck, ExternalLink, MapPin, Upload, CheckCircle2 } from 'lucide-react';
import { postJson, safeHref } from '@/lib/apiClient';
import { WhatsAppConfirm } from './WhatsAppConfirm';
import { cancelHoursOf } from '@/lib/whatsappConfirm';

interface OrderTrackerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The order number of this visitor's latest order, to pre-fill. */
  lastOrderId?: string;
}

/** What Track Order shows: status and delivery, never the address, email or full name. */
interface TrackedOrder {
  id: string;
  createdAt: string;
  status: Order['status'];
  total: number;
  firstName: string;
  emirate: string;
  area: string;
  items: Array<{ title: string; profileName: string; quantity: number; totalPrice: number }>;
  courier: { awbNumber: string; trackingUrl: string; status: string };
  whatsappCheck?: Pick<WhatsAppCheck, 'status' | 'code' | 'hold' | 'cancelAt' | 'openBy'>;
  /** A bank transfer: where it stands, and the customer's own private page while it is open. */
  bankTransfer?: Pick<BankTransferCheck, 'state' | 'uploads' | 'payPath'>;
}

export const OrderTrackerModal: React.FC<OrderTrackerModalProps> = ({
  isOpen,
  onClose,
  lastOrderId,
}) => {
  const [orderId, setOrderId] = useState(lastOrderId || '');
  const [phone, setPhone] = useState('');
  const [searchResult, setSearchResult] = useState<TrackedOrder | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [message, setMessage] = useState('');
  const [searching, setSearching] = useState(false);
  /** The phone the order was found with (for the "Confirm on WhatsApp" ping). */
  const [foundPhone, setFoundPhone] = useState('');

  if (!isOpen) return null;

  // Both the order number and the phone on the order are needed, so nobody can look up someone else's order.
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orderId.trim() || !phone.trim()) return;
    setSearching(true);
    const { data } = await postJson<{ found?: boolean; order?: TrackedOrder; message?: string }>('/api/orders/lookup', {
      orderId: orderId.trim(),
      phone: phone.trim(),
    });
    setSearching(false);
    setSearchResult(data.found && data.order ? data.order : null);
    setFoundPhone(phone.trim());
    setMessage(data.found ? '' : data.message || 'No order matches that order number and phone number.');
    setHasSearched(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-3 sm:p-4 overscroll-contain sheet-fade" role="dialog" aria-modal="true" aria-labelledby="track-title">
      <div className="bg-surface rounded-3xl max-w-lg w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain px-5 pb-5 border border-line space-y-4">
        {/* Header */}
        <div className="sticky top-0 z-10 -mx-5 px-5 pt-4 pb-3 !mb-4 bg-surface flex items-center justify-between gap-3 border-b border-line">
          <div className="flex items-center gap-2 min-w-0">
            <Truck className="w-5 h-5 text-gold-deep shrink-0" strokeWidth={1.5} />
            <h2 id="track-title" className="font-serif text-2xl text-ink">
              Track your order
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Track Order"
            className="shrink-0 w-10 h-10 -mr-2 flex items-center justify-center text-ink rounded-full hover:bg-sand"
          >
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>

        {/* Search Input */}
        <form onSubmit={handleSearch} className="grid grid-cols-1 min-[420px]:grid-cols-[1fr_1fr_auto] gap-2">
          <input
            type="text"
            required
            aria-label="Order number"
            placeholder="Order number (BUH-…)"
            value={orderId}
            maxLength={40}
            onChange={(e) => setOrderId(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong text-xs font-mono uppercase focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <input
            type="tel"
            required
            aria-label="Mobile number on the order"
            placeholder="Mobile on the order"
            value={phone}
            maxLength={20}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong text-xs focus:outline-none focus:ring-2 focus:ring-gold"
          />
          <button
            type="submit"
            disabled={searching}
            className="bg-ink hover:bg-ink disabled:opacity-60 text-paper px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
          >
            <Search className="w-4 h-4" />
            <span>{searching ? 'Finding…' : 'Track'}</span>
          </button>
        </form>

        {/* Search Result Display */}
        {hasSearched && (
          <div>
            {searchResult ? (
              <div className="bg-ivory rounded-2xl p-4 border border-line text-xs space-y-3 animate-in fade-in-50">
                <div className="flex justify-between items-start pb-2 border-b border-line">
                  <div>
                    <span className="font-mono font-semibold text-sm text-ink">
                      {searchResult.id}
                    </span>
                    <div className="text-[10px] text-ink-muted">
                      Placed on {new Date(searchResult.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                      searchResult.status === 'dispatched'
                        ? 'bg-sand text-ink'
                        : searchResult.status === 'confirmed'
                        ? 'bg-success-soft text-success'
                        : 'bg-warning-soft text-warning'
                    }`}
                  >
                    {searchResult.status.replace(/_/g, ' ')}
                  </span>
                </div>

                {searchResult.whatsappCheck && searchResult.status !== 'cancelled' && (
                  <WhatsAppConfirm orderId={searchResult.id} phone={foundPhone} check={searchResult.whatsappCheck} bankDetails={Boolean(searchResult.bankTransfer && searchResult.bankTransfer.state !== 'paid')} cancelHours={cancelHoursOf(searchResult.createdAt, searchResult.whatsappCheck.cancelAt)} openHours={cancelHoursOf(searchResult.createdAt, searchResult.whatsappCheck.openBy)} />
                )}

                {/* Bank transfer: the details and the screenshot upload are on the order's private page. */}
                {searchResult.bankTransfer?.state === 'paid' ? (
                  <p role="status" className="flex items-center gap-1.5 font-semibold text-success bg-success-soft border border-success-line rounded-xl px-3 py-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> Your bank transfer has arrived. Thank you.
                  </p>
                ) : searchResult.bankTransfer?.payPath ? (
                  <div className="bg-surface p-3 rounded-xl border border-line space-y-2">
                    <p className="text-ink-soft leading-relaxed">
                      {searchResult.bankTransfer.state === 'uploaded'
                        ? 'We have your transfer screenshot and will confirm your order once we see the transfer.'
                        : 'Paying by bank transfer: our bank details and the upload for your transfer screenshot are on your order’s private page.'}
                    </p>
                    <a
                      href={searchResult.bankTransfer.payPath}
                      target="_blank"
                      rel="noopener"
                      className="w-full min-h-11 bg-ink hover:bg-ink-2 text-ivory font-semibold text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
                    >
                      <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{searchResult.bankTransfer.uploads > 0 ? 'Upload a different screenshot' : 'Upload your transfer screenshot'}</span>
                    </a>
                  </div>
                ) : null}

                {/* Courier Details */}
                <div className="bg-surface p-3 rounded-xl border border-line space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-ink-muted font-medium">Delivery Service:</span>
                    <strong className="text-ink">
                      UAE Priority Express Delivery
                    </strong>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-ink-muted font-medium">Airway Bill (AWB):</span>
                    <span className="font-mono font-semibold text-warning">
                      {searchResult.courier.awbNumber || 'Assigned when your order is dispatched'}
                    </span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-ink-muted font-medium">Status Note:</span>
                    <span className="font-medium text-ink">
                      {searchResult.courier.status}
                    </span>
                  </div>

                  {safeHref(searchResult.courier.trackingUrl) && (
                    <a
                      href={safeHref(searchResult.courier.trackingUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 flex items-center justify-center gap-1.5 w-full bg-gold/15 hover:bg-gold/25 text-warning font-semibold py-2 rounded-lg transition-colors text-xs"
                    >
                      <span>Open Live Carrier Tracking Page</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                {/* Items */}
                <div>
                  <span className="font-semibold text-ink-soft block mb-1">Items in this Parcel:</span>
                  <div className="space-y-1">
                    {searchResult.items.map((i, idx) => (
                      <div key={idx} className="flex justify-between text-ink-soft text-[11px]">
                        <span>
                          {i.quantity}x {i.title} ({i.profileName})
                        </span>
                        <span className="font-semibold text-ink">AED {i.totalPrice}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Destination */}
                <div className="flex items-center gap-1.5 text-ink-muted text-[11px] pt-1">
                  <MapPin className="w-3.5 h-3.5 text-gold" />
                  <span>
                    Delivering to {searchResult.firstName} in {searchResult.area}, {searchResult.emirate}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-ink-muted text-xs bg-ivory rounded-2xl border border-line">
                {message}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
