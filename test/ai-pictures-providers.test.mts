/**
 * AI pictures from any service (src/lib/server/pictures/) and style photos, with every service
 * replaced by a stand-in:
 * - OpenAI (POST /v1/images/edits, multipart): the product photo first, then the style photos as
 *   image[] in order, the prompt with the fixed rules last, the size, the key in Authorization only;
 *   Test lists the GPT Image models; errors (401, organisation not verified, no credit, 429, safety,
 *   timeout) in plain words, never the key;
 * - fal.ai (queue): the submit (Authorization: Key, the model's own input fields, data URIs in
 *   order, the shape), the status polled, the result as a data URI or from fal's CDN only (any other
 *   address refused and never fetched), the curated models' limits, errors in plain words;
 * - Gemini with style photos: inline images in order, the roles named in the prompt; off when none
 *   are saved, per scene and per batch;
 * - style photos: metadata (EXIF, GPS, text) taken out, size-capped, at most 5, backed up and
 *   restored; the picture service chosen, its status, and its keys (write-only, ••••last4, never in
 *   history, a backup or a log; sk-proj- and fal key shapes redacted).
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
const gemini = await import('@/lib/server/gemini');
const stage = await import('@/lib/server/stagePhoto');
const transport = await import('@/lib/server/pictures/transport');
const fal = await import('@/lib/server/pictures/fal');
const staging = await import('@/lib/staging');
const { saveImageDataUrl, readImage } = await import('@/lib/server/images');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { redact, maskAiKeys } = await import('@/lib/server/log');

const GEMINI = 'AIzaSyTESTKEY-abcdefghijklmnopqrstu-Q9xZ';
const OPENAI = 'sk-proj-OPENAIKEYabcdefghijklmnopqrstuvwxyz0123456789-ZZ9K';
const FAL = '0f4e1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b:abcdef0123456789abcdef0123456789';

const PHOTO = makePng(96, 120, (x, y) => ((x + y) % 24 < 12 ? [47, 63, 122] : [246, 244, 238]));
const PHOTO_URL = `data:image/png;base64,${PHOTO.toString('base64')}`;
let made = 0;
const fresh = () => {
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(2835 + ++made, 0);
  phys.writeUInt32BE(2835, 4);
  phys[8] = 1;
  return bedroomPng(160, 200, [chunk('pHYs', phys)]);
};
/** A style photo as a camera saves it: EXIF with a GPS position and a text comment. */
const styleSource = (n: number) => bedroomPng(120 + n, 150, [chunk('eXIf', Buffer.from(`MM\0*GPS 25.2048,55.2708 camera ${n}`, 'latin1')), chunk('tEXt', Buffer.from(`Comment\0taken at home ${n}`, 'latin1'))]);

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}
let seen: Seen[] = [];
let reply: (req: Seen) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
let geminiSent: Array<Record<string, unknown>> = [];

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
const rejects = (p: Promise<unknown>, code: string, words: RegExp) =>
  assert.rejects(p, (e: { message: string; details?: { code?: string } }) => {
    assert.equal(e.details?.code, code, e.message);
    assert.match(e.message, words);
    assert.ok(!e.message.includes('OPENAIKEY') && !e.message.includes('abcdef0123456789abcdef'), 'never the key');
    return true;
  });

/** The parts of a multipart body, in order. */
function parts(body: Buffer, type: string): Array<{ name: string; filename?: string; type?: string; data: Buffer }> {
  const boundary = /boundary=(\S+)/.exec(type)![1];
  const out = [];
  const text = body.toString('latin1');
  for (const piece of text.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = piece.replace(/^\r\n/, '').split('\r\n\r\n');
    const data = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1');
    out.push({ name: /name="([^"]+)"/.exec(head)![1], filename: /filename="([^"]+)"/.exec(head)?.[1], type: /Content-Type: (\S+)/i.exec(head)?.[1], data });
  }
  return out;
}

async function saveStylePhotos(n: number): Promise<string[]> {
  const urls = [];
  for (let i = 0; i < n; i++) urls.push(stage.uploadStylePhoto({ image: `data:image/png;base64,${styleSource(i).toString('base64')}` }, 'owner@s.t').url);
  await settings.updateSettings('aiPictures', { references: urls, useReferences: true });
  return urls;
}

beforeEach(async () => {
  _clearAllRateLimits();
  seen = [];
  geminiSent = [];
  fal._setFalPollMs(5);
  transport._setPicturesTransport(async (req) => {
    const s: Seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '') };
    seen.push(s);
    const r = reply(s);
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(JSON.stringify(r.body));
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, body };
  });
  gemini._setGeminiTransport(async (req) => {
    geminiSent.push(JSON.parse(req.body ?? '{}'));
    return { status: 200, ok: true, data: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: fresh().toString('base64') } }] }, finishReason: 'STOP' }] } };
  });
  await settings.updateSettings('ai', { picturesProvider: '', geminiApiKey: null, openaiApiKey: null, falApiKey: null, openaiImageModel: '', falModel: 'fal-ai/nano-banana/edit' });
  // The picture check has its own tests (auto-add); here each Gemini call is a picture.
  await settings.updateSettings('aiPictures', { ...staging.DEFAULT_AI_PICTURES, checkPictures: false } as unknown as Record<string, unknown>);
});
afterEach(() => {
  transport._setPicturesTransport(null);
  gemini._setGeminiTransport(null);
});

// ── the service chosen, its status and keys ────────────────────────────────

test('the picture service: none until chosen (or a key saved), then its key and model; status names the service; shapes checked', async () => {
  assert.deepEqual([stage.stagingStatus().reason, stage.stagingStatus().provider], ['no_provider', '']);
  // A fal key alone: fal makes pictures (whichever key the shop has).
  await settings.updateSettings('ai', { falApiKey: FAL });
  assert.deepEqual([stage.stagingStatus().ready, stage.stagingStatus().provider, stage.stagingStatus().model], [true, 'fal', 'fal-ai/nano-banana/edit']);
  // A Gemini key too: Gemini first, unless the owner chose.
  await settings.updateSettings('ai', { geminiApiKey: GEMINI });
  assert.equal(stage.stagingStatus().provider, 'gemini');
  await settings.updateSettings('ai', { picturesProvider: 'openai' });
  assert.deepEqual([stage.stagingStatus().reason, stage.stagingStatus().providerName], ['no_key', 'OpenAI (GPT Image)']);
  await settings.updateSettings('ai', { openaiApiKey: OPENAI });
  assert.equal(stage.stagingStatus().reason, 'no_model', 'a key, but no model chosen yet (Test)');
  await settings.updateSettings('ai', { openaiImageModel: 'gpt-image-2.5-sunburst' });
  assert.deepEqual([stage.stagingStatus().ready, stage.stagingStatus().model], [true, 'gpt-image-2.5-sunburst']);
  // Writing is independent: DeepSeek can write while OpenAI makes pictures.
  await settings.updateSettings('ai', { provider: 'deepseek', deepseekApiKey: ('sk-' + '0123456789abcdef'.repeat(2)), enabled: true });
  assert.deepEqual([stage.stagingStatus().writer, stage.stagingStatus().provider], ['deepseek', 'openai']);
  // Shapes.
  const bad = async (v: Record<string, unknown>) => assert.equal(await settings.updateSettings('ai', v).then(() => 200, (e: { status: number }) => e.status), 400, JSON.stringify(v));
  await bad({ picturesProvider: 'midjourney' });
  await bad({ openaiApiKey: 'pk-nope-abcdefghijklmnopqrstuvwxyz' });
  await bad({ falApiKey: 'no-colon-here-abcdefghijklmnop' });
  await bad({ openaiImageModel: 'dall-e-3; rm -rf' });
  for (const id of ['../x/y', 'fal-ai//edit', 'Fal-AI/Edit', 'fal-ai', 'https://evil.example/x', 'fal-ai/x?y=1']) await bad({ falModel: id });
  await settings.updateSettings('ai', { falModel: 'fal-ai/flux-2/edit' });
});

test('keys: write-only (••••last4), never in history, a backup or a log; sk-proj- and fal key shapes are redacted', async () => {
  await settings.updateSettings('ai', { openaiApiKey: OPENAI, falApiKey: FAL, picturesProvider: 'openai' });
  const view = settings.adminView('ai');
  assert.equal(view.value.openaiApiKey, '');
  assert.equal(view.value.falApiKey, '');
  assert.equal(view.secretsHint?.openaiApiKey, `••••${OPENAI.slice(-4)}`);
  assert.equal(view.secretsHint?.falApiKey, `••••${FAL.slice(-4)}`);
  await settings.updateSettings('ai', { picturesProvider: 'fal' });
  const { getDb } = await import('@/lib/server/db');
  assert.ok(!(getDb().prepare("SELECT group_concat(data) FROM settings_history WHERE key = 'ai'").pluck().get() as string).includes('OPENAIKEY'), 'not in history');
  delete process.env.BACKUP_PASSPHRASE;
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const file = fs.readFileSync(result.file);
  assert.ok(!file.includes(Buffer.from('OPENAIKEY')) && !file.includes(Buffer.from(FAL.split(':')[1])), 'not in the backup');
  // The log's redaction: OpenAI project keys and fal keys, wherever they appear.
  const line = JSON.stringify(redact({ note: `keys ${OPENAI} and ${FAL} and sk-svcacct-abcdefghijklmnopqrstuvwxyz` }));
  assert.ok(!line.includes('OPENAIKEY') && !line.includes('abcdef0123456789abcdef') && !line.includes('abcdefghijklmnopqrstuvwxyz'), line);
  assert.match(maskAiKeys(`a ${OPENAI} b`), /sk-proj-\[redacted\]/);
  assert.match(maskAiKeys(`a ${FAL} b`), /\[fal key redacted\]/);
});

// ── OpenAI ─────────────────────────────────────────────────────────────────

const b64Reply = () => ({ status: 200, body: { created: 1, data: [{ b64_json: fresh().toString('base64') }] } });

test('OpenAI: multipart to /v1/images/edits, the product image first and the style photos in order, the prompt with the fixed rules last; stored and marked; audited with the service', async () => {
  await settings.updateSettings('ai', { picturesProvider: 'openai', openaiApiKey: OPENAI, openaiImageModel: 'gpt-image-2.5-sunburst' });
  const refs = await saveStylePhotos(2);
  reply = b64Reply;
  const original = saveImageDataUrl(PHOTO_URL);
  const r = await stage.stagePhoto({ imageId: original.slice('/api/images/'.length), preset: 'whole-bed' }, 'owner@s.t');
  assert.equal(seen.length, 1);
  const req = seen[0];
  assert.equal(req.url, 'https://api.openai.com/v1/images/edits');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, `Bearer ${OPENAI}`);
  assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
  const p = parts(req.body, req.headers['content-type']);
  const field = (n: string) => p.find((x) => x.name === n)!.data.toString('utf8');
  assert.equal(field('model'), 'gpt-image-2.5-sunburst');
  assert.equal(field('size'), '1024x1280');
  assert.equal(field('quality'), 'medium');
  const prompt = field('prompt');
  assert.match(prompt, /Image 1 is the product: copy its bedding exactly\. Images 2–3 are style references: match their lighting, colour grading, camera angle, room style and mood, but do not copy their bedding, people, text or logos\./);
  assert.ok(prompt.endsWith(staging.STAGING_FIXED_RULES.at(-1)!), 'the fixed rules last');
  const images = p.filter((x) => x.name === 'image[]');
  assert.equal(images.length, 3);
  assert.deepEqual(images[0].data, PHOTO, 'the product first');
  assert.deepEqual(images[1].data, readImage(refs[0].slice('/api/images/'.length))!.bytes, 'then style photo 1');
  assert.deepEqual(images[2].data, readImage(refs[1].slice('/api/images/'.length))!.bytes, 'then style photo 2');
  assert.ok(!req.body.toString('latin1').includes(OPENAI), 'the key is not in the body');
  assert.equal(r.provider, 'openai');
  assert.equal(r.references, 2);
  assert.ok(readImage(r.url.slice('/api/images/'.length))!.bytes.includes(Buffer.from('compositeWithTrainedAlgorithmicMedia')), 'marked as made with AI by the shop');
  const entry = auditEntry('product.photo_staged');
  assert.deepEqual([entry.details.provider, entry.details.model, entry.details.references], ['openai', 'gpt-image-2.5-sunburst', 2]);
  assert.ok(!auditLog().includes('OPENAIKEY'));
  // GPT Image 1 takes its fixed portrait size.
  await settings.updateSettings('ai', { openaiImageModel: 'gpt-image-1' });
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'close-up', aspect: '1:1' }, 'owner@s.t');
  assert.equal(parts(seen[1].body, seen[1].headers['content-type']).find((x) => x.name === 'size')!.data.toString(), '1024x1024');
  const { openaiSize } = await import('@/lib/server/pictures/openai');
  assert.equal(openaiSize('gpt-image-1', '4:5'), '1024x1536');
});

test('OpenAI: Test lists the GPT Image models; errors in plain words, never the key', async () => {
  await settings.updateSettings('ai', { picturesProvider: 'openai', openaiApiKey: OPENAI, openaiImageModel: 'gpt-image-2.5-sunburst' });
  reply = () => ({ status: 200, body: { data: [{ id: 'gpt-4.1' }, { id: 'gpt-image-1' }, { id: 'gpt-image-2.5-flare' }, { id: 'gpt-image-2.5-sunburst' }, { id: 'dall-e-3' }, { id: 'evil model' }] } });
  const t = await stage.testPictures('openai', {}, 'owner@s.t');
  assert.deepEqual(t.models.image, ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-1']);
  assert.equal(t.models.suggested.image, 'gpt-image-2.5-sunburst');
  assert.equal(seen[0].url, 'https://api.openai.com/v1/models');
  assert.equal(seen[0].headers.authorization, `Bearer ${OPENAI}`);
  await assert.rejects(stage.testPictures('openai', { openaiApiKey: 'nope' }, 'owner@s.t'), /starts with sk-/);
  const go = () => stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, `err${Math.random()}@s.t`);
  reply = () => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${OPENAI}`, type: 'invalid_request_error', code: 'invalid_api_key' } } });
  await rejects(go(), 'ai_key_refused', /OpenAI did not accept the API key\. Check it in Settings → AI pictures/);
  reply = () => ({ status: 403, body: { error: { message: 'Your organization must be verified to use the model gpt-image-2.5-sunburst.', type: 'invalid_request_error' } } });
  await rejects(go(), 'ai_key_refused', /organisation verified/);
  reply = () => ({ status: 429, body: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } });
  await rejects(go(), 'ai_no_balance', /credit is used up/);
  reply = () => ({ status: 429, body: { error: { message: 'Rate limit reached', type: 'requests' } } });
  await rejects(go(), 'ai_busy', /limit for your account/);
  reply = () => ({ status: 400, body: { error: { message: 'Your request was rejected by the safety system.', type: 'image_generation_user_error', code: 'moderation_blocked' } } });
  await rejects(go(), 'ai_refused', /would not make this picture/);
  reply = () => ({ status: 200, body: { data: [{}] } });
  await rejects(go(), 'ai_no_image', /did not send a picture back/);
  transport._setPicturesTransport(async () => {
    throw Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' });
  });
  await rejects(go(), 'ai_timeout', /OpenAI took too long/);
});

// ── fal.ai ─────────────────────────────────────────────────────────────────

/** fal's queue: submitted, in progress once, completed, then the result. */
function falQueue(output: unknown, opts: { statusUrl?: string } = {}) {
  let polls = 0;
  return (req: Seen) => {
    if (req.method === 'POST') return { status: 200, body: { request_id: '764cabcf-b745-4b3e-ae38-1200304cf45b', status_url: opts.statusUrl ?? 'https://queue.fal.run/fal-ai/nano-banana/requests/764cabcf-b745-4b3e-ae38-1200304cf45b/status', response_url: 'https://queue.fal.run/fal-ai/nano-banana/requests/764cabcf-b745-4b3e-ae38-1200304cf45b', queue_position: 0 } };
    if (req.url.endsWith('/status')) return { status: 200, body: { status: ++polls < 2 ? 'IN_PROGRESS' : 'COMPLETED' } };
    if (req.url.startsWith('https://queue.fal.run/')) return { status: 200, body: output };
    if (/fal\.media/.test(req.url)) return { status: 200, body: fresh() };
    return { status: 404, body: {} };
  };
}

test('fal.ai: the queue (Authorization: Key, the model\'s fields, the product first then the style photos as data URIs, the shape), polled, the result as a data URI', async () => {
  await settings.updateSettings('ai', { picturesProvider: 'fal', falApiKey: FAL, falModel: 'fal-ai/nano-banana/edit' });
  await saveStylePhotos(2);
  reply = falQueue({ images: [{ url: `data:image/png;base64,${fresh().toString('base64')}`, content_type: 'image/png' }] });
  const r = await stage.stagePhoto({ image: PHOTO_URL, preset: 'lifestyle' }, 'owner@s.t');
  const submit = seen[0];
  assert.equal(submit.url, 'https://queue.fal.run/fal-ai/nano-banana/edit');
  assert.equal(submit.headers.authorization, `Key ${FAL}`);
  const input = JSON.parse(submit.body.toString('utf8'));
  assert.deepEqual(Object.keys(input).sort(), ['aspect_ratio', 'image_urls', 'prompt', 'sync_mode']);
  assert.equal(input.aspect_ratio, '4:5');
  assert.equal(input.sync_mode, true);
  assert.equal(input.image_urls.length, 3);
  assert.equal(input.image_urls[0], PHOTO_URL, 'the product first');
  assert.ok(input.image_urls.slice(1).every((u: string) => /^data:image\/png;base64,/.test(u)));
  assert.match(input.prompt, /Images 2–3 are style references/);
  assert.ok(input.prompt.endsWith(staging.STAGING_FIXED_RULES.at(-1)!));
  assert.ok(seen.some((s) => s.url.endsWith('/status')), 'polled');
  assert.equal(seen.at(-1)!.url, 'https://queue.fal.run/fal-ai/nano-banana/requests/764cabcf-b745-4b3e-ae38-1200304cf45b');
  assert.ok(seen.every((s) => s.headers.authorization === `Key ${FAL}`));
  assert.equal(r.provider, 'fal');
  // FLUX.2 edit: at most 4 pictures in all, and its own size field.
  await settings.updateSettings('ai', { falModel: 'fal-ai/flux-2/edit' });
  await saveStylePhotos(5);
  seen = [];
  reply = falQueue({ images: [{ url: 'https://v3b.fal.media/files/b/0a98f887/YYbm6L.png' }] });
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, 'owner@s.t');
  const flux = JSON.parse(seen[0].body.toString('utf8'));
  assert.equal(flux.image_urls.length, 4);
  assert.deepEqual(flux.image_size, { width: 1024, height: 1280 });
  assert.match(flux.prompt, /Images 2–4 are style references/);
  // The result from fal's CDN: fetched without the key.
  const download = seen.find((s) => s.url.startsWith('https://v3b.fal.media/'))!;
  assert.equal(download.headers.authorization, undefined);
  // Any fal model typed by the owner: image_urls, no shape.
  assert.deepEqual(Object.keys(fal.falInput('someone/new-edit-model', 'p', ['a'], '4:5')).sort(), ['image_urls', 'prompt', 'sync_mode']);
  assert.deepEqual(fal.falInput('fal-ai/flux-pro/kontext/max/multi', 'p', ['a'], '4:5').aspect_ratio, '3:4');
});

test('fal.ai: a result (or a queue address) off fal\'s hosts is refused and never fetched; errors in plain words', async () => {
  await settings.updateSettings('ai', { picturesProvider: 'fal', falApiKey: FAL, falModel: 'fal-ai/nano-banana/edit' });
  const go = () => stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, `fal${Math.random()}@s.t`);
  for (const url of ['https://evil.example/x.png', 'https://fal.media.evil.example/x.png', 'http://v3.fal.media/x.png', 'https://169.254.169.254/latest']) {
    seen = [];
    reply = falQueue({ images: [{ url }] });
    await rejects(go(), 'ai_bad_reply', /does not trust/);
    assert.ok(!seen.some((s) => s.url === url), `never fetched: ${url}`);
  }
  // A status address off fal's queue host is ignored (the shop builds its own).
  seen = [];
  reply = falQueue({ images: [{ url: `data:image/png;base64,${fresh().toString('base64')}` }] }, { statusUrl: 'https://evil.example/status' });
  await go();
  assert.ok(seen.every((s) => new URL(s.url).hostname === 'queue.fal.run'));
  // The transport itself refuses any host but the services'.
  await assert.rejects(transport.picFetch({ method: 'GET', url: 'https://example.com/', headers: {}, timeoutMs: 1000, maxBytes: 10 }), /does not trust/);
  reply = () => ({ status: 401, body: { detail: 'Authentication is required to perform this action.' } });
  await rejects(go(), 'ai_key_refused', /fal\.ai did not accept the key/);
  reply = () => ({ status: 403, body: { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' } });
  await rejects(go(), 'ai_no_balance', /credit is used up/);
  reply = () => ({ status: 422, body: { detail: [{ loc: ['body', 'prompt'], msg: 'The content could not be processed because it contained material flagged by a content checker.', type: 'content_policy_violation' }] } });
  await rejects(go(), 'ai_refused', /would not make this picture/);
  reply = () => ({ status: 429, body: { detail: 'Too many requests' } });
  await rejects(go(), 'ai_busy', /limit for your account/);
  transport._setPicturesTransport(async () => {
    throw Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' });
  });
  await rejects(go(), 'ai_timeout', /fal\.ai took too long/);
});

test('fal.ai Test: the curated models fal lists, with the key', async () => {
  reply = () => ({ status: 200, body: { models: [{ endpoint_id: 'fal-ai/nano-banana/edit' }, { endpoint_id: 'fal-ai/flux-2/edit' }], has_more: false } });
  const t = await stage.testPictures('fal', { falApiKey: FAL }, 'owner@s.t');
  assert.deepEqual(t.models.image, ['fal-ai/nano-banana/edit', 'fal-ai/flux-2/edit']);
  assert.match(seen[0].url, /^https:\/\/api\.fal\.ai\/v1\/models\?endpoint_id=fal-ai%2Fnano-banana%2Fedit&/);
  assert.equal(seen[0].headers.authorization, `Key ${FAL}`);
  reply = () => ({ status: 401, body: { detail: 'Invalid key' } });
  await assert.rejects(stage.testPictures('fal', { falApiKey: FAL }, 'owner@s.t'), /did not accept the key/);
  await assert.rejects(stage.testPictures('fal', { falApiKey: 'nocolon' }, 'owner@s.t'), /key-id:key-secret/);
});

// ── style photos ───────────────────────────────────────────────────────────

test('style photos with Gemini: the product first, then the style photos in order, the roles named; none when none are saved, per scene, per batch; each picture counts once', async () => {
  await settings.updateSettings('ai', { picturesProvider: 'gemini', geminiApiKey: GEMINI });
  // None saved: no references, no roles.
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, 'owner@s.t');
  let partsSent = (geminiSent[0].contents as Array<{ parts: Array<{ text?: string; inlineData?: { data: string } }> }>)[0].parts;
  assert.equal(partsSent.length, 2);
  assert.ok(!/Image 1 is the product/.test(partsSent[0].text!));
  const refs = await saveStylePhotos(3);
  geminiSent = [];
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, 'owner@s.t');
  partsSent = (geminiSent[0].contents as Array<{ parts: Array<{ text?: string; inlineData?: { data: string } }> }>)[0].parts;
  assert.equal(partsSent.length, 5, 'the prompt, the product and 3 style photos');
  assert.equal(partsSent[1].inlineData!.data, PHOTO.toString('base64'));
  refs.forEach((u, i) => assert.equal(partsSent[2 + i].inlineData!.data, readImage(u.slice('/api/images/'.length))!.bytes.toString('base64'), `style photo ${i + 1}`));
  assert.match(partsSent[0].text!, /^Edit the first photograph \(image 1\)/);
  assert.match(partsSent[0].text!, /Image 1 is the product: copy its bedding exactly\. Images 2–4 are style references/);
  assert.ok(partsSent[0].text!.indexOf('Images 2–4') < partsSent[0].text!.indexOf('These rules come first'));
  // Per batch (the studio's switch): off.
  geminiSent = [];
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed', useReferences: false }, 'owner@s.t');
  assert.equal((geminiSent[0].contents as Array<{ parts: unknown[] }>)[0].parts.length, 2);
  // Per scene: "this scene description only".
  const scenes = settings.getSettings('aiPictures').scenes.map((s) => (s.id === 'close-up' ? { ...s, style: 'scene' } : s));
  await settings.updateSettings('aiPictures', { scenes });
  geminiSent = [];
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'close-up' }, 'owner@s.t');
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, 'owner@s.t');
  assert.equal((geminiSent[0].contents as Array<{ parts: unknown[] }>)[0].parts.length, 2, 'close-up: the description only');
  assert.equal((geminiSent[1].contents as Array<{ parts: unknown[] }>)[0].parts.length, 5, 'whole bed: with the style photos');
  // Switched off in Settings: none.
  await settings.updateSettings('aiPictures', { useReferences: false });
  geminiSent = [];
  await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, 'owner@s.t');
  assert.equal((geminiSent[0].contents as Array<{ parts: unknown[] }>)[0].parts.length, 2);
  assert.equal(await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed', useReferences: 'yes' }, 'owner@s.t').then(() => 200, (e: { status: number }) => e.status), 400);
  // Each picture counts once against the hour's 30, style photos or not.
  _clearAllRateLimits();
  await settings.updateSettings('aiPictures', { useReferences: true });
  for (let i = 0; i < 30; i++) await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, 'count@s.t');
  assert.equal(await stage.stagePhoto({ image: PHOTO_URL, preset: 'whole-bed' }, 'count@s.t').then(() => 200, (e: { status: number }) => e.status), 429);
});

test('style photos: metadata (EXIF, GPS, text) taken out, size-capped, at most 5, only stored pictures; audited when changed', async () => {
  const src = styleSource(7);
  assert.ok(src.includes(Buffer.from('25.2048,55.2708')));
  const { url } = stage.uploadStylePhoto({ image: `data:image/png;base64,${src.toString('base64')}` }, 'owner@s.t');
  const stored = readImage(url.slice('/api/images/'.length))!.bytes;
  assert.ok(!stored.includes(Buffer.from('eXIf')) && !stored.includes(Buffer.from('25.2048')) && !stored.includes(Buffer.from('taken at home')), 'EXIF, GPS and comments gone');
  assert.ok(stored.includes(Buffer.from('IDAT')));
  const status = (fn: () => unknown) => Promise.resolve().then(fn).then(() => 200, (e: { status: number }) => e.status);
  const big = Buffer.concat([src.subarray(0, src.length - 12), chunk('IDAT', Buffer.alloc(1.6 * 1024 * 1024)), src.subarray(src.length - 12)]);
  assert.equal(await status(() => stage.uploadStylePhoto({ image: `data:image/png;base64,${big.toString('base64')}` }, 'owner@s.t')), 413);
  assert.equal(await status(() => stage.uploadStylePhoto({ image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, 'owner@s.t')), 400);
  assert.equal(await status(() => stage.uploadStylePhoto({ image: PHOTO_URL, extra: 1 }, 'owner@s.t')), 400);
  // The list: stored pictures only, at most 5.
  const urls = await saveStylePhotos(5);
  assert.equal(await status(() => settings.updateSettings('aiPictures', { references: [...urls, url] })), 400);
  assert.equal(await status(() => settings.updateSettings('aiPictures', { references: [`/api/images/${'c'.repeat(64)}.png`] })), 400);
  assert.equal(await status(() => settings.updateSettings('aiPictures', { references: ['https://evil.example/x.png'] })), 400);
  assert.ok(auditEntry('settings.ai_style_photo_uploaded'));
});

test('backups carry the style photos (the files and the list); the restore script restores them', async () => {
  delete process.env.BACKUP_PASSPHRASE;
  const urls = await saveStylePhotos(2);
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-style-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  for (const u of urls) {
    const name = u.slice('/api/images/'.length);
    assert.deepEqual(fs.readFileSync(path.join(target, 'images', name)), readImage(name)!.bytes, name);
  }
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    const row = JSON.parse((db.prepare("SELECT data FROM settings WHERE key = 'aiPictures'").get() as { data: string }).data);
    assert.deepEqual(row.references, urls);
    assert.equal(row.useReferences, true);
  } finally {
    db.close();
  }
});

test('review: restoring an AI version from before AI pictures keeps today’s picture choices; a style photo whose file is gone is left out of a restore', async () => {
  const { getDb } = await import('@/lib/server/db');
  await settings.updateSettings('ai', { openaiApiKey: OPENAI, picturesProvider: 'openai', openaiImageModel: 'gpt-image-1', falModel: 'fal-ai/flux-2/edit' });
  // A version saved by the release before (no picture fields).
  const oldAi = { ...settings.getSettings('ai') } as Record<string, unknown>;
  for (const f of ['picturesProvider', 'openaiImageModel', 'falModel', 'openaiApiKey', 'falApiKey']) delete oldAi[f];
  const db = getDb();
  const aiId = Number(db.prepare('INSERT INTO settings_history (key, data, saved_at) VALUES (?, ?, ?)').run('ai', JSON.stringify(oldAi), new Date().toISOString()).lastInsertRowid);
  await settings.restoreSettingsVersion(aiId);
  const ai = settings.getSettings('ai');
  assert.equal(ai.picturesProvider, 'openai');
  assert.equal(ai.openaiImageModel, 'gpt-image-1');
  assert.equal(ai.falModel, 'fal-ai/flux-2/edit');

  // A pictures version naming a style photo that is no longer stored: the rest still comes back.
  const kept = saveImageDataUrl(PHOTO_URL);
  const pics = { ...settings.getSettings('aiPictures'), references: [kept, '/api/images/0123456789abcdef0123456789abcdef.png'] };
  const picId = Number(db.prepare('INSERT INTO settings_history (key, data, saved_at) VALUES (?, ?, ?)').run('aiPictures', JSON.stringify(pics), new Date().toISOString()).lastInsertRowid);
  await settings.restoreSettingsVersion(picId);
  assert.deepEqual(settings.getSettings('aiPictures').references, [kept]);
});
