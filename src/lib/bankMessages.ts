import type { BankTransferDetails } from '@/types';
import { formatAed, toFils } from './money';
import { confirmLink, waMeLink } from './whatsappConfirm';

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

// ── Bank transfer "on request" (Settings → Payments: the customer asks on WhatsApp) ─────────────

/** What the customer sends the shop's WhatsApp to ask for the bank details. */
export function askBankDetailsMessage(orderId: string, total: number): string {
  return `Hello, I placed order ${orderId} for ${aed(total)}. Please send your bank details so I can pay by transfer.`;
}

/** Stands for the account in the owner's reply when none is saved (the owner types it in WhatsApp). */
export const BANK_DETAILS_PLACEHOLDER = '[your bank details]';

/** The account is saved (bank, account name and IBAN): the reply can carry it. */
export const bankDetailsSaved = (bank?: Partial<BankTransferDetails> | null) => Boolean(bank?.iban && bank.accountName && bank.bankName);

/**
 * The owner's WhatsApp reply to a customer who asked for the bank details: the saved account, or
 * "[your bank details]" for the owner to fill in before sending; the amount, reference and link.
 */
export function bankDetailsReply(input: Omit<BankMessageInput, 'bank'> & { bank?: BankTransferDetails | null; askConfirm?: boolean }): string {
  // The order still waits for its WhatsApp confirmation: the reply asks for it too (like the hub's "Ask to confirm").
  const confirm = input.askConfirm ? ['', 'Please also reply YES to confirm your order.'] : [];
  if (input.bank && bankDetailsSaved(input.bank)) return [bankDetailsWhatsApp({ ...input, bank: input.bank }), ...confirm].join('\n');
  const firstName = safeFirstName(input.firstName);
  return [
    `Hello${firstName ? ` ${firstName}` : ''}, thank you for your order ${input.orderId} with ${input.shopName || 'Beautiful UAE Home'}.`,
    '',
    `Please transfer ${aed(input.total)} to:`,
    BANK_DETAILS_PLACEHOLDER,
    `Reference: ${input.orderId}`,
    '',
    input.link ? `Then upload a screenshot of the transfer here: ${input.link}` : 'Then send us a screenshot of the transfer here.',
    ...(input.link ? ['Or simply reply here with the screenshot.'] : []),
    ...confirm,
  ].join('\n');
}

/**
 * The customer's one WhatsApp button for an "on request" order: while their number still has to be
 * confirmed (Settings → Phone check), the confirmation message (with its code) that also asks for
 * the bank details, so asking never leaves the order unconfirmed; after that, the plain ask.
 * Null without the shop's WhatsApp number (the caller then points to the support email).
 */
export function bankAskLink(shopNumber: string, order: { id: string; total: number; whatsappCheck?: { status: string; code: string } | null }): { href: string; confirms: boolean } | null {
  const check = order.whatsappCheck;
  if (check?.code && check.status !== 'confirmed') {
    const href = confirmLink(shopNumber, order.id, check.code, { bankDetails: true });
    return href ? { href, confirms: true } : null;
  }
  const href = waMeLink(shopNumber, askBankDetailsMessage(order.id, order.total));
  return href ? { href, confirms: false } : null;
}

/**
 * The email to a customer who will ask for the bank details on WhatsApp: no account in it. While the
 * order waits for its WhatsApp confirmation, the link is that confirmation (it asks for the details
 * too), with the hours before an unconfirmed order is cancelled. With no WhatsApp link at all (the
 * shop's number was removed), they ask by replying to the email.
 */
export function bankRequestEmail({ orderId, total, link, firstName: name, shopName, askLink, confirmLink: confirm, cancelHours }: Omit<BankMessageInput, 'bank'> & { askLink?: string | null }): { subject: string; text: string } {
  const firstName = safeFirstName(name);
  const shop = shopName || 'Beautiful UAE Home';
  return {
    subject: `Paying for your order ${orderId} by bank transfer`,
    text: [
      `Hello${firstName ? ` ${firstName}` : ''},`,
      '',
      ...(confirm
        ? [
            `Thank you for your order ${orderId}. To confirm it and get our bank details to pay ${aed(total)} by transfer, tap to send us a WhatsApp message (it is already typed, just tap Send):`,
            confirm,
            ...(cancelHours ? [`Orders not confirmed within ${cancelHours} hours are cancelled.`] : []),
          ]
        : askLink
          ? [`Thank you for your order ${orderId}. To pay ${aed(total)} by bank transfer, message us on WhatsApp for the bank details (the message is already typed, just tap Send):`, askLink]
          : [`Thank you for your order ${orderId}. To pay ${aed(total)} by bank transfer, reply to this email and we will send you our bank details.`]),
      '',
      `Please use ${orderId} as the transfer reference.`,
      '',
      ...(link ? ['Then upload a screenshot or PDF of the transfer on your order’s private page:', link, '', confirm || askLink ? 'or send it to us on WhatsApp.' : 'or reply to this email with it.'] : [confirm || askLink ? 'Then send us a screenshot of the transfer on WhatsApp.' : 'Then reply to this email with your screenshot.']),
      '',
      'We will confirm your order as soon as we see the transfer.',
      '',
      `${shop}`,
      '',
      'This link is only for you: please don’t share it.',
    ].join('\n'),
  };
}
