import { canSetPasswordWithoutCurrent, changePassword, sessionCookie, setPasswordAfterRecovery } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { passwordProblem } from '@/lib/server/password';

/**
 * Change the admin password: { currentPassword, newPassword }. Right after a
 * recovery-code sign-in, or within 10 minutes of a passkey sign-in, the
 * forgotten password is not asked for: { newPassword }.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req, { allowPendingPasswordChange: true });
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');

    const body = await readJsonBody(req, 4 * 1024);
    allowFields(body, ['currentPassword', 'newPassword']);
    const next = str(body.newPassword, 'New password', 256, { trim: false });
    const problem = passwordProblem(next);
    if (problem) throw new HttpError(400, problem);

    let token: string;
    const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
    if (session.recoveryPending || (!current && canSetPasswordWithoutCurrent(session))) {
      token = await setPasswordAfterRecovery(session, next);
      audit('admin.password_changed', { email: session.email, ip: clientIp(req), after: session.recoveryPending ? 'recovery code' : 'passkey sign-in' });
    } else {
      if (!current) throw new HttpError(400, 'Current password is required.');
      token = await changePassword(current, next, { ip: clientIp(req) });
      audit('admin.password_changed', { email: session.email, ip: clientIp(req) });
    }
    const res = json({ success: true });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/password');
  }
}
