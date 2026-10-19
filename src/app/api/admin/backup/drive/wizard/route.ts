import { saveDriveWizard } from '@/lib/server/driveBackup';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';

/**
 * Settings → System & backups → "Set up Google Drive": the steps the owner ticked and the Google
 * Cloud project id (for the console links). Nothing secret; the owner only.
 */
export async function PUT(req: Request) {
  try {
    await requireAdmin(req);
    enforceLimit('drive-wizard', 300, 3600_000, 'Too many changes in the last hour. Please wait a while and try again.');
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['done', 'projectId']);
    return json({ success: true, wizard: saveDriveWizard(body) });
  } catch (err) {
    return handleRouteError(err, 'admin/backup/drive/wizard');
  }
}
