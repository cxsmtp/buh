/**
 * Structured, privacy-safe server logging. Secrets are redacted by key name
 * and phone numbers / emails are masked, so logs can be shared for
 * troubleshooting without leaking credentials or customer data.
 */

const SECRET_KEY = /(pass(word)?|secret|token|api.?key|auth|authorization|cookie|otp|code|sid|clientkey)/i;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `+${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

function scrubString(s: string): string {
  return s.replace(EMAIL, '$1***@$2').replace(PHONE, (m) => maskPhone(m)).slice(0, 500);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
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
