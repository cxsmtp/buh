/**
 * Google Gemini against the production build, with Google replaced by a stand-in on 127.0.0.1
 * (BUH_TEST_GEMINI_API, loopback only):
 * - the stage-photo route: a stranger gets nothing, sign-in is required, off until a Gemini key is
 *   saved, the size cap, bad image types, fields allow-listed, a NEW photo saved (the original
 *   untouched), Discard, the key in the x-goog-api-key header only and never in a reply or the log;
 *   the old fake /api/ai-transform is an unknown address;
 * - in Chromium at 375 px and 1280 px: Settings → AI writing (provider switch, Gemini key as
 *   ••••last4, Test fills the model lists), the editor's "Style in a bedroom" (original and styled
 *   side by side, Try again, Discard, Add to photos after the original), and the shop's "Styled
 *   image" tag on the product card and in the gallery, gone when the setting is off. No sideways
 *   scroll, no page errors.
 * Screenshots go to BUH_SHOTS_DIR when it is set. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { bedroomPng, chunk } from './fixtures/png.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const KEY = 'AIzaSyE2EKEY-abcdefghijklmnopqrstuvw-L4ST';
const SHOTS = process.env.BUH_SHOTS_DIR || '';
/** The stand-in's picture: a different one each time (Gemini never sends the same one twice). */
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
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-nano-banana-2.1', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  ],
};

let google: http.Server;
const calls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> | null }> = [];
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  google = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method!, url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : null });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-goog-api-key'] !== KEY) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 400, message: `API key not valid. ${String(req.headers['x-goog-api-key'])}`, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }));
      }
      if (req.method === 'GET' && req.url === '/v1beta/models?pageSize=1000') return res.end(JSON.stringify(MODELS));
      if (req.method === 'POST' && /^\/v1beta\/models\/gemini-[a-z0-9.-]+:generateContent$/.test(req.url!)) {
        // A little wait, as a real image model takes a while (the editor shows its spinner).
        return setTimeout(() => res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: staged().toString('base64') } }] }, finishReason: 'STOP' }] })), 400);
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }));
    });
  });
  await new Promise<void>((r) => google.listen(0, '127.0.0.1', () => r()));
  server = await startServer({ BUH_TEST_GEMINI_API: `http://127.0.0.1:${(google.address() as AddressInfo).port}/` });
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Gemini-Staging-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.stop();
  google?.close();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

const PHOTO = fs.readFileSync(path.join('test/fixtures', 'sheet-indigo.png'));
const PHOTO_URL = `data:image/png;base64,${PHOTO.toString('base64')}`;

test('the stage-photo route: hidden from strangers, sign-in required, off until a Gemini key is saved, cap, types, a new photo, Discard; the key never returned or logged', { skip }, async () => {
  const route = '/api/admin/products/stage-photo';
  assert.equal((await rawFetch(`${server.base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: PHOTO_URL, preset: 'dubai-master' }) })).status, 404);
  assert.equal((await api('POST', route, { image: PHOTO_URL, preset: 'dubai-master' }, { cookie: '' })).status, 401);
  // Off until a Gemini key is saved: the owner is told where to get one.
  const off = await api('POST', route, { image: PHOTO_URL, preset: 'dubai-master' });
  assert.equal(off.status, 409);
  assert.match((await off.json()).message, /aistudio\.google\.com/);
  assert.deepEqual(await (await api('GET', route)).json(), { ready: false, reason: 'no_key', model: 'gemini-3.1-flash-image' });
  // Save the key (Anthropic stays the writer): shown back as ••••last4 only.
  const saved = await api('PUT', '/api/admin/settings/ai', { settings: { geminiApiKey: KEY } });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText);
  assert.ok(!savedText.includes('E2EKEY'));
  assert.match(savedText, /••••L4ST/);
  assert.ok(!(await (await api('GET', '/api/admin/settings')).text()).includes('E2EKEY'));
  // Size cap, image types, fields.
  assert.equal((await api('POST', route, JSON.stringify({ image: `data:image/png;base64,${'A'.repeat(7 * 1024 * 1024)}`, preset: 'dubai-master' }))).status, 413);
  assert.equal((await api('POST', route, { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', preset: 'dubai-master' })).status, 400);
  assert.equal((await api('POST', route, { image: PHOTO_URL, preset: 'dubai-master', key: 'x' })).status, 400);
  assert.equal((await api('POST', route, { image: PHOTO_URL, preset: 'nowhere' })).status, 400);
  // A stored photo styled: a NEW photo, the original untouched; Google got the key in its header only.
  const up = await (await api('POST', '/api/admin/images', { image: PHOTO_URL })).json();
  const before = calls.length;
  const ok = await api('POST', route, { imageId: up.url.slice('/api/images/'.length), preset: 'hotel-suite' });
  const okText = await ok.text();
  assert.equal(ok.status, 200, okText);
  const result = JSON.parse(okText);
  assert.notEqual(result.url, up.url);
  assert.equal(result.staged.staged, true);
  assert.equal(result.staged.preset, 'hotel-suite');
  assert.ok(!okText.includes('E2EKEY'));
  const call = calls[before];
  assert.equal(call.url, '/v1beta/models/gemini-3.1-flash-image:generateContent');
  assert.equal(call.headers['x-goog-api-key'], KEY);
  assert.ok(!call.url.includes('key'));
  assert.deepEqual(Buffer.from(await (await fetch(`${server.base}${up.url}`)).arrayBuffer()), PHOTO, 'the original is unchanged');
  assert.equal((await fetch(`${server.base}${result.url}`)).status, 200);
  // Discard: gone; a real photo can't be discarded this way.
  assert.equal((await api('DELETE', route, { url: result.url })).status, 200);
  assert.equal((await fetch(`${server.base}${result.url}`)).status, 404);
  assert.equal((await api('DELETE', route, { url: up.url })).status, 404);
  // A refused key: Google's message comes back without the key.
  await api('PUT', '/api/admin/settings/ai', { settings: { geminiApiKey: 'AIzaSyWRONGKEY-abcdefghijklmnopqrstuvwxyz' } });
  const refused = await api('POST', '/api/admin/ai/test', { settings: { provider: 'gemini' } });
  const refusedText = await refused.text();
  assert.equal(refused.status, 502);
  assert.match(refusedText, /did not accept the Gemini API key/);
  assert.ok(!refusedText.includes('WRONGKEY'));
  await api('PUT', '/api/admin/settings/ai', { settings: { geminiApiKey: KEY } });
  // The old fake address is gone: an unknown address, signed in or not.
  for (const c of [cookie, '']) assert.equal((await api('POST', '/api/ai-transform', { image: PHOTO_URL, presetId: 'dubai-luxury-master' }, { cookie: c })).status, 404);
  assert.ok(!/E2EKEY|WRONGKEY/.test(server.log()), 'no key in the log');
});

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
async function shot(page: Page, name: string, locator?: import('playwright').Locator) {
  if (!SHOTS) return;
  const file = path.join(SHOTS, `${name}.png`);
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
}
async function openSettings(page: Page, section: string) {
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
  await page.getByRole('heading', { name: section, exact: true, level: 2 }).waitFor();
}

for (const width of [375, 1280]) {
  test(`Settings → AI writing at ${width}px: switch to Gemini, the key as ••••last4, Test fills the model lists, Save`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'AI writing');
    const card = page.getByTestId('ai-settings');
    const g = card.getByTestId('gemini-settings');
    assert.match((await g.getByLabel('Gemini API key').getAttribute('placeholder'))!, /^••••L4ST saved$/);
    await card.getByRole('radio', { name: 'Google Gemini' }).check();
    await g.getByLabel('Gemini API key').fill(KEY);
    await g.getByRole('button', { name: 'Test Gemini' }).click();
    await g.getByTestId('gemini-test-result').filter({ hasText: /^Works: Google offers 3 writing and 2 image models/ }).waitFor();
    assert.equal(await g.getByLabel('Writing model').inputValue(), 'gemini-3.1-pro', 'the newest Pro');
    assert.equal(await g.getByLabel('Image model (styled photos)').inputValue(), 'gemini-3.1-flash-image');
    assert.deepEqual(await g.getByLabel('Writing model').locator('option').allTextContents(), ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-2.5-pro']);
    assert.ok(await card.getByLabel('Label styled photos for customers').isChecked(), 'on by default');
    assert.deepEqual(await overflow(page), []);
    await shot(page, `gemini-settings-${width}`, page.locator('section[aria-labelledby="settings-title"]'));
    await card.getByRole('button', { name: 'Save AI settings' }).click();
    await card.getByRole('status').filter({ hasText: /^Saved\./ }).waitFor();
    const ai = (await (await api('GET', '/api/admin/settings')).json()).ai;
    assert.equal(ai.value.provider, 'gemini');
    assert.equal(ai.value.geminiModel, 'gemini-3.1-pro');
    assert.equal(ai.value.geminiApiKey, '');
    assert.equal(ai.secretsHint.geminiApiKey, '••••L4ST');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`product editor at ${width}px: "Style in a bedroom" shows original and styled side by side; Try again, Discard, Add to photos after the original`, { skip }, async () => {
    // A fresh editor (not the other width's draft).
    await api('DELETE', '/api/admin/products/drafts/new');
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const editor = page.getByRole('dialog', { name: 'Add a product' });
    await editor.waitFor();
    const panel = editor.getByTestId('stage-in-bedroom');
    await panel.waitFor();
    const button = panel.getByRole('button', { name: 'Style in a bedroom' });
    assert.ok(await button.isDisabled(), 'needs a photo first');
    await editor.getByLabel('Choose photos from the gallery').setInputFiles([{ name: 'sheet-indigo.png', mimeType: 'image/png', buffer: PHOTO }]);
    await editor.getByAltText('Cover photo').waitFor();
    await panel.getByLabel('Style').selectOption({ label: 'Palm villa' });
    await panel.getByLabel('Extra words (optional)').fill('morning light');
    // Keyboard: focus the button and press Enter; the spinner shows while Gemini works.
    const sentBefore = calls.length;
    await button.focus();
    await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: 'Styling the photo…' }).waitFor();
    const result = panel.getByTestId('stage-result');
    await result.waitFor();
    const prompt = String(((calls[sentBefore].body as { contents: Array<{ parts: Array<{ text?: string }> }> }).contents[0].parts[0].text));
    assert.match(prompt, /Palm Jumeirah/);
    assert.match(prompt, /morning light/);
    await result.getByText('Check the pattern and colours match the real product before adding.').waitFor();
    await result.getByAltText('Original photo').waitFor();
    await result.getByAltText('Styled photo').waitFor();
    assert.deepEqual(await overflow(page), [], 'result shown');
    await result.scrollIntoViewIfNeeded();
    await shot(page, `stage-result-${width}`);
    await shot(page, `stage-result-panel-${width}`, panel);
    const firstUrl = await result.getByAltText('Styled photo').getAttribute('src');
    // Try again: a new picture; the first is thrown away.
    await result.getByRole('button', { name: 'Try again' }).click();
    await panel.getByTestId('stage-result').waitFor();
    // Discard: the panel is cleared and the file deleted.
    await panel.getByTestId('stage-result').getByRole('button', { name: 'Discard' }).click();
    await panel.getByTestId('stage-result').waitFor({ state: 'detached' });
    await button.click();
    await panel.getByTestId('stage-result').waitFor();
    await panel.getByTestId('stage-result').getByRole('button', { name: 'Add to photos' }).click();
    await panel.getByText(/Added after the original photo/).waitFor();
    // The real photo stays first; the styled one is photo 2.
    const photos = editor.getByRole('list', { name: 'Photos in order' }).locator('li img');
    assert.equal(await photos.count(), 2);
    assert.match((await photos.nth(1).getAttribute('src'))!, /^\/api\/images\/[a-f0-9]{64}\.png$/);
    assert.equal(await editor.getByAltText('Cover photo').getAttribute('src').then((s) => s!.startsWith('/api/images/')), true);
    // Try again threw the first picture away.
    assert.ok(firstUrl);
    assert.equal((await api('GET', firstUrl!)).status, 404);
    assert.deepEqual(await overflow(page), []);
    await shot(page, `stage-added-${width}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('the shop: a "Styled image" tag on the styled card photo and in the gallery, at 375 and 1280 px; none once the label is switched off', { skip }, async () => {
  // Two products: one with the styled photo as its cover, one with it second (after the real photo).
  const real = (await (await api('POST', '/api/admin/images', { image: PHOTO_URL })).json()).url as string;
  const styled = (await (await api('POST', '/api/admin/products/stage-photo', { imageId: real.slice('/api/images/'.length), preset: 'dubai-master' })).json()).url as string;
  const sizes = (await (await api('GET', '/api/admin/settings')).json()).catalog.value.sizes.filter((s: { id: string }) => s.id === 'king');
  const make = async (title: string, featuredImage: string, galleryImages: string[]) => {
    const res = await api('POST', '/api/admin/products', { product: { title, category: 'bedsheets', price: 420, featuredImage, galleryImages, profiles: sizes, defaultProfileId: 'king', stockBySize: { king: 3 }, active: true } });
    assert.equal(res.status, 201, await res.clone().text());
    return (await res.json()).product as { id: string; stagedPhotos?: Record<string, unknown> };
  };
  const second = await make('Indigo Garden Styled Second', real, [styled]);
  const cover = await make('Indigo Garden Styled Cover', styled, [real]);
  assert.ok(second.stagedPhotos?.[styled] && cover.stagedPhotos?.[styled], 'marked by the server');

  for (const width of [375, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.locator('main h3').first().waitFor();
    const coverCard = page.locator('main article').filter({ hasText: 'Indigo Garden Styled Cover' });
    const secondCard = page.locator('main article').filter({ hasText: 'Indigo Garden Styled Second' });
    await coverCard.getByTestId('styled-tag').waitFor();
    assert.equal(await coverCard.getByTestId('styled-tag').textContent(), 'Styled image');
    assert.equal(await secondCard.getByTestId('styled-tag').count(), 0, 'its card shows the real photo');
    assert.deepEqual(await overflow(page), []);
    await shot(page, `shop-card-tag-${width}`, coverCard);
    // The gallery: the second photo carries the tag, the real one doesn't.
    await secondCard.locator('h3').click();
    const sheet = page.getByRole('dialog', { name: 'Indigo Garden Styled Second' });
    await sheet.waitFor();
    const slides = sheet.getByTestId('photo-track').getByRole('group');
    assert.equal(await slides.nth(0).getByTestId('styled-tag').count(), 0);
    assert.equal(await slides.nth(1).getByTestId('styled-tag').count(), 1);
    await sheet.getByTestId('photo-track').focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    assert.deepEqual(await overflow(page), []);
    await shot(page, `shop-gallery-tag-${width}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // The owner switches the label off: no tags anywhere.
  assert.equal((await api('PUT', '/api/admin/settings/ai', { settings: { labelStyledPhotos: false } })).status, 200);
  const shown = (await (await fetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; stagedPhotos?: unknown }>;
  assert.equal(shown.find((p) => p.id === cover.id)!.stagedPhotos, undefined);
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('main article').filter({ hasText: 'Indigo Garden Styled Cover' }).waitFor();
  assert.equal(await page.getByTestId('styled-tag').count(), 0);
  await ctx.close();
  await api('PUT', '/api/admin/settings/ai', { settings: { labelStyledPhotos: true } });
});
