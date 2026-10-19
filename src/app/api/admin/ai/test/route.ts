import { testAiSettings } from '@/lib/server/aiWriting';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

/** Settings → AI writing → Test: { settings: { anthropicApiKey?, model? } } (a blank key uses the saved one). */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 4 * 1024);
    const s = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? (body.settings as Record<string, unknown>) : {};
    for (const k of Object.keys(s)) if (k !== 'anthropicApiKey' && k !== 'model' && k !== 'enabled') throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
    const result = await testAiSettings({ anthropicApiKey: s.anthropicApiKey, model: s.model }, session.email);
    return json({ success: true, ...result });
  } catch (err) {
    return handleRouteError(err, 'admin/ai/test');
  }
}
