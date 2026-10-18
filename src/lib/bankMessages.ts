import type { BankTransferDetails } from '@/types';
import { formatAed, toFils } from './money';

/**
 * What the customer is sent for a bank transfer, by email (automatic) or WhatsApp (the owner's
 * one tap), with no paid service or WhatsApp API. The bank account is only ever in these private
 * messages and on the order's private page, never on the public website. Shared by the server
 * (the email), the hub (wa.me links) and Settings (the preview), so all three say the same.
 */

export interface BankMessageInput {
  orderId: string;
  /** AED, from the server. */
  total: number;
  bank: BankTransferDetails;
  /** The order's private page, as a full https:// address (absent when it has none). */
  link?: string;
  firstName?: string;
  shopName?: string;
  /** The order's "Confirm on WhatsApp" link (wa.me), while it still waits for that message. */
  confirmLink?: string;
  /** Hours before an order still not confirmed is cancelled (Settings → Phone check, WhatsApp mode). */
  cancelHours?: number;
}

/**
 * The customer's first name as it may appear in a message to them: letters, spaces, apostrophes,
 * hyphens and dots only, and never a word that looks like a link or an address ("evil.com",
 * "http://…", "a@b"), so a name typed at checkout can't put a link into the shop's email.
 */
export function safeFirstName(fullName?: string): string {
  for (const word of (fullName ?? '').normalize('NFC').split(/\s+/)) {
    if (!word || /[/:@\\]|\p{L}\.\p{L}{2,}|^www\b/iu.test(word)) continue;
    const clean = word.replace(/[^\p{L}\p{M}'’.-]/gu, '').replace(/^[.'’-]+|[.'’-]+$/g, '').slice(0, 40);
    if (/\p{L}/u.test(clean)) return clean;
  }
  return '';
}

const aed = (total: number) => `AED ${formatAed(toFils(total))}`;

/** The account, one detail per line (only the ones the owner filled in). */
export function bankDetailLines(bank: BankTransferDetails): string[] {
  return [
    ['Bank', bank.bankName],
    ['Account name', bank.accountName],
    ['IBAN', bank.iban],
    ['Account number', bank.accountNumber],
    ['SWIFT', bank.swiftCode],
    ['Branch', bank.branch],
  ]
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}: ${v.trim()}`);
}

/** The owner's WhatsApp message to the customer: details, amount, reference and the private link. */
export function bankDetailsWhatsApp({ orderId, total, bank, link, firstName: name, shopName }: BankMessageInput): string {
  const firstName = safeFirstName(name);
  return [
    `Hello${firstName ? ` ${firstName}` : ''}, thank you for your order ${orderId} with ${shopName || 'Beautiful UAE Home'}.`,
    '',
    `Please transfer ${aed(total)} to:`,
    ...bankDetailLines(bank),
    `Reference: ${orderId}`,
    '',
    link ? `Then upload a screenshot of the transfer here: ${link}` : 'Then send us a screenshot of the transfer here.',
    ...(link ? ['Or simply reply here with the screenshot.'] : []),
  ].join('\n');
}

/** The automatic email to the customer. */
export function bankDetailsEmail({ orderId, total, bank, link, firstName: name, shopName, confirmLink, cancelHours }: BankMessageInput): { subject: string; text: string } {
  const firstName = safeFirstName(name);
  const shop = shopName || 'Beautiful UAE Home';
  return {
    subject: `Bank details for your order ${orderId}`,
    text: [
      `Hello${firstName ? ` ${firstName}` : ''},`,
      '',
      `Thank you for your order ${orderId}. To pay by bank transfer, please send ${aed(total)} to:`,
      '',
      ...bankDetailLines(bank).map((l) => `  ${l}`),
      '',
      `Please use ${orderId} as the transfer reference.`,
      ...(bank.instructions?.trim() ? [bank.instructions.trim()] : []),
      '',
      ...(link ? ['Then upload a screenshot or PDF of the transfer on your order’s private page:', link, '', 'or reply to this email with your screenshot.'] : ['Then reply to this email with your screenshot.']),
      '',
      'We will confirm your order as soon as we see the transfer.',
      '',
      ...(confirmLink
        ? [
            'To confirm your order, tap to send us a WhatsApp message (it is already typed, just tap Send):',
            confirmLink,
            ...(cancelHours ? [`Orders not confirmed within ${cancelHours} hours are cancelled.`] : []),
            '',
          ]
        : []),
      `${shop}`,
      '',
      'This link and these details are only for you: please don’t share them.',
    ].join('\n'),
  };
}

/** The owner's one-tap reply once the money is in. */
export function paymentReceivedReply(orderId: string): string {
  return `We've received your payment for order ${orderId}, thank you ✓`;
}

/** The owner's reply when the transfer hasn't arrived yet. */
export function notReceivedReply(orderId: string, total: number, link?: string): string {
  return [
    `We haven't seen your transfer of ${aed(total)} for order ${orderId} in our account yet. Transfers can take a little while; we'll check again.`,
    link ? `If you have a new screenshot, you can upload it here: ${link}` : 'If you have a screenshot of the transfer, please send it here.',
  ].join('\n');
}
