import { answerOf, generateContent, listGeminiModels, textOf } from './gemini';
import { logEvent } from './log';

/**
 * The check on every AI picture (Settings → AI pictures → "Check every picture against the product
 * photo", on by default): Gemini looks at the product photo and the new picture side by side and
 * says whether the picture shows the same printed design in the same colours, and whether anything
 * but the product's own pieces is on the bed (a comforter, a throw, cushions of another design…).
 * The owner's two must-haves: the design, and the items in the scene. A picture that fails is made
 * again once (stagePhoto.ts); one that fails twice is marked "Doesn't match" and never added to a
 * product by itself (quick add).
 * Uses the shop's Gemini key with a fast writing model (the newest "flash" the key offers, looked
 * up once and kept for a few hours). No key, or Google unreachable: no verdict (null), never a block.
 */

export interface PictureVerdict {
  ok: boolean;
  samePrint: boolean;
  extraItems: boolean;
  /** Plain words for the owner (and for the second try's prompt). */
  reason: string;
}

const CHECK_TIMEOUT_MS = 45_000;
let modelCache: { key: string; model: string; at: number } | null = null;
const MODEL_TTL_MS = 6 * 3600_000;

async function checkModel(key: string): Promise<string> {
  if (modelCache && modelCache.key === key && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.model;
  const lists = await listGeminiModels(key);
  const model = lists.writing.find((id) => /-flash\b/.test(id) && !/lite/.test(id)) ?? lists.writing.find((id) => /-flash\b/.test(id)) ?? lists.suggested.writing;
  if (!model) throw new Error('no Gemini model for the check');
  modelCache = { key, model, at: Date.now() };
  return model;
}

/** Tests: forget the model found for a key. */
export function _resetCheckModel() {
  modelCache = null;
}

export const CHECK_PROMPT = [
  'You are checking a picture for a bed-linen shop. Image 1 is the real product photo. Image 2 is an AI-made picture that must show exactly that product.',
  'Answer only with JSON: {"samePrint": true|false, "extraItems": true|false, "reason": "one short sentence"}.',
  'samePrint: true only if the bedsheet and the pillow covers in image 2 carry the same printed design as image 1: the same motifs, arrangement, print scale and colours (camera angle, light and folds may differ). False if the pattern is different, redrawn, simplified, invented, or a different design appears on any piece.',
  'extraItems: true if image 2 shows any bedding that is not the product: a comforter, duvet, quilt, blanket, throw, bed runner, decorative cushions, more than two pillows, or any sheet or pillow cover in another design or colour.',
  'reason: what is wrong, in plain words for the shop owner (or "matches" when both are fine).',
].join('\n');

export function parseVerdict(text: string): PictureVerdict | null {
  const body = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof o.samePrint !== 'boolean' || typeof o.extraItems !== 'boolean') return null;
    const reason = typeof o.reason === 'string' ? o.reason.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const ok = o.samePrint && !o.extraItems;
    return { ok, samePrint: o.samePrint, extraItems: o.extraItems, reason: ok ? 'matches' : reason || (!o.samePrint ? 'the design does not match the product' : 'other bedding was added') };
  } catch {
    return null;
  }
}

export async function checkPicture(key: string, product: { mime: string; bytes: Buffer }, picture: { mime: string; bytes: Buffer }): Promise<PictureVerdict | null> {
  if (!key) return null;
  try {
    const model = await checkModel(key);
    const inline = (img: { mime: string; bytes: Buffer }) => ({ inlineData: { mimeType: img.mime, data: img.bytes.toString('base64') } });
    const data = await generateContent(
      key,
      model,
      { contents: [{ role: 'user', parts: [{ text: CHECK_PROMPT }, inline(product), inline(picture)] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } },
      { timeoutMs: CHECK_TIMEOUT_MS, maxBytes: 256 * 1024, what: 'Gemini', place: 'Settings → AI pictures' }
    );
    const verdict = parseVerdict(textOf(answerOf(data).parts));
    if (!verdict) logEvent('warn', 'picture_check_unreadable', {});
    return verdict;
  } catch (err) {
    logEvent('warn', 'picture_check_failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
