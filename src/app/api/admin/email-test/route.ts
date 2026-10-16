import { audit } from '@/lib/server/audit';
import { enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';
import { peekLimit, recordHit } from '@/lib/server/rateLimit';
import { mailConfig, sender, transport } from '@/lib/server/mail';
import { explainMailError, markWorking } from '@/lib/server/settingsGuard';
import { getSettings } from '@/lib/server/settings';

const HOUR = 60 * 60 * 1000;
const SENT_KEY = 'global:email-test-sent';
const SENT_MAX = 10;

/** "Send a test email" with the saved settings, to the Send-to address(es). */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    // Tries that fail send nothing, so only a generous cap on attempts (to spare the mail server)…
    enforceIpLimit(req, 'email-test-try', 60, HOUR, 'Too many tries in an hour. Wait a few minutes, then try again.');
    // …and the real limit counts test emails that were actually sent.
    const sent = peekLimit(SENT_KEY, SENT_MAX, HOUR);
    if (!sent.ok) {
      const minutes = Math.ceil(sent.retryAfterSec / 60);
      throw new HttpError(429, `${SENT_MAX} test emails were sent in the last hour. You can send another in ${minutes} minute${minutes === 1 ? '' : 's'}.`, { 'Retry-After': String(sent.retryAfterSec) });
    }
    // The exact settings this test uses (an autosave landing meanwhile must not be marked as working).
    const tested = getSettings('email');
    const config = mailConfig();
    if (!config) throw new HttpError(400, 'Save a mail server first (or set SMTP_* in .env.production).');
    if (!config.to) throw new HttpError(400, 'Add a "Send to" address first.');
    try {
      await (await transport(config)).sendMail({
        from: sender(),
        to: config.to,
        subject: '[Beautiful UAE Home] Test email',
        text: 'This is a test from your shop. Backups, alerts, the daily summary and password resets will arrive like this.',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent('warn', 'email_test_failed', { error: message });
      // In plain words (wrong port/security pair, refused password, unreachable); no secrets of ours in it.
      throw new HttpError(502, `Not sent: ${explainMailError(err, { smtpPort: config.port, smtpSecurity: config.secure ? 'tls' : 'starttls' })}.`);
    }
    recordHit(SENT_KEY);
    // These settings demonstrably work: a later failing change won't replace them.
    markWorking('email', tested);
    audit('settings.email_tested', { by: session.email });
    return json({ success: true, message: `Test email sent to ${config.to}.` });
  } catch (err) {
    return handleRouteError(err, 'admin/email-test');
  }
}
