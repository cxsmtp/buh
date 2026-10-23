import type { Order } from '@/types';
import { orderConfirmedEmail, orderReceivedEmail, type OrderMailInput } from '@/lib/orderMessages';
import { confirmLink } from '@/lib/whatsappConfirm';
import { logEvent } from './log';
import { mailConfig, ownerEmail, sender, transport } from './mail';
import { claimOrderEmail, getOrder, isCustomerEmail, orderEmailDone, type OrderEmailKind } from './orders';
import { customerLink } from './runtimeConfig';
import { contactEmail, getSettings } from './settings';

/**
 * The customer's order emails, when they gave an email at checkout and the shop's email is set up:
 * - "Your order is in process" (received), when a cash-on-delivery order is placed, with the one
 *   last step (the Confirm on WhatsApp link) while it waits for it. A bank transfer gets its
 *   bank-details email instead (src/lib/server/bankMail.ts); a card order its payment.
 * - "Your order is confirmed" (confirmed), when the shop confirms it: on WhatsApp, by phone call,
 *   or by moving it on (Confirmed, Dispatched…). Cash on delivery and bank transfer.
 * Each is claimed on the order first (once, whatever retries or copies of the shop), within a daily
 * share per address and per connection; noted on the order's history; logged with the address
 * masked. Replies go to the shop's contact email. Never throws: a failed email is noted and can go
 * on the next try.
 */
export async function emailOrder(orderId: string, kind: OrderEmailKind): Promise<'sent' | 'skipped' | 'failed'> {
  const order = getOrder(orderId);
  const to = order?.customer.email;
  if (!order || !to || !isCustomerEmail(to) || !mailConfig() || !wanted(order, kind)) return 'skipped';
  const claim = claimOrderEmail(orderId, kind);
  if (claim === 'limited') {
    orderEmailDone(orderId, kind, 'limited');
    logEvent('warn', 'order_email_limited', { orderId, kind, to });
    return 'skipped';
  }
  if (claim !== 'claimed') return 'skipped';
  const { subject, text } = (kind === 'received' ? orderReceivedEmail : orderConfirmedEmail)(mailInput(order, kind));
  try {
    const replyTo = contactEmail() || ownerEmail().split(',')[0]?.trim() || undefined;
    await (await transport()).sendMail({ from: sender(), to, ...(replyTo ? { replyTo } : {}), headers: { 'Auto-Submitted': 'auto-generated' }, subject, text });
    orderEmailDone(orderId, kind, 'sent');
    logEvent('info', 'order_emailed', { orderId, kind, to });
    return 'sent';
  } catch (err) {
    orderEmailDone(orderId, kind, 'failed');
    logEvent('warn', 'order_email_failed', { orderId, kind, to, error: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}

/** Whether this order gets this email now. */
function wanted(order: Order, kind: OrderEmailKind): boolean {
  if (order.status === 'cancelled') return false;
  if (kind === 'received') return order.paymentMethod === 'cod';
  if (order.paymentMethod !== 'cod' && order.paymentMethod !== 'bank_transfer') return false;
  // Confirmed: by the shop on WhatsApp or by phone call, or moved on by the shop.
  return order.whatsappCheck?.status === 'confirmed' || ['confirmed', 'dispatched', 'out_for_delivery', 'delivered'].includes(order.status);
}

function mailInput(order: Order, kind: OrderEmailKind): OrderMailInput {
  const waiting = kind === 'received' && order.whatsappCheck && order.whatsappCheck.status !== 'confirmed';
  const link = waiting ? confirmLink(getSettings('store').whatsappNumber, order.id, order.whatsappCheck!.code) : null;
  const cancelHours = waiting && order.whatsappCheck?.cancelAt ? Math.round((Date.parse(order.whatsappCheck.cancelAt) - Date.parse(order.createdAt)) / 3600_000) : undefined;
  const track = customerLink(`/?open=track&order=${encodeURIComponent(order.id)}`);
  return {
    orderId: order.id,
    total: order.total,
    firstName: order.customer.fullName,
    shopName: getSettings('brand').storeName,
    paymentMethod: order.paymentMethod,
    lines: order.items.map((i) => `${i.quantity} × ${i.title} (${[i.profileName, i.color].filter(Boolean).join(', ')})`),
    ...(link ? { confirmLink: link } : {}),
    ...(cancelHours ? { cancelHours } : {}),
    ...(track ? { trackLink: track } : {}),
  };
}
