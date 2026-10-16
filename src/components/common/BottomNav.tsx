'use client';

import React from 'react';
import { Home, Package, ShoppingBag, Truck, Camera, Users, Settings, Store, ClipboardList, MessagesSquare, Search } from 'lucide-react';

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
  cartCount: number;
  onOpenCart: () => void;
  onOpenTrack: () => void;
  onToggleAdminMode: () => void;
  pendingOrdersCount?: number;
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
}) => {
  if (isAdminMode) {
    return (
      <nav aria-label="Admin sections" className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-stone-200 px-1 py-1.5 flex items-center justify-around shadow-lg">
        {/* Admin Orders */}
        <button
          onClick={() => onSetAdminTab('orders')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs relative ${
            adminTab === 'orders' ? 'text-[#8a6a2c] font-bold' : 'text-stone-500'
          }`}
        >
          <ClipboardList className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Orders</span>
          {pendingOrdersCount > 0 && (
            <span className="absolute -top-1 right-0 bg-red-500 text-white text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center font-bold">
              {pendingOrdersCount}
            </span>
          )}
        </button>

        {/* Chats from the shop (badge: waiting for a person) */}
        <button
          onClick={() => onSetAdminTab('chats')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs relative ${
            adminTab === 'chats' ? 'text-[#8a6a2c] font-bold' : 'text-stone-500'
          }`}
        >
          <MessagesSquare className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Chats</span>
          {chatsWaiting > 0 && (
            <span className="absolute -top-1 right-0 bg-red-500 text-white text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center font-bold" aria-label={`${chatsWaiting} waiting`}>
              {chatsWaiting}
            </span>
          )}
        </button>

        {/* Add Product with AI Photo */}
        <button
          onClick={() => onSetAdminTab('add-product')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs relative ${
            adminTab === 'add-product' ? 'text-[#8a6a2c] font-bold' : 'text-stone-500'
          }`}
        >
          <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-[#c5a059] to-[#dfc082] text-white flex items-center justify-center shadow-md -mt-2.5 ring-2 ring-white">
            <Camera className="w-3.5 h-3.5" />
          </div>
          <span className="text-[9px] mt-0.5 font-medium">+ Add</span>
        </button>

        {/* Inventory */}
        <button
          onClick={() => onSetAdminTab('inventory')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs ${
            adminTab === 'inventory' ? 'text-[#8a6a2c] font-bold' : 'text-stone-500'
          }`}
        >
          <Package className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Stock</span>
        </button>

        {/* CRM Customers */}
        <button
          onClick={() => onSetAdminTab('crm')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs ${
            adminTab === 'crm' ? 'text-[#8a6a2c] font-bold' : 'text-stone-500'
          }`}
        >
          <Users className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">CRM</span>
        </button>

        {/* Settings console (store, catalogue, branding, SMS, couriers, system) */}
        <button
          onClick={() => onSetAdminTab('settings')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs ${
            adminTab === 'settings' ? 'text-[#8a6a2c] font-bold' : 'text-stone-500'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Settings</span>
        </button>

        {/* Return to Shop */}
        <button
          onClick={onToggleAdminMode}
          className="flex flex-col items-center py-1 px-1.5 rounded-lg text-xs text-stone-700 hover:text-stone-900"
          title="Return to Customer Storefront"
        >
          <Store className="w-5 h-5" />
          <span className="text-[10px] mt-0.5">View Shop</span>
        </button>
      </nav>
    );
  }

  // The shop on a phone: Home, Search, Bag and Orders, like an app's tab bar (hidden on wider screens,
  // where the header has them). The chat's Help button floats just above it.
  const tab = (active: boolean) =>
    `flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px] ${active ? 'text-[#0f1c2e] font-semibold' : 'text-stone-600'}`;
  return (
    <nav aria-label="Shop" className="fixed bottom-0 inset-x-0 z-40 bg-[#fbf9f5]/95 backdrop-blur-md border-t border-[#e8e1d5] pb-safe md:hidden">
      <div className="flex items-stretch max-w-md mx-auto">
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
      </div>
    </nav>
  );
};
