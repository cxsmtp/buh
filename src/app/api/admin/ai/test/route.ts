import { testAiSettings, testGeminiSettings } from '@/lib/server/aiWriting';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

const FIELDS = new Set(['provider', 'anthropicApiKey', 'model', 'enabled', 'geminiApiKey', 'geminiModel', 'geminiImageModel', 'labelStyledPhotos']);

/**
 * Settings → AI writing → Test: { settings: { provider?, anthropicApiKey?, model?, geminiApiKey? } }
 * (a blank key uses the saved one). Anthropic: a tiny call with the model. Gemini: the list of the
 * models the key can use (for the writing and image lists).
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 4 * 1024);
    const s = body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings) ? (body.settings as Record<string, unknown>) : {};
    for (const k of Object.keys(s)) if (!FIELDS.has(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
    if (s.provider !== undefined && s.provider !== 'anthropic' && s.provider !== 'gemini') throw new HttpError(400, 'Writing AI: Anthropic or Gemini.');
    if (s.provider === 'gemini') {
      const result = await testGeminiSettings({ geminiApiKey: s.geminiApiKey }, session.email);
      return json({ success: true, ...result });
    }
    const result = await testAiSettings({ anthropicApiKey: s.anthropicApiKey, model: s.model }, session.email);
    return json({ success: true, ...result });
  } catch (err) {
    return handleRouteError(err, 'admin/ai/test');
  }
}
