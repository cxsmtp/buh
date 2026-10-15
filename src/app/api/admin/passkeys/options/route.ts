import { confirmOwner } from '@/lib/server/adminAuth';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { challengeCookie, registrationBinding, requireRelyingParty, startPasskeyRegistration } from '@/lib/server/passkeys';

/**
 * Step 1 of adding a passkey: the owner types the current password again, and
 * gets a challenge tied to this browser (HttpOnly cookie) and this session.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['currentPassword']);
    const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
    const rp = requireRelyingParty(req.headers.get('host'));
    await confirmOwner(session, current, { ip: clientIp(req) });
    const { options, challengeId } = await startPasskeyRegistration({ rp, email: session.email, boundTo: registrationBinding(session) });
    const res = json({ success: true, options });
    res.cookies.set(challengeCookie(challengeId));
    return res;
  } catch (err) {
    return handleRouteError(err, 'admin/passkeys/options');
  }
}
