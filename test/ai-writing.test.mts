/**
 * "Write from photo" (src/lib/server/aiWriting.ts) with Anthropic replaced by a stand-in: the
 * request sent (fixed address, headers, the image as a base64 block, the model, no key in the body),
 * the answer parsed and cut to size, a bad answer refused clearly, Anthropic's errors made readable
 * without the key, the key never in a reply or a log, the 20-an-hour limit, the audit entry, and
 * Settings → AI writing (write-only key shown as ••••last4, off until a key is saved).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const settings = await import('@/lib/server/settings');
const ai = await import('@/lib/server/aiWriting');
const { saveImageDataUrl } = await import('@/lib/server/images');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { redact } = await import('@/lib/server/log');

const KEY = 'sk-ant-api03-TESTKEY-abcdefghijklmnopqrstuvwxyz0123456789-WXYZ';

/** A tiny PNG (signature + IHDR saying 64 × 64): enough for the shop's image checks. */
function png(): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(64, 8);
  ihdr.writeUInt32BE(64, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(40)]);
}
const PNG_URL = `data:image/png;base64,${png().toString('base64')}`;

interface Sent {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}
let sent: Sent[] = [];
let answer: { status: number; data: unknown } = { status: 200, data: null };
const reply = (obj: unknown, extra: Record<string, unknown> = {}) => ({ status: 200, data: { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], stop_reason: 'end_turn', ...extra } });

/** Everything the server logs while fn runs. */
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

beforeEach(async () => {
  _clearAllRateLimits();
  sent = [];
  answer = reply({ title: 'Indigo Garden Hand Block Set', shortDescription: 'Hand-stamped indigo florals on a soft white ground.', description: 'A quiet garden of indigo blooms.\n\nEach motif is stamped by hand.', colors: [{ name: 'Indigo', hex: '#3F4A8A' }, 'white'], weave: 'percale', motif: 'Hand block floral' });
  ai._setAnthropicTransport(async (body, headers) => {
    sent.push({ body: JSON.parse(body), headers });
    return { ...answer, ok: answer.status >= 200 && answer.status < 300 };
  });
  await settings.updateSettings('ai', { anthropicApiKey: KEY, enabled: true, model: 'claude-sonnet-5-5' });
});
afterEach(() => ai._setAnthropicTransport(null));

test('AI writing is off and keyless by default; switching it on needs a key; the key is write-only and shown as ••••last4', async () => {
  await settings.updateSettings('ai', { anthropicApiKey: null });
  assert.equal(settings.getSettings('ai').enabled, false, 'clearing the key switches it off');
  await assert.rejects(settings.updateSettings('ai', { enabled: true }), /Add your Anthropic API key/);
  await assert.rejects(settings.updateSettings('ai', { anthropicApiKey: 'not-a-key' }), /starts with sk-ant-/);
  await assert.rejects(settings.updateSettings('ai', { model: 'gpt-4' }), /Model: one of/);
  await settings.updateSettings('ai', { anthropicApiKey: KEY, enabled: true, model: 'claude-haiku-5-5' });
  const view = settings.adminView('ai');
  assert.equal(view.value.anthropicApiKey, '');
  assert.equal(view.secretsSet.anthropicApiKey, true);
  assert.equal(view.secretsHint?.anthropicApiKey, '••••WXYZ');
  assert.ok(!JSON.stringify(view).includes('TESTKEY'));
  // An autosave without the key keeps it.
  await settings.updateSettings('ai', { model: 'claude-opus-5-5', anthropicApiKey: '' }, { auto: true });
  assert.equal(settings.getSettings('ai').anthropicApiKey, KEY);
  assert.deepEqual(ai.aiStatus(), { ready: true, reason: null, provider: 'anthropic', model: 'claude-opus-5-5' });
});

test('the request: fixed address, Anthropic headers, the photo as a base64 block, the hints as given, the key only in x-api-key', async () => {
  const s = await ai.describeProduct({ image: PNG_URL, hints: { category: 'bedsheets', material: '100% Cotton', threadCount: 300, weave: 'Percale', colors: ['Indigo'], evil: '<script>' } }, 'owner@shop.test');
  assert.equal(ai.ANTHROPIC_URL, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.length, 1);
  const { body, headers } = sent[0];
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.ok(Number(body.max_tokens) <= 4096);
  assert.ok(!JSON.stringify(body).includes(KEY), 'the key is never in the body');
  const content = (body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png().toString('base64') } });
  const prompt = String(content[1].text);
  assert.match(prompt, /"material":"100% Cotton"/);
  assert.match(prompt, /"threadCount":300/);
  assert.match(prompt, /"category":"Hand Block Sets"/, 'the category by its name');
  assert.ok(!prompt.includes('<script>'), 'unknown hints are dropped');
  assert.match(String(body.system), /British English/);
  assert.match(String(body.system), /Never state a thread count, material/);
  // The answer: weave matched to the shop's list, colours with swatches.
  assert.equal(s.title, 'Indigo Garden Hand Block Set');
  assert.equal(s.weave, 'Percale');
  assert.deepEqual(s.colors, [{ name: 'Indigo', hex: '#3f4a8a' }, { name: 'White', hex: '#ffffff' }]);
  assert.equal(s.description, 'A quiet garden of indigo blooms.\n\nEach motif is stamped by hand.');
});

test('a stored product photo is read from disk; Haiku goes without fallbacks; https photos go by address', async () => {
  const url = saveImageDataUrl(PNG_URL);
  await settings.updateSettings('ai', { model: 'claude-haiku-5-5' });
  await ai.describeProduct({ imageId: url.slice('/api/images/'.length) }, 'owner@shop.test');
  assert.equal(sent[0].body.model, 'claude-haiku-5-5');
  assert.equal(sent[0].body.fallbacks, undefined);
  assert.equal(sent[0].headers['anthropic-beta'], undefined);
  const block = (sent[0].body.messages as Array<{ content: Array<{ source: Record<string, unknown> }> }>)[0].content[0];
  assert.equal(block.source.data, png().toString('base64'));
  await ai.describeProduct({ imageUrl: 'https://images.example.com/sheet.jpg' }, 'owner@shop.test');
  assert.deepEqual((sent[1].body.messages as Array<{ content: Array<{ source: unknown }> }>)[0].content[0].source, { type: 'url', url: 'https://images.example.com/sheet.jpg' });
});

test('bad photos are refused before anything is sent: wrong type, not an image, unknown stored name, plain http', async () => {
  const status = async (body: Record<string, unknown>) => ai.describeProduct(body, 'owner@shop.test').then(() => 200, (e: { status?: number }) => e.status ?? -1);
  assert.equal(await status({ image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }), 400);
  assert.equal(await status({ image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }), 400);
  assert.equal(await status({ image: `data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}` }), 400);
  assert.equal(await status({ image: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4 * 1024 * 1024)]).toString('base64')}` }), 413);
  assert.equal(await status({ imageId: '../../etc/passwd' }), 400);
  assert.equal(await status({ imageId: `${'a'.repeat(64)}.png` }), 404);
  assert.equal(await status({ imageUrl: 'http://169.254.169.254/latest' }), 400);
  assert.equal(await status({}), 400);
  assert.equal(await status({ image: PNG_URL, extra: 1 }), 400, 'fields are allow-listed');
  assert.equal(sent.length, 0);
});

test('every field is checked and cut to size: lengths, markup, emoji, control characters, unknown weave, at most 4 colours', async () => {
  answer = reply(
    '```json\n' +
      JSON.stringify({
        title: `<b>Royal</b> ✨ Mughal Garden ${'Velvet '.repeat(20)}`,
        shortDescription: `Line one\nline two ${'soft '.repeat(60)}`,
        description: `${'A long sentence about the print. '.repeat(40)}\n\nSecond.\n\nThird.\n\nFourth paragraph dropped.`,
        colors: ['Gold', 'Ivory', 'Rose', 'Sage', 'Navy', '<img src=x>', 42],
        weave: 'Waffle',
        motif: 'paisley\u0007',
      }) +
      '\n```'
  );
  const s = await ai.describeProduct({ image: PNG_URL }, 'owner@shop.test');
  assert.ok(s.title.length <= 60, s.title);
  assert.ok(!/[<>✨]/.test(s.title), s.title);
  assert.ok(s.title.startsWith('Royal Mughal Garden'), s.title);
  assert.ok(s.shortDescription.length <= 140 && !s.shortDescription.includes('\n'));
  assert.ok(s.description.length <= 1200);
  assert.ok(!s.description.includes('Fourth'));
  assert.equal(s.colors.length, 4);
  assert.equal(s.weave, null, 'a weave the shop does not have is not offered');
  assert.equal(s.motif, 'paisley');
});

test('an answer that is not the JSON asked for is a clear error; refusals and cut-off answers too', async () => {
  answer = reply('Sorry, I cannot help with that.');
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'o@s.t'), (e: { status: number; message: string; details: { code: string } }) => e.status === 502 && /could not be read/.test(e.message) && e.details.code === 'ai_bad_reply');
  answer = reply('{"title": "Half', { stop_reason: 'max_tokens' });
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'o@s.t'), /cut short/);
  answer = reply('{}');
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'o@s.t'), /empty/);
  answer = { status: 200, data: { content: [], stop_reason: 'refusal' } };
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'o@s.t'), /would not describe this photo/);
});

test('Anthropic errors are readable and never carry the key, in the reply or the logs', async () => {
  answer = { status: 401, data: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } } };
  const { result, logs } = await logsOf(() => ai.describeProduct({ image: PNG_URL }, 'o@s.t'));
  const e = result as unknown as { status: number; message: string; details: Record<string, unknown> };
  assert.equal(e.status, 502);
  assert.match(e.message, /did not accept the API key/);
  const everything = JSON.stringify({ message: e.message, details: e.details }) + logs;
  assert.ok(!everything.includes('TESTKEY'), everything);
  assert.ok(!everything.includes(KEY.slice(10)));
  answer = { status: 400, data: { error: { type: 'invalid_request_error', message: `messages.0: image too small (key ${KEY})` } } };
  const r2 = await logsOf(() => ai.describeProduct({ image: PNG_URL }, 'o@s.t'));
  assert.match((r2.result as Error).message, /^Anthropic said: messages\.0: image too small/);
  assert.ok(!((r2.result as Error).message + r2.logs).includes('TESTKEY'));
  // The log masks any Anthropic key, wherever it appears.
  assert.ok(!JSON.stringify(redact({ note: `failed with ${KEY}` })).includes('TESTKEY'));
  ai._setAnthropicTransport(async () => {
    throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
  });
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'o@s.t'), (err: { status: number }) => err.status === 504);
});

test('without a key, or switched off, nothing is sent and the owner is told where to switch it on', async () => {
  await settings.updateSettings('ai', { enabled: false });
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'o@s.t'), (e: { status: number; message: string }) => e.status === 409 && /switched off/.test(e.message));
  await settings.updateSettings('ai', { anthropicApiKey: null });
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'o@s.t'), /Add your AI key in Settings → AI writing/);
  assert.equal(ai.aiStatus().reason, 'no_key');
  assert.equal(sent.length, 0);
});

test('20 descriptions an hour per admin, then 429 (another admin is not affected)', async () => {
  for (let i = 0; i < 20; i++) await ai.describeProduct({ image: PNG_URL }, 'a@shop.test');
  await assert.rejects(ai.describeProduct({ image: PNG_URL }, 'a@shop.test'), (e: { status: number; headers: Record<string, string> }) => e.status === 429 && Number(e.headers['Retry-After']) > 0);
  assert.equal(sent.length, 20);
  await ai.describeProduct({ image: PNG_URL }, 'b@shop.test');
});

test('each description is in the audit log, without the photo or the key', async () => {
  await ai.describeProduct({ image: PNG_URL }, 'audit@shop.test');
  const log = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  const entry = log.trim().split('\n').map((l) => JSON.parse(l)).reverse().find((e) => e.action === 'product.ai_described');
  assert.ok(entry, 'audited');
  assert.equal(entry.details.by, 'audit@shop.test');
  assert.equal(entry.details.photo, 'upload');
  assert.ok(!log.includes(png().toString('base64').slice(0, 40)), 'no image data');
  assert.ok(!log.includes('TESTKEY'));
});

test('Test: a tiny call with the typed key or the saved one; failures say why', async () => {
  answer = reply('OK');
  const r = await ai.testAiSettings({ model: 'claude-haiku-5-5' }, 'o@s.t');
  assert.deepEqual(r, { ok: true, model: 'claude-haiku-5-5' });
  assert.equal(sent[0].headers['x-api-key'], KEY, 'the saved key');
  assert.ok(Number(sent[0].body.max_tokens) <= 64);
  const other = 'sk-ant-api03-OTHERKEY-abcdefghijklmnopqrstuvwxyz';
  await ai.testAiSettings({ anthropicApiKey: other, model: 'claude-sonnet-5-5' }, 'o@s.t');
  assert.equal(sent[1].headers['x-api-key'], other, 'the typed key');
  answer = { status: 401, data: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
  await assert.rejects(ai.testAiSettings({}, 'o@s.t'), /did not accept the API key/);
  await assert.rejects(ai.testAiSettings({ anthropicApiKey: 'nope' }, 'o@s.t'), /starts with sk-ant-/);
});
