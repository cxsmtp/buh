import { cookies } from 'next/headers';
import { isFreshPasskeySession } from '@/lib/server/adminAuth';
import { emailAdmin, readableUtc } from '@/lib/server/adminAlerts';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import {
  CHALLENGE_COOKIE,
  challengeIdFromCookie,
  cleanPasskeyName,
  clearedChallengeCookie,
  finishPasskeyRegistration,
  listPasskeys,
  parseRegistrationResponse,
  registrationBinding,
  relyingParty,
  requireRelyingParty,
} from '@/lib/server/passkeys';

/** The owner's passkeys (name, added, last used), and whether passkeys can work at this address. */
export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    const rp = relyingParty(req.headers.get('host'));
    return json({
      passkeys: listPasskeys('problem' in rp ? undefined : rp.rpID),
      available: !('problem' in rp),
      problem: 'problem' in rp ? rp.problem : undefined,
      // Signed in with a passkey in the last 10 minutes: no password needed to remove or keep one.
      freshPasskey: isFreshPasskeySession(session),
    });
  } catch (err) {
    return handleRouteError(err, 'admin/passkeys');
  }
}

/** Step 2 of adding a passkey: check what the phone or computer made, against this browser's challenge, and keep it. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'passkey-add', 20, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 32 * 1024);
    allowFields(body, ['name', 'response']);
    const response = parseRegistrationResponse(body.response);
    const name = cleanPasskeyName(body.name);
    const rp = requireRelyingParty(req.headers.get('host'));
    const challengeId = challengeIdFromCookie((await cookies()).get(CHALLENGE_COOKIE)?.value);
    const passkey = await finishPasskeyRegistration({ rp, challengeId, boundTo: registrationBinding(session), response, name });
    audit('admin.passkey_added', { email: session.email, ip: clientIp(req), device: passkey.name });
    void emailAdmin(
      session.email,
      'A passkey was added to your Admin Hub',
      `A passkey called "${passkey.name}" was added on ${readableUtc()}. It can now be used to sign in to the Admin Hub.\n\nIf this was not you: sign in, remove it in Settings → Passkeys & recovery codes, and change your password.`
    );
    const res = json({ success: true, passkey, passkeys: listPasskeys(rp.rpID) });
    res.cookies.set(clearedChallengeCookie());
    return res;
  } catch (err) {
    const res = handleRouteError(err, 'admin/passkeys/add');
    res.cookies.set(clearedChallengeCookie());
    return res;
  }
}
