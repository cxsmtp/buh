/**
 * Structured, privacy-safe server logging. Secrets are redacted by key name
 * and phone numbers / emails are masked, so logs can be shared for
 * troubleshooting without leaking credentials or customer data.
 */

const SECRET_KEY = /(pass(word)?|secret|token|api.?key|private.?key|auth|authorization|cookie|otp|code|sid|clientkey)/i;
// Field names that look like secrets but hold none: Stripe's error code (e.g. resource_missing) and
// a card's decline code (e.g. insufficient_funds) are needed to understand a failed payment.
const SAFE_KEYS = new Set(['stripeCode', 'declineCode']);
// A phone number: 9+ digits (spaces and dashes allowed), not inside an identifier, so an order
// number like BUH-261018-123456 or a date like 2026-10-18T09:00 stays readable.
const PHONE = /(?<![\w-])\+?\d[\d\s-]{7,}\d(?![\w-]*\w)/g;
// A calendar date (2026-10-18) has 8 digits and dashes too: it is not a phone number (audit entries
// carry report periods and the dates on bills).
const ISO_DATE = /^(?:19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// A long random path segment: the private admin link (32 characters) or a password-reset
// email's single-reset path (43). Only its first 4 characters are ever logged.
const SECRET_PATH = /\/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{28,}/g;
// Stripe keys, webhook signing secrets and payment client secrets, wherever they appear in a message.
const STRIPE_SECRET = /\b((?:sk|rk)_(?:test|live)_|whsec_)[A-Za-z0-9+/=_-]{6,}|\b(pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g;
// Anthropic API keys (Settings → AI writing).
const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{6,}/g;
// DeepSeek API keys (Settings → AI writing): sk- and 16+ letters or digits. Never sk-ant- (masked
// above as Anthropic's) and never Stripe's sk_live_ / sk_test_ (an underscore, masked as Stripe's).
const DEEPSEEK_KEY = /\bsk-(?!ant-)[A-Za-z0-9]{16,}/g;
// OpenAI project, service-account and admin keys (Settings → AI pictures): sk-proj-…, sk-svcacct-…,
// sk-admin-… (a dash after the prefix, so DEEPSEEK_KEY above does not catch them; plain sk-… keys it does).
const OPENAI_KEY = /\bsk-(proj|svcacct|admin)-[A-Za-z0-9_-]{8,}/g;
// fal.ai keys (Settings → AI pictures): key-id:key-secret (a UUID-like id, a colon, a long secret).
const FAL_KEY = /\b[A-Za-z0-9][A-Za-z0-9_-]{7,79}:[A-Za-z0-9_-]{16,}/g;
// Google (Gemini) API keys (Settings → AI writing): the classic AIza… keys and the newer
// authorization keys that start with AQ. (letters, digits, '.', '_' and '-'). Whole words only,
// so ordinary text is never touched.
const GOOGLE_KEY = /\b(AIza)[A-Za-z0-9_-]{20,}|\b(AQ\.)[A-Za-z0-9._-]{16,}/g;

/** Anthropic, DeepSeek and Google API keys anywhere in a text, replaced by their prefix + [redacted]. */
export function maskAiKeys(s: string): string {
  return maskGoogleKeys(s.replace(ANTHROPIC_KEY, 'sk-ant-[redacted]').replace(OPENAI_KEY, 'sk-$1-[redacted]').replace(DEEPSEEK_KEY, 'sk-[redacted]').replace(FAL_KEY, '[fal key redacted]'));
}

/** Google API keys (AIza… and AQ.…) anywhere in a text, replaced by their prefix + [redacted]. */
export function maskGoogleKeys(s: string): string {
  return s.replace(GOOGLE_KEY, (_m, classic: string | undefined, auth: string | undefined) => `${classic ?? auth}[redacted]`);
}
// A PEM private key (a Google service account's, Settings → System & backups → Google Drive), even
// cut short; and Google OAuth access tokens (ya29.…).
const PEM_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const BARE_KEY = /\bMII[A-Za-z0-9+/=]{60,}/g;
const GOOGLE_TOKEN = /\bya29\.[A-Za-z0-9._-]+/g;
// Google refresh tokens (1//…: Connect my Google Drive) and OAuth client secrets (GOCSPX-…).
const GOOGLE_REFRESH = /(?<![\w/])1\/\/[A-Za-z0-9._-]{10,}/g;
const GOOGLE_CLIENT_SECRET = /\bGOCSPX-[A-Za-z0-9_-]{6,}/g;

// Secrets known at run time (the backup password): removed wherever they appear, whatever the key.
const KNOWN_SECRETS = new Set<string>();

const KNOWN_SECRETS_MAX = 100;

/**
 * Never log this value (minLength characters or more), wherever it appears: the backup password.
 * The newest ones are kept: adding one again moves it to the front, and the oldest drops out past 100.
 */
export function addRedactedValue(value: string, minLength = 8): void {
  if (typeof value !== 'string' || value.length < minLength) return;
  KNOWN_SECRETS.delete(value);
  KNOWN_SECRETS.add(value);
  if (KNOWN_SECRETS.size > KNOWN_SECRETS_MAX) KNOWN_SECRETS.delete(KNOWN_SECRETS.values().next().value as string);
}

function withoutKnownSecrets(s: string): string {
  let out = s;
  for (const v of KNOWN_SECRETS) if (out.includes(v)) out = out.split(v).join('[redacted]');
  return out;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `+${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

/** Mask the private admin link (and reset paths) in a path or URL. */
export function maskSecretPaths(s: string): string {
  return s.replace(SECRET_PATH, '/$1…');
}

function scrubString(s: string, max = 500): string {
  // Masked before it is cut, so a cut can never leave half a phone number unmasked.
  // A private key is removed whole, or what is left of it after the cut (from its BEGIN line on);
  // a bare key body (base64 DER starts MII…) too.
  // Known secrets first, before the cut (a password is at most 256 characters), so no half of one is left.
  return maskSecretPaths(withoutKnownSecrets(s.slice(0, max * 2 + 300)).slice(0, max * 2).replace(PEM_KEY, '[private key redacted]').replace(BARE_KEY, '[private key redacted]').replace(GOOGLE_REFRESH, '1//[redacted]'))
    .replace(STRIPE_SECRET, (_m, key: string | undefined, intent: string | undefined) => (key ? `${key}[redacted]` : `${intent}_[redacted]`))
    .replace(ANTHROPIC_KEY, 'sk-ant-[redacted]')
    .replace(OPENAI_KEY, 'sk-$1-[redacted]')
    .replace(DEEPSEEK_KEY, 'sk-[redacted]')
    .replace(FAL_KEY, '[fal key redacted]')
    .replace(GOOGLE_KEY, (_m, classic: string | undefined, auth: string | undefined) => `${classic ?? auth}[redacted]`)
    .replace(GOOGLE_TOKEN, 'ya29.[redacted]')
    .replace(GOOGLE_CLIENT_SECRET, 'GOCSPX-[redacted]')
    .replace(EMAIL, '$1***@$2')
    .replace(PHONE, (m) => (ISO_DATE.test(m) ? m : maskPhone(m)))
    .slice(0, max);
}

/**
 * Secrets by key name, phones and emails masked, strings cut at 500 characters. `longText` lets
 * some fields (by name, at any depth: an expense's note before → after in the audit log) keep up
 * to `max` characters, masked the same way.
 */
export function redact(value: unknown, depth = 0, longText?: { keys: Set<string>; max: number }, long = false): unknown {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') return scrubString(value, long && longText ? longText.max : 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1, longText, long));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && !SAFE_KEYS.has(k) ? '[redacted]' : redact(v, depth + 1, longText, long || Boolean(longText?.keys.has(k)));
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
