import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { adminView, undoVersionId, type SettingsKey } from '@/lib/server/settings';
import { saveGuarded } from '@/lib/server/settingsGuard';

const KEYS: SettingsKey[] = ['brand', 'bank', 'courier', 'sms', 'catalog', 'store', 'theme', 'email', 'assistant', 'delivery'];

export async function PUT(req: Request, { params }: { params: Promise<{ key: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { key } = await params;
    if (!KEYS.includes(key as SettingsKey)) throw new HttpError(404, 'Unknown settings.');
    // Branding may carry a logo image (stored as a file).
    const body = await readJsonBody(req, key === 'brand' ? 4 * 1024 * 1024 : 64 * 1024);
    // Validated, and tried first where possible: a change that fails keeps the working settings.
    const result = await saveGuarded(key as SettingsKey, body.settings);
    // Field names only: never the values (they may be keys).
    audit('settings.updated', { by: session.email, key, fields: Object.keys((body.settings as object) || {}), auto: body.auto === true, verified: result.verified });
    return json({ success: true, ...result, undoId: undoVersionId(key as SettingsKey), ...adminView(key as SettingsKey) });
  } catch (err) {
    return handleRouteError(err, 'admin/settings/update');
  }
}
