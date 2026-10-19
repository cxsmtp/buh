import { driveStatus, updateDriveSettings } from '@/lib/server/driveBackup';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

/** Settings → System & backups → Google Drive: the setup (never the key: its service account's email). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(driveStatus());
  } catch (err) {
    return handleRouteError(err, 'admin/backup/drive');
  }
}

/** Save: { enabled?, mode?, folderId?, keep?, serviceAccountKey?, disconnect? } (allow-listed and checked in saveDriveSettings; Disconnect revokes at Google first). */
export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 16 * 1024);
    return json(await updateDriveSettings(body, session.email));
  } catch (err) {
    return handleRouteError(err, 'admin/backup/drive/save');
  }
}
