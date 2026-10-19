import { testDriveConnection } from '@/lib/server/driveBackup';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

/**
 * "Test connection": { folderId?, serviceAccountKey? } (blank ones from the saved settings). Uploads a
 * tiny text file to the folder, checks it and deletes it. 20 an hour.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 16 * 1024);
    enforceLimit('drive-test', 20, 3600_000, 'Too many tests in the last hour. Please wait a while and try again.');
    const result = await testDriveConnection(body, session.email);
    return json({ success: true, ...result });
  } catch (err) {
    return handleRouteError(err, 'admin/backup/drive/test');
  }
}
