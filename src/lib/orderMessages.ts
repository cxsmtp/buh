import { formatAed, toFils } from './money';
import { safeFirstName } from './bankMessages';

/**
 * The customer's order emails (src/lib/server/orderMail.ts), plain text, shared with the tests:
 * - received: "your order is in process", sent when a cash-on-delivery order is placed (a bank
 *   transfer gets its bank-details email instead), with the one last step (confirm on WhatsApp)
 *   while it waits for that;
 * - confirmed: once the shop has confirmed the order (on WhatsApp, by phone call, or by moving it
 *   on), what happens next.
 * Both carry the Track Order link (the shop's address, when it is set). No promise the shop does
 * not make: no delivery date, no stock claim.
 */

export interface OrderMailInput {
  orderId: string;
  /** AED, from the server. */
  total: number;
  firstName?: string;
  shopName?: string;
  paymentMethod: 'cod' | 'bank_transfer' | 'online_card';
  /** "2 × Palm & Rose Hand Block Print Bed Set (King)". */
  lines: string[];
  /** The "Confirm on WhatsApp" link while the order still waits for it. */
  confirmLink?: string;
  /** Hours before an order still not confirmed is cancelled. */
  cancelHours?: number;
  /** The shop's Track Order link for this order (absent when the shop's address is not set). */
  trackLink?: string;
}

const aed = (total: number) => `AED ${formatAed(toFils(total))}`;
const PAYMENT: Record<OrderMailInput['paymentMethod'], string> = { cod: 'Cash on delivery', bank_transfer: 'Bank transfer', online_card: 'Card' };

function summary(i: OrderMailInput): string[] {
  return ['Your order:', ...i.lines.map((l) => `  ${l}`), `  Total: ${aed(i.total)}`, `  Payment: ${PAYMENT[i.paymentMethod]}`];
}

function track(i: OrderMailInput): string[] {
  return i.trackLink ? ['Track your order any time:', i.trackLink] : ['Track your order any time on our website (Track Order), with your order number and phone number.'];
}

export function orderReceivedEmail(i: OrderMailInput): { subject: string; text: string } {
  const name = safeFirstName(i.firstName);
  const shop = i.shopName || 'Beautiful UAE Home';
  return {
    subject: i.confirmLink ? `One last step to confirm your order ${i.orderId}` : `Your order ${i.orderId} is in process`,
    text: [
      `Hello${name ? ` ${name}` : ''},`,
      '',
      `Thank you for shopping with ${shop}. Your order ${i.orderId} is in process.`,
      '',
      ...(i.confirmLink
        ? [
            'One last step: please confirm it on WhatsApp. Tap this link and press Send (the message is already typed):',
            i.confirmLink,
            ...(i.cancelHours ? [`Orders not confirmed within ${i.cancelHours} hours are cancelled.`] : []),
            '',
            'We will confirm your order shortly after your message, and email you when it is confirmed.',
          ]
        : ['We will confirm it shortly and email you when it is confirmed.']),
      '',
      ...summary(i),
      '',
      ...track(i),
      '',
      shop,
    ].join('\n'),
  };
}

export function orderConfirmedEmail(i: OrderMailInput): { subject: string; text: string } {
  const name = safeFirstName(i.firstName);
  const shop = i.shopName || 'Beautiful UAE Home';
  const next =
    i.paymentMethod === 'bank_transfer'
      ? 'We will prepare it as soon as your bank transfer arrives (use your order number as the reference).'
      : i.paymentMethod === 'cod'
        ? 'We are preparing it now. You pay in cash when it is delivered.'
        : 'We are preparing it now.';
  return {
    subject: `Your order ${i.orderId} is confirmed`,
    text: [`Hello${name ? ` ${name}` : ''},`, '', `Good news: your order ${i.orderId} is confirmed. ${next} We will send you the tracking details when it ships.`, '', ...summary(i), '', ...track(i), '', `Thank you for shopping with ${shop}.`].join('\n'),
  };
}
