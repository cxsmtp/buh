import type { EmailSettings } from '@/types';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { mac } from './secrets';
import { getSettings, updateSettings, type SettingsKey, type SettingsMap } from './settings';

/**
 * "Once set, the settings keep working." Every save is validated (nothing invalid is ever
 * stored). Settings that reach another service are also tried before they go live:
 *
 * - Email: the mail server must accept the login (and the mailbox, if set).
 *
 * If the trial fails while the settings in use are known to work, the change is refused and
 * the working ones stay (the owner is told why). If the current ones were never proven to
 * work, the change is kept with a warning: refusing it would protect nothing.
 *
 * SMS gateways and couriers have no harmless way to try credentials (it would send a message
 * or book a shipment), so they rely on validation, their Test buttons, and Undo.
 */

const goodKey = (key: SettingsKey) => `settings:good:${key}`;
/** Keyed with the server's own secret: a backup holding this can't be used to test password guesses. */
const fingerprint = (value: unknown) => mac('settings-known-working', JSON.stringify(value));

/** Remember that these settings (as stored now) work. */
export function markWorking(key: SettingsKey, value: unknown = getSettings(key)) {
  kvSet(goodKey(key), { hash: fingerprint(value), at: new Date().toISOString() });
}

export function isKnownWorking(key: SettingsKey, value: unknown = getSettings(key)): boolean {
  return kvGet<{ hash: string }>(goodKey(key))?.data?.hash === fingerprint(value);
}

export type Verifier = (next: EmailSettings) => Promise<void>;

/** Try the mail server (login), and the mailbox if one is set. Throws a readable reason. */
/**
 * What a failed mail-server check means, in plain words. The raw OpenSSL or SMTP text
 * ("ssl3_get_record:wrong version number") tells the owner nothing.
 */
export function explainMailError(err: unknown, s: Pick<EmailSettings, 'smtpPort' | 'smtpSecurity'>): string {
  const e = err as { message?: string; code?: string; responseCode?: number };
  const text = String(e?.message ?? err);
  if (/wrong version number|ssl3_get_record|packet length too long|unknown protocol|EPROTO/i.test(text)) {
    const want = s.smtpPort === 465 ? 'TLS' : 'STARTTLS';
    return `the port and the security setting don't match: port ${s.smtpPort} needs Security “${want}” (465 → TLS; 587, 2525 and 25 → STARTTLS)`;
  }
  if (/missing credentials/i.test(text)) {
    return 'no password is saved for this mail server: type the (app) password and press “Save email settings”';
  }
  if (e?.code === 'EAUTH' || e?.responseCode === 535 || /\b535\b|authentication failed|username and password not accepted/i.test(text)) {
    return 'the mail server refused the username or password (Gmail and Outlook need an app password, not your normal password)';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|timed? ?out/i.test(text) || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNECTION') {
    return `could not reach the mail server on port ${s.smtpPort}: check the server name and port`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'that mail server name was not found: check the spelling';
  if (/self.signed|certificate|CERT_/i.test(text)) return 'the mail server’s certificate is not valid for that name: use the server name your provider gives';
  return `the mail server said: ${text.slice(0, 160)}`;
}

export const verifyEmail: Verifier = async (next) => {
  if (!next.smtpHost) return; // .env.production is used: nothing typed here to try
  const { assertPublicMailHost } = await import('./mail');
  const nodemailer = (await import('nodemailer')).default;
  const address = await assertPublicMailHost(next.smtpHost);
  const t = nodemailer.createTransport({
    host: address,
    port: next.smtpPort,
    secure: next.smtpSecurity === 'tls',
    requireTLS: next.smtpSecurity !== 'tls',
    auth: next.smtpUser ? { user: next.smtpUser, pass: next.smtpPass } : undefined,
    tls: { servername: next.smtpHost, rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await t.verify();
  } catch (err) {
    throw new Error(explainMailError(err, next));
  } finally {
    t.close();
  }
};

export interface GuardedResult {
  /** The change was tried and works. */
  verified: boolean;
  /** Saved, but could not be proven to work (the previous settings weren't either). */
  warning?: string;
}

/**
 * Save settings, trying them first where that is possible (see above).
 * `verifiers` is injectable for tests.
 */
export async function saveGuarded<K extends SettingsKey>(key: K, input: unknown, verifiers: { email?: Verifier } = { email: verifyEmail }, { auto = false }: { auto?: boolean } = {}): Promise<GuardedResult> {
  const result: GuardedResult = { verified: false };
  if (key !== 'email') {
    await updateSettings(key, input, { auto });
    return result;
  }
  await updateSettings(key, input, {
    auto,
    beforeSave: async (next, current) => {
      const n = next as unknown as EmailSettings;
      const unchanged = JSON.stringify(n) === JSON.stringify(current);
      if (unchanged || !n.smtpHost || !verifiers.email) return;
      try {
        await verifiers.email(n);
        result.verified = true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (isKnownWorking(key, current)) {
          logEvent('warn', 'settings_change_refused', { key, reason });
          throw new HttpError(409, `Not saved: ${reason}. Your working email settings are still in use.`, {}, { code: 'kept_working' });
        }
        result.warning = `Saved, but ${reason}. Check the details, then use “Send a test email”.`;
      }
    },
  });
  if (result.verified) markWorking(key);
  return result;
}

export type { SettingsMap };
