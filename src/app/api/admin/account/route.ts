import { adminAccountInfo, changeAdminEmail, sessionCookie } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody, str } from '@/lib/server/http';

/** The admin's sign-in email (Settings → Admin account). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(await adminAccountInfo());
  } catch (err) {
    return handleRouteError(err, 'admin/account');
  }
}

/** Change the sign-in email: { email, currentPassword }. Other sessions end; this one continues. */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 2048);
    const email = str(body.email, 'Email', 254);
    const current = str(body.currentPassword, 'Current password', 256, { trim: false });
    const token = await changeAdminEmail(current, email, { ip: clientIp(req) });
    audit('admin.email_changed', { from: session.email, to: email.trim().toLowerCase(), ip: clientIp(req) });
    const res = json({ success: true, ...(await adminAccountInfo()) });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/account/update');
  }
}
