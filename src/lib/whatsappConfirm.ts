/**
 * "Confirm on WhatsApp", with no WhatsApp API or paid service: a wa.me link opens the
 * customer's own WhatsApp with a message to the shop already typed (the order number and
 * a 4-digit code). They tap Send; the owner's WhatsApp shows it from the customer's number,
 * which proves they hold that number. Shared by the shop, the hub and the server.
 */

/** A https://wa.me link to a number (any format: only its digits are used), or null without one. */
export function waMeLink(number: string, message: string): string | null {
  const digits = (number || '').replace(/\D/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  // encodeURIComponent: Arabic, emoji, "·", "&", "#" and new lines all reach WhatsApp as typed.
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

/** What the customer sends: short, and readable by the owner at a glance. */
export function confirmMessage(orderId: string, code: string): string {
  return `Confirm my order ${orderId} · code ${code}`;
}

/** The customer's "Confirm on WhatsApp" link to the shop's number. */
export function confirmLink(shopNumber: string, orderId: string, code: string): string | null {
  return waMeLink(shopNumber, confirmMessage(orderId, code));
}

/** The owner's one-tap reply after confirming. */
export function confirmedReply(orderId: string): string {
  return `Thank you, your order ${orderId} is confirmed ✓`;
}
