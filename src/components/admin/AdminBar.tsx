'use client';

import React, { useId, useState } from 'react';
import { Camera, ClipboardList, Menu, MessagesSquare, Package, Settings, Store, Users, X } from 'lucide-react';
import { Sheet } from '@/components/common/Sheet';

type AdminTabId = 'orders' | 'add-product' | 'inventory' | 'crm' | 'settings' | 'chats';

/**
 * The Admin Hub's bottom bar. On a phone: Orders, Inventory, Chats and More (big targets);
 * More holds Add product, Customers, Settings and View shop. On wider screens every section
 * has its own button. Badges: orders to confirm, products sold out or low, chats waiting.
 */
export function AdminBar({
  adminTab,
  onSetAdminTab,
  pendingOrdersCount,
  chatsWaiting,
  stockAlerts,
  onToggleAdminMode,
}: {
  adminTab: AdminTabId;
  onSetAdminTab: (tab: AdminTabId) => void;
  pendingOrdersCount: number;
  chatsWaiting: number;
  stockAlerts: number;
  onToggleAdminMode: () => void;
}) {
  const [more, setMore] = useState(false);
  const titleId = useId();
  const inMore = adminTab === 'crm' || adminTab === 'settings' || adminTab === 'add-product';
  const item = (active: boolean) =>
    `relative flex-1 min-w-0 flex-col items-center justify-center gap-0.5 min-h-14 px-1 rounded-xl text-[11px] ${active ? 'text-[#7a5c22] font-bold' : 'text-stone-700'}`;
  const badge = (n: number, label: string) =>
    n > 0 ? (
      <span className="absolute top-1 left-1/2 ml-2 bg-red-700 text-white text-[10px] min-w-4 h-4 px-1 rounded-full flex items-center justify-center font-bold" aria-label={label}>
        {n}
      </span>
    ) : null;
  const go = (tab: AdminTabId) => {
    setMore(false);
    onSetAdminTab(tab);
  };
  return (
    <>
      <nav aria-label="Admin sections" className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-stone-200 px-1 pb-safe flex items-stretch shadow-lg">
        <button type="button" onClick={() => go('orders')} aria-current={adminTab === 'orders' ? 'page' : undefined} className={`${item(adminTab === 'orders')} flex`}>
          <ClipboardList className="w-6 h-6" aria-hidden="true" />
          <span>Orders</span>
          {badge(pendingOrdersCount, `${pendingOrdersCount} to confirm`)}
        </button>
        <button type="button" onClick={() => go('inventory')} aria-current={adminTab === 'inventory' ? 'page' : undefined} className={`${item(adminTab === 'inventory')} flex`}>
          <Package className="w-6 h-6" aria-hidden="true" />
          <span>Inventory</span>
          {badge(stockAlerts, `${stockAlerts} sold out or low`)}
        </button>
        <button type="button" onClick={() => go('chats')} aria-current={adminTab === 'chats' ? 'page' : undefined} className={`${item(adminTab === 'chats')} flex`}>
          <MessagesSquare className="w-6 h-6" aria-hidden="true" />
          <span>Chats</span>
          {badge(chatsWaiting, `${chatsWaiting} waiting`)}
        </button>
        {/* Phones: the rest under More. */}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" aria-expanded={more} className={`${item(inMore)} flex sm:hidden`}>
          <Menu className="w-6 h-6" aria-hidden="true" />
          <span>More</span>
        </button>
        {/* Wider screens: every section in the bar. */}
        <button type="button" onClick={() => go('add-product')} aria-current={adminTab === 'add-product' ? 'page' : undefined} className={`${item(adminTab === 'add-product')} hidden sm:flex`}>
          <Camera className="w-6 h-6" aria-hidden="true" />
          <span>+ Add</span>
        </button>
        <button type="button" onClick={() => go('crm')} aria-current={adminTab === 'crm' ? 'page' : undefined} className={`${item(adminTab === 'crm')} hidden sm:flex`}>
          <Users className="w-6 h-6" aria-hidden="true" />
          <span>Customers</span>
        </button>
        <button type="button" onClick={() => go('settings')} aria-current={adminTab === 'settings' ? 'page' : undefined} className={`${item(adminTab === 'settings')} hidden sm:flex`}>
          <Settings className="w-6 h-6" aria-hidden="true" />
          <span>Settings</span>
        </button>
        <button type="button" onClick={onToggleAdminMode} className={`${item(false)} hidden sm:flex`} title="Return to Customer Storefront">
          <Store className="w-6 h-6" aria-hidden="true" />
          <span>View Shop</span>
        </button>
      </nav>
      {more && (
        <Sheet labelledBy={titleId} onClose={() => setMore(false)} variant="bottom">
          <div className="flex items-center px-4 pt-3 pb-1">
            <h2 id={titleId} className="font-serif font-bold text-base text-[#0f1c2e] flex-1">
              More
            </h2>
            <button type="button" onClick={() => setMore(false)} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-stone-600" aria-label="Close">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
          <ul className="px-2 pb-4">
            {(
              [
                ['add-product', 'Add product', 'Photos, price, sizes and stock, step by step', Camera],
                ['crm', 'Customers', 'Everyone who ordered, with totals', Users],
                ['settings', 'Settings', 'Store, catalogue, delivery, couriers, backups…', Settings],
              ] as Array<[AdminTabId, string, string, typeof Users]>
            ).map(([id, name, hint, Icon]) => (
              <li key={id}>
                <button type="button" onClick={() => go(id)} aria-current={adminTab === id ? 'page' : undefined} className="w-full min-h-14 flex items-center gap-3 px-3 rounded-xl text-left hover:bg-stone-100">
                  <Icon className="w-5 h-5 text-[#7a5c22] shrink-0" aria-hidden="true" />
                  <span>
                    <span className="block font-semibold text-stone-900">{name}</span>
                    <span className="block text-xs text-stone-600">{hint}</span>
                  </span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                onClick={() => {
                  setMore(false);
                  onToggleAdminMode();
                }}
                className="w-full min-h-14 flex items-center gap-3 px-3 rounded-xl text-left hover:bg-stone-100"
              >
                <Store className="w-5 h-5 text-[#7a5c22] shrink-0" aria-hidden="true" />
                <span className="block font-semibold text-stone-900">View shop</span>
              </button>
            </li>
          </ul>
        </Sheet>
      )}
    </>
  );
}
