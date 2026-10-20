import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { indexNowOn, KEY_PATH, lastPings } from '@/lib/server/indexNow';
import { shopUrl } from '@/lib/server/runtimeConfig';
import { seoOverview } from '@/lib/server/seo';
import { undoVersionId, updateSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * Settings → Search (SEO). GET: what Google sees (every page's title, address and description,
 * with its status and problems), the festival schedule, the health checks, a sample of the
 * structured data and IndexNow's last pings. PUT { settings }: save (validated, an allow-list;
 * kept in settings history and backups like every other setting), then the home page is rebuilt.
 * Owner only.
 */

function overview(base: string) {
  const site = shopUrl();
  return seoOverview(base, new Date(), { indexNow: { on: indexNowOn(), keyUrl: indexNowOn() && site ? `${site}${KEY_PATH}` : null, last: lastPings() } });
}

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(overview(await siteUrl()));
  } catch (err) {
    return handleRouteError(err, 'admin/seo');
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 64 * 1024);
    allowFields(body, ['settings']);
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) throw new HttpError(400, 'Settings must be an object.');
    await updateSettings('seo', body.settings);
    audit('settings.updated', { by: session.email, key: 'seo', fields: Object.keys(body.settings as object) });
    return json({ success: true, undoId: undoVersionId('seo'), ...overview(await siteUrl()) });
  } catch (err) {
    return handleRouteError(err, 'admin/seo/update');
  }
}
