/**
 * "Write from photo" and Settings → Catalogue → Weaves against the production build, with Anthropic
 * replaced by a stand-in on 127.0.0.1 (BUH_TEST_ANTHROPIC_API, loopback only):
 * - the describe route: a stranger gets nothing, sign-in is required, the size cap, bad image types,
 *   "switched off" until a key is saved, and the key never in a reply or the server's log;
 * - in Chromium at 375 px and 1280 px: Settings → AI writing (key shown as ••••last4, Test), the
 *   editor's button filling empty fields, the preview with "Use these" / "Keep mine" when there is
 *   text, colours and weave added only with a tap, and the Weaves editor (add, rename across
 *   products, remove refused while in use). No sideways scroll, no page errors.
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

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const KEY = 'sk-ant-api03-E2EKEY-abcdefghijklmnopqrstuvwxyz0123456789-L4ST';
const SHOTS = process.env.BUH_SHOTS_DIR || '';

/** What the stand-in answers: the copy a stylist would write for the indigo fixture. */
const ANSWER = {
  title: 'Indigo Garden Hand Block Set',
  shortDescription: 'Hand-stamped indigo florals on a soft white ground, calm and timeless.',
  description:
    'A quiet garden of indigo blooms, stamped by hand across a soft white ground. Each motif sits a little differently from the next, the gentle mark of a printer’s block.\n\nThe deep blue settles beautifully into a light, airy bedroom, pairing as easily with crisp white as with warm sand and wood.',
  colors: [
    { name: 'Indigo', hex: '#2f3f7a' },
    { name: 'White', hex: '#ffffff' },
  ],
  weave: 'Percale',
  motif: 'Hand block floral',
};

let anthropic: http.Server;
let anthropicUrl = '';
const calls: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  anthropic = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      calls.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-api-key'] !== KEY) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${String(req.headers['x-api-key'])}` } }));
      }
      const isTest = typeof (body.messages as Array<{ content: unknown }>)[0].content === 'string';
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', content: [{ type: 'text', text: isTest ? 'OK' : JSON.stringify(ANSWER) }] }));
    });
  });
  await new Promise<void>((r) => anthropic.listen(0, '127.0.0.1', () => r()));
  anthropicUrl = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}/`;
  server = await startServer({ BUH_TEST_ANTHROPIC_API: anthropicUrl });
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Ai-Writing-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.stop();
  anthropic?.close();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

const PHOTO = fs.readFileSync(path.join('test/fixtures', 'sheet-indigo.png'));
const PHOTO_URL = `data:image/png;base64,${PHOTO.toString('base64')}`;

test('the describe route: hidden from strangers, sign-in required, size cap, image types, off until a key is saved, key never returned or logged', { skip }, async () => {
  // A stranger (no door): the address does not exist.
  assert.equal((await rawFetch(`${server.base}/api/admin/products/describe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: PHOTO_URL }) })).status, 404);
  // Through the door but not signed in.
  assert.equal((await api('POST', '/api/admin/products/describe', { image: PHOTO_URL }, { cookie: '' })).status, 401);
  // Off until a key is saved: the owner is told where.
  const off = await api('POST', '/api/admin/products/describe', { image: PHOTO_URL });
  assert.equal(off.status, 409);
  assert.match((await off.json()).message, /Settings → AI writing/);
  assert.deepEqual(await (await api('GET', '/api/admin/products/describe')).json(), { ready: false, reason: 'no_key', model: 'claude-opus-5-5' });
  // Save the key: shown back as ••••last4 only.
  const saved = await api('PUT', '/api/admin/settings/ai', { settings: { anthropicApiKey: KEY, enabled: true, model: 'claude-sonnet-5-5' } });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText);
  assert.ok(!savedText.includes('E2EKEY'));
  assert.match(savedText, /••••L4ST/);
  const all = await (await api('GET', '/api/admin/settings')).text();
  assert.ok(!all.includes('E2EKEY'), 'never in the settings read');
  // Size cap (9 MB body) and image types.
  assert.equal((await api('POST', '/api/admin/products/describe', JSON.stringify({ image: `data:image/png;base64,${'A'.repeat(10 * 1024 * 1024)}` }))).status, 413);
  assert.equal((await api('POST', '/api/admin/products/describe', { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' })).status, 400);
  assert.equal((await api('POST', '/api/admin/products/describe', { image: `data:image/png;base64,${Buffer.from('GIF89a not a png').toString('base64')}` })).status, 400);
  assert.equal((await api('POST', '/api/admin/products/describe', { image: PHOTO_URL, sneaky: true })).status, 400);
  // A real call: the stand-in gets the key in x-api-key, the photo as base64; the reply has the suggestion and no key.
  const before = calls.length;
  const ok = await api('POST', '/api/admin/products/describe', { image: PHOTO_URL, hints: { category: 'bedsheets' } });
  const okText = await ok.text();
  assert.equal(ok.status, 200, okText);
  const { suggestion } = JSON.parse(okText);
  assert.equal(suggestion.title, ANSWER.title);
  assert.equal(suggestion.weave, 'Percale');
  assert.ok(!okText.includes('E2EKEY'));
  const call = calls[before];
  assert.equal(call.headers['x-api-key'], KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal((call.body.messages as Array<{ content: Array<{ source: { data: string } }> }>)[0].content[0].source.data, PHOTO.toString('base64'));
  // A refused key: Anthropic's message comes back without the key.
  await api('PUT', '/api/admin/settings/ai', { settings: { anthropicApiKey: 'sk-ant-api03-WRONGKEY-abcdefghijklmnopqrstuvwxyz' } });
  const refused = await api('POST', '/api/admin/ai/test', { settings: {} });
  const refusedText = await refused.text();
  assert.equal(refused.status, 502);
  assert.match(refusedText, /did not accept the API key/);
  assert.ok(!refusedText.includes('WRONGKEY'));
  await api('PUT', '/api/admin/settings/ai', { settings: { anthropicApiKey: KEY } });
  assert.equal((await api('POST', '/api/admin/ai/test', { settings: {} })).status, 200);
  // Nothing in the server's log carries a key.
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
  test(`Settings → AI writing at ${width}px: the key as ••••last4, model, switch and Test`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'AI writing');
    const card = page.getByTestId('ai-settings');
    assert.match((await card.getByLabel('Anthropic API key').getAttribute('placeholder'))!, /^••••L4ST saved$/);
    assert.equal(await card.getByLabel('Model').inputValue(), 'claude-sonnet-5-5');
    assert.ok(await card.getByLabel('Use AI writing').isChecked());
    await card.getByRole('button', { name: 'Test' }).click();
    await card.getByTestId('ai-test-result').filter({ hasText: /^Works/ }).waitFor();
    assert.deepEqual(await overflow(page), []);
    await shot(page, `ai-settings-${width}`, page.locator('section[aria-labelledby="settings-title"]'));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`product editor at ${width}px: "Write from photo" fills empty fields; with text, a preview; colours and weave only with a tap`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const editor = page.getByRole('dialog', { name: 'Add a product' });
    await editor.waitFor();
    const button = editor.getByRole('button', { name: 'Write name & descriptions from photo' });
    await button.waitFor();
    assert.ok(await button.isDisabled(), 'needs a photo first');
    await editor.getByLabel('Choose photos from the gallery').setInputFiles([{ name: 'sheet-indigo.png', mimeType: 'image/png', buffer: PHOTO }]);
    await editor.getByAltText('Cover photo').waitFor();
    // Keyboard: focus the button and press Enter.
    await button.focus();
    await page.keyboard.press('Enter');
    await editor.getByText(/filled in from the photo/).waitFor();
    // Colours and weave are offered, not added.
    const extras = editor.getByTestId('ai-extras');
    await extras.getByRole('list', { name: 'Colours seen' }).waitFor();
    assert.deepEqual(await overflow(page), [], 'photos step with suggestions');
    await shot(page, `editor-filled-${width}`);
    await shot(page, `editor-filled-panel-${width}`, editor.getByTestId('write-from-photo'));
    await extras.getByRole('button', { name: 'Add these colours' }).click();
    await editor.getByRole('button', { name: /^Next: Details/ }).click();
    assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), ANSWER.title);
    await editor.getByText(/More details/).click();
    assert.equal(await editor.getByLabel('Short description (on the card)').inputValue(), ANSWER.shortDescription);
    assert.equal(await editor.getByLabel('Full description').inputValue(), ANSWER.description);
    assert.equal(await editor.getByLabel('Colour 1 name').inputValue(), 'Indigo');
    assert.equal(await editor.getByLabel('Colour 2 name').inputValue(), 'White');
    // The owner's own text: a second run shows a preview and keeps it until "Use these".
    await editor.getByLabel('Name', { exact: true }).fill('My own name');
    await editor.getByRole('button', { name: /^Back/ }).click();
    await editor.getByRole('button', { name: 'Write name & descriptions from photo' }).click();
    const preview = editor.getByTestId('ai-preview');
    await preview.waitFor();
    assert.deepEqual(await overflow(page), [], 'preview');
    await preview.scrollIntoViewIfNeeded();
    await shot(page, `editor-preview-${width}`);
    await shot(page, `editor-preview-panel-${width}`, editor.getByTestId('write-from-photo'));
    await preview.getByRole('button', { name: 'Keep mine' }).click();
    await preview.waitFor({ state: 'detached' });
    await editor.getByRole('button', { name: 'Write name & descriptions from photo' }).click();
    await editor.getByTestId('ai-preview').getByRole('button', { name: 'Use these' }).click();
    await editor.getByRole('button', { name: /^Next: Details/ }).click();
    assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), ANSWER.title);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`Settings → Catalogue → Weaves at ${width}px: add, rename across products, remove refused while in use`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'Catalogue');
    const weaves = page.getByTestId('weaves-editor');
    await weaves.getByTestId('weave-used-Linen').filter({ hasText: /product/ }).waitFor();
    const extra = `Waffle ${width}`;
    await weaves.getByLabel('New weave').fill(extra);
    await weaves.getByRole('button', { name: 'Add a weave' }).click();
    await page.getByText('Saved automatically.').waitFor();
    assert.ok(((await (await api('GET', '/api/admin/catalog/weaves')).json()).weaves as string[]).includes(extra));
    // Remove: refused while products use it (Linen is on a starter set).
    await weaves.getByRole('button', { name: "Linen is in use and can't be removed" }).click();
    await weaves.getByRole('alert').filter({ hasText: /use Rename/ }).waitFor();
    // Rename Linen on every product.
    const linenBefore = (await (await api('GET', '/api/admin/catalog/weaves')).json()).usage.Linen as number;
    await weaves.getByRole('button', { name: 'Rename Linen' }).click();
    const to = `Linen ${width}`;
    await weaves.getByLabel('New name for Linen').fill(to);
    await weaves.getByRole('button', { name: 'Rename', exact: true }).click();
    await weaves.getByRole('status').filter({ hasText: `Renamed to ${to}` }).waitFor();
    const after = await (await api('GET', '/api/admin/catalog/weaves')).json();
    assert.equal(after.usage[to], linenBefore);
    assert.ok(!after.weaves.includes('Linen'));
    assert.deepEqual(await overflow(page), []);
    await shot(page, `weaves-${width}`, weaves);
    // Put it back for the other width's run.
    await weaves.getByRole('button', { name: `Rename ${to}` }).click();
    await weaves.getByLabel(`New name for ${to}`).fill('Linen');
    await weaves.getByRole('button', { name: 'Rename', exact: true }).click();
    await weaves.getByRole('status').filter({ hasText: 'Renamed to Linen' }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}
