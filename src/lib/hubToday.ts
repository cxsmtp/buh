import type { Order, OrderStatus, Product } from '@/types';
import { stockAlerts } from '@/lib/client/stock';
import { saleFils } from '@/lib/orderMoney';
import { dubaiDateOf, dubaiToday } from '@/lib/reportPeriods';

/**
 * The Admin Hub's "today" figures: what needs the owner now, and the money highlights on the
 * laptop's Overview. Pure, so the server (which counts every order: hubTotalsOf, through
 * src/lib/server/orders.ts hubTotals), the hub and the tests use the same code. The hub only holds
 * the open orders and the newest finished ones, so its header, badges, to-dos and highlights come
 * from the server's totals, never from that list. Sales count orders placed and not cancelled,
 * leaving out card orders not yet paid; the full figures (refunds, expenses, VAT) are in
 * Money → Reports.
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

/** The to-dos from the server's totals (every order), and the stock the hub holds. */
export function todosFrom(totals: Pick<HubTotals, 'toConfirm' | 'toDispatch'>, products: Array<Product & { archived?: boolean }>, lowStockThreshold: number): Todos {
  const alerts = stockAlerts(products, lowStockThreshold);
  return { toConfirm: totals.toConfirm, toDispatch: totals.toDispatch, lowStock: alerts.low.length, soldOut: alerts.soldOut.length };
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
export function moneyHighlights(orders: Iterable<Order>, now = Date.now()): MoneyHighlight[] {
  const sums = highlightSums(now);
  for (const o of orders) sums.add(o);
  return sums.result();
}

function highlightSums(now: number) {
  const today = dubaiToday(now);
  const ranges = [
    { label: 'Today', from: today, fils: 0, orders: 0 },
    { label: 'Last 7 days', from: dubaiToday(now - 6 * 86_400_000), fils: 0, orders: 0 },
    { label: 'This month', from: `${today.slice(0, 7)}-01`, fils: 0, orders: 0 },
  ];
  return {
    add(o: Order) {
      if (!countsAsSale(o)) return;
      const day = dubaiDateOf(o.createdAt);
      if (day > today) return;
      for (const r of ranges) {
        if (day >= r.from) {
          r.fils += fils(o.total);
          r.orders += 1;
        }
      }
    },
    result: (): MoneyHighlight[] => ranges.map(({ label, fils: f, orders }) => ({ label, fils: f, orders })),
  };
}

/** What the hub shows about every order the shop has, counted on the server (GET /api/admin/orders). */
export interface HubTotals {
  /** Every order, any status. */
  orders: number;
  byStatus: Record<OrderStatus, number>;
  toConfirm: number;
  toDispatch: number;
  /** Card orders, and orders from a photo (the Orders tab's chips). */
  card: number;
  photo: number;
  /** The header's Sales figure (src/lib/orderMoney.ts saleFils), in fils. */
  salesFils: number;
  highlights: MoneyHighlight[];
  /** Customers: one per phone number. */
  customers: number;
}

const STATUSES: OrderStatus[] = ['pending_payment', 'pending_confirmation', 'confirmed', 'dispatched', 'out_for_delivery', 'delivered', 'cancelled'];

/** The totals of a set of orders (the server passes every order, one at a time). */
export function hubTotalsOf(orders: Iterable<Order>, now = Date.now()): HubTotals {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  const sums = highlightSums(now);
  const phones = new Set<string>();
  let n = 0;
  let card = 0;
  let photo = 0;
  let salesFils = 0;
  for (const o of orders) {
    n += 1;
    if (o.status in byStatus) byStatus[o.status] += 1;
    if (o.paymentMethod === 'online_card') card += 1;
    if (o.photoOrder) photo += 1;
    salesFils += saleFils(o);
    sums.add(o);
    phones.add(o.customer.phone);
  }
  return { orders: n, byStatus, toConfirm: byStatus.pending_confirmation, toDispatch: byStatus.confirmed, card, photo, salesFils, highlights: sums.result(), customers: phones.size };
}

/**
 * What a search for orders looks for: text in the order number or the customer's name, and (three
 * digits or more) the digits in the phone number, without a leading 0 ("050 123 4567" finds
 * +971501234567). The server's search and the hub's own list use the same rule.
 */
export function orderSearchTerms(q: string): { text: string; phone: string } | null {
  const text = q.trim().toLowerCase().slice(0, 60);
  if (text.length < 2) return null;
  const digits = /^[\d\s+()-]+$/.test(text) ? text.replace(/\D/g, '').replace(/^0+/, '') : '';
  return { text, phone: digits.length >= 3 ? digits : '' };
}

export function orderMatchesSearch(o: Pick<Order, 'id' | 'customer'>, terms: { text: string; phone: string }): boolean {
  if (o.id.toLowerCase().includes(terms.text) || o.customer.fullName.toLowerCase().includes(terms.text)) return true;
  return Boolean(terms.phone) && o.customer.phone.replace(/\D/g, '').includes(terms.phone);
}

/** How the customer pays, in plain words (the Customers tab's order history). */
export function paymentName(method: Order['paymentMethod']): string {
  return method === 'cod' ? 'Cash on Delivery' : method === 'online_card' ? 'Card' : 'Bank Transfer';
}
