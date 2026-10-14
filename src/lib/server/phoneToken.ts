import { mac, macMatches } from './secrets';

/**
 * Proof that a phone number passed SMS verification, handed to the browser by
 * /api/otp/verify and required by /api/orders. Signed (HMAC, "phone" purpose)
 * and valid for 30 minutes, so an order can only carry a number its customer
 * really received a code on.
 */

export const PHONE_TOKEN_TTL_MS = 30 * 60 * 1000;

export function issuePhoneToken(phone: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ p: phone, exp: now + PHONE_TOKEN_TTL_MS })).toString('base64url');
  return `${body}.${mac('phone', body)}`;
}

/** The verified phone number, or null if the token is missing, forged or expired. */
export function verifyPhoneToken(token: unknown, now = Date.now()): string | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  if (!macMatches('phone', body, sig)) return null;
  try {
    const { p, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof p !== 'string' || !Number.isFinite(exp) || exp <= now) return null;
    return p;
  } catch {
    return null;
  }
}
