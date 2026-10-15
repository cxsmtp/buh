import { adminAccountInfo, confirmOwner, isFreshPasskeySession } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';
import { createRecoveryCodes, recoveryCodeStatus } from '@/lib/server/recoveryCodes';

/** How many recovery codes are left (Settings → Passkeys & recovery codes). Never the codes. */
export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    return json({ ...recoveryCodeStatus(), freshPasskey: isFreshPasskeySession(session), managedByEnv: (await adminAccountInfo()).managedByEnv });
  } catch (err) {
    return handleRouteError(err, 'admin/recovery-codes');
  }
}

/**
 * A new set of 10 codes, shown this once; the old set stops working. The owner
 * proves it's them again: the current password, or a passkey sign-in in the
 * last 10 minutes (a stolen session cookie alone can't mint a way back in).
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['currentPassword']);
    const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
    await confirmOwner(session, current, { ip: clientIp(req), allowFreshPasskey: true });
    const codes = createRecoveryCodes();
    audit('admin.recovery_codes_created', { email: session.email, ip: clientIp(req), count: codes.length });
    return json({ success: true, codes, ...recoveryCodeStatus() });
  } catch (err) {
    return handleRouteError(err, 'admin/recovery-codes/create');
  }
}
