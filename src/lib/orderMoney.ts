import type { Order } from '@/types';

/**
 * What is collected on delivery, and what a paid order still holds, in fils, the same in the hub
 * and on the server (src/lib/server/orders.ts setExtraCharge / moveCredit):
 *  - cash on delivery: the total (extra included), less payments moved in from cancelled orders;
 *  - paid online (card, bank transfer): only the extra the owner added, less those payments;
 *  - a paid order holds what was paid, less refunds and less what was moved to other orders.
 */
const fils = (aed: number | undefined) => Math.round((aed ?? 0) * 100);

export const creditInFils = (o: Pick<Order, 'creditsIn'>) => (o.creditsIn ?? []).reduce((s, c) => s + fils(c.amount), 0);
export const creditOutFils = (o: Pick<Order, 'creditsOut'>) => (o.creditsOut ?? []).reduce((s, c) => s + fils(c.amount), 0);

/** What the courier collects from the customer. */
export function dueOnDeliveryFils(o: Pick<Order, 'paymentMethod' | 'total' | 'extraCharge' | 'creditsIn'> & Partial<Pick<Order, 'bulk' | 'paymentStatus'>>): number {
  // A bulk order already paid in cash (typed in by the owner as paid): the courier collects only an extra, like a prepaid order.
  const cashPaid = o.paymentMethod === 'cod' && Boolean(o.bulk) && o.paymentStatus === 'paid';
  const base = o.paymentMethod === 'cod' && !cashPaid ? fils(o.total) : fils(o.extraCharge?.amount);
  return Math.max(0, base - creditInFils(o));
}

/** The money a paid card or bank-transfer order holds that can be refunded or moved to another order. */
export function heldFils(o: Pick<Order, 'paymentMethod' | 'total' | 'card' | 'bankTransfer' | 'creditsOut' | 'extraCharge'>): number {
  let paid = 0;
  if (o.paymentMethod === 'online_card' && o.card?.state === 'paid') paid = fils(o.card.paidAmount ?? o.total) - fils(o.card.refundedAmount);
  else if (o.paymentMethod === 'bank_transfer' && o.bankTransfer?.state === 'paid') paid = fils(o.total) - fils(o.extraCharge?.amount);
  return Math.max(0, paid - creditOutFils(o));
}

export interface OrderClass {
  counted: boolean;
  /** Why not counted ('' when counted). */
  reason: string;
  paid: boolean;
}

/** How an order counts in the books (Money → Reports, src/lib/server/reports.ts; the hub's Sales figure). */
export function classifyOrder(o: Order): OrderClass {
  const card = o.paymentMethod === 'online_card' ? o.card : undefined;
  const cardTaken = card ? fils(card.paidAmount) > 0 && ['paid', 'refund_pending', 'refunded'].includes(card.state) : false;
  const paid =
    o.paymentMethod === 'online_card'
      ? cardTaken
      : o.paymentMethod === 'bank_transfer'
      ? o.bankTransfer?.state === 'paid' || o.paymentStatus === 'verified' || o.paymentStatus === 'paid'
      : o.paymentStatus === 'paid' || o.paymentStatus === 'verified';
  let reason = '';
  if (card?.mode === 'test') reason = 'Stripe test mode (not real money)';
  else if (o.status === 'pending_payment') reason = 'waiting for the card payment';
  else if (o.status === 'cancelled' && !cardTaken) reason = 'cancelled';
  return { counted: !reason, reason, paid };
}

/**
 * What an order adds to the shop's sales, in fils: its total when it counts (not cancelled unpaid,
 * not waiting for its card payment, not a Stripe test), less the card refunds made and less a
 * payment moved onto another order (counted there). The hub's "Sales" figure; Money → Reports
 * books refunds by the day they were made.
 */
export function saleFils(o: Order): number {
  if (!classifyOrder(o).counted) return 0;
  const refunded = o.paymentMethod === 'online_card' ? fils(o.card?.refundedAmount) : 0;
  return Math.max(0, fils(o.total) - refunded - creditOutFils(o));
}
