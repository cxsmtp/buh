'use client';

import React, { useId, useState } from 'react';
import { Camera, ClipboardList, Menu, MessagesSquare, Package, Settings, Store, Users, Wallet, X } from 'lucide-react';
import { Sheet } from '@/components/common/Sheet';

type AdminTabId = 'orders' | 'add-product' | 'inventory' | 'crm' | 'money' | 'settings' | 'chats';

/**
 * The Admin Hub's bottom bar in the phone view: Orders, Inventory, Chats and More (big
 * targets); More holds Add product, Customers, Money, Settings and View shop. (The laptop view has
 * tabs at the top instead.) Badges: orders to confirm, products sold out or low, chats waiting.
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
  const inMore = adminTab === 'crm' || adminTab === 'money' || adminTab === 'settings' || adminTab === 'add-product';
  const item = (active: boolean) =>
    `relative flex-1 min-w-0 flex-col items-center justify-center gap-0.5 min-h-14 px-1 rounded-xl text-[11px] ${active ? 'text-gold-deep font-semibold' : 'text-ink-soft'}`;
  const badge = (n: number, label: string) =>
    n > 0 ? (
      <span className="absolute top-1 left-1/2 ml-2 bg-danger text-white text-[10px] min-w-4 h-4 px-1 rounded-full flex items-center justify-center font-bold" aria-label={label}>
        {n}
      </span>
    ) : null;
  const go = (tab: AdminTabId) => {
    setMore(false);
    onSetAdminTab(tab);
  };
  return (
    <>
      <nav aria-label="Admin sections" className="fixed bottom-0 left-0 right-0 mx-auto max-w-[480px] z-40 bg-surface/95 backdrop-blur-md border-t border-line px-1 pb-safe flex items-stretch">
        <button type="button" onClick={() => go('orders')} aria-current={adminTab === 'orders' ? 'page' : undefined} className={`${item(adminTab === 'orders')} flex`}>
          <ClipboardList className="w-6 h-6" aria-hidden="true" />
          <span className="max-w-full truncate">Orders</span>
          {badge(pendingOrdersCount, `${pendingOrdersCount} to confirm`)}
        </button>
        <button type="button" onClick={() => go('inventory')} aria-current={adminTab === 'inventory' ? 'page' : undefined} className={`${item(adminTab === 'inventory')} flex`}>
          <Package className="w-6 h-6" aria-hidden="true" />
          <span className="max-w-full truncate">Inventory</span>
          {badge(stockAlerts, `${stockAlerts} sold out or low`)}
        </button>
        <button type="button" onClick={() => go('chats')} aria-current={adminTab === 'chats' ? 'page' : undefined} className={`${item(adminTab === 'chats')} flex`}>
          <MessagesSquare className="w-6 h-6" aria-hidden="true" />
          <span className="max-w-full truncate">Chats</span>
          {badge(chatsWaiting, `${chatsWaiting} waiting`)}
        </button>
        {/* The rest under More. */}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" aria-expanded={more} className={`${item(inMore)} flex`}>
          <Menu className="w-6 h-6" aria-hidden="true" />
          <span className="max-w-full truncate">More</span>
        </button>
      </nav>
      {more && (
        <Sheet labelledBy={titleId} onClose={() => setMore(false)} variant="bottom">
          <div className="flex items-center px-4 pt-3 pb-1">
            <h2 id={titleId} className="font-serif text-xl text-ink flex-1">
              More
            </h2>
            <button type="button" onClick={() => setMore(false)} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
          <ul className="px-2 pb-4">
            {(
              [
                ['add-product', 'Add product', 'Photos, price, sizes and stock, step by step', Camera],
                ['crm', 'Customers', 'Everyone who ordered, with totals', Users],
                ['money', 'Money', 'Expenses with photos of bills, reports for your accountant, audit log', Wallet],
                ['settings', 'Settings', 'Store, catalogue, delivery, couriers, backups…', Settings],
              ] as Array<[AdminTabId, string, string, typeof Users]>
            ).map(([id, name, hint, Icon]) => (
              <li key={id}>
                <button type="button" onClick={() => go(id)} aria-current={adminTab === id ? 'page' : undefined} className="w-full min-h-14 flex items-center gap-3 px-3 rounded-xl text-left hover:bg-sand">
                  <Icon className="w-5 h-5 text-gold-deep shrink-0" aria-hidden="true" />
                  <span>
                    <span className="block font-semibold text-ink">{name}</span>
                    <span className="block text-xs text-ink-soft">{hint}</span>
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
                className="w-full min-h-14 flex items-center gap-3 px-3 rounded-xl text-left hover:bg-sand"
              >
                <Store className="w-5 h-5 text-gold-deep shrink-0" aria-hidden="true" />
                <span className="block font-semibold text-ink">View shop</span>
              </button>
            </li>
          </ul>
        </Sheet>
      )}
    </>
  );
}
