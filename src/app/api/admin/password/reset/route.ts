import { completePasswordReset } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { passwordProblem } from '@/lib/server/password';

/** Set a new admin password with the emailed one-time link. Every session ends; sign in again. */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'password-reset', 10, 60 * 60 * 1000, 'Too many attempts from this address. Try again in an hour.');
    const body = await readJsonBody(req, 2048);
    const token = str(body.token, 'Reset link', 100);
    const next = str(body.newPassword, 'New password', 256, { trim: false });
    const problem = passwordProblem(next);
    if (problem) throw new HttpError(400, problem);
    await completePasswordReset(token, next);
    audit('admin.password_reset', { ip: clientIp(req) });
    return json({ success: true, message: 'Password changed. Sign in with the new password.' });
  } catch (err) {
    return handleRouteError(err, 'admin/password/reset');
  }
}
