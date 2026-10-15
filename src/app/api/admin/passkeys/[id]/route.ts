import { audit } from '@/lib/server/audit';
import { clientIp, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { listPasskeys, relyingParty, removePasskey } from '@/lib/server/passkeys';

/** Remove a passkey: it stops working at once. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    if (!/^[A-Za-z0-9_-]{1,1400}$/.test(id)) throw new HttpError(404, 'That passkey was not found.');
    const removed = removePasskey(id);
    if (!removed) throw new HttpError(404, 'That passkey was not found.');
    audit('admin.passkey_removed', { email: session.email, ip: clientIp(req), device: removed.name });
    const rp = relyingParty(req.headers.get('host'));
    return json({ success: true, passkeys: listPasskeys('problem' in rp ? undefined : rp.rpID) });
  } catch (err) {
    return handleRouteError(err, 'admin/passkeys/remove');
  }
}
