/**
 * The owner-editable prompts and the Picture studio against the production build, in Chromium at
 * 375 px and 1280 px, with Google Gemini and Anthropic replaced by stand-ins on 127.0.0.1
 * (BUH_TEST_GEMINI_API, BUH_TEST_ANTHROPIC_API, loopback only):
 * - Inventory → Make pictures without a Gemini key: the studio shows the steps to get one and a
 *   button to Settings → AI pictures (never a silent failure);
 * - Settings → AI writing → Prompt: edit the instructions and a field guide, Save, Preview (the
 *   owner's words first, the fixed rules after), Reset, and Try on a photo (the unsaved prompt sent,
 *   nothing saved, the photo and the result side by side);
 * - Settings → AI pictures: the steps without a key, the key typed and tested (the image models
 *   listed), the status line, Save; the scenes edited, reordered, the default trio changed, a scene
 *   added, saved; the picture prompt previewed;
 * - Inventory → Make pictures → the studio → 3 pictures → Add one → it shows in the product's photos
 *   (and on the server).
 * Every check: no sideways scroll, no page errors, text boxes at least 16 px on a phone (no zoom on
 * iPhones), the keyboard works. Screenshots go to BUH_SHOTS_DIR when it is set. Skipped without a
 * build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { bedroomPng, chunk } from './fixtures/png.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const KEY = 'AIzaSyPROMPTKEY-abcdefghijklmnopqrstu-W4XY';
const ANTHROPIC_KEY = 'sk-ant-api03-PROMPTKEY-abcdefghijklmnopqrstuvwxyz0123456789-ABCD';
const SHOTS = process.env.BUH_SHOTS_DIR || '';
const TITLE = 'Indigo Studio Test Set';

let made = 0;
const staged = () => {
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(2835 + ++made, 0);
  phys.writeUInt32BE(2835, 4);
  phys[8] = 1;
  return bedroomPng(320, 400, [chunk('pHYs', phys)]);
};
const MODELS = {
  models: [
    { name: 'models/gemini-3.1-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-pro-image', supportedGenerationMethods: ['generateContent'] },
  ],
};
const SUGGESTION = {
  title: 'Indigo Chevron Hand Block Print Bed Set',
  shortDescription: 'Hand-stamped indigo chevrons on a soft white ground.',
  design: 'Indigo chevrons run across a soft white ground, calm and crisp.',
  comfort: 'It looks soft and matte, lovely for warm nights.',
  closing: 'A calm bedroom, every night.',
  highlights: ['Hand block printed chevrons', 'Soft matte look', 'Pairs with white furniture'],
  giftLine: '',
  colors: [{ name: 'Indigo', hex: '#3f4a8a' }],
  weave: null,
  motif: 'Chevron',
};

let google: http.Server;
let anthropic: http.Server;
const pictureCalls: string[] = [];
/** How many pictures each Gemini call carried (the product, then the style photos). */
const pictureImages: number[] = [];
const openaiCalls: Array<{ images: number; prompt: string; auth: string }> = [];
let openai: http.Server;
const OPENAI_KEY = 'sk-proj-STUDIOKEY-abcdefghijklmnopqrstuvwxyz0123-QRST';
const writerCalls: Array<{ system: string; user: string }> = [];
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
let productId = '';
let photoUrl = '';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

let checkMode: 'match' | 'mismatch' | 'down' = 'match';

before(async () => {
  if (skip) return;
  google = http.createServer(async (req, res) => {
    const text = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-goog-api-key'] !== KEY) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
    }
    if (req.method === 'GET' && req.url === '/v1beta/models?pageSize=1000') return res.end(JSON.stringify(MODELS));
    // The check on every picture: matches, doesn't match (the pillow covers), or Google is down (not checked).
    if (req.method === 'POST' && text.includes('You are the strict quality check')) {
      if (checkMode === 'down') {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }));
      }
      const v = checkMode === 'match' ? { samePrint: true, sameColours: true, pillowCovers: true, extraItems: false, reason: 'matches' } : { samePrint: true, sameColours: true, pillowCovers: false, extraItems: false, reason: 'the pillow covers are missing' };
      return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(v) }] }, finishReason: 'STOP' }] }));
    }
    if (req.method === 'POST' && /^\/v1beta\/models\/gemini-[a-z0-9.-]+-image:generateContent$/.test(req.url!)) {
      const parts = JSON.parse(text).contents[0].parts as Array<{ text?: string; inlineData?: unknown }>;
      pictureCalls.push(String(parts[0].text));
      pictureImages.push(parts.filter((x) => x.inlineData).length);
      return setTimeout(() => res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: staged().toString('base64') } }] }, finishReason: 'STOP' }] })), 300);
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }));
  });
  anthropic = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { system?: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    writerCalls.push({ system: String(body.system ?? ''), user: body.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(SUGGESTION) }], stop_reason: 'end_turn' }));
  });
  openai = http.createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${OPENAI_KEY}`) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } }));
    }
    if (req.method === 'GET' && req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-4.1' }, { id: 'gpt-image-2.5-sunburst' }, { id: 'gpt-image-2.5-flare' }] }));
    if (req.method === 'POST' && req.url === '/v1/images/edits') {
      const prompt = /name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(body)?.[1] ?? '';
      openaiCalls.push({ images: body.split('name="image[]"').length - 1, prompt, auth: String(req.headers.authorization) });
      return setTimeout(() => res.end(JSON.stringify({ created: 1, data: [{ b64_json: staged().toString('base64') }] })), 200);
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise<void>((r) => openai.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => google.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => anthropic.listen(0, '127.0.0.1', () => r()));
  server = await startServer({
    BUH_TEST_GEMINI_API: `http://127.0.0.1:${(google.address() as AddressInfo).port}/`,
    BUH_TEST_ANTHROPIC_API: `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}/`,
    BUH_TEST_OPENAI_API: `http://127.0.0.1:${(openai.address() as AddressInfo).port}/`,
  });
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Prompt-Studio-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  // Claude writes (no Gemini key yet); one product with a real photo.
  const ai = await api('PUT', '/api/admin/settings/ai', { settings: { provider: 'anthropic', anthropicApiKey: ANTHROPIC_KEY, enabled: true } });
  assert.equal(ai.status, 200, await ai.clone().text());
  photoUrl = (await (await api('POST', '/api/admin/images', { image: PHOTO_URL })).json()).url;
  const sizes = (await (await api('GET', '/api/admin/settings')).json()).catalog.value.sizes.filter((s: { id: string }) => s.id === 'king');
  const created = await api('POST', '/api/admin/products', { product: { title: TITLE, category: 'bedsheets', price: 420, featuredImage: photoUrl, galleryImages: [], colors: [{ name: 'Indigo', hex: '#3f4a8a' }], profiles: sizes, defaultProfileId: 'king', stockBySize: { king: 3 }, active: true } });
  assert.equal(created.status, 201, await created.clone().text());
  productId = (await created.json()).product.id;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.stop();
  google?.close();
  anthropic?.close();
  openai?.close();
});

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

const PHOTO = fs.readFileSync(path.join('test/fixtures', 'sheet-indigo.png'));
const PHOTO_URL = `data:image/png;base64,${PHOTO.toString('base64')}`;

async function hub(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.getByRole('status').filter({ hasText: /Backup/ }).waitFor();
  return { ctx, page, errors };
}
async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}
/** On a phone, every text box in the area at least 16 px (iPhones zoom into smaller ones); laptops may use 14 px. */
async function smallText(page: Page, selector: string) {
  if ((page.viewportSize()?.width ?? 0) >= 640) return [];
  return page.evaluate((sel) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll(`${sel} input:not([type=checkbox]):not([type=radio]):not([type=file]), ${sel} textarea, ${sel} select`)) {
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) out.push(`${el.id || el.getAttribute('aria-label') || el.tagName}: ${size}px`);
    }
    return out;
  }, selector);
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}
async function openSettings(page: Page, section: string) {
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
  await page.getByRole('heading', { name: section, exact: true, level: 2 }).waitFor();
}
async function openStudio(page: Page) {
  await openAdminSection(page, /^Inventory/);
  await page.getByRole('searchbox', { name: 'Search name or SKU' }).or(page.getByLabel('Search name or SKU')).first().fill(TITLE);
  await page.getByRole('button', { name: `Stock and actions for ${TITLE}` }).click();
  await page.getByRole('button', { name: `Make pictures of ${TITLE}` }).click();
  const sheet = page.getByRole('dialog', { name: 'Picture studio' });
  await sheet.waitFor();
  return sheet;
}

test('Inventory → Make pictures without a Gemini key: the studio shows the steps and a button to Settings → AI pictures (375 and 1280 px)', { skip }, async () => {
  for (const width of [375, 1280]) {
    const { ctx, page, errors } = await hub(width);
    const sheet = await openStudio(page);
    const setup = sheet.getByTestId('studio-setup');
    await setup.waitFor();
    await setup.getByText('Pictures need a picture service and its key.').waitFor();
    assert.equal(await setup.getByRole('link', { name: /Google Gemini key/ }).getAttribute('href'), 'https://aistudio.google.com/apikey');
    assert.equal(await setup.getByRole('link', { name: /OpenAI .*key/ }).getAttribute('href'), 'https://platform.openai.com/api-keys');
    assert.equal(await setup.getByRole('link', { name: /fal\.ai .*key/ }).getAttribute('href'), 'https://fal.ai/dashboard/keys');
    assert.equal(await sheet.getByRole('button', { name: /^Make \d pictures?/ }).count(), 0, 'nothing to press that would fail');
    assert.deepEqual(await overflow(page), []);
    if (width === 375) await shot(page, 'studio-no-key-375');
    // The button goes straight to Settings → AI pictures (keyboard).
    await setup.getByRole('button', { name: 'Open Settings → AI pictures' }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'AI pictures', exact: true, level: 2 }).waitFor();
    await page.getByTestId('pictures-status').filter({ hasText: 'Choose a picture service' }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});

for (const width of [375, 1280]) {
  test(`Settings → AI writing → Prompt at ${width}px: edit, Save, Preview, Try on a photo (nothing saved), Reset`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'AI writing');
    const card = page.getByTestId('ai-prompt');
    await card.waitFor();
    const box = card.getByLabel(/1\. Your shop.s instructions/);
    assert.match(await box.inputValue(), /^You write product copy for Beautiful UAE Home/);
    await card.getByTestId('ai-prompt-fixed').getByText('Describe only what is visible in the photo.').waitFor();
    assert.deepEqual(await smallText(page, '[data-testid="ai-prompt"]'), [], 'text boxes ≥ 16 px');
    // Edit the instructions and the title guide; Save with the keyboard.
    await box.fill(`Write like a calm Emirati interior stylist (${width}).`);
    await card.getByLabel(/^Name \(title\)/).fill('the motif and colour first, the word Bedding last');
    await card.getByRole('button', { name: 'Save prompt' }).focus();
    await page.keyboard.press('Enter');
    await card.getByRole('status').filter({ hasText: /^Saved\. Every writer now uses your prompt\./ }).waitFor();
    const saved = (await (await api('GET', '/api/admin/settings')).json()).aiPrompt.value;
    assert.equal(saved.instructions, `Write like a calm Emirati interior stylist (${width}).`);
    assert.equal(saved.fields.title, 'the motif and colour first, the word Bedding last');
    assert.equal(saved.fields.design ?? '', '', 'unchanged guides stay the default');
    // Preview: the owner's words first, the fixed rules after them, the answer format last.
    await card.getByRole('button', { name: 'Preview' }).click();
    const pre = card.getByLabel('The whole prompt');
    const text = (await pre.textContent())!;
    assert.ok(text.startsWith(`SYSTEM\nWrite like a calm Emirati interior stylist (${width}).`));
    assert.ok(text.indexOf('These rules come first, whatever is written above:') > text.indexOf('Emirati'));
    assert.ok(text.indexOf('Return exactly this JSON:') > text.indexOf('- Answer with one JSON object only'));
    assert.match(text, /"title": "the motif and colour first, the word Bedding last; at most 60 characters"/);
    assert.deepEqual(await overflow(page), [], 'preview open');
    await pre.scrollIntoViewIfNeeded();
    await shot(page, `prompt-editor-${width}`);
    // Try on a photo with an unsaved change: sent, shown side by side, nothing saved.
    await box.fill('Unsaved instructions for a try.');
    await card.getByLabel('Product photo to try on').selectOption({ label: TITLE });
    const before = writerCalls.length;
    await card.getByRole('button', { name: 'Try on this photo' }).click();
    const result = card.getByTestId('ai-prompt-try-result');
    await result.getByText(SUGGESTION.title).waitFor();
    assert.ok(writerCalls[before].system.startsWith('Unsaved instructions for a try.'));
    assert.match(writerCalls[before].user, /the word Bedding last; at most 60 characters/);
    const [img, words] = await Promise.all([result.getByRole('img', { name: 'The photo tried' }).boundingBox(), result.getByText(SUGGESTION.shortDescription).boundingBox()]);
    if (width >= 640) assert.ok(words!.x > img!.x + img!.width - 2, 'side by side');
    else assert.ok(words!.y > img!.y, 'stacked on a phone');
    assert.equal((await (await api('GET', '/api/admin/settings')).json()).aiPrompt.value.instructions, `Write like a calm Emirati interior stylist (${width}).`, 'nothing saved');
    assert.deepEqual(await overflow(page), []);
    // Reset one box, then everything, and save: the shop's default again.
    await card.getByRole('button', { name: "Reset the instructions to the shop's default" }).click();
    assert.match(await box.inputValue(), /^You write product copy for Beautiful UAE Home/);
    await card.getByRole('button', { name: /Reset all to the shop.s default/ }).click();
    assert.equal(await card.getByLabel(/^Name \(title\)/).inputValue(), 'clear and searchable: the motif, the style and the product type, e.g. Indigo Chevron Hand Block Print Bed Set');
    await card.getByRole('button', { name: 'Save prompt' }).click();
    await card.getByRole('status').filter({ hasText: /default prompt is used/ }).waitFor();
    const reset = (await (await api('GET', '/api/admin/settings')).json()).aiPrompt.value;
    assert.equal(reset.instructions, '');
    assert.equal(reset.fields.title ?? '', '');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

for (const width of [375, 1280]) {
  test(`Settings → AI pictures at ${width}px: key steps, Test lists the image models, status, Save; scenes edited, reordered, the trio changed, a scene added; preview`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'AI pictures');
    const card = page.getByTestId('ai-pictures');
    await card.getByText(/DeepSeek and Claude can’t make pictures\)\. Your writing AI can stay Claude\./).waitFor();
    const statusLine = card.getByTestId('pictures-status');
    if (width === 375) {
      // No key yet: the steps, and the key typed, tested and saved.
      assert.equal(await statusLine.textContent().then((t) => t!.trim()), 'Choose a picture service');
      await card.getByRole('radio', { name: 'Google Gemini' }).check();
      assert.equal(await statusLine.textContent().then((t) => t!.trim()), 'Needs a Google Gemini key');
      assert.equal(await card.getByTestId('pictures-key-steps').getByRole('link', { name: /Create API key/ }).getAttribute('href'), 'https://aistudio.google.com/apikey');
      await card.getByLabel('Gemini API key').fill(KEY);
      await card.getByRole('button', { name: 'Test the Gemini key' }).click();
      await card.getByTestId('pictures-test-result').filter({ hasText: /^Works: Gemini offers 2 image models/ }).waitFor();
      assert.deepEqual(await card.getByLabel('Image model').locator('option').allTextContents(), ['gemini-3.1-flash-image', 'gemini-3-pro-image']);
      await statusLine.filter({ hasText: 'Key works, choose an image model' }).waitFor();
      await card.getByRole('button', { name: 'Save key and model' }).click();
      await statusLine.filter({ hasText: 'Ready (Gemini gemini-3.1-flash-image)' }).waitFor();
    } else {
      await statusLine.filter({ hasText: 'Ready' }).waitFor();
      assert.match((await card.getByLabel('Gemini API key').getAttribute('placeholder'))!, /^••••W4XY saved$/);
    }
    const ai = (await (await api('GET', '/api/admin/settings')).json()).ai;
    assert.equal(ai.secretsHint.geminiApiKey, '••••W4XY');
    assert.equal(ai.value.geminiImageModel, 'gemini-3.1-flash-image');
    assert.equal(ai.value.provider, 'anthropic', 'the writing AI stays');
    assert.deepEqual(await smallText(page, '[data-testid="ai-pictures"]'), [], 'text boxes ≥ 16 px');

    // Scenes: move the close-up up, rename it, swap lifestyle for Palm villa in the trio, add one.
    const scenes = card.getByTestId('pictures-scenes');
    await scenes.getByRole('button', { name: 'Move Close-up of print and texture up' }).click();
    const first = scenes.getByTestId('pictures-scene').first();
    assert.equal(await first.getByLabel('Name').inputValue(), 'Close-up of print and texture');
    await first.getByLabel('Name').fill(`Close-up (${width})`);
    await scenes.getByRole('checkbox', { name: 'Make with one press: Lifestyle — breakfast tray' }).uncheck();
    await scenes.getByRole('checkbox', { name: 'Make with one press: Palm villa' }).check();
    assert.ok(await scenes.getByRole('checkbox', { name: 'Make with one press: Hotel suite' }).isDisabled(), 'at most 3');
    await scenes.getByRole('button', { name: 'Add a scene' }).click();
    const added = scenes.getByTestId('pictures-scene').last();
    await added.getByLabel('Name').fill('Majlis guest room');
    await added.getByLabel(/^Scene/).fill('show the bedding on a bed in a calm majlis-style guest room with carved wood and soft daylight');
    // The look and mood, and the preview: scene and look first, the fixed rules last.
    await card.getByLabel('Look and mood (every picture)').fill('Golden-hour light, fresh jasmine, a calm and luxurious mood.');
    // The fixed prompt can be fine-tuned (reported: it should be editable); the set's pieces are always added after it.
    const fixed = card.getByTestId('pictures-fixed-prompt');
    assert.match(await fixed.inputValue(), /^Strict fidelity requirements:\n- Exact print and motif replication/);
    await fixed.fill(`${await fixed.inputValue()}\nKeep the pillow covers crisp and bright (${width}).`);
    assert.match(await card.getByTestId('pictures-locked').innerText(), /This set has no comforter: show none\.[\s\S]*never change the printed design or the colours of any piece/);
    // Festival scenes: listed and editable; the festival picture for new products off by default.
    await card.getByTestId('pictures-festivals').locator('summary').click();
    assert.equal(await card.getByTestId('pictures-festival-auto').isChecked(), false);
    assert.match(await card.getByLabel('Diwali', { exact: true }).inputValue(), /^a Diwali evening: clay diyas/);
    await card.getByLabel('Diwali', { exact: true }).fill(`rows of diyas on the windowsill (${width})`);
    assert.deepEqual(await overflow(page), [], 'fixed prompt and festival scenes: no sideways scroll');
    await card.getByRole('button', { name: 'Preview' }).click();
    const text = (await card.getByLabel('The whole picture prompt').textContent())!;
    assert.ok(text.indexOf('The look and mood: Golden-hour light') > 0);
    assert.ok(text.indexOf('These rules come first, whatever is written above:') > text.indexOf('Golden-hour'));
    assert.ok(text.includes(`anywhere in the image.\nKeep the pillow covers crisp and bright (${width}).\nThis set's pieces`), 'the owner’s fixed prompt, then the set’s pieces');
    assert.ok(text.trimEnd().endsWith('never change the printed design or the colours of any piece.'));
    await card.getByRole('button', { name: 'Save scenes and prompt' }).focus();
    await page.keyboard.press('Enter');
    await card.getByRole('status').filter({ hasText: /^Saved\. The studio offers these scenes now\./ }).waitFor();
    const pics = (await (await api('GET', '/api/admin/settings')).json()).aiPictures.value;
    assert.equal(pics.scenes[0].id, 'close-up');
    assert.equal(pics.scenes[0].name, `Close-up (${width})`);
    assert.deepEqual([...pics.defaultSet].sort(), ['close-up', 'palm-villa', 'whole-bed']);
    assert.equal(pics.scenes.at(-1).name, 'Majlis guest room');
    assert.equal(pics.look, 'Golden-hour light, fresh jasmine, a calm and luxurious mood.');
    assert.match(pics.fixedPrompt, new RegExp(`Keep the pillow covers crisp and bright \\(${width}\\)\\.$`));
    assert.deepEqual(pics.festivalScenes, { diwali: `rows of diyas on the windowsill (${width})` });
    assert.deepEqual(await overflow(page), []);
    await shot(page, `ai-pictures-${width}`);
    // Back to the shop's scenes (the studio test uses them).
    await card.getByRole('button', { name: /Reset to the shop.s scenes/ }).click();
    await card.getByRole('button', { name: "Reset the look and mood to the shop's default" }).click();
    await card.getByRole('button', { name: "Reset the fixed prompt to the shop's default" }).click();
    await card.getByLabel('Diwali', { exact: true }).fill('');
    await card.getByRole('button', { name: 'Save scenes and prompt' }).click();
    await card.getByRole('status').filter({ hasText: /^Saved\./ }).last().waitFor();
    await page.waitForTimeout(300);
    const back = (await (await api('GET', '/api/admin/settings')).json()).aiPictures.value;
    assert.deepEqual(back.defaultSet, ['whole-bed', 'close-up', 'lifestyle']);
    assert.equal(back.fixedPrompt, '', 'the default is stored as empty');
    assert.deepEqual(back.festivalScenes, {});
    assert.equal(back.look, '');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

for (const width of [375, 1280]) {
  test(`Inventory → Make pictures at ${width}px: the studio makes 3 pictures (the default trio), Add one: it shows in the product's photos and is saved`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    const sheet = await openStudio(page);
    const studio = sheet.getByTestId('picture-studio');
    for (const name of ['Whole bed — Dubai master bedroom', 'Close-up of print and texture', 'Lifestyle — breakfast tray']) assert.ok(await studio.getByRole('checkbox', { name }).isChecked(), name);
    assert.ok(await studio.getByRole('radio', { name: 'Photo 1 (cover)' }).isChecked());
    await studio.getByLabel('Your note (optional)').fill('soft morning light');
    assert.deepEqual(await smallText(page, '[data-testid="picture-studio"]'), [], 'text boxes ≥ 16 px');
    const gallery = sheet.getByTestId('product-gallery').locator('img');
    const startCount = await gallery.count();
    const before = pictureCalls.length;
    await studio.getByRole('button', { name: 'Make 3 pictures (Gemini)' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="picture-studio"] [data-testid="stage-result"] img[alt^="Styled photo"]').length === 3);
    assert.equal(pictureCalls.length - before, 3);
    assert.ok(pictureCalls.slice(before).every((p) => /soft morning light/.test(p) && /The look and mood: Make the product look its most beautiful/.test(p) && /These rules come first/.test(p)));
    const results = studio.getByTestId('stage-result');
    const boxes = await Promise.all([0, 1, 2].map((i) => results.nth(i).boundingBox()));
    if (width < 640) assert.ok(boxes[1]!.y > boxes[0]!.y, 'stacked on a phone');
    else assert.ok(Math.abs(boxes[1]!.y - boxes[0]!.y) < 2 && boxes[1]!.x > boxes[0]!.x, 'side by side');
    assert.deepEqual(await overflow(page), []);
    await studio.getByTestId('stage-results').scrollIntoViewIfNeeded();
    await shot(page, `studio-${width}`);
    // Add one: in the product's photos at once, first (the owner's photo last, the default), and saved on the server.
    const url = (await studio.getByRole('img', { name: 'Styled photo: Close-up of print and texture' }).getAttribute('src'))!;
    await studio.getByRole('button', { name: 'Add to gallery: Close-up of print and texture' }).click();
    await studio.getByText(/Added to the photos/).waitFor();
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="product-gallery"] img').length === n, startCount + 1);
    const shown = await sheet.getByTestId('product-gallery').locator('img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')));
    assert.ok(shown.indexOf(url) >= 0 && shown.indexOf(url) < shown.indexOf(photoUrl), 'the AI picture before the owner’s photo');
    assert.equal(shown.at(-1), photoUrl, 'the owner’s photo last');
    const product = (await (await api('GET', '/api/admin/products')).json()).products.find((p: { id: string }) => p.id === productId);
    assert.ok(product.stagedPhotos[product.featuredImage], 'an AI picture is the cover');
    assert.equal(product.galleryImages.at(-1), photoUrl, 'the owner’s photo last');
    assert.equal(product.stagedPhotos[url].staged, true);
    // Reported: pictures not true to the product must never be published. At one width (each try
    // counts in the 30 an hour): made again, still without the pillow covers, it is marked and can't
    // be added; not checked (Google down), it is added only once the owner confirms it.
    const strict = width < 640;
    if (strict) {
      checkMode = 'mismatch';
      await studio.getByRole('button', { name: 'Try again: Whole bed — Dubai master bedroom' }).click();
      await studio.getByTestId('stage-mismatch').getByText(/Doesn’t match the product: the pillow covers are missing\. It can’t be added/).waitFor();
      assert.ok(await studio.getByRole('button', { name: 'Add to gallery: Whole bed — Dubai master bedroom' }).isDisabled());
      checkMode = 'down';
      await studio.getByRole('button', { name: 'Try again: Lifestyle — breakfast tray' }).click();
      await studio.getByTestId('stage-unchecked').waitFor();
      let asked = '';
      page.once('dialog', (d) => {
        asked = d.message();
        void d.accept();
      });
      await studio.getByRole('button', { name: 'Add to gallery: Lifestyle — breakfast tray' }).click();
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="product-gallery"] img').length === n, startCount + 2);
      assert.match(asked, /not checked against your product photo\. Add only if it shows exactly your product: the same design and colours, its pillow covers, and nothing else on the bed/);
      checkMode = 'match';
      assert.deepEqual(await overflow(page), []);
    }
    // Discard the others: their files are gone.
    for (const name of strict ? ['Whole bed — Dubai master bedroom'] : ['Whole bed — Dubai master bedroom', 'Lifestyle — breakfast tray']) {
      const src = await studio.getByRole('img', { name: `Styled photo: ${name}` }).getAttribute('src');
      await studio.getByRole('button', { name: `Discard: ${name}` }).click();
      await page.waitForTimeout(300);
      assert.equal((await api('GET', src!)).status, 404, name);
    }
    // Close with the keyboard.
    await sheet.getByRole('button', { name: 'Close' }).focus();
    await page.keyboard.press('Enter');
    await sheet.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

/** Three different photos to use as style photos. */
const STYLE = [0, 1, 2].map((n) => ({ name: `style-${n}.png`, mimeType: 'image/png', buffer: bedroomPng(200 + n * 8, 250, [chunk('tEXt', Buffer.from(`Comment\0shoot ${n}`, 'latin1'))]) }));

for (const width of [375, 1280]) {
  test(`Style photos at ${width}px: upload 2 (then a third), reorder, remove, save; the studio sends the product and both style photos to Gemini (3 images a picture)`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'AI pictures');
    const refs = page.getByTestId('pictures-references');
    await refs.getByLabel('Upload style photos').setInputFiles(STYLE.slice(0, 2));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="style-photo"]').length === 2);
    await refs.getByLabel('Upload style photos').setInputFiles(STYLE.slice(2));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="style-photo"]').length === 3);
    const srcs = async () => refs.getByTestId('style-photo').locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('src')!));
    const [a, b, c] = await srcs();
    // Reorder: the second first; remove the third.
    await refs.getByRole('button', { name: 'Move style photo 2 earlier' }).click();
    assert.deepEqual(await srcs(), [b, a, c]);
    await refs.getByRole('button', { name: 'Remove style photo 3' }).click();
    assert.deepEqual(await srcs(), [b, a]);
    assert.ok(await refs.getByRole('checkbox', { name: /Use my style photos/ }).isChecked(), 'on once there are some');
    assert.deepEqual(await overflow(page), []);
    await refs.scrollIntoViewIfNeeded();
    if (SHOTS) await refs.screenshot({ path: path.join(SHOTS, `ai-pictures-references-${width}.png`) });
    await page.getByTestId('ai-pictures').getByRole('button', { name: 'Save scenes and prompt' }).click();
    await page.getByTestId('ai-pictures').getByRole('status').filter({ hasText: /^Saved\. The studio offers these scenes now\./ }).waitFor();
    const saved = (await (await api('GET', '/api/admin/settings')).json()).aiPictures.value;
    assert.deepEqual(saved.references, [b, a]);
    // Stored without their text chunks (the hub re-encodes them small; the server strips metadata).
    for (const u of saved.references) assert.ok(!Buffer.from(await (await api('GET', u)).arrayBuffer()).includes(Buffer.from('shoot ')));

    // The studio: with the style photos (3 images in each request).
    const sheet = await openStudio(page);
    const studio = sheet.getByTestId('picture-studio');
    const toggle = studio.getByTestId('studio-references').getByRole('checkbox', { name: 'Use my style photos (2) for these pictures' });
    assert.ok(await toggle.isChecked());
    const before = pictureImages.length;
    await studio.getByRole('button', { name: 'Make 3 pictures (Gemini)' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="picture-studio"] [data-testid="stage-result"] img[alt^="Styled photo"]').length === 3);
    assert.deepEqual(pictureImages.slice(before), [3, 3, 3], 'the product and 2 style photos each time');
    assert.ok(pictureCalls.slice(-3).every((t) => /Images 2–3 are style references/.test(t)));
    // Off for one batch: the product only.
    await toggle.uncheck();
    const again = pictureImages.length;
    await studio.getByRole('button', { name: 'Make 3 pictures (Gemini)' }).click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="picture-studio"] [data-testid="stage-result"] img[alt^="Styled photo"]').length === 3 && n > 0, again);
    await page.waitForTimeout(500);
    assert.deepEqual(pictureImages.slice(again), [1, 1, 1]);
    assert.deepEqual(await overflow(page), []);
    while (await studio.getByRole("button", { name: /^Discard: / }).count()) await studio.getByRole("button", { name: /^Discard: / }).first().click();
    assert.deepEqual(errors, []);
    await ctx.close();
    // Back to none (the other tests make pictures without them).
    await api('PUT', '/api/admin/settings/aiPictures', { settings: { references: [] } });
  });
}

for (const width of [375, 1280]) {
  test(`Picture services at ${width}px: choose OpenAI, Test (stand-in), Save, make 3 pictures in the studio; fal.ai's curated models listed`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'AI pictures');
    const card = page.getByTestId('ai-pictures');
    await card.getByRole('radio', { name: 'OpenAI (GPT Image)' }).check();
    const box = card.getByTestId('pictures-openai');
    const statusLine = card.getByTestId('pictures-status');
    if (width === 375) {
      await statusLine.filter({ hasText: 'Needs an OpenAI key' }).waitFor();
      assert.equal(await box.getByRole('link', { name: /Create API key/ }).getAttribute('href'), 'https://platform.openai.com/api-keys');
      await box.getByText(/verify your organisation/).waitFor();
      await box.getByLabel('OpenAI API key').fill(OPENAI_KEY);
    } else {
      assert.match((await box.getByLabel('OpenAI API key').getAttribute('placeholder'))!, /^••••QRST saved$/);
    }
    await box.getByRole('button', { name: 'Test the OpenAI key' }).click();
    await box.getByTestId('pictures-test-result').filter({ hasText: /^Works: OpenAI offers 2 image models/ }).waitFor();
    assert.deepEqual(await box.getByLabel('Image model').locator('option').allTextContents(), ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']);
    await card.getByRole('button', { name: 'Save key and model' }).click();
    await statusLine.filter({ hasText: 'Ready (OpenAI gpt-image-2.5-sunburst)' }).waitFor();
    const ai = (await (await api('GET', '/api/admin/settings')).json()).ai;
    assert.deepEqual([ai.value.picturesProvider, ai.value.openaiImageModel, ai.value.openaiApiKey, ai.secretsHint.openaiApiKey], ['openai', 'gpt-image-2.5-sunburst', '', '••••QRST']);
    assert.equal(ai.value.provider, 'anthropic', 'writing stays as it was');
    // fal.ai: the curated edit models, each with its price and how many pictures it takes.
    await card.getByRole('radio', { name: 'fal.ai (many models)' }).check();
    const falBox = card.getByTestId('fal-models');
    assert.equal(await falBox.getByRole('radio').count(), 8);
    await falBox.getByRole('radio', { name: 'FLUX.2 edit' }).check();
    await falBox.getByText(/\$0\.012 a megapixel/).waitFor();
    assert.equal(await card.getByTestId('pictures-fal').getByRole('link', { name: /Create API key/ }).getAttribute('href'), 'https://fal.ai/dashboard/keys');
    assert.deepEqual(await smallText(page, '[data-testid="ai-pictures"]'), [], 'text boxes ≥ 16 px');
    assert.deepEqual(await overflow(page), []);
    await card.getByTestId('pictures-service').scrollIntoViewIfNeeded();
    if (SHOTS) await card.getByTestId('pictures-service').screenshot({ path: path.join(SHOTS, `ai-pictures-providers-${width}.png`) });
    // Not saved: OpenAI still makes the pictures. The studio uses it.
    const sheet = await openStudio(page);
    const studio = sheet.getByTestId('picture-studio');
    const before = openaiCalls.length;
    await studio.getByRole('button', { name: 'Make 3 pictures (OpenAI)' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="picture-studio"] [data-testid="stage-result"] img[alt^="Styled photo"]').length === 3);
    const calls = openaiCalls.slice(before);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => [c.images, c.auth === `Bearer ${OPENAI_KEY}`, /These rules come first/.test(c.prompt)]), [[1, true, true], [1, true, true], [1, true, true]], JSON.stringify(calls.map((c) => c.prompt.slice(0, 80))));
    assert.deepEqual(await overflow(page), []);
    while (await studio.getByRole("button", { name: /^Discard: / }).count()) await studio.getByRole("button", { name: /^Discard: / }).first().click();
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
