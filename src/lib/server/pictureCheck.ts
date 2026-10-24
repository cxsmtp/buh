import { answerOf, generateContent, listGeminiModels, textOf } from './gemini';
import { logEvent } from './log';
import { pieceImages, type SetPieces } from '@/lib/staging';

/**
 * The check on every AI picture (Settings → AI pictures → "Check every picture against the product
 * photo", on by default): Gemini looks at the product photo and the new picture side by side and
 * says whether the picture shows the same printed design in the same colours, and whether anything
 * but the product's own pieces is on the bed (a comforter, a throw, cushions of another design…).
 * The owner's must-haves: the exact design and colours, the product's pillow covers, and nothing
 * else on the bed. A picture that fails is made again (stagePhoto.ts); one that still fails is
 * marked "Doesn't match" and can never be added to a product (src/lib/server/stagedPhotos.ts).
 * Uses the shop's Gemini key with a fast writing model (the newest "flash" the key offers, looked
 * up once and kept for a few hours). No key, or Google unreachable: no verdict (null): the picture
 * is "not checked", never added by itself, and added by hand only once the owner confirms it.
 */

export interface PictureVerdict {
  ok: boolean;
  samePrint: boolean;
  /** The same colours and shades as the photo (not recoloured, brightened or faded). */
  sameColours: boolean;
  /** The product's pillow covers shown, in the product's design (when the photo shows them). */
  pillowCovers: boolean;
  extraItems: boolean;
  /** Plain words for the owner (and for the next try's prompt). */
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

/**
 * What the check asks, for this set: image 1 the bedsheet photo, then the pillow cover photo and the
 * comforter photo when the owner added them, and last the AI picture.
 */
export function checkPrompt(p: SetPieces = {}): string {
  const img = pieceImages(p);
  const pic = img.count + 1;
  const pillowFrom = img.pillow ? `image ${img.pillow} (the real pillow cover photo)` : 'image 1';
  return [
    `You are the strict quality check for a bed-linen shop. Image 1 is the real bedsheet photo of the product.${img.pillow ? ` Image ${img.pillow} is the real photo of its pillow cover.` : ''}${img.comforter ? ` Image ${img.comforter} is the real photo of its comforter.` : ''} Image ${pic} is an AI-made picture that must show exactly this set: shoppers buy from it, so any difference is a failure.`,
    'Answer only with JSON: {"samePrint": true|false, "sameColours": true|false, "pillowCovers": true|false, "extraItems": true|false, "reason": "one short sentence"}.',
    `samePrint: true only if, in image ${pic}, the bedsheet carries the same printed design as image 1${img.comforter ? `, the comforter the same design as image ${img.comforter}` : ''} and the pillow covers the same design as ${pillowFrom}: the same motifs, arrangement and print scale (camera angle, light and folds may differ). False if any pattern is different, redrawn, simplified, invented, mirrored into another layout, or a piece shows another piece's design.`,
    `sameColours: true only if the fabric colours and shades in image ${pic} are the same as in the real photos. False if any colour is changed, recoloured, much brighter, more saturated or faded.`,
    img.pillow
      ? `pillowCovers: true only if image ${pic} clearly shows the pillow covers, in the same design and colours as ${pillowFrom}. False if they are missing, hidden, plain, or in another design.`
      : `pillowCovers: if image 1 shows pillow covers, true only if image ${pic} also clearly shows the pillow covers, in the same design and colours as in image 1. False if they are missing, hidden, plain, or in another design. If image 1 shows no pillow covers, true.`,
    img.comforter
      ? `extraItems: true if image ${pic} shows any bedding that is not this set: another duvet, quilt, blanket, throw, bed runner, decorative cushions, or any sheet, pillow cover or comforter in another design or colour.`
      : `extraItems: true if image ${pic} shows any bedding that is not the product: a comforter, duvet, quilt, blanket, throw, bed runner, decorative cushions, or any sheet or pillow cover in another design or colour (this set has no comforter).`,
    'If you are not sure about any of these, answer the failing value.',
    'reason: what is wrong, in plain words for the shop owner (or "matches" when everything is fine).',
  ].join('\n');
}

/** The check for a set with only its bedsheet photo. */
export const CHECK_PROMPT = checkPrompt();

export function parseVerdict(text: string): PictureVerdict | null {
  const body = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const flags = ['samePrint', 'sameColours', 'pillowCovers', 'extraItems'] as const;
    // Every answer must be there: a verdict with one missing is no verdict (not checked, never added by itself).
    if (flags.some((f) => typeof o[f] !== 'boolean')) return null;
    const v = { samePrint: o.samePrint as boolean, sameColours: o.sameColours as boolean, pillowCovers: o.pillowCovers as boolean, extraItems: o.extraItems as boolean };
    const reason = typeof o.reason === 'string' ? o.reason.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const ok = v.samePrint && v.sameColours && v.pillowCovers && !v.extraItems;
    const why = !v.samePrint ? 'the design does not match the product' : !v.sameColours ? 'the colours do not match the product' : !v.pillowCovers ? 'the product’s pillow covers are missing or different' : 'other bedding was added';
    return { ok, ...v, reason: ok ? 'matches' : reason && !/^matches\.?$/i.test(reason) ? reason : why };
  } catch {
    return null;
  }
}

export async function checkPicture(key: string, photos: Array<{ mime: string; bytes: Buffer }>, picture: { mime: string; bytes: Buffer }, pieces: SetPieces = {}): Promise<PictureVerdict | null> {
  if (!key) return null;
  try {
    const model = await checkModel(key);
    const inline = (img: { mime: string; bytes: Buffer }) => ({ inlineData: { mimeType: img.mime, data: img.bytes.toString('base64') } });
    const data = await generateContent(
      key,
      model,
      { contents: [{ role: 'user', parts: [{ text: checkPrompt(pieces) }, ...photos.map(inline), inline(picture)] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } },
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
