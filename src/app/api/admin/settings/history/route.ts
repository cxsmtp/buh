import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { restoreSettingsVersion, settingsHistory } from '@/lib/server/settings';

/** Earlier versions of the settings (keys are never kept in history). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ versions: settingsHistory() });
  } catch (err) {
    return handleRouteError(err, 'admin/settings/history');
  }
}

/** Restore one: { id }. The version it replaces is kept too, so a restore can be undone. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 256);
    if (!Number.isInteger(body.id) || (body.id as number) < 1) throw new HttpError(400, 'Give the version id.');
    const key = await restoreSettingsVersion(body.id as number, session.email);
    audit('settings.restored', { by: session.email, key, versionId: body.id });
    return json({ success: true, key });
  } catch (err) {
    return handleRouteError(err, 'admin/settings/history/restore');
  }
}
