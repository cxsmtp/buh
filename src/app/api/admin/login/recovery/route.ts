import { sessionCookie, signInWithRecoveryCode } from '@/lib/server/adminAuth';
import { emailAdmin, readableUtc } from '@/lib/server/adminAlerts';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireDoor } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';

/**
 * "Use a recovery code": email + one of the owner's one-time codes. The code
 * is used up, every other session ends, and the owner must choose a new
 * password next (unless the password is set in the environment). Wrong codes
 * count towards the same pause as wrong passwords. The admin email hears about
 * it; the audit log records it (never the code).
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  try {
    requireDoor(req);
    assertSameOrigin(req);
    // Shares the sign-in allowance of this address with passwords.
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many sign-in attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['email', 'code']);
    const email = str(body.email, 'Email', 254);
    const code = str(body.code, 'Recovery code', 40);

    let result: Awaited<ReturnType<typeof signInWithRecoveryCode>>;
    try {
      result = await signInWithRecoveryCode(email, code, { ip });
    } catch (err) {
      if (err instanceof HttpError) audit('admin.recovery_sign_in_refused', { email, ip, status: err.status });
      throw err;
    }
    audit('admin.recovery_code_used', { email: result.email, ip, remaining: result.remaining });
    void emailAdmin(
      result.email,
      'A recovery code was used to sign in',
      [
        `A recovery code was used to sign in to the Admin Hub on ${readableUtc()}${ip ? ` (from address ${ip})` : ''}.`,
        `Every other device was signed out. ${result.remaining} recovery code${result.remaining === 1 ? ' is' : 's are'} left.`,
        '',
        'If this was you, nothing else to do (create a new set of codes in Settings → Passkeys & recovery codes when you are running low).',
        'If this was NOT you: sign in, change your password, remove any passkey you do not recognise and create a new set of recovery codes (the old ones stop working).',
      ].join('\n')
    );
    const res = json({
      success: true,
      email: result.email,
      mustChangePassword: result.mustChangePassword,
      managedByEnv: result.managedByEnv,
      remaining: result.remaining,
    });
    res.cookies.set(sessionCookie(result.token));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/login/recovery');
  }
}
