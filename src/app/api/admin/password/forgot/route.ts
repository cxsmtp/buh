import { startPasswordReset } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireDoor } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { logEvent } from '@/lib/server/log';
import { emailConfigured, sender, transport } from '@/lib/server/mail';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * "Forgot password?": emails a one-time reset link (30 minutes) to the admin
 * email. The answer is the same, and as quick, whatever email is typed (the
 * email is sent after answering), so it cannot be used to find the admin
 * email. Limited per address, and to 3 links an hour for the account.
 */
const ANSWER =
  'If that is the admin email, a reset link is on its way (valid for 30 minutes). Nothing arriving? Email must be set up in Settings → Email; otherwise use "Reset the admin password" in the deployment guide.';

export async function POST(req: Request) {
  try {
    requireDoor(req);
    assertSameOrigin(req);
    enforceIpLimit(req, 'password-forgot', 5, 60 * 60 * 1000, 'Too many requests from this address. Try again in an hour.');
    const body = await readJsonBody(req, 1024);
    const email = str(body.email, 'Email', 254);
    // Worked out for every request (and inside it: it reads this request's Host), so both answers cost the same.
    const base = await siteUrl();
    const reset = await startPasswordReset(email);
    if (reset) {
      audit('admin.password_reset_requested', { ip: clientIp(req), emailed: emailConfigured() });
      // Not awaited: waiting for the mail server would make the admin email's answer slower than any other.
      // The path is the link's one-time door grant (it opens the Admin Hub); the token stays in the fragment.
      if (emailConfigured()) void sendLink(email.trim().toLowerCase(), `${base}/${reset.grant}#reset=${encodeURIComponent(reset.token)}`);
    }
    return json({ success: true, message: ANSWER });
  } catch (err) {
    return handleRouteError(err, 'admin/password/forgot');
  }
}

/**
 * The token is in the fragment (#), which browsers never send to a server, so it stays out of access logs.
 * The path is a separate one-time grant, valid as long as the reset link, masked in the logs.
 */
async function sendLink(to: string, link: string) {
  try {
    const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
    await (await transport()).sendMail({
      from: sender(),
      to,
      subject: `[${shop}] Reset your admin password`,
      text: `Someone (hopefully you) asked to reset the admin password of ${shop}.\n\nChoose a new password here (the link works once, for 30 minutes):\n${link}\n\nIf this wasn't you, ignore this email: your password stays as it is.`,
    });
  } catch (err) {
    logEvent('warn', 'password_reset_email_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

