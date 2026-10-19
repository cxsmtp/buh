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
          className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-xs text-ink focus:outline-none focus:ring-2 focus:ring-gold"
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
              className={`p-4 rounded-2xl border transition-all cursor-pointer bg-surface text-xs space-y-2.5 shadow-sm hover:shadow-md ${
                isSelected
                  ? 'border-ink ring-2 ring-gold/40 bg-warning-soft/20'
                  : 'border-line hover:border-line-strong'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-serif font-bold text-sm text-ink">
                    {customer.fullName}
                  </h4>
                  <div className="flex items-center gap-1 text-[11px] text-ink-muted mt-0.5">
                    <Phone className="w-3 h-3 text-gold" />
                    <span>{customer.phone}</span>
                  </div>
                </div>

                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sand text-ink-soft border border-line">
                  {customer.emirate}
                </span>
              </div>

              {/* Address Strip */}
              <div className="text-[11px] text-ink-soft flex items-start gap-1.5 bg-ivory p-2 rounded-xl border border-line">
                <MapPin className="w-3.5 h-3.5 text-gold shrink-0 mt-0.5" />
                <span className="line-clamp-2">
                  {customer.defaultAddress.buildingVilla}, {customer.defaultAddress.flatVillaNo}, {customer.area}, {customer.emirate}
                  {customer.defaultAddress.landmark ? ` (Near ${customer.defaultAddress.landmark})` : ''}
                </span>
              </div>

              {/* Spend & Orders Metrics */}
              <div className="flex items-center justify-between pt-1 border-t border-line text-[11px]">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-ink">{customer.totalOrders} {customer.totalOrders === 1 ? 'Order' : 'Orders'}</span>
                  <span>•</span>
                  <span className="font-bold text-warning">AED {customer.totalSpent}</span>
                </div>

                {/* WhatsApp Chat Button */}
                <a
                  href={`https://wa.me/${cleanPhone}?text=${encodeURIComponent(`Hello ${customer.fullName}, greetings from Beautiful UAE Home! How can we assist you with our hand-block printed bed linens?`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="flex items-center gap-1 text-[11px] text-success bg-success-soft hover:bg-success-soft px-2 py-1 rounded-lg border border-success-line transition-colors font-medium"
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
        <div className="bg-ivory rounded-2xl p-4 border border-line space-y-3 mt-4 animate-in fade-in-50 text-xs">
          <div className="flex items-center justify-between border-b border-line pb-2">
            <div>
              <h4 className="font-serif font-bold text-sm text-ink">
                Order History for {selectedCustomer.fullName}
              </h4>
              <span className="text-[11px] text-ink-muted">
                Phone: {selectedCustomer.phone} • {selectedCustomer.emirate}
              </span>
            </div>
            <button
              onClick={() => setSelectedCustomer(null)}
              className="text-ink-muted hover:text-ink-soft font-bold"
            >
              ✕
            </button>
          </div>

          <div className="space-y-2">
            {customerOrders.length === 0 ? (
              <p className="text-ink-muted text-xs py-2">No past orders registered yet.</p>
            ) : (
              customerOrders.map((ord) => (
                <div
                  key={ord.id}
                  className="bg-surface p-3 rounded-xl border border-line flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs text-ink">{ord.id}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-sand text-ink-soft font-semibold uppercase">
                        {ord.status.replace('_', ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-muted mt-0.5">
                      {ord.items.map((i) => `${i.quantity}x ${i.title} (${i.mattressSize ? i.profileName.split(' ')[0] : i.profileName})`).join(', ')}
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <span className="font-bold text-sm text-ink">AED {ord.total}</span>
                      <span className="text-[10px] text-ink-muted block capitalize">{ord.paymentMethod === 'cod' ? 'Cash on Delivery' : 'Bank Transfer'}</span>
                    </div>

                    {ord.courier.awbNumber && (
                      <span className="text-[10px] font-mono font-semibold bg-warning-soft text-warning border border-warning-line px-2 py-1 rounded">
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
