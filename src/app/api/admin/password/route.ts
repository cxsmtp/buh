import { changePassword, sessionCookie } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { passwordProblem } from '@/lib/server/password';

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req, { allowPendingPasswordChange: true });
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');

    const body = await readJsonBody(req, 4 * 1024);
    const current = str(body.currentPassword, 'Current password', 256, { trim: false });
    const next = str(body.newPassword, 'New password', 256, { trim: false });
    const problem = passwordProblem(next);
    if (problem) throw new HttpError(400, problem);

    const token = await changePassword(current, next, { ip: clientIp(req) });
    audit('admin.password_changed', { email: session.email, ip: clientIp(req) });
    const res = json({ success: true });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/password');
  }
}
