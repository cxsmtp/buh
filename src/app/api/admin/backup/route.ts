import { audit } from '@/lib/server/audit';
import { backupHealth, runBackup } from '@/lib/server/backup';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json } from '@/lib/server/http';

/** Backup status for the admin hub. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(backupHealth());
  } catch (err) {
    return handleRouteError(err, 'admin/backup');
  }
}

/** "Back up now": takes and emails a backup, then returns the new status. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    audit('backup.requested', { by: session.email });
    await runBackup('manual');
    return json(backupHealth());
  } catch (err) {
    return handleRouteError(err, 'admin/backup/run');
  }
}
