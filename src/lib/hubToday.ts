import type { Order, Product } from '@/types';
import { stockAlerts } from '@/lib/client/stock';
import { dubaiDateOf, dubaiToday } from '@/lib/reportPeriods';

/**
 * The Admin Hub's "today" figures, from the orders and products the hub already has (no extra
 * call): what needs the owner now, and the money highlights on the laptop's Overview. Pure, so the
 * tests use the same code. Sales count orders placed and not cancelled, leaving out card orders
 * not yet paid; the full figures (refunds, expenses, VAT) are in Money → Reports.
 */

export interface Todos {
  toConfirm: number;
  toDispatch: number;
  lowStock: number;
  soldOut: number;
}

export function todayTodos(orders: Order[], products: Array<Product & { archived?: boolean }>, lowStockThreshold: number): Todos {
  const alerts = stockAlerts(products, lowStockThreshold);
  return {
    toConfirm: orders.filter((o) => o.status === 'pending_confirmation').length,
    toDispatch: orders.filter((o) => o.status === 'confirmed').length,
    lowStock: alerts.low.length,
    soldOut: alerts.soldOut.length,
  };
}

export interface MoneyHighlight {
  label: string;
  /** Sales in fils (AED × 100). */
  fils: number;
  orders: number;
}

/** A sale: placed, not cancelled, and (for a card) paid. */
export function countsAsSale(o: Pick<Order, 'status' | 'card'>): boolean {
  if (o.status === 'cancelled' || o.status === 'pending_payment') return false;
  if (o.card && !['paid', 'refund_pending', 'refunded'].includes(o.card.state)) return false;
  return true;
}

const fils = (aed: number) => Math.round(Number(aed) * 100) || 0;

/** Today, the last 7 days and this month (UAE dates), with the number of orders. */
export function moneyHighlights(orders: Order[], now = Date.now()): MoneyHighlight[] {
  const today = dubaiToday(now);
  const weekStart = dubaiToday(now - 6 * 86_400_000);
  const monthStart = `${today.slice(0, 7)}-01`;
  const sales = orders.filter(countsAsSale).map((o) => ({ day: dubaiDateOf(o.createdAt), fils: fils(o.total) }));
  const sum = (from: string) => {
    const inRange = sales.filter((s) => s.day >= from && s.day <= today);
    return { fils: inRange.reduce((n, s) => n + s.fils, 0), orders: inRange.length };
  };
  return [
    { label: 'Today', ...sum(today) },
    { label: 'Last 7 days', ...sum(weekStart) },
    { label: 'This month', ...sum(monthStart) },
  ];
}
