'use client';

import React from 'react';
import { Store, Clock, TrendingUp, Layers, Users, LogOut } from 'lucide-react';
import { Order, Product, Customer, BrandSettings } from '@/types';

interface AdminHeaderProps {
  orders: Order[];
  products: Product[];
  customers: Customer[];
  onExitAdmin: () => void;
  onLogoutAdmin?: () => void;
  brandSettings?: BrandSettings;
}

export const AdminHeader: React.FC<AdminHeaderProps> = ({
  orders,
  products,
  customers,
  onExitAdmin,
  onLogoutAdmin,
  brandSettings,
}) => {
  const pendingOrders = orders.filter((o) => o.status === 'pending_confirmation');
  const totalRevenue = orders.reduce((sum, o) => sum + o.total, 0);

  return (
    <div className="bg-[#0f1c2e] text-white p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] border-b border-stone-800 shadow-md">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Brand & Mode */}
        <div className="flex items-center justify-between sm:justify-start gap-3">
          <div className="flex items-center gap-2">
            {brandSettings?.logoType === 'image' && brandSettings?.logoImageUrl ? (
              <img
                src={brandSettings.logoImageUrl}
                alt="Admin Logo"
                className="w-9 h-9 object-contain rounded-xl border border-stone-700 shadow"
              />
            ) : (
              <div 
                className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-serif font-bold text-base shadow"
                style={{
                  background: `linear-gradient(135deg, ${brandSettings?.accentColor || '#c5a059'}, #dfc082)`,
                }}
              >
                {brandSettings?.logoText || 'BU'}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-serif font-bold text-base tracking-wide">
                  {brandSettings?.storeName ? `${brandSettings.storeName} Admin` : 'BUHome Admin Center'}
                </span>
                <span className="text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {brandSettings?.badgeText || 'Mobile Hub'}
                </span>
              </div>
              <p className="text-[10px] text-stone-300">
                Logistics, AI Inventory, CRM & Live Marquee
                <span className="ml-2 font-mono font-bold text-amber-300/90" title="Version of this build">
                  {process.env.NEXT_PUBLIC_APP_VERSION}
                </span>
              </p>
            </div>
          </div>

          {/* Mobile Buttons */}
          <div className="flex items-center gap-2 sm:hidden">
            <button
              onClick={onExitAdmin}
              className="flex items-center gap-1 text-xs font-semibold bg-white/10 hover:bg-white/20 text-white px-2.5 py-1.5 rounded-xl transition-colors"
            >
              <Store className="w-3.5 h-3.5 text-amber-300" />
              <span>Shop</span>
            </button>
            {onLogoutAdmin && (
              <button
                onClick={onLogoutAdmin}
                className="p-1.5 rounded-xl bg-red-500/20 text-red-300 border border-red-500/30"
                title="Log out from Admin"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Quick KPI Stats Bar */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
          {/* Pending Orders Pill */}
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <Clock className="w-3.5 h-3.5 text-amber-400" />
            <div className="text-[11px] leading-tight">
              <span className="text-stone-300 block text-[9px]">Needs Confirmation</span>
              <strong className="text-amber-300 font-bold">{pendingOrders.length} Orders</strong>
            </div>
          </div>

          {/* Total Revenue */}
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            <div className="text-[11px] leading-tight">
              <span className="text-stone-300 block text-[9px]">Total Volume</span>
              <strong className="text-white font-bold">AED {totalRevenue}</strong>
            </div>
          </div>

          {/* Stock Count */}
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <Layers className="w-3.5 h-3.5 text-[#c5a059]" />
            <div className="text-[11px] leading-tight">
              <span className="text-stone-300 block text-[9px]">Live Inventory</span>
              <strong className="text-white font-bold">{products.length} Products</strong>
            </div>
          </div>

          {/* CRM Count */}
          <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <Users className="w-3.5 h-3.5 text-blue-400" />
            <div className="text-[11px] leading-tight">
              <span className="text-stone-300 block text-[9px]">Registered CRM</span>
              <strong className="text-white font-bold">{customers.length} Profiles</strong>
            </div>
          </div>

          {/* Desktop Switch to Shop Button */}
          <button
            onClick={onExitAdmin}
            className="hidden sm:flex items-center gap-1.5 text-xs font-semibold bg-[#c5a059] hover:bg-[#b59049] text-[#0f1c2e] px-3.5 py-2 rounded-xl transition-all shadow shrink-0 font-sans"
          >
            <Store className="w-4 h-4" />
            <span>Storefront</span>
          </button>

          {/* Desktop Logout Button */}
          {onLogoutAdmin && (
            <button
              onClick={onLogoutAdmin}
              className="hidden sm:flex items-center gap-1 text-xs font-semibold bg-white/10 hover:bg-red-500/20 text-stone-300 hover:text-red-200 border border-white/10 px-3 py-2 rounded-xl transition-all shrink-0"
              title="Lock Admin Session"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Lock</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
