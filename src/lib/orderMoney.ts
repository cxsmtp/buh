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
export function dueOnDeliveryFils(o: Pick<Order, 'paymentMethod' | 'total' | 'extraCharge' | 'creditsIn'>): number {
  const base = o.paymentMethod === 'cod' ? fils(o.total) : fils(o.extraCharge?.amount);
  return Math.max(0, base - creditInFils(o));
}

/** The money a paid card or bank-transfer order holds that can be refunded or moved to another order. */
export function heldFils(o: Pick<Order, 'paymentMethod' | 'total' | 'card' | 'bankTransfer' | 'creditsOut' | 'extraCharge'>): number {
  let paid = 0;
  if (o.paymentMethod === 'online_card' && o.card?.state === 'paid') paid = fils(o.card.paidAmount ?? o.total) - fils(o.card.refundedAmount);
  else if (o.paymentMethod === 'bank_transfer' && o.bankTransfer?.state === 'paid') paid = fils(o.total) - fils(o.extraCharge?.amount);
  return Math.max(0, paid - creditOutFils(o));
}
