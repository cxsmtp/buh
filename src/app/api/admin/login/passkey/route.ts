import { cookies } from 'next/headers';
import { adminAccountInfo, passkeySession, sessionCookie } from '@/lib/server/adminAuth';
import { emailAdmin, readableUtc } from '@/lib/server/adminAlerts';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import {
  CHALLENGE_COOKIE,
  challengeIdFromCookie,
  clearedChallengeCookie,
  finishPasskeySignIn,
  parseAuthenticationResponse,
  PasskeyCloneSuspected,
  requireRelyingParty,
} from '@/lib/server/passkeys';

/**
 * Step 2 of "Sign in with a passkey": check the signed answer against the
 * challenge this browser was given (used up either way). The session is the
 * same as after a password sign-in. A passkey can't be guessed, so wrong
 * passwords pausing sign-in don't stop it: the owner still gets in during an
 * attack on the password.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'passkey-sign-in', 30, 10 * 60 * 1000, 'Too many sign-in attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 16 * 1024);
    allowFields(body, ['response']);
    const response = parseAuthenticationResponse(body.response);
    const rp = requireRelyingParty(req.headers.get('host'));
    const challengeId = challengeIdFromCookie((await cookies()).get(CHALLENGE_COOKIE)?.value);

    let device: string;
    try {
      device = (await finishPasskeySignIn({ rp, challengeId, response })).name;
    } catch (err) {
      if (err instanceof HttpError) audit('admin.passkey_sign_in_refused', { ip, status: err.status });
      if (err instanceof PasskeyCloneSuspected) {
        void emailAdmin(
          (await adminAccountInfo()).email,
          'A passkey was refused: it may have been copied',
          `On ${readableUtc()} the passkey "${err.device}" was used to sign in to the Admin Hub, but its counter went backwards, which happens when a copy of it exists. It was refused.\n\nSign in another way, then in Settings → Passkeys & recovery codes remove "${err.device}" and add it again. If you did not try to sign in just now, also change your password.`
        );
      }
      throw err;
    }
    const result = await passkeySession();
    audit('admin.sign_in', { email: result.email, ip, method: 'passkey', device });
    const res = json({ success: true, email: result.email, mustChangePassword: result.mustChangePassword });
    res.cookies.set(sessionCookie(result.token));
    res.cookies.set(clearedChallengeCookie());
    return res;
  } catch (err) {
    const res = handleRouteError(err, 'admin/login/passkey');
    res.cookies.set(clearedChallengeCookie());
    return res;
  }
}
