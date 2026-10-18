/**
 * Structured, privacy-safe server logging. Secrets are redacted by key name
 * and phone numbers / emails are masked, so logs can be shared for
 * troubleshooting without leaking credentials or customer data.
 */

const SECRET_KEY = /(pass(word)?|secret|token|api.?key|auth|authorization|cookie|otp|code|sid|clientkey)/i;
// Field names that look like secrets but hold none: Stripe's error code (e.g. resource_missing) and
// a card's decline code (e.g. insufficient_funds) are needed to understand a failed payment.
const SAFE_KEYS = new Set(['stripeCode', 'declineCode']);
// A phone number: 9+ digits (spaces and dashes allowed), not inside an identifier, so an order
// number like BUH-261018-123456 or a date like 2026-10-18T09:00 stays readable.
const PHONE = /(?<![\w-])\+?\d[\d\s-]{7,}\d(?![\w-]*\w)/g;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// A long random path segment: the private admin link (32 characters) or a password-reset
// email's single-reset path (43). Only its first 4 characters are ever logged.
const SECRET_PATH = /\/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{28,}/g;
// Stripe keys, webhook signing secrets and payment client secrets, wherever they appear in a message.
const STRIPE_SECRET = /\b((?:sk|rk)_(?:test|live)_|whsec_)[A-Za-z0-9+/=_-]{6,}|\b(pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g;

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `+${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

/** Mask the private admin link (and reset paths) in a path or URL. */
export function maskSecretPaths(s: string): string {
  return s.replace(SECRET_PATH, '/$1…');
}

function scrubString(s: string): string {
  return maskSecretPaths(s)
    .replace(STRIPE_SECRET, (_m, key: string | undefined, intent: string | undefined) => (key ? `${key}[redacted]` : `${intent}_[redacted]`))
    .replace(EMAIL, '$1***@$2')
    .replace(PHONE, (m) => maskPhone(m))
    .slice(0, 500);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && !SAFE_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function logEvent(level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(details) as object) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
