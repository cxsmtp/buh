import { bankDetailsEmail } from '@/lib/bankMessages';
import { logEvent } from './log';
import { mailConfig, ownerEmail, sender, transport } from './mail';
import { bankEmailDone, bankEmailLimited, claimBankEmail, getOrder, isCustomerEmail } from './orders';
import { bankTransferReady, contactEmail, getSettings } from './settings';
import { confirmLink } from '@/lib/whatsappConfirm';

/**
 * The bank details, emailed to a customer who chose bank transfer and gave an email (when the
 * shop's email is set up): the account, the amount, the reference (the order number) and the
 * order's private link (from NEXT_PUBLIC_APP_URL; left out when that is not set), "or reply to
 * this email with your screenshot" (replies go to the shop).
 * Once per order: the send is claimed on the order first, so a retry or a second copy of the shop
 * never sends it twice; and at most 3 a day to one address, 5 a day per connection (the address is
 * whatever was typed at checkout). Noted on the order's history; logged with the address and link masked.
 * Never throws: a failed email is noted, and the owner sends the details on WhatsApp instead.
 */
export async function emailBankDetails(orderId: string): Promise<'sent' | 'skipped' | 'failed'> {
  const order = getOrder(orderId);
  const bank = getSettings('bank');
  const to = order?.customer.email;
  if (!order || order.paymentMethod !== 'bank_transfer' || !order.bankTransfer?.payPath || !to || !isCustomerEmail(to) || !mailConfig() || !bankTransferReady(bank)) return 'skipped';
  const claim = claimBankEmail(orderId);
  if (claim === 'limited') {
    // Today's share for this address (or connection) is used: the customer has the private page already.
    bankEmailLimited(orderId);
    logEvent('warn', 'bank_details_email_limited', { orderId, to });
    return 'skipped';
  }
  if (claim !== 'claimed') return 'skipped';
  // The link is built from the shop's configured address only (never the request's Host): without
  // it, the email asks for the screenshot by reply instead.
  const link = order.bankTransfer.payUrl;
  const { subject, text } = bankDetailsEmail({
    orderId,
    total: order.total,
    bank,
    link,
    firstName: order.customer.fullName,
    shopName: getSettings('brand').storeName,
    // Still waiting for the customer's WhatsApp message: the email carries the same one-tap link.
    ...(order.whatsappCheck?.status === 'awaiting' ? { confirmLink: confirmLink(getSettings('store').whatsappNumber, orderId, order.whatsappCheck.code) ?? undefined } : {}),
    ...(order.whatsappCheck?.cancelAt ? { cancelHours: Math.round((Date.parse(order.whatsappCheck.cancelAt) - Date.parse(order.createdAt)) / 3600_000) } : {}),
  });
  try {
    const replyTo = contactEmail() || ownerEmail().split(',')[0]?.trim() || undefined;
    await (await transport()).sendMail({ from: sender(), to, ...(replyTo ? { replyTo } : {}), headers: { 'Auto-Submitted': 'auto-generated' }, subject, text });
    bankEmailDone(orderId, true);
    logEvent('info', 'bank_details_emailed', { orderId, to, link });
    return 'sent';
  } catch (err) {
    bankEmailDone(orderId, false);
    logEvent('warn', 'bank_details_email_failed', { orderId, to, error: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}
