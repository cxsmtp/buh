'use client';

import React, { createContext, useContext } from 'react';
import type { CartItem, Product, StoreSettings } from '@/types';
import type { FestivalTheme } from '@/lib/festivals/catalog';

/** Today's festival look, from /api/settings/public (null: the everyday look). */
export interface FestivalView {
  themeId: string;
  festivalId: string | null;
  phase: 'upcoming' | 'during' | 'after' | 'none';
  daysToStart: number | null;
  theme: FestivalTheme;
  showBanner: boolean;
  showMarquee: boolean;
}
import { DEFAULT_CATALOG, DEFAULT_STORE } from '@/data/catalogDefaults';

/** Shop-wide public settings for storefront components (from /api/settings/public). */
export interface ShopInfo {
  store: StoreSettings;
  lowStockThreshold: number;
  supportEmail: string;
  festival: FestivalView | null;
}

const ShopContext = createContext<ShopInfo>({
  store: DEFAULT_STORE,
  lowStockThreshold: DEFAULT_CATALOG.lowStockThreshold,
  supportEmail: 'orders@beautifuluaehome.com',
  festival: null,
});

export const ShopProvider = ShopContext.Provider;
export const useShop = () => useContext(ShopContext);

/** Pieces of this size in stock (0 when unknown). */
export function piecesLeft(product: Product, sizeId: string): number {
  return product.stockBySize?.[sizeId] ?? 0;
}

/** A wa.me link to the shop's WhatsApp with a message, or null when no number is set. */
export function whatsappLink(store: StoreSettings, message: string): string | null {
  const digits = store.whatsappNumber.replace(/\D/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/**
 * Re-match the bag to a fresh catalogue: the latest product data and prices,
 * quantities capped to what is in stock. Lines whose size sold out are kept
 * (shown as sold out) so the customer sees what happened instead of a line vanishing.
 */
export function refreshCart(cart: CartItem[], products: Product[]): CartItem[] {
  // Pieces already given to earlier lines of the same product and size (different colours).
  const used = new Map<string, number>();
  return cart.flatMap((item) => {
    const product = products.find((p) => p.id === item.product.id);
    const profile = product?.profiles.find((p) => p.id === item.selectedProfile.id);
    if (!product || !profile) return [];
    const key = `${product.id}|${profile.id}`;
    const left = piecesLeft(product, profile.id) - (used.get(key) ?? 0);
    const quantity = left > 0 ? Math.min(item.quantity, left) : item.quantity;
    used.set(key, (used.get(key) ?? 0) + Math.max(0, Math.min(quantity, left)));
    return [{ ...item, product, selectedProfile: profile, quantity }];
  });
}
