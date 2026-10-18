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

/**
 * What the customer sends: short, and readable by the owner at a glance. A bank-transfer order
 * also asks for the bank details (they are never on the website), so the owner's reply is one tap.
 */
export function confirmMessage(orderId: string, code: string, { bankDetails = false } = {}): string {
  return `Confirm my order ${orderId} · code ${code}${bankDetails ? ', and please send me the bank details' : ''}`;
}

/** The customer's "Confirm on WhatsApp" link to the shop's number. */
export function confirmLink(shopNumber: string, orderId: string, code: string, opts: { bankDetails?: boolean } = {}): string | null {
  return waMeLink(shopNumber, confirmMessage(orderId, code, opts));
}

/** The owner's one-tap reply after confirming. */
export function confirmedReply(orderId: string): string {
  return `Thank you, your order ${orderId} is confirmed ✓`;
}

/** The hours an order had to be confirmed (Settings → Phone check), from its times; null when it isn't cancelled for that. */
export function cancelHoursOf(createdAt: string | undefined, cancelAt: string | undefined): number | null {
  if (!createdAt || !cancelAt) return null;
  const h = Math.round((Date.parse(cancelAt) - Date.parse(createdAt)) / 3600_000);
  return Number.isFinite(h) && h > 0 ? h : null;
}

/** "13 h", "45 min": how long until an order still not confirmed is cancelled (never below 0). */
export function timeLeft(cancelAt: string, now = Date.now()): string {
  const ms = Math.max(0, Date.parse(cancelAt) - now);
  if (ms >= 3600_000) return `${Math.round(ms / 3600_000)} h`;
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/**
 * The owner's "Ask to confirm" message to the customer (from the hub, a wa.me link to the
 * customer's number): the name is passed through safeFirstName by the caller.
 */
export function askToConfirmMessage(orderId: string, firstName: string, shopName?: string): string {
  return `Hello${firstName ? ` ${firstName}` : ''}, please confirm your order ${orderId} from ${messageName(shopName)} by replying YES. Thank you!`;
}

/** The shop's name for a message: a logo-style "BEAUTIFUL UAE HOME" reads "Beautiful UAE Home" (short words kept, like UAE). */
function messageName(shopName?: string): string {
  const name = (shopName || '').trim() || 'Beautiful UAE Home';
  if (name !== name.toUpperCase() || !/\p{L}/u.test(name)) return name;
  return name.replace(/\p{L}+/gu, (w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()));
}
