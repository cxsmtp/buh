import { startPasswordReset } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, enforceLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';
import { emailConfigured, sender, transport } from '@/lib/server/mail';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * "Forgot password?": emails a one-time reset link (30 minutes) to the admin
 * email. The answer is the same whatever email is typed, so it cannot be used
 * to find the admin email. Limited per address and shop-wide.
 */
const ANSWER =
  'If that is the admin email, a reset link is on its way (valid for 30 minutes). Nothing arriving? Email must be set up in Settings → Email; otherwise use "Reset the admin password" in the deployment guide.';

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'password-forgot', 5, 60 * 60 * 1000, 'Too many requests from this address. Try again in an hour.');
    enforceLimit('password-forgot:all', 20, 60 * 60 * 1000, 'Too many reset requests right now. Try again in an hour.');
    const body = await readJsonBody(req, 1024);
    const email = str(body.email, 'Email', 254);
    const token = await startPasswordReset(email);
    if (token) {
      audit('admin.password_reset_requested', { ip: clientIp(req), emailed: emailConfigured() });
      if (emailConfigured()) {
        const link = `${await siteUrl()}/?reset=${encodeURIComponent(token)}`;
        const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
        try {
          await (await transport()).sendMail({
            from: sender(),
            to: email.trim().toLowerCase(),
            subject: `[${shop}] Reset your admin password`,
            text: `Someone (hopefully you) asked to reset the admin password of ${shop}.\n\nChoose a new password here (the link works once, for 30 minutes):\n${link}\n\nIf this wasn't you, ignore this email: your password stays as it is.`,
          });
        } catch (err) {
          logEvent('warn', 'password_reset_email_failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return json({ success: true, message: ANSWER });
  } catch (err) {
    return handleRouteError(err, 'admin/password/forgot');
  }
}
