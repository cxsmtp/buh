'use client';

import React, { useMemo } from 'react';
import { AlertTriangle, ClipboardCheck, PackageX, Truck, Wallet } from 'lucide-react';
import type { Order, Product } from '@/types';
import { formatAed } from '@/lib/money';
import { moneyHighlights, todayTodos } from '@/lib/hubToday';

type Go = (tab: 'orders' | 'inventory' | 'money') => void;

/** Today's to-dos: orders to confirm, to dispatch, and stock sold out or running low. */
export function TodayTodos({ orders, products, lowStockThreshold, onGo }: { orders: Order[]; products: Array<Product & { archived?: boolean }>; lowStockThreshold: number; onGo: Go }) {
  const t = useMemo(() => todayTodos(orders, products, lowStockThreshold), [orders, products, lowStockThreshold]);
  const items: Array<{ key: string; n: number; label: string; tab: 'orders' | 'inventory'; Icon: typeof Truck; tone: string }> = [
    { key: 'confirm', n: t.toConfirm, label: t.toConfirm === 1 ? 'order to confirm' : 'orders to confirm', tab: 'orders', Icon: ClipboardCheck, tone: 'border-warning-line bg-warning-soft text-warning' },
    { key: 'dispatch', n: t.toDispatch, label: 'to dispatch', tab: 'orders', Icon: Truck, tone: 'border-line-strong bg-surface text-ink' },
    { key: 'stock', n: t.lowStock + t.soldOut, label: t.soldOut ? `low or sold out (${t.soldOut} sold out)` : 'running low', tab: 'inventory', Icon: t.soldOut ? PackageX : AlertTriangle, tone: 'border-danger-line bg-danger-soft text-danger' },
  ];
  const nothing = items.every((i) => i.n === 0);
  return (
    <section aria-labelledby="today-todos-title" className="space-y-2" data-testid="today-todos">
      <h2 id="today-todos-title" className="font-serif font-bold text-lg text-ink">
        Today&rsquo;s to-dos
      </h2>
      {nothing ? (
        <p className="rounded-2xl border border-success-line bg-success-soft text-success px-3 py-2.5 text-sm font-semibold">All done: nothing to confirm, dispatch or restock.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {items.map(({ key, n, label, tab, Icon, tone }) => (
            <li key={key} className="min-w-0">
              <button type="button" onClick={() => onGo(tab)} className={`w-full h-full min-h-16 rounded-2xl border px-2.5 py-2 text-left ${n ? tone : 'border-line bg-surface text-ink-soft'}`} data-testid={`todo-${key}`}>
                <span className="flex items-center gap-1.5">
                  <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span className="text-xl font-bold leading-tight tabular-nums">{n}</span>
                </span>
                <span className="block text-[11px] font-semibold leading-snug">{label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The laptop's landing page: today's to-dos and the money highlights. */
export function HubOverview({ orders, products, lowStockThreshold, onGo }: { orders: Order[]; products: Array<Product & { archived?: boolean }>; lowStockThreshold: number; onGo: Go }) {
  const money = useMemo(() => moneyHighlights(orders), [orders]);
  return (
    <div className="space-y-6 max-w-4xl" data-testid="hub-overview">
      <TodayTodos orders={orders} products={products} lowStockThreshold={lowStockThreshold} onGo={onGo} />
      <section aria-labelledby="money-highlights-title" className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 id="money-highlights-title" className="font-serif font-bold text-lg text-ink flex items-center gap-2">
            <Wallet className="w-5 h-5 text-gold-deep" aria-hidden="true" /> Money highlights
          </h2>
          <button type="button" onClick={() => onGo('money')} className="ml-auto min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-xs font-semibold text-ink">
            Open Money
          </button>
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="money-highlights">
          {money.map((m) => (
            <li key={m.label} className="rounded-2xl border border-line bg-surface px-3 py-3">
              <span className="block text-xs font-semibold text-ink-soft">{m.label}</span>
              <span className="block text-2xl font-bold text-ink tabular-nums">AED {formatAed(m.fils)}</span>
              <span className="block text-xs text-ink-soft">
                {m.orders} {m.orders === 1 ? 'order' : 'orders'}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-soft">Orders placed and not cancelled (card orders once paid), UAE dates. Refunds, expenses and the full figures are in Money → Reports.</p>
      </section>
    </div>
  );
}
