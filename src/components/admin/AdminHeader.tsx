'use client';

import React from 'react';
import { PALETTE } from '@/lib/design/tokens';
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
    <div className="bg-ink text-white p-4 pt-[max(1rem,env(safe-area-inset-top,0px))] border-b border-gold/25">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Brand & Mode */}
        <div className="flex items-center justify-between sm:justify-start gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {brandSettings?.logoType === 'image' && brandSettings?.logoImageUrl ? (
              <img
                src={brandSettings.logoImageUrl}
                alt="Admin Logo"
                className="w-9 h-9 object-contain rounded-xl border border-ink shadow"
              />
            ) : (
              <div 
                className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-ink font-serif font-bold text-base"
                style={{
                  background: `linear-gradient(135deg, ${brandSettings?.accentColor || PALETTE.gold}, ${PALETTE['gold-light']})`,
                }}
              >
                {brandSettings?.logoText || 'BU'}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-serif text-lg leading-tight tracking-wide truncate">
                  {brandSettings?.storeName ? `${brandSettings.storeName} Admin` : 'BUHome Admin Center'}
                </span>
                <span className="hidden min-[400px]:inline shrink-0 text-[9px] uppercase tracking-[0.14em] px-2 py-0.5 rounded-full text-gold-light border border-gold/40">
                  {brandSettings?.badgeText || 'Mobile Hub'}
                </span>
              </div>
              <p className="text-[10px] text-sand truncate">
                Orders, stock, customers and settings
                <span className="ml-2 font-mono font-bold text-gold-light/90" title="Version of this build">
                  {process.env.NEXT_PUBLIC_APP_VERSION}
                </span>
              </p>
            </div>
          </div>

          {/* Mobile Buttons */}
          <div className="flex items-center gap-2 sm:hidden shrink-0">
            <button
              onClick={onExitAdmin}
              className="flex items-center gap-1 text-xs font-semibold bg-surface/10 hover:bg-surface/20 text-white px-2.5 py-1.5 rounded-xl transition-colors"
            >
              <Store className="w-3.5 h-3.5 text-gold-light" />
              <span>Shop</span>
            </button>
            {onLogoutAdmin && (
              <button
                onClick={onLogoutAdmin}
                className="w-9 h-9 flex items-center justify-center rounded-xl text-danger-soft border border-white/15"
                title="Log out from Admin"
                aria-label="Log out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Quick KPI Stats Bar */}
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
          {/* Pending Orders Pill */}
          <div className="flex items-center gap-2 bg-surface/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <Clock className="w-3.5 h-3.5 text-gold" />
            <div className="text-[11px] leading-tight">
              <span className="text-sand block text-[9px]">Needs Confirmation</span>
              <strong className="text-gold-light font-bold">{pendingOrders.length} Orders</strong>
            </div>
          </div>

          {/* Total Revenue */}
          <div className="flex items-center gap-2 bg-surface/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <TrendingUp className="w-3.5 h-3.5 text-success" />
            <div className="text-[11px] leading-tight">
              <span className="text-sand block text-[9px]">Total Volume</span>
              <strong className="text-white font-bold">AED {totalRevenue}</strong>
            </div>
          </div>

          {/* Stock Count */}
          <div className="flex items-center gap-2 bg-surface/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <Layers className="w-3.5 h-3.5 text-gold" />
            <div className="text-[11px] leading-tight">
              <span className="text-sand block text-[9px]">Live Inventory</span>
              <strong className="text-white font-bold">{products.length} Products</strong>
            </div>
          </div>

          {/* CRM Count */}
          <div className="flex items-center gap-2 bg-surface/5 border border-white/10 px-3 py-1.5 rounded-xl shrink-0">
            <Users className="w-3.5 h-3.5 text-ink-muted" />
            <div className="text-[11px] leading-tight">
              <span className="text-sand block text-[9px]">Registered CRM</span>
              <strong className="text-white font-bold">{customers.length} Profiles</strong>
            </div>
          </div>

          {/* Desktop Switch to Shop Button */}
          <button
            onClick={onExitAdmin}
            className="hidden sm:flex items-center gap-1.5 text-xs font-medium bg-gold hover:bg-gold-light text-ink px-3.5 py-2 rounded-xl transition-colors shrink-0 font-sans"
          >
            <Store className="w-4 h-4" />
            <span>Storefront</span>
          </button>

          {/* Desktop Logout Button */}
          {onLogoutAdmin && (
            <button
              onClick={onLogoutAdmin}
              className="hidden sm:flex items-center gap-1 text-xs font-semibold bg-surface/10 hover:bg-danger/20 text-sand hover:text-danger-soft border border-white/10 px-3 py-2 rounded-xl transition-all shrink-0"
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
