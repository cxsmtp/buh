import { audit } from '@/lib/server/audit';
import { backupHealth, runBackup } from '@/lib/server/backup';
import { driveStatus } from '@/lib/server/driveBackup';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

/** Backup status for the admin hub (last, next, what waits), with the last copy to Google Drive (when switched on). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ ...backupHealth(), drive: driveStatus() });
  } catch (err) {
    return handleRouteError(err, 'admin/backup');
  }
}

/**
 * "Back up now": takes a backup (emailed as Settings → System & backups says, or as asked with
 * { email: true | false }), then returns the new status.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    // The body is optional (older pages send none); when given: only { email }.
    const body = /^application\/json\b/i.test(req.headers.get('content-type') || '') && req.body ? await readJsonBody(req, 1024) : {};
    for (const k of Object.keys(body)) if (k !== 'email') throw new HttpError(400, 'Unknown field.');
    if (body.email !== undefined && typeof body.email !== 'boolean') throw new HttpError(400, 'email: true or false.');
    const email = body.email as boolean | undefined;
    audit('backup.requested', { by: session.email, ...(email !== undefined ? { email } : {}) });
    await runBackup('manual', { email });
    return json({ ...backupHealth(), drive: driveStatus() });
  } catch (err) {
    return handleRouteError(err, 'admin/backup/run');
  }
}
