'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { Home, ShoppingBag, Truck, Search } from 'lucide-react';

// The Admin Hub's bar: loaded only in the Admin Hub, never for shoppers.
const AdminBar = dynamic(() => import('@/components/admin/AdminBar').then((m) => m.AdminBar), { ssr: false });

interface BottomNavProps {
  isAdminMode: boolean;
  /** Which shop tab is lit: the feed, or search while it is open. */
  storeTab: 'home' | 'search';
  onHome: () => void;
  onOpenSearch: () => void;
  adminTab: 'orders' | 'add-product' | 'inventory' | 'crm' | 'settings' | 'chats';
  onSetAdminTab: (tab: 'orders' | 'add-product' | 'inventory' | 'crm' | 'settings' | 'chats') => void;
  /** Chats waiting for a person. */
  chatsWaiting?: number;
  /** Products on sale that are sold out or running low (the Inventory badge). */
  stockAlerts?: number;
  cartCount: number;
  onOpenCart: () => void;
  onOpenTrack: () => void;
  onToggleAdminMode: () => void;
  pendingOrdersCount?: number;
  /** The Help (chat or WhatsApp) button sits in the bar's right-hand slot on phones. */
  helpSlot?: boolean;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  isAdminMode,
  storeTab,
  onHome,
  onOpenSearch,
  adminTab,
  onSetAdminTab,
  cartCount,
  onOpenCart,
  onOpenTrack,
  onToggleAdminMode,
  pendingOrdersCount = 0,
  chatsWaiting = 0,
  stockAlerts = 0,
  helpSlot = false,
}) => {
  if (isAdminMode) {
    return <AdminBar adminTab={adminTab} onSetAdminTab={onSetAdminTab} pendingOrdersCount={pendingOrdersCount} chatsWaiting={chatsWaiting} stockAlerts={stockAlerts} onToggleAdminMode={onToggleAdminMode} />;
  }

  // The shop on a phone: Home, Search, Bag and Orders, like an app's tab bar (hidden on wider screens,
  // where the header has them). The Help button takes the slot at its right end, so it never floats over the feed.
  const tab = (active: boolean) =>
    `flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px] transition-transform active:scale-95 ${active ? 'text-[#0f1c2e] font-semibold' : 'text-stone-600'}`;
  return (
    <nav aria-label="Shop" className="fixed bottom-0 inset-x-0 z-40 bg-[#fbf9f5]/95 backdrop-blur-md border-t border-[#e8e1d5] pb-safe px-safe md:hidden">
      <div className="flex items-stretch">
        <button type="button" onClick={onHome} aria-current={storeTab === 'home' ? 'page' : undefined} className={tab(storeTab === 'home')}>
          <Home className="w-6 h-6" aria-hidden="true" strokeWidth={storeTab === 'home' ? 2.25 : 1.75} />
          <span>Home</span>
        </button>
        <button type="button" onClick={onOpenSearch} className={tab(storeTab === 'search')}>
          <Search className="w-6 h-6" aria-hidden="true" strokeWidth={storeTab === 'search' ? 2.25 : 1.75} />
          <span>Search</span>
        </button>
        <button type="button" onClick={onOpenCart} aria-label={`Bag${cartCount ? `, ${cartCount} ${cartCount === 1 ? 'piece' : 'pieces'}` : ''}`} className={tab(false)}>
          <span className="relative">
            <ShoppingBag className="w-6 h-6" aria-hidden="true" strokeWidth={1.75} />
            {cartCount > 0 && (
              <span className="absolute -top-1.5 -right-2.5 bg-[#c5a059] text-stone-950 text-[10px] font-bold min-w-4 h-4 px-1 rounded-full flex items-center justify-center" aria-hidden="true">
                {cartCount}
              </span>
            )}
          </span>
          <span>Bag</span>
        </button>
        <button type="button" onClick={onOpenTrack} className={tab(false)}>
          <Truck className="w-6 h-6" aria-hidden="true" strokeWidth={1.75} />
          <span>Orders</span>
        </button>
        {helpSlot && <span className="w-[4.5rem] shrink-0" aria-hidden="true" />}
      </div>
    </nav>
  );
};

