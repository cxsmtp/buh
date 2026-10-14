'use client';

import React from 'react';
import { Home, Package, ShoppingBag, Truck, Camera, Users, Settings, Store, Sparkles, ClipboardList, Palette } from 'lucide-react';

interface BottomNavProps {
  isAdminMode: boolean;
  storeTab: 'home' | 'catalog';
  onSetStoreTab: (tab: 'home' | 'catalog') => void;
  adminTab: 'orders' | 'add-product' | 'inventory' | 'crm' | 'couriers' | 'branding' | 'sms';
  onSetAdminTab: (tab: 'orders' | 'add-product' | 'inventory' | 'crm' | 'couriers' | 'branding' | 'sms') => void;
  cartCount: number;
  onOpenCart: () => void;
  onOpenTrack: () => void;
  onToggleAdminMode: () => void;
  pendingOrdersCount?: number;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  isAdminMode,
  storeTab,
  onSetStoreTab,
  adminTab,
  onSetAdminTab,
  cartCount,
  onOpenCart,
  onOpenTrack,
  onToggleAdminMode,
  pendingOrdersCount = 0,
}) => {
  if (isAdminMode) {
    return (
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-stone-200 px-1 py-1.5 flex items-center justify-around shadow-lg">
        {/* Admin Orders */}
        <button
          onClick={() => onSetAdminTab('orders')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs relative ${
            adminTab === 'orders' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
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

        {/* Add Product with AI Photo */}
        <button
          onClick={() => onSetAdminTab('add-product')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs relative ${
            adminTab === 'add-product' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
          }`}
        >
          <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-[#c5a059] to-[#dfc082] text-white flex items-center justify-center shadow-md -mt-2.5 ring-2 ring-white">
            <Camera className="w-3.5 h-3.5" />
          </div>
          <span className="text-[9px] mt-0.5 font-medium">+ AI</span>
        </button>

        {/* Inventory */}
        <button
          onClick={() => onSetAdminTab('inventory')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs ${
            adminTab === 'inventory' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
          }`}
        >
          <Package className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Stock</span>
        </button>

        {/* CRM Customers */}
        <button
          onClick={() => onSetAdminTab('crm')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs ${
            adminTab === 'crm' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
          }`}
        >
          <Users className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">CRM</span>
        </button>

        {/* Courier Hub (Jeebly & Echo) */}
        <button
          onClick={() => onSetAdminTab('couriers')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs ${
            adminTab === 'couriers' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
          }`}
        >
          <Truck className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Couriers</span>
        </button>

        {/* Branding & Marquee */}
        <button
          onClick={() => onSetAdminTab('branding')}
          className={`flex flex-col items-center py-1 px-1.5 rounded-lg text-xs ${
            adminTab === 'branding' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
          }`}
          title="Store Logo, Branding & Live Marquee"
        >
          <Palette className="w-4 h-4" />
          <span className="text-[9px] mt-0.5">Brand</span>
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
      </div>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-stone-200 px-3 py-1.5 flex items-center justify-around shadow-lg md:hidden">
      {/* Home */}
      <button
        onClick={() => onSetStoreTab('home')}
        className={`flex flex-col items-center py-1 px-3 text-xs ${
          storeTab === 'home' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
        }`}
      >
        <Home className="w-5 h-5" />
        <span className="text-[10px] mt-0.5">Home</span>
      </button>

      {/* Catalog */}
      <button
        onClick={() => onSetStoreTab('catalog')}
        className={`flex flex-col items-center py-1 px-3 text-xs ${
          storeTab === 'catalog' ? 'text-[#c5a059] font-bold' : 'text-stone-500'
        }`}
      >
        <Package className="w-5 h-5" />
        <span className="text-[10px] mt-0.5">Bed Sheets</span>
      </button>

      {/* Cart with Counter */}
      <button
        onClick={onOpenCart}
        className="flex flex-col items-center py-1 px-3 text-xs relative text-stone-700"
      >
        <div className="relative">
          <ShoppingBag className="w-5 h-5 text-stone-800" />
          {cartCount > 0 && (
            <span className="absolute -top-1.5 -right-2 bg-[#c5a059] text-stone-900 text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shadow">
              {cartCount}
            </span>
          )}
        </div>
        <span className="text-[10px] mt-0.5">Bag</span>
      </button>

      {/* Track */}
      <button
        onClick={onOpenTrack}
        className="flex flex-col items-center py-1 px-3 text-xs text-stone-500"
      >
        <Truck className="w-5 h-5" />
        <span className="text-[10px] mt-0.5">Tracking</span>
      </button>

      {/* Admin Quick Switch */}
      <button
        onClick={onToggleAdminMode}
        className="flex flex-col items-center py-1 px-3 text-xs text-amber-700 relative font-medium"
      >
        <div className="relative">
          <Sparkles className="w-5 h-5 text-amber-600" />
          {pendingOrdersCount > 0 && (
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-red-500 ring-1 ring-white"></span>
          )}
        </div>
        <span className="text-[10px] mt-0.5">Admin</span>
      </button>
    </div>
  );
};
