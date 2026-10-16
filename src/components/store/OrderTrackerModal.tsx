'use client';

import React, { useState } from 'react';
import { Order } from '@/types';
import { X, Search, Truck, ExternalLink, MapPin } from 'lucide-react';
import { postJson, safeHref } from '@/lib/apiClient';

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
    setMessage(data.found ? '' : data.message || 'No order matches that order number and phone number.');
    setHasSearched(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overscroll-contain sheet-fade">
      <div className="bg-white rounded-3xl max-w-lg w-full p-5 shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-stone-200">
          <div className="flex items-center gap-2">
            <Truck className="w-5 h-5 text-[#c5a059]" />
            <h2 className="font-serif font-bold text-base text-[#0f1c2e]">
              Track Your UAE Bedding Order
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Track Order"
            className="p-1 text-stone-500 hover:text-stone-700 rounded-full hover:bg-stone-100"
          >
            <X className="w-5 h-5" />
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
            className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 text-xs font-mono uppercase focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
          />
          <input
            type="tel"
            required
            aria-label="Mobile number on the order"
            placeholder="Mobile on the order"
            value={phone}
            maxLength={20}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
          />
          <button
            type="submit"
            disabled={searching}
            className="bg-[#0f1c2e] hover:bg-stone-800 disabled:opacity-60 text-white px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
          >
            <Search className="w-4 h-4" />
            <span>{searching ? 'Finding…' : 'Track'}</span>
          </button>
        </form>

        {/* Search Result Display */}
        {hasSearched && (
          <div>
            {searchResult ? (
              <div className="bg-stone-50 rounded-2xl p-4 border border-stone-200 text-xs space-y-3 animate-in fade-in-50">
                <div className="flex justify-between items-start pb-2 border-b border-stone-200">
                  <div>
                    <span className="font-mono font-bold text-sm text-[#0f1c2e]">
                      {searchResult.id}
                    </span>
                    <div className="text-[10px] text-stone-500">
                      Placed on {new Date(searchResult.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <span
                    className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      searchResult.status === 'dispatched'
                        ? 'bg-blue-100 text-blue-800'
                        : searchResult.status === 'confirmed'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {searchResult.status.replace(/_/g, ' ')}
                  </span>
                </div>

                {/* Courier Details */}
                <div className="bg-white p-3 rounded-xl border border-stone-200 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Delivery Service:</span>
                    <strong className="text-[#0f1c2e]">
                      UAE Priority Express Delivery
                    </strong>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Airway Bill (AWB):</span>
                    <span className="font-mono font-bold text-amber-700">
                      {searchResult.courier.awbNumber || 'Assigned when your order is dispatched'}
                    </span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-stone-500 font-medium">Status Note:</span>
                    <span className="font-medium text-stone-800">
                      {searchResult.courier.status}
                    </span>
                  </div>

                  {safeHref(searchResult.courier.trackingUrl) && (
                    <a
                      href={safeHref(searchResult.courier.trackingUrl)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 flex items-center justify-center gap-1.5 w-full bg-[#c5a059]/15 hover:bg-[#c5a059]/25 text-amber-900 font-semibold py-2 rounded-lg transition-colors text-xs"
                    >
                      <span>Open Live Carrier Tracking Page</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                {/* Items */}
                <div>
                  <span className="font-bold text-stone-700 block mb-1">Items in this Parcel:</span>
                  <div className="space-y-1">
                    {searchResult.items.map((i, idx) => (
                      <div key={idx} className="flex justify-between text-stone-600 text-[11px]">
                        <span>
                          {i.quantity}x {i.title} ({i.profileName})
                        </span>
                        <span className="font-semibold text-stone-900">AED {i.totalPrice}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Destination */}
                <div className="flex items-center gap-1.5 text-stone-500 text-[11px] pt-1">
                  <MapPin className="w-3.5 h-3.5 text-[#c5a059]" />
                  <span>
                    Delivering to {searchResult.firstName} in {searchResult.area}, {searchResult.emirate}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-stone-500 text-xs bg-stone-50 rounded-2xl border border-stone-200">
                {message}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
