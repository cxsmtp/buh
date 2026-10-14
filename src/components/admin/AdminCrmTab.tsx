'use client';

import React, { useState } from 'react';
import { Customer, Order } from '@/types';
import { Users, Phone, MapPin, ShoppingBag, MessageCircle, Search, ExternalLink, Calendar, Star } from 'lucide-react';

interface AdminCrmTabProps {
  customers: Customer[];
  orders: Order[];
}

export const AdminCrmTab: React.FC<AdminCrmTabProps> = ({ customers, orders }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  const filtered = customers.filter(
    (c) =>
      c.fullName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.phone.includes(searchTerm) ||
      c.emirate.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.area.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const customerOrders = selectedCustomer
    ? orders.filter(
        (o) =>
          o.customer.phone.replace(/\s+/g, '') === selectedCustomer.phone.replace(/\s+/g, '')
      )
    : [];

  return (
    <div className="space-y-4">
      {/* Search Bar */}
      <div className="relative">
        <input
          type="text"
          placeholder="Search customers by name, phone (+971), or UAE Emirate..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-xs text-stone-900 focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
        />
      </div>

      {/* Grid of Customers */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((customer) => {
          const isSelected = selectedCustomer?.id === customer.id;
          const cleanPhone = customer.phone.replace(/[^0-9]/g, '');

          return (
            <div
              key={customer.id}
              onClick={() => setSelectedCustomer(isSelected ? null : customer)}
              className={`p-4 rounded-2xl border transition-all cursor-pointer bg-white text-xs space-y-2.5 shadow-sm hover:shadow-md ${
                isSelected
                  ? 'border-[#0f1c2e] ring-2 ring-[#c5a059]/40 bg-amber-50/20'
                  : 'border-stone-200 hover:border-stone-300'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-serif font-bold text-sm text-[#0f1c2e]">
                    {customer.fullName}
                  </h4>
                  <div className="flex items-center gap-1 text-[11px] text-stone-500 mt-0.5">
                    <Phone className="w-3 h-3 text-[#c5a059]" />
                    <span>{customer.phone}</span>
                  </div>
                </div>

                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 border border-stone-200">
                  {customer.emirate}
                </span>
              </div>

              {/* Address Strip */}
              <div className="text-[11px] text-stone-600 flex items-start gap-1.5 bg-stone-50 p-2 rounded-xl border border-stone-100">
                <MapPin className="w-3.5 h-3.5 text-[#c5a059] shrink-0 mt-0.5" />
                <span className="line-clamp-2">
                  {customer.defaultAddress.buildingVilla}, {customer.defaultAddress.flatVillaNo}, {customer.area}, {customer.emirate}
                  {customer.defaultAddress.landmark ? ` (Near ${customer.defaultAddress.landmark})` : ''}
                </span>
              </div>

              {/* Spend & Orders Metrics */}
              <div className="flex items-center justify-between pt-1 border-t border-stone-100 text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-[#0f1c2e]">{customer.totalOrders} {customer.totalOrders === 1 ? 'Order' : 'Orders'}</span>
                  <span>•</span>
                  <span className="font-bold text-amber-800">AED {customer.totalSpent}</span>
                </div>

                {/* WhatsApp Chat Button */}
                <a
                  href={`https://wa.me/${cleanPhone}?text=${encodeURIComponent(`Hello ${customer.fullName}, greetings from Beautiful UAE Home! How can we assist you with our hand-block printed bed linens?`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 text-[11px] text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-2 py-1 rounded-lg border border-emerald-300 transition-colors font-medium"
                >
                  <MessageCircle className="w-3 h-3" />
                  <span>WhatsApp</span>
                </a>
              </div>
            </div>
          );
        })}
      </div>

      {/* Customer Order History Drawer / Detail */}
      {selectedCustomer && (
        <div className="bg-stone-50 rounded-2xl p-4 border border-stone-200 space-y-3 mt-4 animate-in fade-in-50 text-xs">
          <div className="flex items-center justify-between border-b border-stone-200 pb-2">
            <div>
              <h4 className="font-serif font-bold text-sm text-[#0f1c2e]">
                Order History for {selectedCustomer.fullName}
              </h4>
              <span className="text-[11px] text-stone-500">
                Phone: {selectedCustomer.phone} • {selectedCustomer.emirate}
              </span>
            </div>
            <button
              onClick={() => setSelectedCustomer(null)}
              className="text-stone-400 hover:text-stone-700 font-bold"
            >
              ✕
            </button>
          </div>

          <div className="space-y-2">
            {customerOrders.length === 0 ? (
              <p className="text-stone-500 text-xs py-2">No past orders registered yet.</p>
            ) : (
              customerOrders.map((ord) => (
                <div
                  key={ord.id}
                  className="bg-white p-3 rounded-xl border border-stone-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs text-[#0f1c2e]">{ord.id}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-stone-100 text-stone-700 font-semibold uppercase">
                        {ord.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-stone-500 mt-0.5">
                      {ord.items.map((i) => `${i.quantity}x ${i.title} (${i.profileName.split(' ')[0]})`).join(', ')}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <span className="font-bold text-sm text-[#0f1c2e]">AED {ord.total}</span>
                      <span className="text-[10px] text-stone-500 block capitalize">{ord.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Bank Transfer'}</span>
                    </div>

                    {ord.courier.awbNumber && (
                      <span className="text-[10px] font-mono font-semibold bg-amber-50 text-amber-900 border border-amber-200 px-2 py-1 rounded">
                        AWB: {ord.courier.awbNumber}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
