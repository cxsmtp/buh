import { confirmOwner } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody, str } from '@/lib/server/http';
import { confirmPasskey, listPasskeys, relyingParty, removePasskey } from '@/lib/server/passkeys';

/**
 * Changing which passkeys open the Admin Hub needs the owner again: the
 * current password, or a passkey sign-in in the last 10 minutes. (A session
 * alone is not enough: after a recovery code on an account set by
 * ADMIN_PASSWORD_HASH, the session is full but nobody typed a password.)
 */
async function owner(req: Request) {
  const session = await requireAdmin(req);
  enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
  const body = await readJsonBody(req, 1024);
  allowFields(body, ['currentPassword']);
  const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
  await confirmOwner(session, current, { ip: clientIp(req), allowFreshPasskey: true });
  return session;
}

function passkeyId(id: string) {
  if (!/^[A-Za-z0-9_-]{1,1400}$/.test(id)) throw new HttpError(404, 'That passkey was not found.');
  return id;
}

function list(req: Request) {
  const rp = relyingParty(req.headers.get('host'));
  return listPasskeys('problem' in rp ? undefined : rp.rpID);
}

/** Remove a passkey: it stops working at once. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await owner(req);
    const removed = removePasskey(passkeyId((await params).id));
    if (!removed) throw new HttpError(404, 'That passkey was not found.');
    audit('admin.passkey_removed', { email: session.email, ip: clientIp(req), device: removed.name });
    return json({ success: true, passkeys: list(req) });
  } catch (err) {
    return handleRouteError(err, 'admin/passkeys/remove');
  }
}

/** Keep a passkey that came back with a restored backup: it works again. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await owner(req);
    const kept = confirmPasskey(passkeyId((await params).id));
    if (!kept) throw new HttpError(404, 'That passkey was not found.');
    audit('admin.passkey_confirmed_after_restore', { email: session.email, ip: clientIp(req), device: kept.name });
    return json({ success: true, passkeys: list(req) });
  } catch (err) {
    return handleRouteError(err, 'admin/passkeys/confirm');
  }
}
