/**
 * Google Gemini (src/lib/server/gemini.ts) with Google replaced by a stand-in:
 * - Settings → AI writing: the provider choice, the Gemini key (write-only, ••••last4, never in
 *   history, backups or logs), model ids checked against a strict pattern;
 * - "Write from photo" with Gemini: the request (fixed host and path, the key only in the
 *   x-goog-api-key header, JSON asked for, the same rules), the answer clamped as with Claude,
 *   errors readable without the key;
 * - Test: Google's model list parsed into writing and image models;
 * - "Style in a bedroom" (src/lib/server/stagePhoto.ts): the prompt, a NEW photo saved and marked
 *   styled with the original untouched, metadata stripped, a bad picture refused, 10 an hour,
 *   the audit entry, Discard, products marked by the server, backup and restore;
 * - the shop's catalogue: the "Styled image" mark only while the label setting is on.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';
import { bedroomPng, chunk, makePng } from './fixtures/png.mjs';

const dir = tempDataDir();
const settings = await import('@/lib/server/settings');
const ai = await import('@/lib/server/aiWriting');
const gemini = await import('@/lib/server/gemini');
const stage = await import('@/lib/server/stagePhoto');
const products = await import('@/lib/server/products');
const { saveImageDataUrl, readImage } = await import('@/lib/server/images');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { redact } = await import('@/lib/server/log');
const { getDb } = await import('@/lib/server/db');
const productsRoute = await import('@/app/api/products/route');

const KEY = 'AIzaSyTESTKEY-abcdefghijklmnopqrstu-Q9xZ';
const ANTHROPIC = 'sk-ant-api03-TESTKEY-abcdefghijklmnopqrstuvwxyz0123456789-WXYZ';

const PHOTO = makePng(96, 120, (x, y) => ((x + y) % 24 < 12 ? [47, 63, 122] : [246, 244, 238]));
const PHOTO_URL = `data:image/png;base64,${PHOTO.toString('base64')}`;
/** What the stand-in sends back: a real PNG carrying metadata the shop must strip. */
const STAGED = bedroomPng(160, 200, [chunk('tEXt', Buffer.from('Comment\0made by a camera at 25.2,55.3', 'latin1')), chunk('eXIf', Buffer.from('MM\0*private'))]);

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
let sent: Sent[] = [];
let answer: (req: Sent) => { status: number; data: unknown } = () => ({ status: 200, data: null });

const textReply = (obj: unknown, finishReason = 'STOP') => ({ status: 200, data: { candidates: [{ content: { role: 'model', parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason }] } });
const imageReply = (bytes: Buffer, mimeType = 'image/png') => ({ status: 200, data: { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType, data: bytes.toString('base64') } }] }, finishReason: 'STOP' }] } });
const MODELS = {
  models: [
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-nano-banana-2.1', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
    { name: 'models/gemini-EVIL/../x', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
  ],
};
const SUGGESTION = { title: 'Indigo Garden Hand Block Set', shortDescription: 'Hand-stamped indigo florals on a soft white ground.', description: 'A quiet garden of indigo blooms.\n\nEach motif is stamped by hand.', colors: [{ name: 'Indigo', hex: '#3F4A8A' }, 'white'], weave: 'percale', motif: 'Hand block floral' };

async function logsOf<T>(fn: () => Promise<T>): Promise<{ result: T | Error; logs: string }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) console[k] = (...a: unknown[]) => lines.push(a.map(String).join(' '));
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } catch (err) {
    return { result: err as Error, logs: lines.join('\n') };
  } finally {
    Object.assign(console, saved);
  }
}
const auditLog = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('');
const auditEntry = (action: string) =>
  auditLog()
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .reverse()
    .find((e) => e.action === action);
const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? -1);

beforeEach(async () => {
  _clearAllRateLimits();
  sent = [];
  answer = (req) => (req.method === 'GET' ? { status: 200, data: MODELS } : req.path.includes('image') ? imageReply(STAGED) : textReply(SUGGESTION));
  gemini._setGeminiTransport(async (req) => {
    const s: Sent = { method: req.method, path: req.path, headers: req.headers, body: req.body ? JSON.parse(req.body) : null };
    sent.push(s);
    const a = answer(s);
    return { ...a, ok: a.status >= 200 && a.status < 300 };
  });
  await settings.updateSettings('ai', { provider: 'gemini', geminiApiKey: KEY, geminiModel: 'gemini-3.1-pro', geminiImageModel: 'gemini-3.1-flash-image', enabled: true, labelStyledPhotos: true });
});
afterEach(() => gemini._setGeminiTransport(null));

// ── settings ────────────────────────────────────────────────────────────────

test('Settings: Anthropic by default; the Gemini key is write-only (••••last4), checked by shape, and needed to switch Gemini writing on', async () => {
  const d = (await import('@/data/catalogDefaults')).DEFAULT_AI;
  assert.equal(d.provider, 'anthropic');
  assert.equal(d.labelStyledPhotos, true, 'styled photos are labelled by default');
  assert.equal(d.geminiImageModel, 'gemini-3.1-flash-image');
  assert.equal(d.geminiModel, '', 'no writing model until Test lists them');
  const view = settings.adminView('ai');
  assert.equal(view.value.geminiApiKey, '');
  assert.equal(view.secretsSet.geminiApiKey, true);
  assert.equal(view.secretsHint?.geminiApiKey, '••••Q9xZ');
  assert.ok(!JSON.stringify(view).includes('TESTKEY'));
  await assert.rejects(settings.updateSettings('ai', { geminiApiKey: 'sk-not-google' }), /starts with AIza/);
  await assert.rejects(settings.updateSettings('ai', { provider: 'openai' }), /Anthropic or Gemini/);
  for (const bad of ['gemini-3/../../x', 'GEMINI-3', 'gpt-4o', `gemini-${'a'.repeat(61)}`, 'gemini-3?key=x', 'gemini-3 pro']) {
    await assert.rejects(settings.updateSettings('ai', { geminiModel: bad }), /press Test/, bad);
    await assert.rejects(settings.updateSettings('ai', { geminiImageModel: bad }), /press Test/, bad);
  }
  // An autosave without the key keeps it.
  await settings.updateSettings('ai', { geminiModel: 'gemini-2.5-pro', geminiApiKey: '' }, { auto: true });
  assert.equal(settings.getSettings('ai').geminiApiKey, KEY);
  // Clearing the chosen writer's key switches writing off; switching on needs it again.
  await settings.updateSettings('ai', { geminiApiKey: null });
  assert.equal(settings.getSettings('ai').enabled, false);
  await assert.rejects(settings.updateSettings('ai', { enabled: true }), /Add your Gemini API key/);
  // Anthropic as the writer with only a Gemini key: can't be switched on either.
  await settings.updateSettings('ai', { geminiApiKey: KEY, provider: 'anthropic', anthropicApiKey: null });
  await assert.rejects(settings.updateSettings('ai', { enabled: true }), /Add your Anthropic API key/);
  // Never in settings history.
  const history = getDb().prepare("SELECT data FROM settings_history WHERE key = 'ai'").pluck().all() as string[];
  assert.ok(history.length > 0);
  assert.ok(!history.join('').includes('TESTKEY'), 'history never keeps the key');
  // Logs mask any Google key.
  assert.ok(!JSON.stringify(redact({ note: `failed with ${KEY}` })).includes('TESTKEY'));
  assert.ok(!JSON.stringify(redact({ url: `https://x.test/?key=${KEY}` })).includes('TESTKEY'));
});

// ── writing ────────────────────────────────────────────────────────────────

test('Gemini writing: fixed host and path, the key only in x-goog-api-key, JSON asked for, the same rules and the photo as inlineData', async () => {
  assert.equal(gemini.GEMINI_BASE, 'https://generativelanguage.googleapis.com/v1beta');
  const s = await ai.describeProduct({ image: PHOTO_URL, hints: { category: 'bedsheets', material: '100% Cotton', threadCount: 300 } }, 'owner@shop.test');
  assert.equal(sent.length, 1);
  const { method, path: p, headers, body } = sent[0];
  assert.equal(method, 'POST');
  assert.equal(p, '/models/gemini-3.1-pro:generateContent');
  assert.equal(headers['x-goog-api-key'], KEY);
  assert.equal(headers['content-type'], 'application/json');
  assert.ok(!p.includes('key='), 'never in the address');
  assert.ok(!JSON.stringify(body).includes(KEY), 'never in the body');
  const b = body as { systemInstruction: { parts: Array<{ text: string }> }; contents: Array<{ parts: Array<Record<string, unknown>> }>; generationConfig: Record<string, unknown> };
  assert.match(b.systemInstruction.parts[0].text, /Never state a thread count, material/);
  assert.match(b.systemInstruction.parts[0].text, /Describe only what is visible/);
  assert.deepEqual(b.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: PHOTO.toString('base64') } });
  assert.match(String(b.contents[0].parts[1].text), /"material":"100% Cotton"/);
  assert.equal(b.generationConfig.responseMimeType, 'application/json');
  assert.equal(s.title, SUGGESTION.title);
  assert.equal(s.weave, 'Percale');
  assert.deepEqual(s.colors, [{ name: 'Indigo', hex: '#3f4a8a' }, { name: 'White', hex: '#ffffff' }]);
  assert.equal(s.provider, 'gemini');
  assert.equal(s.model, 'gemini-3.1-pro');
  const entry = auditEntry('product.ai_described');
  assert.equal(entry.details.provider, 'gemini');
  assert.ok(!auditLog().includes('TESTKEY'));
  assert.deepEqual(ai.aiStatus(), { ready: true, reason: null, provider: 'gemini', model: 'gemini-3.1-pro' });
});

test('Gemini writing: the answer is clamped as with Claude (lengths, markup, emoji, at most 4 colours, unknown weave); thoughts are left out', async () => {
  answer = () => ({
    status: 200,
    data: {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Thinking about {"title": "a thought"}', thought: true },
              {
                text: JSON.stringify({
                  title: `<b>Royal</b> ✨ Mughal Garden ${'Velvet '.repeat(20)}`,
                  shortDescription: `Line one\nline two ${'soft '.repeat(60)}`,
                  description: `${'A long sentence about the print. '.repeat(40)}\n\nSecond.\n\nThird.\n\nFourth paragraph dropped.`,
                  colors: ['Gold', 'Ivory', 'Rose', 'Sage', 'Navy'],
                  weave: 'Waffle',
                  motif: 'paisley\u0007',
                }),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    },
  });
  const s = await ai.describeProduct({ image: PHOTO_URL }, 'o@s.t');
  assert.ok(s.title.length <= 60 && s.title.startsWith('Royal Mughal Garden'), s.title);
  assert.ok(s.shortDescription.length <= 140 && !s.shortDescription.includes('\n'));
  assert.ok(s.description.length <= 900 && !s.description.includes('Fourth'));
  assert.equal(s.colors.length, 4);
  assert.equal(s.weave, null);
  assert.equal(s.motif, 'paisley');
});

test('Gemini writing errors are readable and never carry the key (reply or logs); blocked and cut-off answers; no model chosen', async () => {
  answer = () => ({ status: 400, data: { error: { code: 400, message: `API key not valid. Please pass a valid API key. (${KEY})`, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } });
  const { result, logs } = await logsOf(() => ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'));
  const e = result as unknown as { status: number; message: string; details: Record<string, unknown> };
  assert.equal(e.status, 502);
  assert.match(e.message, /did not accept the Gemini API key/);
  assert.ok(!(JSON.stringify({ m: e.message, d: e.details }) + logs).includes('TESTKEY'));
  answer = () => ({ status: 429, data: { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } } });
  await assert.rejects(ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'), /limit for your Gemini key/);
  answer = () => ({ status: 400, data: { error: { code: 400, message: `Unsupported MIME type ${KEY}`, status: 'INVALID_ARGUMENT' } } });
  const r = await logsOf(() => ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'));
  assert.match((r.result as Error).message, /^Gemini said: Unsupported MIME type/);
  assert.ok(!((r.result as Error).message + r.logs).includes('TESTKEY'));
  answer = () => ({ status: 200, data: { promptFeedback: { blockReason: 'SAFETY' } } });
  await assert.rejects(ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'), /would not describe this photo/);
  answer = () => textReply('{"title": "Half', 'MAX_TOKENS');
  await assert.rejects(ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'), /cut short/);
  gemini._setGeminiTransport(async () => {
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  });
  await assert.rejects(ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'), (err: { status: number }) => err.status === 504);
  // No writing model chosen yet: the owner is sent to Test, nothing is sent.
  await settings.updateSettings('ai', { geminiModel: '' });
  sent = [];
  await assert.rejects(ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'), (err: { status: number; message: string }) => err.status === 409 && /press Test/.test(err.message));
  assert.equal(ai.aiStatus().reason, 'no_model');
  assert.equal(sent.length, 0);
});

// ── models ─────────────────────────────────────────────────────────────────

test('the model list: generateContent models only, ids checked, writing and image models apart, newest Pro suggested, gemini-3.1-flash-image for photos', () => {
  const m = gemini.parseModelList(MODELS);
  assert.deepEqual(m.writing, ['gemini-3.1-pro', 'gemini-3.1-pro-preview', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']);
  assert.ok(m.image.includes('gemini-3.1-flash-image') && m.image.includes('gemini-nano-banana-2.1') && m.image.includes('gemini-2.5-flash-image'));
  assert.ok(!m.image.some((x) => x.startsWith('imagen')) && !m.writing.some((x) => /tts|embedding|image/.test(x)));
  assert.ok(![...m.writing, ...m.image].some((x) => !/^gemini-[a-z0-9.-]{1,60}$/.test(x)), 'bad ids dropped');
  assert.deepEqual(m.suggested, { writing: 'gemini-3.1-pro', image: 'gemini-3.1-flash-image' });
  // Without a Pro: the newest Flash. Without gemini-3.1-flash-image: the newest image model.
  const noPro = gemini.parseModelList({ models: MODELS.models.filter((x) => !/pro|3\.1-flash-image/.test(x.name)) });
  assert.equal(noPro.suggested.writing, 'gemini-3-flash');
  assert.equal(noPro.suggested.image, 'gemini-nano-banana-2.1');
  assert.deepEqual(gemini.parseModelList(null), { writing: [], image: [], suggested: { writing: '', image: 'gemini-3.1-flash-image' } });
  assert.deepEqual(gemini.parseModelList({ models: 'x' }).writing, []);
});

test('Test (Gemini): GET /models with the typed or saved key in the header; a refused key is readable', async () => {
  const r = await ai.testGeminiSettings({}, 'o@s.t');
  assert.equal(sent[0].method, 'GET');
  assert.equal(sent[0].path, '/models?pageSize=1000');
  assert.equal(sent[0].headers['x-goog-api-key'], KEY, 'the saved key');
  assert.ok(!sent[0].path.includes('key'), 'not in the address');
  assert.equal(r.models.suggested.writing, 'gemini-3.1-pro');
  const typed = 'AIzaSyOTHERKEY-abcdefghijklmnopqrstuvwx';
  await ai.testGeminiSettings({ geminiApiKey: typed }, 'o@s.t');
  assert.equal(sent[1].headers['x-goog-api-key'], typed);
  await assert.rejects(ai.testGeminiSettings({ geminiApiKey: 'nope' }, 'o@s.t'), /starts with AIza/);
  answer = () => ({ status: 403, data: { error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' } } });
  await assert.rejects(ai.testGeminiSettings({}, 'o@s.t'), /did not accept the Gemini API key/);
});

// ── Style in a bedroom ─────────────────────────────────────────────────────

test('stage-photo: the request (image model, the photo as inlineData, IMAGE out, 4:5) and a prompt that keeps the product exactly', async () => {
  const original = saveImageDataUrl(PHOTO_URL);
  const name = original.slice('/api/images/'.length);
  await stage.stagePhoto({ imageId: name, preset: 'palm-villa', extra: 'morning light, olive green wall' }, 'owner@shop.test');
  const { path: p, headers, body } = sent[0];
  assert.equal(p, '/models/gemini-3.1-flash-image:generateContent');
  assert.equal(headers['x-goog-api-key'], KEY);
  const b = body as { contents: Array<{ parts: Array<Record<string, unknown>> }>; generationConfig: Record<string, unknown> };
  assert.deepEqual(b.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5', imageSize: '1K' } });
  assert.deepEqual(b.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: PHOTO.toString('base64') } });
  const prompt = String(b.contents[0].parts[0].text);
  for (const rule of [/same pattern and motif/, /same print scale/, /same colours/, /stitching, piping/, /same number of pieces/, /Change only what is around it/, /No text/, /no logos, no watermarks, no people/, /Palm Jumeirah/, /morning light, olive green wall/]) assert.match(prompt, rule);
  assert.ok(!JSON.stringify(body).includes(KEY));
});

test('stage-photo: the picture is saved as a NEW photo marked styled; the original is untouched; metadata is stripped', async () => {
  const original = saveImageDataUrl(PHOTO_URL);
  const name = original.slice('/api/images/'.length);
  const r = await stage.stagePhoto({ imageId: name, preset: 'dubai-master' }, 'owner@shop.test');
  assert.match(r.url, /^\/api\/images\/[a-f0-9]{64}\.png$/);
  assert.notEqual(r.url, original);
  assert.deepEqual(readImage(name)!.bytes, PHOTO, 'the original is unchanged');
  const saved = readImage(r.url.slice('/api/images/'.length))!.bytes;
  assert.ok(!saved.includes(Buffer.from('tEXt')) && !saved.includes(Buffer.from('eXIf')) && !saved.includes(Buffer.from('25.2,55.3')), 'metadata stripped');
  assert.ok(saved.includes(Buffer.from('IDAT')) && saved.length < STAGED.length);
  assert.deepEqual({ ...r.staged, at: '' }, { staged: true, source: name, preset: 'dubai-master', at: '' });
  assert.equal(r.width, 160);
  assert.equal(r.height, 200);
  // A product saved with it: marked styled by the server, even though the browser sent no mark.
  const king = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  const p = products.createProduct({ title: 'Styled Set', category: 'bedsheets', price: 300, featuredImage: original, galleryImages: [r.url], profiles: king, defaultProfileId: 'king', stockBySize: { king: 1 } });
  assert.equal(p.stagedPhotos?.[r.url]?.staged, true);
  assert.equal(p.stagedPhotos?.[original], undefined, 'the real photo is not marked');
  // A mark sent by the browser for a real photo is ignored; the styled one can't be unmarked.
  const u = products.updateProduct(p.id, { stagedPhotos: { [original]: { staged: true }, [r.url]: null }, galleryImages: [r.url] });
  assert.equal(u.stagedPhotos?.[original], undefined);
  assert.equal(u.stagedPhotos?.[r.url]?.staged, true);
  // The styled photo taken off the product: no mark left.
  const off = products.updateProduct(p.id, { galleryImages: [] });
  assert.equal(off.stagedPhotos, undefined);
  // Audited, without image data or the key.
  const entry = auditEntry('product.photo_staged');
  assert.equal(entry.details.by, 'owner@shop.test');
  assert.equal(entry.details.preset, 'dubai-master');
  assert.equal(entry.details.model, 'gemini-3.1-flash-image');
  const log = auditLog();
  assert.ok(!log.includes(STAGED.toString('base64').slice(0, 40)) && !log.includes(PHOTO.toString('base64').slice(0, 40)), 'no image data');
  assert.ok(!log.includes('TESTKEY'));
});

test('stage-photo: a bad picture from Gemini is refused and nothing is saved', async () => {
  const before = () => fs.readdirSync(path.join(dir, 'images')).length;
  saveImageDataUrl(PHOTO_URL);
  const n = before();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const truncated = STAGED.subarray(0, STAGED.length - 30);
  const tiny = makePng(8, 8, () => [0, 0, 0]);
  const huge = Buffer.concat([STAGED.subarray(0, STAGED.length - 12), chunk('IDAT', Buffer.alloc(11 * 1024 * 1024)), STAGED.subarray(STAGED.length - 12)]);
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  for (const [what, reply] of [
    ['svg', imageReply(svg, 'image/svg+xml')],
    ['svg labelled png', imageReply(svg)],
    ['cut-off png', imageReply(truncated)],
    ['too few pixels', imageReply(tiny)],
    ['too large', imageReply(huge)],
    ['html', imageReply(html, 'image/jpeg')],
    ['not base64', { status: 200, data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: '<<<not base64>>>' } }] } }] } }],
  ] as const) {
    answer = () => reply;
    await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, `bad-${what}@s.t`), (e: { status: number; details?: { code?: string } }) => e.status === 502 && e.details?.code === 'ai_bad_image' || (what === 'svg' && e.details?.code === 'ai_no_image'), what);
  }
  answer = () => textReply('I made a lovely picture for you.');
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'text@s.t'), /did not send a picture/);
  answer = () => ({ status: 200, data: { candidates: [{ finishReason: 'IMAGE_SAFETY' }] } });
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'safety@s.t'), /would not style this photo/);
  assert.equal(before(), n, 'nothing saved');
});

test('stage-photo: input checks (fields allow-listed, presets, extra words, photo types and size), no key, and 10 an hour', async () => {
  const s = (body: Record<string, unknown>, who = 'checks@s.t') => status(stage.stagePhoto(body, who));
  assert.equal(await s({ image: PHOTO_URL, preset: 'dubai-master', sneaky: 1 }), 400);
  assert.equal(await s({ image: PHOTO_URL, preset: 'moon-base' }), 400);
  assert.equal(await s({ image: PHOTO_URL, preset: '__proto__' }), 400);
  assert.equal(await s({ image: PHOTO_URL, preset: 'kids-room', extra: 'x'.repeat(201) }), 400);
  assert.equal(await s({ image: PHOTO_URL, preset: 'kids-room', extra: 42 }), 400);
  assert.equal(await s({ image: PHOTO_URL, preset: 'kids-room', aspect: '16:9' }), 400);
  assert.equal(await s({ image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', preset: 'kids-room' }), 400);
  assert.equal(await s({ image: `data:image/png;base64,${Buffer.from('GIF89a not a png').toString('base64')}`, preset: 'kids-room' }), 400);
  assert.equal(await s({ image: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4 * 1024 * 1024 + 10)]).toString('base64')}`, preset: 'kids-room' }), 413);
  assert.equal(await s({ imageId: '../../shop.db', preset: 'kids-room' }), 400);
  assert.equal(await s({ imageId: `${'b'.repeat(64)}.png`, preset: 'kids-room' }), 404);
  assert.equal(await s({ preset: 'kids-room' }), 400);
  assert.equal(sent.length, 0, 'nothing sent for a bad request');
  // Extra words are cleaned (one line, no markup) before they reach the prompt.
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'clean-catalogue', aspect: '1:1', extra: 'soft\nlight <b>{x}</b>' }, 'checks@s.t');
  const prompt = String((sent[0].body as { contents: Array<{ parts: Array<{ text?: string }> }> }).contents[0].parts[0].text);
  assert.match(prompt, /soft light b x \/b$/);
  assert.match(prompt, /square framing/);
  assert.deepEqual((sent[0].body as { generationConfig: { imageConfig: unknown } }).generationConfig.imageConfig, { aspectRatio: '1:1', imageSize: '1K' });
  // 10 an hour per admin, then 429 (another admin is not affected).
  for (let i = 0; i < 10; i++) await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'limit@s.t');
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'limit@s.t'), (e: { status: number; headers: Record<string, string> }) => e.status === 429 && Number(e.headers['Retry-After']) > 0);
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'other@s.t');
  // Without a Gemini key: the owner is told how to add one, nothing is sent.
  await settings.updateSettings('ai', { provider: 'anthropic', anthropicApiKey: ANTHROPIC, geminiApiKey: null });
  sent = [];
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'nokey@s.t'), (e: { status: number; message: string }) => e.status === 409 && /aistudio\.google\.com/.test(e.message));
  assert.deepEqual(stage.stagingStatus(), { ready: false, reason: 'no_key', model: 'gemini-3.1-flash-image' });
  assert.equal(sent.length, 0);
});

test('stage-photo: a model that wants TEXT and IMAGE together is asked again that way; older 2.5 models get no image size', async () => {
  let calls = 0;
  answer = (req) => {
    calls++;
    const mods = (req.body as { generationConfig: { responseModalities: string[] } }).generationConfig.responseModalities;
    return mods.length === 1 ? { status: 400, data: { error: { code: 400, message: 'Model does not support the requested response modalities: image', status: 'INVALID_ARGUMENT' } } } : imageReply(STAGED);
  };
  const r = await stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'mods@s.t');
  assert.equal(calls, 2);
  assert.ok(r.url);
  answer = () => imageReply(STAGED);
  sent = [];
  await settings.updateSettings('ai', { geminiImageModel: 'gemini-2.5-flash-image' });
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'mods@s.t');
  assert.deepEqual((sent[0].body as { generationConfig: { imageConfig: unknown } }).generationConfig.imageConfig, { aspectRatio: '4:5' });
});

test('Discard deletes an unused styled photo; it refuses photos it did not make and styled photos a product uses', async () => {
  const r = await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'discard@s.t');
  const name = r.url.slice('/api/images/'.length);
  assert.ok(readImage(name));
  assert.deepEqual(stage.discardStagedPhoto({ url: r.url }, 'discard@s.t'), { deleted: true });
  assert.equal(readImage(name), null, 'the file is gone');
  assert.ok(auditEntry('product.photo_staged_discarded'));
  // A real photo can't be deleted this way.
  const real = saveImageDataUrl(PHOTO_URL);
  assert.throws(() => stage.discardStagedPhoto({ url: real }, 'discard@s.t'), (e: { status: number }) => e.status === 404);
  assert.ok(readImage(real.slice('/api/images/'.length)));
  assert.throws(() => stage.discardStagedPhoto({ url: '../../shop.db' }, 'discard@s.t'), (e: { status: number }) => e.status === 400);
  assert.throws(() => stage.discardStagedPhoto({ url: r.url, more: 1 }, 'discard@s.t'), (e: { status: number }) => e.status === 400);
  // One on a product stays.
  answer = () => imageReply(bedroomPng(170, 210));
  const used = await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'discard@s.t');
  const king = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  products.createProduct({ title: 'Kept Styled', category: 'bedsheets', price: 300, featuredImage: real, galleryImages: [used.url], profiles: king, defaultProfileId: 'king', stockBySize: { king: 1 } });
  assert.throws(() => stage.discardStagedPhoto({ url: used.url }, 'discard@s.t'), (e: { status: number }) => e.status === 409);
  assert.ok(readImage(used.url.slice('/api/images/'.length)));
});

test('the shop: styled photos carry a "Styled image" mark while the label setting is on, and none when it is off', async () => {
  answer = () => imageReply(bedroomPng(180, 225));
  const real = saveImageDataUrl(PHOTO_URL);
  const r = await stage.stagePhoto({ imageId: real.slice('/api/images/'.length), preset: 'hotel-suite' }, 'shop@s.t');
  const king = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  const p = products.createProduct({ title: 'Label Test Set', category: 'bedsheets', price: 300, featuredImage: real, galleryImages: [r.url], profiles: king, defaultProfileId: 'king', stockBySize: { king: 1 } });
  const shown = async () => ((await (await productsRoute.GET()).json()) as { products: Array<{ id: string; stagedPhotos?: Record<string, unknown> }> }).products.find((x) => x.id === p.id)!;
  assert.deepEqual((await shown()).stagedPhotos, { [r.url]: { staged: true } }, 'only the mark: not the source or the style');
  await settings.updateSettings('ai', { labelStyledPhotos: false });
  assert.equal((await shown()).stagedPhotos, undefined);
  await settings.updateSettings('ai', { labelStyledPhotos: true });
  assert.ok((await shown()).stagedPhotos);
});

test('a backup keeps styled photos (files, their mark on the product, the record) and never the Gemini key; the restore script restores them', async () => {
  delete process.env.BACKUP_PASSPHRASE;
  answer = () => imageReply(bedroomPng(190, 230));
  const real = saveImageDataUrl(PHOTO_URL);
  const r = await stage.stagePhoto({ imageId: real.slice('/api/images/'.length), preset: 'palm-villa' }, 'backup@s.t');
  const king = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  const p = products.createProduct({ title: 'Backup Styled Set', category: 'bedsheets', price: 300, featuredImage: real, galleryImages: [r.url], profiles: king, defaultProfileId: 'king', stockBySize: { king: 1 } });
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-staged-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const name = r.url.slice('/api/images/'.length);
  assert.deepEqual(fs.readFileSync(path.join(target, 'images', name)), readImage(name)!.bytes, 'the styled photo file');
  assert.ok(fs.existsSync(path.join(target, 'images', real.slice('/api/images/'.length))), 'the original too');
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    const data = JSON.parse((db.prepare('SELECT data FROM products WHERE id = ?').get(p.id) as { data: string }).data);
    assert.equal(data.stagedPhotos[r.url].staged, true);
    assert.equal(data.stagedPhotos[r.url].preset, 'palm-villa');
    assert.equal(data.stagedPhotos[r.url].source, real.slice('/api/images/'.length));
    const record = JSON.parse((db.prepare("SELECT data FROM kv WHERE key = 'staging:photos'").get() as { data: string }).data);
    assert.equal(record[name].preset, 'palm-villa');
    const aiRow = JSON.parse((db.prepare("SELECT data FROM settings WHERE key = 'ai'").get() as { data: string }).data);
    assert.equal(aiRow.geminiApiKey, '', 'the key is blanked in every backup');
    assert.equal(aiRow.geminiImageModel, 'gemini-3.1-flash-image');
    assert.equal(aiRow.provider, 'gemini');
  } finally {
    db.close();
  }
  assert.ok(!fs.readFileSync(result.file).includes(Buffer.from('TESTKEY')), 'not in the backup file');
});
