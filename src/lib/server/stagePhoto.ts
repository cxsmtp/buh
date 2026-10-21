import { type AiProvider, type StagedPhoto } from '@/types';
import { FAL_KEY, FAL_KEY_HINT, OPENAI_KEY, OPENAI_KEY_HINT, PROVIDER_INFO, type PictureProvider } from '@/lib/pictureProviders';
import { STAGING_EXTRA_MAX, STAGING_SCENE_MAX, STYLE_MAX, STYLE_SIDE_MAX, angleName, lookOf, oneLine, splitAngles, stagingPrompt, usesReferences, type StagingContext, type StagingScene } from '@/lib/staging';
import { audit } from './audit';
import { getDb } from './db';
import { PICTURE_MODULES, modelOk, pictureKey, pictureModel, picturesProviderOf, providerName } from './pictures';
import { HttpError } from './http';
import { parseImageDataUrl } from './imageInput';
import { IMAGE_NAME, cleanImage, deleteImage, readImage, saveImageBytes } from './images';
import { logEvent } from './log';
import { getProduct, updateProduct } from './products';
import { rateLimit } from './rateLimit';
import { getSettings, withStoredSecrets } from './settings';
import { forgetStaged, recordStaged, stagedRecords } from './stagedPhotos';

export { stagingPrompt, type StagingContext };

/**
 * AI pictures (the Picture studio in Inventory, and the product editor's Photos step): one of the
 * product's photos goes to Google Gemini (an image model, the owner's own key from Settings → AI
 * pictures) with a prompt that keeps the product exactly as photographed and changes only the
 * setting around it: one of the owner's scenes, the owner's look and mood, then the fixed rules
 * (src/lib/staging.ts). The picture that comes back is checked (a whole PNG, JPEG or WebP, size and
 * pixel limits), its metadata is taken out except its AI provenance (C2PA, XMP DigitalSourceType:
 * kept, or added when missing), and it is stored as a NEW photo, recorded as styled
 * (src/lib/server/stagedPhotos.ts). The original is never touched. The owner looks at both side by
 * side and adds it to the product, or discards it.
 *
 * - One press makes the default trio (or up to 4 chosen scenes), one request each: each picture is
 *   checked, stored and audited on its own, and one failing loses none of the others.
 * - The prompt can carry the product's own words (name, motif, colours, design) so the scene suits
 *   it; the owner can reword the scene for one picture and add a note; the fixed rules always come
 *   after them.
 * - 30 pictures an hour per admin (each one is a paid call on the owner's Google account).
 * - Each one is in the audit log (scene, model, sizes; never image data, never the key).
 */

export const STAGE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };
const LIMIT_MESSAGE = 'That is 30 styled pictures this hour. Please wait a while before the next ones.';
/** The photo sent: at most 4 MB (the shop's own uploads are at most 3 MB). */
export const SOURCE_MAX_BYTES = 4 * 1024 * 1024;
/** The picture Gemini sends back (a 1K picture is 1–2 MB). */
export const RESULT_MAX_BYTES = 10 * 1024 * 1024;
const ASPECTS = new Set(['4:5', '1:1']);
const BODY_FIELDS = new Set(['imageId', 'image', 'preset', 'angle', 'sameRoom', 'extra', 'aspect', 'scene', 'context', 'useReferences']);
/** Where the owner fixes the key or the model. */
export const PICTURES_PLACE = 'Settings → AI pictures';

/** The owner's extra words: plain text, one line, at most 200 characters. */
export function cleanExtra(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'Extra words must be text.');
  const s = oneLine(v);
  if (s.length > STAGING_EXTRA_MAX) throw new HttpError(400, `Extra words: at most ${STAGING_EXTRA_MAX} characters.`);
  return s;
}

/** The owner's wording of the scene for one picture: plain text, one line, at most 400 characters ('' = the scene's). */
export function cleanScene(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, 'The scene must be text.');
  const s = oneLine(v);
  if (s.length > STAGING_SCENE_MAX) throw new HttpError(400, `Scene: at most ${STAGING_SCENE_MAX} characters.`);
  return s;
}

/** The product's words, allow-listed and cut to size (anything else dropped). */
export function cleanContext(v: unknown): StagingContext {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const cut = (x: unknown, max: number) => (typeof x === 'string' ? oneLine(x).slice(0, max).trim() : '');
  const out: StagingContext = {};
  const title = cut(o.title, 80);
  if (title) out.title = title;
  const motif = cut(o.motif, 80);
  if (motif) out.motif = motif;
  const colors = (Array.isArray(o.colors) ? o.colors : []).map((c) => cut(c, 40)).filter(Boolean).slice(0, 6);
  if (colors.length) out.colors = colors;
  const design = cut(o.design, 300);
  if (design) out.design = design;
  return out;
}

/** One of the owner's scenes (Settings → AI pictures) by its id. */
export function sceneById(id: unknown): StagingScene | undefined {
  return typeof id === 'string' ? getSettings('aiPictures').scenes.find((s) => s.id === id) : undefined;
}

export interface StageResult {
  url: string;
  staged: StagedPhoto;
  model: string;
  provider: PictureProvider;
  /** How many style photos went with it. */
  references: number;
  width: number;
  height: number;
}

export interface StagingStatus {
  ready: boolean;
  /**
   * no_provider: no picture service chosen (and no key for one); no_key: the chosen service has no
   * key; no_model: the key is there, choose an image model (Test).
   */
  reason: 'no_provider' | 'no_key' | 'no_model' | null;
  /** The service that makes pictures ('' until one is chosen or a key is saved). */
  provider: PictureProvider | '';
  providerName: string;
  model: string;
  /** Who writes the text (pictures are made by the picture service, whoever writes). */
  writer: AiProvider;
  /** The owner's scenes, in order, and the ones made with one press. */
  scenes: StagingScene[];
  defaultSet: string[];
  /** The style photos (addresses) and whether they are sent. */
  references: string[];
  useReferences: boolean;
  /**
   * The numbered angles in the look and mood (Settings → AI pictures), one picture each, in order:
   * when there are any, one press makes these instead of the scenes.
   */
  angles: Array<{ n: number; name: string }>;
  /** Where AI pictures go among the product's photos. */
  photoOrder: 'styled-first' | 'photo-first';
}

/** For the studio and the editor: ready, or why not, who makes pictures, and the scenes to offer. */
export function stagingStatus(): StagingStatus {
  const ai = getSettings('ai');
  const pictures = getSettings('aiPictures');
  const provider = picturesProviderOf(ai);
  const model = provider ? pictureModel(ai, provider) : '';
  const reason = !provider ? 'no_provider' : !pictureKey(ai, provider) ? 'no_key' : !modelOk(provider, model) ? 'no_model' : null;
  return {
    ready: !reason,
    reason,
    provider,
    providerName: provider ? providerName(provider) : '',
    model,
    writer: ai.provider,
    scenes: pictures.scenes,
    defaultSet: pictures.defaultSet,
    references: pictures.references ?? [],
    useReferences: pictures.useReferences !== false,
    angles: anglesOf(pictures).map((a, i) => ({ n: i + 1, name: angleName(a, i) })),
    photoOrder: pictures.photoOrder ?? 'styled-first',
  };
}

/** The numbered angles in the owner's look and mood ([] when it has none). */
export function anglesOf(settings: { look?: string }): string[] {
  return settings.look?.trim() ? splitAngles(settings.look).angles : [];
}

/** The style photos to send, in the owner's order, each checked (metadata out) and within the size cap. */
function referenceImages(urls: string[], max: number): Array<{ mime: string; bytes: Buffer }> {
  const out: Array<{ mime: string; bytes: Buffer }> = [];
  for (const u of urls.slice(0, Math.max(0, max))) {
    const img = readImage(u.replace(/^\/api\/images\//, ''));
    const clean = img ? cleanImage(img.bytes, STYLE_MAX) : null;
    if (clean) out.push({ mime: clean.mime, bytes: clean.bytes });
  }
  return out;
}

/** POST /api/admin/products/stage-photo, after the admin check and the size-capped read. */
export async function stagePhoto(body: Record<string, unknown>, actor: string): Promise<StageResult> {
  for (const k of Object.keys(body)) if (!BODY_FIELDS.has(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const ai = getSettings('ai');
  const settings = getSettings('aiPictures');
  const provider = picturesProviderOf(ai);
  if (!provider) throw new HttpError(409, `Pictures need a picture service: choose Google Gemini, OpenAI or fal.ai in ${PICTURES_PLACE} and add its key (for Gemini: aistudio.google.com/apikey → Create API key).`, {}, { code: 'staging_off', reason: 'no_provider' });
  const info = PROVIDER_INFO[provider];
  const key = pictureKey(ai, provider);
  if (!key) throw new HttpError(409, `Pictures need a ${info.name} key: add one in ${PICTURES_PLACE} (${info.keyUrlLabel}).`, {}, { code: 'staging_off', reason: 'no_key' });
  const model = pictureModel(ai, provider);
  if (!modelOk(provider, model)) throw new HttpError(409, `Your ${info.name} key is saved: now choose an image model (press Test in ${PICTURES_PLACE}).`, {}, { code: 'staging_off', reason: 'no_model' });
  if (body.useReferences !== undefined && typeof body.useReferences !== 'boolean') throw new HttpError(400, 'Style photos: on or off.');
  // One of the numbered angles in the owner's prompt, or one of the scenes.
  let angle = '';
  let preset: StagingScene | undefined;
  if (body.angle !== undefined) {
    const angles = anglesOf(settings);
    const n = Number(body.angle);
    if (!Number.isInteger(n) || n < 1 || n > angles.length) throw new HttpError(400, 'That angle is not in your prompt any more (Settings → AI pictures).');
    angle = angles[n - 1];
    preset = { id: `angle-${n}`, name: angleName(angle, n - 1), scene: angle };
  } else {
    preset = sceneById(body.preset);
    if (!preset) throw new HttpError(400, 'Choose a scene.');
  }
  const extra = cleanExtra(body.extra);
  const shot = angle || cleanScene(body.scene) || preset.scene;
  const context = cleanContext(body.context);
  const aspect = body.aspect === undefined ? '4:5' : String(body.aspect);
  if (!ASPECTS.has(aspect)) throw new HttpError(400, 'Shape: 4:5 or 1:1.');
  const sameRoom = body.sameRoom === undefined || body.sameRoom === null || body.sameRoom === '' ? '' : stagedName(body.sameRoom);

  // The photo: one of the product's stored photos, or one just taken (a data URL).
  let source = '';
  let photo: { mime: string; bytes: Buffer };
  if (typeof body.imageId === 'string') {
    const name = body.imageId.replace(/^\/api\/images\//, '');
    if (!IMAGE_NAME.test(name)) throw new HttpError(400, 'Choose one of the product’s photos.');
    const img = readImage(name);
    if (!img) throw new HttpError(404, 'That photo is no longer stored. Upload it again.');
    if (img.bytes.length > SOURCE_MAX_BYTES) throw new HttpError(413, 'The photo is too large (at most 4 MB).');
    source = name;
    photo = img;
  } else if (body.image !== undefined) {
    photo = parseImageDataUrl(body.image, SOURCE_MAX_BYTES);
  } else {
    throw new HttpError(400, 'Choose a photo first (PNG, JPEG or WebP).');
  }
  return makePicture({ photo, source, preset, shot, angle, extra, context, aspect: aspect as '4:5' | '1:1', useReferences: body.useReferences as boolean | undefined, sameRoom }, actor);
}

/** A styled photo this feature made (for "same room as"), by its address; anything else is refused. */
function stagedName(v: unknown): string {
  const name = typeof v === 'string' ? v.replace(/^\/api\/images\//, '') : '';
  if (!IMAGE_NAME.test(name) || !(name in stagedRecords())) throw new HttpError(400, 'The first picture of this set is no longer stored: make the set again.');
  return name;
}

export interface PictureJob {
  photo: { mime: string; bytes: Buffer };
  /** The product photo's stored name ('' for one just taken). */
  source: string;
  preset: StagingScene;
  /** The scene (or the owner's wording of it), or the angle. */
  shot: string;
  /** One of the numbered angles in the owner's prompt ('' for a scene). */
  angle: string;
  extra: string;
  context: StagingContext;
  aspect: '4:5' | '1:1';
  useReferences?: boolean;
  /** A styled photo already made of this product (the first angle): sent so the room stays the same. */
  sameRoom: string;
}

/**
 * One picture: the service, key and model checked, sent, the answer checked, stored and recorded as
 * styled, audited. Used by the studio (stagePhoto) and by automatic pictures for new products
 * (src/lib/server/autoAdd.ts).
 */
export async function makePicture(job: PictureJob, actor: string): Promise<StageResult> {
  const ai = getSettings('ai');
  const settings = getSettings('aiPictures');
  const provider = picturesProviderOf(ai);
  if (!provider) throw new HttpError(409, `Pictures need a picture service: choose Google Gemini, OpenAI or fal.ai in ${PICTURES_PLACE} and add its key.`, {}, { code: 'staging_off', reason: 'no_provider' });
  const key = pictureKey(ai, provider);
  const model = pictureModel(ai, provider);
  if (!key || !modelOk(provider, model)) throw new HttpError(409, `Pictures are not set up: ${PICTURES_PLACE}.`, {}, { code: 'staging_off', reason: key ? 'no_model' : 'no_key' });
  const { photo, source, preset, shot, angle, extra, context, aspect } = job;
  // Numbered angles never go in a request as a list (the service would put them all in one
  // picture): the rest of the owner's prompt (the room, the styling) goes with every picture.
  const look = splitAngles(lookOf(settings)).shared || lookOf(settings);
  const maker = PICTURE_MODULES[provider];
  const room = job.sameRoom ? readImage(job.sameRoom) : null;
  const roomImage = room ? cleanImage(room.bytes, RESULT_MAX_BYTES) : null;
  const sameRoom = roomImage ? [{ mime: roomImage.mime, bytes: roomImage.bytes }] : [];
  // The style photos: after the product photo (and the same-room picture), as many as the model takes.
  const styles = usesReferences(settings, preset, job.useReferences) ? referenceImages(settings.references, maker.maxImages(model) - 1 - sameRoom.length) : [];
  const references = [...sameRoom, ...styles];

  const r = rateLimit(`ai-stage:${actor}`, STAGE_LIMIT.max, STAGE_LIMIT.windowMs);
  if (!r.ok) throw new HttpError(429, LIMIT_MESSAGE, { 'Retry-After': String(r.retryAfterSec) }, { retryAfterSec: r.retryAfterSec });

  const raw = await maker.edit({
    key,
    model,
    product: photo,
    references,
    prompt: stagingPrompt(shot, extra, aspect, context, look, references.length, { angle, sameRoom: sameRoom.length > 0 }),
    aspect,
    again: () => {
      // A second paid call for the same picture counts against the hour's limit too.
      const again = rateLimit(`ai-stage:${actor}`, STAGE_LIMIT.max, STAGE_LIMIT.windowMs);
      if (!again.ok) throw new HttpError(429, LIMIT_MESSAGE, { 'Retry-After': String(again.retryAfterSec) }, { retryAfterSec: again.retryAfterSec });
    },
  });
  // Checked whoever made it: a whole PNG, JPEG or WebP within the limits, metadata out, and marked
  // as made with AI (kept from the service, or added).
  const clean = cleanImage(raw, RESULT_MAX_BYTES, { keepProvenance: true });
  if (!clean) {
    logEvent('warn', 'pictures_bad_image', { provider, length: raw.length });
    throw new HttpError(502, `${maker.name}’s picture could not be used (not a whole PNG, JPEG or WebP, or too large). Nothing was saved; please try again.`, {}, { code: 'ai_bad_image' });
  }

  // Stored by its SHA-256: a picture already stored (the photo sent, or any other) is not a new
  // styled photo, and must never be marked styled or deleted by Discard.
  const { url, created } = saveImageBytes(clean.bytes, clean.mime);
  const name = url.slice('/api/images/'.length);
  if (!created || name === source) {
    logEvent('warn', 'gemini_stage_same_image', { created, provider });
    throw new HttpError(502, `${maker.name} returned the same photo; try another scene.`, {}, { code: 'ai_same_image' });
  }
  const at = new Date().toISOString();
  recordStaged(name, { source, preset: preset.id, at });
  audit('product.photo_staged', { by: actor, provider, model, preset: preset.id, source: source || 'upload', sourceBytes: photo.bytes.length, references: references.length, sameRoom: sameRoom.length > 0, result: name, resultBytes: clean.bytes.length, width: clean.width, height: clean.height, extraLength: extra.length, sceneEdited: !angle && shot !== preset.scene, lookDefault: !settings.look, context: Object.keys(context), aspect });
  return { url, staged: { staged: true, source, preset: preset.id, at }, model, provider, references: references.length, width: clean.width, height: clean.height };
}

/**
 * Settings → AI pictures → style photos: one photo (a data URL, shrunk to about 1,024 px in the hub)
 * checked as every image is, its metadata (EXIF, GPS, comments) taken out, at most 1.5 MB and
 * 2,048 px, stored by its hash. It is used once the owner saves it in the list.
 */
export function uploadStylePhoto(body: Record<string, unknown>, actor: string): { url: string; width: number; height: number } {
  for (const k of Object.keys(body)) if (k !== 'image') throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const { bytes } = parseImageDataUrl(body.image, STYLE_MAX);
  const clean = cleanImage(bytes, STYLE_MAX);
  if (!clean) throw new HttpError(400, 'That photo could not be read (PNG, JPEG or WebP, at least 64 px).');
  if (clean.width > STYLE_SIDE_MAX || clean.height > STYLE_SIDE_MAX) throw new HttpError(413, `The photo is too large (at most ${STYLE_SIDE_MAX} px): it is made smaller on the way; try again.`);
  const { url } = saveImageBytes(clean.bytes, clean.mime);
  audit('settings.ai_style_photo_uploaded', { by: actor, result: url.slice('/api/images/'.length), bytes: clean.bytes.length, width: clean.width, height: clean.height });
  return { url, width: clean.width, height: clean.height };
}

/**
 * "Discard": a styled photo that no product (and no editor draft) uses is deleted. Only photos this
 * feature made can be deleted here; anything else is refused.
 */
export function discardStagedPhoto(body: Record<string, unknown>, actor: string): { deleted: boolean } {
  for (const k of Object.keys(body)) if (k !== 'url') throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  const name = typeof body.url === 'string' ? body.url.replace(/^\/api\/images\//, '') : '';
  if (!IMAGE_NAME.test(name)) throw new HttpError(400, 'Which styled photo?');
  // Only a photo this feature stored as new (it is recorded only then, never a picture already stored).
  if (!(name in stagedRecords())) throw new HttpError(404, 'That is not a styled photo.');
  const db = getDb();
  // Nothing may use it: a product, a draft, an order line (its picture), a setting (the logo…) or a
  // saved earlier version of a setting.
  const used = ['products', 'product_drafts', 'orders', 'settings', 'settings_history'].some((table) => (db.prepare(`SELECT COUNT(*) FROM ${table} WHERE instr(data, ?) > 0`).pluck().get(name) as number) > 0);
  if (used) throw new HttpError(409, 'That styled photo is in use (on a product, its draft, an order or a setting): remove it there instead.');
  const deleted = deleteImage(name);
  forgetStaged(name);
  audit('product.photo_staged_discarded', { by: actor, result: name });
  return { deleted };
}

/** A product holds at most this many photos (the cover and 7 more), as the editor does. */
export const PRODUCT_MAX_PHOTOS = 8;

const nameOf = (url: string) => url.replace(/^\/api\/images\//, '');

/**
 * A product's photos with AI pictures added. "styled-first" (the default, Settings → AI pictures):
 * every AI picture first, the ones already there then the new ones in the order made, and the
 * owner's own photos last, so a shopper first sees the product made up in a room and the real photo
 * at the end. "photo-first": each new one right after the photo it was made from (the owner's
 * photo stays the cover). Photos already there are never repeated; at most 8 in all, and what does
 * not fit comes back in "full".
 */
export function withStyledPhotos(photos: string[], urls: string[], made: Record<string, { source: string }>, order: 'styled-first' | 'photo-first'): { photos: string[]; added: string[]; full: string[] } {
  const out = [...photos];
  const added: string[] = [];
  const full: string[] = [];
  const fresh = [...new Set(urls)].filter((u) => !out.includes(u));
  if (order === 'styled-first') {
    const styled = out.filter((u) => nameOf(u) in made);
    const own = out.filter((u) => !(nameOf(u) in made));
    for (const u of fresh) {
      if (styled.length + own.length >= PRODUCT_MAX_PHOTOS) full.push(u);
      else {
        styled.push(u);
        added.push(u);
      }
    }
    return { photos: [...styled, ...own], added, full };
  }
  /** Where the next one from each source goes: right after the source, in the order sent (as the editor does). */
  const next = new Map<string, number>();
  for (const url of fresh) {
    if (out.length >= PRODUCT_MAX_PHOTOS) {
      full.push(url);
      continue;
    }
    const source = made[nameOf(url)]?.source ?? '';
    const from = source ? out.indexOf(`/api/images/${source}`) : -1;
    // Not made from one of its photos (an upload): at the end.
    let at = from < 0 ? out.length : (next.get(source) ?? from + 1);
    at = Math.min(at, out.length);
    out.splice(at, 0, url);
    if (from >= 0) next.set(source, at + 1);
    added.push(url);
  }
  return { photos: out, added, full };
}

/**
 * The Picture studio's "Add to gallery" / "Add all": styled photos this feature made, added to an
 * existing product where Settings → AI pictures puts them (first, the owner's photo last, by
 * default: withStyledPhotos). Safe to send twice: a photo the product already has is not added
 * again. Anything that is not a styled photo is refused; what does not fit (8 photos) is said, not
 * added. Saved through updateProduct (validated, marked styled by the server, audited before it is saved).
 */
export function addStyledPhotos(productId: string, body: Record<string, unknown>, actor: string) {
  for (const k of Object.keys(body)) if (k !== 'urls') throw new HttpError(400, `Unexpected field: ${k.slice(0, 30)}.`);
  if (!Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > PRODUCT_MAX_PHOTOS) throw new HttpError(400, 'Which styled photos?');
  const made = stagedRecords();
  const names = body.urls.map((u) => (typeof u === 'string' ? nameOf(u) : ''));
  for (const n of names) {
    if (!IMAGE_NAME.test(n)) throw new HttpError(400, 'Which styled photos?');
    if (!(n in made)) throw new HttpError(404, 'That is not a styled photo (make it again).');
    if (!readImage(n)) throw new HttpError(404, 'That styled photo is no longer stored (make it again).');
  }
  return saveStyledPhotos(productId, names.map((n) => `/api/images/${n}`), actor);
}

/** The styled photos (already checked) saved on the product, in the owner's order. */
export function saveStyledPhotos(productId: string, urls: string[], actor: string) {
  const product = getProduct(productId);
  if (!product) throw new HttpError(404, 'Product not found.');
  const current = [product.featuredImage, ...(product.galleryImages ?? [])].filter(Boolean);
  const { photos, added, full } = withStyledPhotos(current, urls, stagedRecords(), getSettings('aiPictures').photoOrder ?? 'styled-first');
  if (!added.length) return { product, added, full };
  const saved = updateProduct(productId, { featuredImage: photos[0], galleryImages: photos.slice(1) }, actor);
  audit('product.photo_staged_added', { by: actor, productId, added: added.map(nameOf), notAddedFull: full.length });
  return { product: saved, added, full };
}

const PICTURE_TEST_LIMIT = { max: 10, windowMs: 10 * 60 * 1000 };

/**
 * Settings → AI pictures → Test for OpenAI or fal.ai: the image models the key (typed, or the saved
 * one) can use. A refused key says so in plain words (never the key).
 */
export async function testPictures(provider: 'openai' | 'fal', input: Record<string, unknown>, actor: string): Promise<{ ok: true; models: { image: string[]; suggested: { image: string } } }> {
  const field = provider === 'openai' ? 'openaiApiKey' : 'falApiKey';
  const typed = withStoredSecrets('ai', { [field]: input[field] }) as Record<string, unknown>;
  const key = typeof typed[field] === 'string' ? (typed[field] as string).trim() : '';
  const info = PROVIDER_INFO[provider];
  if (!key) throw new HttpError(400, `Type your ${info.name} key first (${info.keyUrlLabel}).`, {}, { code: 'ai_off' });
  if (!(provider === 'openai' ? OPENAI_KEY : FAL_KEY).test(key)) throw new HttpError(400, provider === 'openai' ? OPENAI_KEY_HINT : FAL_KEY_HINT);
  const r = rateLimit(`ai-test:${actor}`, PICTURE_TEST_LIMIT.max, PICTURE_TEST_LIMIT.windowMs);
  if (!r.ok) throw new HttpError(429, 'Too many tests. Please wait a few minutes.', { 'Retry-After': String(r.retryAfterSec) });
  const { models, suggested } = await PICTURE_MODULES[provider].listModels(key);
  audit('settings.ai_tested', { by: actor, provider, ok: true, imageModels: models.length });
  return { ok: true, models: { image: models, suggested: { image: suggested } } };
}
