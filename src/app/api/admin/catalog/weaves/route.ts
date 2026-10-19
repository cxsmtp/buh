import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getSettings } from '@/lib/server/settings';
import { renameWeave, weaveUsage } from '@/lib/server/weaves';

/** Settings → Catalogue → Weaves: the list and how many products use each weave. */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ weaves: getSettings('catalog').weaves, usage: weaveUsage() });
  } catch (err) {
    return handleRouteError(err, 'admin/catalog/weaves');
  }
}

/** Rename a weave on every product and in the list, in one audited transaction: { from, to }. */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 2 * 1024);
    for (const k of Object.keys(body)) if (k !== 'from' && k !== 'to') throw new HttpError(400, 'Give the weave (from) and its new name (to).');
    const result = renameWeave(body.from, body.to, session.email);
    return json({ success: true, ...result, usage: weaveUsage() });
  } catch (err) {
    return handleRouteError(err, 'admin/catalog/weaves/rename');
  }
}
