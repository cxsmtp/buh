import { enforceIpLimit } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { challengeCookie, requireRelyingParty, startPasskeySignIn } from '@/lib/server/passkeys';

/**
 * Step 1 of "Sign in with a passkey": a fresh challenge, tied to this browser
 * by an HttpOnly cookie. No shop-wide limit (a stranger could use it up and
 * block the owner); the challenge table is bounded and drops the oldest.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'passkey-sign-in', 30, 10 * 60 * 1000, 'Too many sign-in attempts from this address. Wait a few minutes.');
    allowFields(await readJsonBody(req, 256), []);
    const rp = requireRelyingParty(req.headers.get('host'));
    const { options, challengeId } = await startPasskeySignIn({ rp });
    const res = json({ success: true, options });
    res.cookies.set(challengeCookie(challengeId));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/login/passkey/options');
  }
}
