import { audit } from '@/lib/server/audit';
import { enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';
import { mailConfig, sender, transport } from '@/lib/server/mail';

/** "Send a test email" with the saved settings, to the Send-to address(es). */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'email-test', 10, 60 * 60 * 1000, 'Too many test emails. Try again later.');
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
      // The mail server's own answer helps (wrong password, blocked port); it holds no secrets of ours.
      throw new HttpError(502, `The mail server refused: ${message.slice(0, 200)}`);
    }
    audit('settings.email_tested', { by: session.email });
    return json({ success: true, message: `Test email sent to ${config.to}.` });
  } catch (err) {
    return handleRouteError(err, 'admin/email-test');
  }
}
