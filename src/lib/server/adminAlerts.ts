import { logEvent } from './log';
import { mailConfig, sender, transport } from './mail';
import { getSettings } from './settings';

/**
 * A short security notice to the admin's sign-in email ("a recovery code was
 * used", "a passkey was added"), when a mail server is set up. Never throws
 * and never holds up the answer to the browser: callers don't await it.
 */
export async function emailAdmin(to: string, subject: string, text: string): Promise<boolean> {
  if (!mailConfig() || !to) return false;
  try {
    const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
    await (await transport()).sendMail({ from: sender(), to, subject: `[${shop}] ${subject}`, text });
    return true;
  } catch (err) {
    logEvent('warn', 'admin_alert_email_failed', { subject, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** "15 Oct 2026, 09:12 UTC": a time anyone can read. */
export function readableUtc(date = new Date()): string {
  return `${date.toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC`;
}
