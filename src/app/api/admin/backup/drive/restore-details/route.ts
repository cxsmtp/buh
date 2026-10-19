import { confirmOwner } from '@/lib/server/adminAuth';
import { audit } from '@/lib/server/audit';
import { driveRestoreDetails } from '@/lib/server/driveBackup';
import { clientIp, enforceIpLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';

/**
 * "Copy restore details": the Google Drive connection (client id and secret, refresh token, folder)
 * as env-file lines, for rebuilding the shop on a new server. The current password every time (a
 * passkey sign-in is not enough: this hands out a working credential), audited before it is shown.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    enforceIpLimit(req, 'signin', 30, 10 * 60 * 1000, 'Too many attempts from this address. Wait a few minutes.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['currentPassword']);
    const current = str(body.currentPassword, 'Current password', 256, { trim: false, required: false });
    await confirmOwner(session, current, { ip: clientIp(req), allowFreshPasskey: false });
    const text = driveRestoreDetails();
    if (!audit('backup.drive_details_revealed', { by: session.email })) throw new Error('audit write failed');
    return json({ success: true, text });
  } catch (err) {
    return handleRouteError(err, 'admin/backup/drive/restore-details');
  }
}
