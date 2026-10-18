/**
 * Phone numbers as the shop stores them (+9715…), with no server imports: the server
 * (src/lib/otpService.ts: validatePhone) and the Admin Hub (to show the number the server will
 * store before the owner confirms a change) use the same rules. The server always checks again.
 */

/** Arabic-Indic and Persian digits as 0–9. */
export function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => String(c.charCodeAt(0) & 0xf));
}

/** "050 123 4567", "00971501234567", "+971 050…" → "+971501234567" (other forms: "+" and the digits). */
export function normalizePhoneNumber(rawPhone: string): string {
  let cleaned = toAsciiDigits(rawPhone).replace(/[^\d+]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  } else if (cleaned.startsWith('05')) {
    cleaned = '+971' + cleaned.slice(1);
  } else if (cleaned.startsWith('5') && cleaned.length === 9) {
    cleaned = '+971' + cleaned;
  } else if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  // "+971 050…" (international prefix plus the domestic trunk 0) is the same
  // number as "+971 50…": fold it, so one number has one rate-limit key.
  return cleaned.replace(/^\+9710/, '+971');
}

/** UAE mobile networks: 50, 52, 54, 55, 56, 58. Matches the checkout form. */
export const UAE_MOBILE = /^\+9715[024568]\d{7}$/;

/** The number as the shop would store it, when it is a UAE mobile; otherwise null. */
export function uaeMobileOrNull(raw: string): string | null {
  const phone = normalizePhoneNumber(raw);
  return UAE_MOBILE.test(phone) ? phone : null;
}
