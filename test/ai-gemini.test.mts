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
import crypto from 'node:crypto';
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
/** STAGED, but a different picture each time (Gemini never sends the same one twice). */
let made = 0;
const freshStaged = () => {
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(2835 + ++made, 0);
  phys.writeUInt32BE(2835, 4);
  phys[8] = 1;
  return bedroomPng(160, 200, [chunk('tEXt', Buffer.from('Comment\0made by a camera at 25.2,55.3', 'latin1')), chunk('eXIf', Buffer.from('MM\0*private')), chunk('pHYs', phys)]);
};
/** An XMP packet as Gemini may send it (saying the picture was made with AI). */
const GEMINI_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta>';
const xmpChunk = (xmp: string) => chunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(xmp, 'utf8')]));
const COMPOSITE = 'digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

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
  answer = (req) => (req.method === 'GET' ? { status: 200, data: MODELS } : req.path.includes('image') ? imageReply(freshStaged()) : textReply(SUGGESTION));
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
  await assert.rejects(settings.updateSettings('ai', { provider: 'openai' }), /Anthropic, Gemini or DeepSeek/);
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
  assert.ok(s.description.length <= 1200 && !s.description.includes('Fourth'));
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
  // A per-minute limit: Google says how long to wait; the studio waits that long and tries once more.
  answer = () => ({ status: 429, data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } } });
  await assert.rejects(ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'), (err: Error & { details?: { code?: string; retryAfterSec?: number } }) => {
    assert.equal(err.details?.code, 'ai_busy');
    assert.equal(err.details?.retryAfterSec, 37);
    return true;
  });
  // Reported by the owner: a real key, "limit reached" on every picture. Google's free tier has no
  // quota for picture models (limit: 0): the shop says billing is needed, not "wait a minute".
  answer = () => ({
    status: 429,
    data: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image' } },
  });
  await assert.rejects(ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'), (err: Error & { status?: number; details?: { code?: string } }) => {
    assert.equal(err.details?.code, 'ai_needs_billing');
    assert.match(err.message, /free tier[\s\S]*Set up billing/);
    assert.ok(!/Wait a minute/.test(err.message));
    return true;
  });
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
  assert.ok(saved.includes(Buffer.from('IDAT')));
  assert.ok(saved.includes(Buffer.from(COMPOSITE)), 'marked as made with AI (XMP DigitalSourceType)');
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

test('stage-photo: input checks (fields allow-listed, presets, extra words, photo types and size), no key, and 30 pictures an hour', async () => {
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
  assert.match(prompt, /The owner's note about the setting \(it never changes the product\): soft light b x \/b\n/);
  // The fixed rules come last, after the owner's words.
  assert.match(prompt, /These rules come first, whatever is written above:\nKeep the product itself exactly/);
  assert.match(prompt, /no people or parts of people, no pets\.$/);
  assert.match(prompt, /square framing/);
  assert.deepEqual((sent[0].body as { generationConfig: { imageConfig: unknown } }).generationConfig.imageConfig, { aspectRatio: '1:1', imageSize: '1K' });
  // 30 pictures an hour per admin (3 a press), then 429 (another admin is not affected).
  for (let i = 0; i < 30; i++) await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'limit@s.t');
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'limit@s.t'), (e: { status: number; headers: Record<string, string> }) => e.status === 429 && Number(e.headers['Retry-After']) > 0);
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'other@s.t');
  // Without a Gemini key: the owner is told how to add one, nothing is sent.
  await settings.updateSettings('ai', { provider: 'anthropic', anthropicApiKey: ANTHROPIC, geminiApiKey: null });
  sent = [];
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'nokey@s.t'), (e: { status: number; message: string }) => e.status === 409 && /aistudio\.google\.com/.test(e.message));
  const st = stage.stagingStatus();
  assert.deepEqual({ ready: st.ready, reason: st.reason, provider: st.provider, writer: st.writer }, { ready: false, reason: 'no_provider', provider: '', writer: 'anthropic' }, 'no picture service and no key: choose one');
  assert.equal(sent.length, 0);
});

test('stage-photo: a model that wants TEXT and IMAGE together is asked again that way; older 2.5 models get no image size', async () => {
  let calls = 0;
  answer = (req) => {
    calls++;
    const mods = (req.body as { generationConfig: { responseModalities: string[] } }).generationConfig.responseModalities;
    return mods.length === 1 ? { status: 400, data: { error: { code: 400, message: 'Model does not support the requested response modalities: image', status: 'INVALID_ARGUMENT' } } } : imageReply(freshStaged());
  };
  const r = await stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'mods@s.t');
  assert.equal(calls, 2);
  assert.ok(r.url);
  // The second call is paid for too: it counts against the 30 an hour (2 + 1 + 13 × 2 = 29 used).
  const wants = answer;
  answer = () => imageReply(freshStaged());
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'mods@s.t');
  answer = wants;
  for (let i = 0; i < 13; i++) await stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'mods@s.t');
  calls = 0;
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'hotel-suite' }, 'mods@s.t'), (e: { status: number }) => e.status === 429);
  assert.equal(calls, 1, 'the second call is not made over the limit');
  _clearAllRateLimits();
  answer = () => imageReply(freshStaged());
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

test('Discard refuses a styled photo an order line or a setting still shows', async () => {
  const db = getDb();
  const now = new Date().toISOString();
  const inOrder = await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'refs@s.t');
  db.prepare("INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, data) VALUES ('ord-staged-ref', ?, ?, '+971500000000', 'pending', 'cod', 'pending', 30000, ?)").run(now, now, JSON.stringify({ items: [{ title: 'Set', image: inOrder.url }] }));
  assert.throws(() => stage.discardStagedPhoto({ url: inOrder.url }, 'refs@s.t'), (e: { status: number }) => e.status === 409);
  assert.ok(readImage(inOrder.url.slice('/api/images/'.length)), 'the order still shows its picture');
  const inSetting = await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'refs@s.t');
  db.prepare("INSERT INTO settings (key, data, updated_at) VALUES ('test-staged-ref', ?, ?)").run(JSON.stringify({ heroImage: inSetting.url }), now);
  assert.throws(() => stage.discardStagedPhoto({ url: inSetting.url }, 'refs@s.t'), (e: { status: number }) => e.status === 409);
  assert.ok(readImage(inSetting.url.slice('/api/images/'.length)));
  db.prepare("DELETE FROM settings WHERE key = 'test-staged-ref'").run();
  db.prepare("DELETE FROM orders WHERE id = 'ord-staged-ref'").run();
});

test('a picture Gemini sends back that is already stored (the photo sent, or a real photo) is refused, never marked styled, and Discard cannot delete it', async () => {
  // A real photo uploaded with an XMP packet that says how it was made: kept as it is when cleaned.
  const realBytes = bedroomPng(150, 190, [xmpChunk(GEMINI_XMP)]);
  const real = saveImageDataUrl(`data:image/png;base64,${realBytes.toString('base64')}`);
  const name = real.slice('/api/images/'.length);
  const king = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  const p = products.createProduct({ title: 'Real Photo Set', category: 'bedsheets', price: 300, featuredImage: real, galleryImages: [], profiles: king, defaultProfileId: 'king', stockBySize: { king: 1 } });
  answer = () => imageReply(realBytes);
  for (const body of [{ imageId: name }, { image: PHOTO_URL }]) {
    await assert.rejects(stage.stagePhoto({ ...body, preset: 'hotel-suite' }, 'same@s.t'), (e: { status: number; message: string; details?: { code?: string } }) => e.status === 502 && e.details?.code === 'ai_same_image' && /same photo; try another scene/.test(e.message));
  }
  const { stagedRecords } = await import('@/lib/server/stagedPhotos');
  assert.equal(name in stagedRecords(), false, 'not recorded as styled');
  assert.equal(products.updateProduct(p.id, { title: 'Real Photo Set 2' }).stagedPhotos, undefined, 'the real photo is not marked');
  // Taken off the product, it still can't be deleted as a "styled photo".
  products.updateProduct(p.id, { featuredImage: saveImageDataUrl(PHOTO_URL) });
  assert.throws(() => stage.discardStagedPhoto({ url: real }, 'same@s.t'), (e: { status: number }) => e.status === 404);
  assert.deepEqual(readImage(name)!.bytes, realBytes, 'the real photo is still stored');
  // The same picture sent twice: the second is refused, so "Try again" can't discard the first one.
  const twice = freshStaged();
  answer = () => imageReply(twice);
  const first = await stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'same@s.t');
  await assert.rejects(stage.stagePhoto({ image: PHOTO_URL, preset: 'kids-room' }, 'same@s.t'), /same photo/);
  assert.ok(readImage(first.url.slice('/api/images/'.length)));
});

test('styled photos keep their AI provenance: C2PA and the XMP DigitalSourceType stay (or are added); EXIF, GPS and text go', async () => {
  const { cleanImage } = await import('@/lib/server/images');
  const c2pa = chunk('caBX', Buffer.from('jumbc2pa-manifest'));
  const text = chunk('tEXt', Buffer.from('Comment\0secret', 'latin1'));
  const exif = chunk('eXIf', Buffer.from('MM\0*GPS 25.2,55.3'));
  // PNG from Gemini with C2PA and XMP: both kept; EXIF and text gone.
  const withXmp = bedroomPng(100, 120, [c2pa, xmpChunk(GEMINI_XMP), text, exif]);
  const kept = cleanImage(withXmp, 1e7, { keepProvenance: true })!.bytes;
  assert.ok(kept.includes(c2pa) && kept.includes(xmpChunk(GEMINI_XMP)), 'C2PA and XMP kept');
  assert.ok(!kept.includes(Buffer.from('secret')) && !kept.includes(Buffer.from('25.2,55.3')), 'text and EXIF gone');
  assert.ok(!kept.includes(Buffer.from(COMPOSITE)), 'nothing added when Gemini said it already');
  // Without keepProvenance (anything else): all of it goes.
  const plain = cleanImage(withXmp, 1e7)!.bytes;
  assert.ok(!plain.includes(Buffer.from('caBX')) && !plain.includes(Buffer.from('xmpmeta')));
  // PNG without XMP (or XMP with a place in it): the packet is added as an iTXt XML:com.adobe.xmp chunk.
  for (const extra of [[c2pa], [xmpChunk('<x:xmpmeta>DigitalSourceType exif:GPSLatitude="25.2"</x:xmpmeta>')]]) {
    const added = cleanImage(bedroomPng(100, 120, extra), 1e7, { keepProvenance: true })!;
    assert.ok(added.bytes.includes(Buffer.from('iTXtXML:com.adobe.xmp\0', 'latin1')) && added.bytes.includes(Buffer.from(COMPOSITE)));
    assert.ok(!added.bytes.includes(Buffer.from('GPSLatitude')));
    assert.equal(added.bytes.subarray(-12).toString('latin1', 4, 8), 'IEND');
    assert.equal(added.width, 100);
  }

  // JPEG: SOI, JFIF, EXIF, C2PA (APP11), a comment, a frame of 100 × 80, the scan.
  const seg = (marker: number, data: Buffer) => {
    const h = Buffer.from([0xff, marker, 0, 0]);
    h.writeUInt16BE(2 + data.length, 2);
    return Buffer.concat([h, data]);
  };
  const jfif = seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  const app11 = seg(0xeb, Buffer.from('JP\0\x01jumbc2pa', 'latin1'));
  const sof = seg(0xc0, Buffer.from([8, 0, 80, 0, 100, 1, 1, 0x11, 0]));
  const scan = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([1, 2, 3, 0xff, 0xd9])]);
  const jpeg = (...mid: Buffer[]) => Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, ...mid, sof, scan]);
  const exifSeg = seg(0xe1, Buffer.from('Exif\0\0GPS 25.2,55.3', 'latin1'));
  const xmpSeg = seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(GEMINI_XMP)]));
  const j1 = cleanImage(jpeg(exifSeg, app11, xmpSeg, seg(0xfe, Buffer.from('comment'))), 1e7, { keepProvenance: true })!;
  assert.deepEqual(j1.bytes, jpeg(app11, xmpSeg), 'C2PA and XMP kept; EXIF and the comment gone');
  assert.equal(j1.width, 100);
  const j2 = cleanImage(jpeg(exifSeg, app11), 1e7, { keepProvenance: true })!.bytes;
  assert.deepEqual(j2.subarray(0, 2 + jfif.length), Buffer.concat([Buffer.from([0xff, 0xd8]), jfif]), 'JFIF stays first');
  assert.equal(j2.readUInt16BE(2 + jfif.length), 0xffe1, 'an APP1 XMP segment right after it');
  assert.ok(j2.includes(Buffer.from(COMPOSITE)) && j2.includes(app11) && !j2.includes(Buffer.from('Exif')));
  assert.deepEqual(cleanImage(jpeg(exifSeg, app11, xmpSeg), 1e7)!.bytes, jpeg(), 'everything goes without keepProvenance');

  // WebP (lossless, 100 × 80): EXIF, XMP and unknown chunks go; with keepProvenance, VP8X + XMP are added.
  const riff = (type: string, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, 'latin1');
    h.writeUInt32LE(data.length, 4);
    return Buffer.concat([h, data, Buffer.alloc(data.length % 2)]);
  };
  const vp8lData = Buffer.alloc(11);
  vp8lData[0] = 0x2f;
  vp8lData.writeUInt32LE((99 & 0x3fff) | ((79 & 0x3fff) << 14), 1);
  const webp = (...chunks: Buffer[]) => {
    const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
    const h = Buffer.alloc(8);
    h.write('RIFF', 0, 'latin1');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const vp8l = riff('VP8L', vp8lData);
  const w1 = cleanImage(webp(vp8l, riff('EXIF', Buffer.from('GPS 25.2,55.3')), riff('ABCD', Buffer.from('tracking')), riff('XMP ', Buffer.from(GEMINI_XMP))), 1e7)!;
  assert.deepEqual(w1.bytes, webp(vp8l), 'only the picture is kept');
  assert.deepEqual([w1.width, w1.height], [100, 80]);
  const w2 = cleanImage(webp(vp8l, riff('ABCD', Buffer.from('tracking'))), 1e7, { keepProvenance: true })!;
  assert.equal(w2.bytes.toString('latin1', 12, 16), 'VP8X');
  assert.equal(w2.bytes[20] & 0x04, 0x04, 'the XMP flag');
  assert.deepEqual([w2.width, w2.height], [100, 80]);
  assert.ok(w2.bytes.includes(Buffer.from(COMPOSITE)) && !w2.bytes.includes(Buffer.from('tracking')));
  assert.equal(w2.bytes.readUInt32LE(4), w2.bytes.length - 8, 'the RIFF size is right');
  // WebP from Gemini with its own XMP and C2PA: kept, XMP flag set.
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x0c;
  vp8x.writeUIntLE(99, 4, 3);
  vp8x.writeUIntLE(79, 7, 3);
  const w3 = cleanImage(webp(riff('VP8X', vp8x), vp8l, riff('EXIF', Buffer.from('x')), riff('XMP ', Buffer.from(GEMINI_XMP)), riff('C2PA', Buffer.from('manifest'))), 1e7, { keepProvenance: true })!.bytes;
  assert.deepEqual(w3, webp(riff('VP8X', Buffer.concat([Buffer.from([0x04]), vp8x.subarray(1)])), vp8l, riff('XMP ', Buffer.from(GEMINI_XMP)), riff('C2PA', Buffer.from('manifest'))));
});

test('a PNG whose IHDR is not 13 bytes is refused', async () => {
  const { cleanImage } = await import('@/lib/server/images');
  const { imageDimensions } = await import('@/lib/server/imageInput');
  const good = bedroomPng(100, 120);
  // The same picture with a 17-byte IHDR (4 extra bytes): length, type, data and CRC rebuilt.
  const ihdr = Buffer.concat([good.subarray(16, 29), Buffer.alloc(4)]);
  const bad = Buffer.concat([good.subarray(0, 8), chunk('IHDR', ihdr), good.subarray(33)]);
  assert.ok(cleanImage(good, 1e7));
  assert.equal(cleanImage(bad, 1e7), null);
  assert.equal(imageDimensions(bad), null);
});

test('the styled-photo record never drops a photo still stored (only records of files that are gone)', async () => {
  const sp = await import('@/lib/server/stagedPhotos');
  const { kvSet } = await import('@/lib/server/kv');
  const imgDir = path.join(dir, 'images');
  const before = sp.stagedRecords();
  const all: Record<string, { source: string; preset: string; at: string }> = {};
  const fake = (i: number) => `${crypto.createHash('sha256').update(`staged-${i}`).digest('hex')}.png`;
  for (let i = 0; i < 2002; i++) {
    if (i < 2000) all[fake(i)] = { source: '', preset: 'kids-room', at: '' };
    if (i !== 5) fs.writeFileSync(path.join(imgDir, fake(i)), 'x');
  }
  kvSet('staging:photos', all);
  sp.recordStaged(fake(2000), { source: '', preset: 'kids-room', at: '' });
  sp.recordStaged(fake(2001), { source: '', preset: 'kids-room', at: '' });
  const now = sp.stagedRecords();
  assert.equal(fake(5) in now, false, 'the record of a file that is gone goes first');
  for (const i of [0, 1, 4, 6, 1999, 2000, 2001]) assert.ok(fake(i) in now, `record ${i} kept`);
  assert.equal(Object.keys(now).length, 2001, 'over the limit rather than lose a stored photo’s mark');
  for (let i = 0; i < 2002; i++) fs.rmSync(path.join(imgDir, fake(i)), { force: true });
  kvSet('staging:photos', before);
});

test('the shop: styled photos carry a "Styled image" mark while the label setting is on, and none when it is off', async () => {
  answer = () => imageReply(bedroomPng(180, 225));
  const real = saveImageDataUrl(PHOTO_URL);
  const r = await stage.stagePhoto({ imageId: real.slice('/api/images/'.length), preset: 'hotel-suite' }, 'shop@s.t');
  const king = settings.getSettings('catalog').sizes.filter((s) => s.id === 'king');
  const p = products.createProduct({ title: 'Label Test Set', category: 'bedsheets', price: 300, featuredImage: real, galleryImages: [r.url], profiles: king, defaultProfileId: 'king', stockBySize: { king: 1 } });
  const shown = async () => ((await (await productsRoute.GET()).json()) as { products: Array<{ id: string; stagedPhotos?: Record<string, unknown> }> }).products.find((x) => x.id === p.id)!;
  assert.deepEqual((await shown()).stagedPhotos, { [r.url]: { staged: true } }, 'only the mark: not the source or the style');
  // The Meta / Google feed: the styled photo is an additional image only while the shop labels them.
  const feed = await import('@/app/feeds/meta.csv/route');
  process.env.NEXT_PUBLIC_APP_URL = 'https://shop.test';
  const feedRow = async () => (await (await feed.GET()).text()).split('\n').find((l) => l.includes(`${p.id}-king`))!;
  assert.ok((await feedRow()).includes(r.url));
  await settings.updateSettings('ai', { labelStyledPhotos: false });
  assert.equal((await shown()).stagedPhotos, undefined);
  assert.ok(!(await feedRow()).includes(r.url), 'no unlabelled styled photo in the feed');
  assert.ok((await feedRow()).includes(real), 'the real photo stays');
  await settings.updateSettings('ai', { labelStyledPhotos: true });
  assert.ok((await shown()).stagedPhotos);
  delete process.env.NEXT_PUBLIC_APP_URL;
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

// ── the newer key format (AQ.…) ────────────────────────────────────────────

// AI Studio's authorization keys (all new keys since May 2026) start with AQ. instead of AIza.
const AUTH_KEY = 'AQ.Ab8RN6IvTESTAUTHKEY-q2_w.e9r8t7y6u5i4o3p2-L4sT';

test('an AQ. key (AI Studio authorization key) is accepted, saved write-only (••••last4), sent only in x-goog-api-key, and never in history, logs, errors or backups', async () => {
  await settings.updateSettings('ai', { geminiApiKey: AUTH_KEY });
  assert.equal(settings.getSettings('ai').geminiApiKey, AUTH_KEY, 'saved as typed');
  const view = settings.adminView('ai');
  assert.equal(view.value.geminiApiKey, '');
  assert.equal(view.secretsHint?.geminiApiKey, '••••L4sT');
  assert.ok(!JSON.stringify(view).includes('AUTHKEY'), 'never in a response');
  // Writing: only in the header.
  sent = [];
  await ai.describeProduct({ image: PHOTO_URL }, 'o@s.t');
  assert.equal(sent[0].headers['x-goog-api-key'], AUTH_KEY);
  assert.ok(!sent[0].path.includes('AQ.') && !JSON.stringify(sent[0].body).includes(AUTH_KEY), 'not in the address or body');
  // Test: the saved AQ. key, and a typed one.
  sent = [];
  await ai.testGeminiSettings({}, 'o@s.t');
  assert.equal(sent[0].headers['x-goog-api-key'], AUTH_KEY);
  const typed = 'AQ.Ab8RN6OTHERAUTHKEY_abcdefghijklmnop';
  await ai.testGeminiSettings({ geminiApiKey: typed }, 'o@s.t');
  assert.equal(sent[1].headers['x-goog-api-key'], typed);
  // Google echoing the key (or another AQ. key) back: never in the message or the logs.
  const OTHER = 'AQ.Ab8RN6ANOTHERAUTHKEY-zyxwvutsrqponm';
  answer = () => ({ status: 400, data: { error: { code: 400, message: `Unsupported MIME type ${AUTH_KEY} ${OTHER}`, status: 'INVALID_ARGUMENT' } } });
  const r = await logsOf(() => ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'));
  assert.match((r.result as Error).message, /^Gemini said: Unsupported MIME type/);
  assert.ok(!((r.result as Error).message + r.logs).includes('AUTHKEY'), 'neither key in the error or logs');
  answer = () => ({ status: 400, data: { error: { code: 400, message: `API key not valid. (${AUTH_KEY})`, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } } });
  const bad = await logsOf(() => ai.describeProduct({ image: PHOTO_URL }, 'o@s.t'));
  const e = bad.result as unknown as { message: string; details: unknown };
  assert.match(e.message, /did not accept the Gemini API key/);
  assert.ok(!(JSON.stringify({ m: e.message, d: e.details }) + bad.logs).includes('AUTHKEY'));
  // Settings history, audit log, backup.
  const history = getDb().prepare("SELECT data FROM settings_history WHERE key = 'ai'").pluck().all() as string[];
  assert.ok(!history.join('').includes('AUTHKEY'), 'history never keeps the key');
  assert.ok(!auditLog().includes('AUTHKEY'), 'never in the audit log');
  delete process.env.BACKUP_PASSPHRASE;
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  assert.ok(!fs.readFileSync(result.file).includes(Buffer.from('AUTHKEY')), 'not in the backup file');
  await settings.updateSettings('ai', { geminiApiKey: KEY });
});

test('Gemini key shapes: AIza… and AQ.… accepted; anything else refused with "starts with AIza or AQ."', async () => {
  const { GEMINI_KEY } = settings;
  for (const good of [KEY, AUTH_KEY, `AQ.${'a'.repeat(20)}`, `AQ.${'A1._-'.repeat(50)}`, `AIza${'b'.repeat(35)}`]) assert.ok(GEMINI_KEY.test(good), good);
  const badKeys = [
    'AQ.short',
    `AQ.${'a'.repeat(19)}`,
    `AQ.${'a'.repeat(251)}`,
    `aq.${'a'.repeat(30)}`,
    `AQ${'a'.repeat(30)}`,
    `AQ.${'a'.repeat(15)} ${'b'.repeat(15)}`,
    `AQ.${'a'.repeat(15)}\n${'b'.repeat(15)}`,
    `AQ.${'a'.repeat(20)}<script>`,
    `AQ.${'a'.repeat(20)}/../x`,
    `AQ.${'a'.repeat(20)}+=`,
    'AIzaTooShort',
    `AIza${'b'.repeat(61)}`,
    `xAQ.${'a'.repeat(30)}`,
    'sk-not-google',
  ];
  for (const bad of badKeys) {
    assert.ok(!GEMINI_KEY.test(bad), bad);
    await assert.rejects(settings.updateSettings('ai', { geminiApiKey: bad }), /starts with AIza or AQ\./, bad);
    await assert.rejects(ai.testGeminiSettings({ geminiApiKey: bad }, 'o@s.t'), /starts with AIza or AQ\./, bad);
  }
  assert.equal(settings.getSettings('ai').geminiApiKey, KEY, 'the saved key is untouched');
});

test('redaction covers both Google key formats, as whole words only', () => {
  const text = `classic ${KEY}, new ${AUTH_KEY}; in a url https://x.test/?key=${AUTH_KEY}&k2=${KEY}`;
  const out = JSON.stringify(redact({ note: text }));
  assert.ok(!out.includes('TESTKEY') && !out.includes('AUTHKEY'), out);
  assert.match(out, /AIza\[redacted\]/);
  assert.match(out, /AQ\.\[redacted\]/);
  const scrubbed = gemini.scrubGemini(text, '');
  assert.ok(!scrubbed.includes('TESTKEY') && !scrubbed.includes('AUTHKEY'), scrubbed);
  // Ordinary text is left alone: a short AQ. word, AQ. inside a longer word, and plain sentences.
  for (const plain of ['Grade AQ. Next sentence.', 'See AQ.example.com for more', `SAQ.${'a'.repeat(30)}`, 'Ask the AQI today', 'Model AQ.5 sheets']) {
    assert.equal(redact(plain), plain, plain);
  }
});
