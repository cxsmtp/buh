'use client';

import React, { useState } from 'react';
import { Order } from '@/types';
import { X, Search, Truck, CheckCircle2, Clock, ExternalLink, MapPin } from 'lucide-react';
import { safeHref } from '@/lib/apiClient';

interface OrderTrackerModalProps {
  isOpen: boolean;
  onClose: () => void;
  orders: Order[];
}

export const OrderTrackerModal: React.FC<OrderTrackerModalProps> = ({
  isOpen,
  onClose,
  orders,
}) => {
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<Order | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  if (!isOpen) return null;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = query.trim().toLowerCase();
    const found = orders.find(
      (o) =>
        o.id.toLowerCase() === clean ||
        o.customer.phone.replace(/\s+/g, '').includes(clean) ||
        o.courier.awbNumber.toLowerCase() === clean
    );
    setSearchResult(found || null);
    setHasSearched(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
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
            onClick={onClose}
            className="p-1 text-stone-400 hover:text-stone-700 rounded-full hover:bg-stone-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              placeholder="Enter Order # (e.g. BUH-2026-1094) or Mobile"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 text-xs focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
            />
          </div>
          <button
            type="submit"
            className="bg-[#0f1c2e] hover:bg-stone-800 text-white px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Search className="w-4 h-4" />
            <span>Track</span>
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
                    {searchResult.status.replace('_', ' ')}
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
                      {searchResult.courier.awbNumber}
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
                    Delivering to {searchResult.customer.buildingVilla}, {searchResult.customer.area}, {searchResult.customer.emirate}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-center py-6 text-stone-500 text-xs bg-stone-50 rounded-2xl border border-stone-200">
                No active order found matching &quot;{query}&quot;. Please verify the order number or mobile phone number.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
