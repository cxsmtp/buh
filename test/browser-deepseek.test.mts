/**
 * DeepSeek, the fuller copy and gift lines against the production build, with DeepSeek replaced by a
 * stand-in on 127.0.0.1 (BUH_TEST_DEEPSEEK_API, loopback only), in Chromium at 375 px and 1280 px:
 * - Settings → AI writing: choose DeepSeek, paste the key, Test (the model list), pick the model,
 *   save; the key shown back as ••••last4 only; the test route checks fields and the provider;
 * - the product editor: "Write from photo" with DeepSeek fills the fields; each suggested field
 *   (name, short description, design, comfort, highlights, gift line) is editable with Use, Use all
 *   and Write again; the gift-line picker (festival now and next, or everyday) and "Write gift
 *   lines for the next festivals";
 * - the shop: the product card and page show today's gift line (the themed festival's, else the
 *   everyday one). No sideways scroll, no page errors, no key in the log.
 * Screenshots go to BUH_SHOTS_DIR when it is set. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

const KEY = 'sk-e2e0123456789abcdef0123456789L4ST';
const SHOTS = process.env.BUH_SHOTS_DIR || '';
const ANSWER = {
  title: 'Indigo Chevron Hand Block Print Bed Set',
  shortDescription: 'Hand-stamped indigo that brings calm to a white bedroom.',
  design: 'Indigo motifs stamped by hand on a soft white ground. Pairs with white or walnut furniture; suits a calm master bedroom.',
  comfort: 'Looks soft and matte, with an easy drape for warm nights.',
  closing: 'A quiet, crafted set for slow mornings.',
  highlights: ['Hand block printed indigo', 'Soft matte look', 'Pairs with white or walnut'],
  giftLine: 'A warm gift for the festival at home.',
  colors: [{ name: 'Indigo', hex: '#2f3f7a' }],
  weave: 'Percale',
  motif: 'Indigo chevron',
};

let ds: http.Server;
const calls: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> | null }> = [];
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  ds = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : null;
      calls.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: `Authentication Fails, Your api key: ${String(req.headers.authorization)} is invalid`, type: 'authentication_error' } }));
      }
      if (req.method === 'GET' && req.url === '/models') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }] }));
      if (req.method === 'POST' && req.url === '/chat/completions') {
        const user = String(body.messages[1].content.find((c: { type: string }) => c.type === 'text').text);
        // The batch: one line per festival id asked for (read from the JSON template in the prompt).
        const ids = /"giftLines": \{(.*)\}\}/.exec(user)?.[1].match(/"([a-z0-9-]+)": "the line"/g)?.map((m) => m.split('"')[1]);
        const content = ids ? { giftLines: Object.fromEntries(ids.map((id) => [id, `A ${id} gift for a calm home.`])) } : { ...ANSWER, giftLine: /everyday gift idea/.test(user) ? 'A warm housewarming gift.' : ANSWER.giftLine };
        return setTimeout(() => res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }] })), 200);
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  await new Promise<void>((r) => ds.listen(0, '127.0.0.1', () => r()));
  server = await startServer({ BUH_TEST_DEEPSEEK_API: `http://127.0.0.1:${(ds.address() as AddressInfo).port}/` });
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'DeepSeek-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.stop();
  ds?.close();
});

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

const PHOTO = fs.readFileSync(path.join('test/fixtures', 'sheet-indigo.png'));

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
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
async function openSettings(page: Page, section: string) {
  await openAdminSection(page, /^Settings/);
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
  await page.getByRole('heading', { name: section, exact: true, level: 2 }).waitFor();
}

test('the test route: DeepSeek allowed, fields allow-listed; a refused key comes back without the key', { skip }, async () => {
  assert.equal((await api('POST', '/api/admin/ai/test', { settings: { provider: 'openai' } })).status, 400);
  assert.equal((await api('POST', '/api/admin/ai/test', { settings: { provider: 'deepseek', sneaky: 1 } })).status, 400);
  const refused = await api('POST', '/api/admin/ai/test', { settings: { provider: 'deepseek', deepseekApiKey: 'sk-wrong0123456789abcdef0123456789ab' } });
  const text = await refused.text();
  assert.equal(refused.status, 502);
  assert.match(text, /DeepSeek did not accept the API key/);
  assert.ok(!text.includes('wrong0123456789'));
});

for (const width of [375, 1280]) {
  test(`Settings → AI writing at ${width}px: choose DeepSeek, paste the key, Test lists the models, pick one, Save`, { skip }, async () => {
    const { ctx, page, errors } = await hub(width);
    await openSettings(page, 'AI writing');
    const card = page.getByTestId('ai-settings');
    const box = card.getByTestId('deepseek-settings');
    await card.getByRole('radio', { name: 'DeepSeek' }).check();
    await box.getByText('DeepSeek writes names and descriptions (deepseek-flash also reads your photos). Bedroom styling still uses Gemini.').waitFor();
    assert.equal(await box.getByRole('link', { name: /platform\.deepseek\.com/ }).getAttribute('href'), 'https://platform.deepseek.com/api_keys');
    const keyField = box.getByLabel('DeepSeek API key');
    if (width === 375) assert.equal(await keyField.getAttribute('placeholder'), 'sk-…');
    await keyField.fill(KEY);
    // Keyboard: Tab to Test and press Enter.
    await box.getByRole('button', { name: 'Test DeepSeek' }).focus();
    await page.keyboard.press('Enter');
    await box.getByTestId('deepseek-test-result').filter({ hasText: /^Works: DeepSeek offers 2 models to this key \(1 can read photos\)/ }).waitFor();
    const model = box.getByLabel('DeepSeek model');
    assert.deepEqual(await model.locator('option').allTextContents(), ['deepseek-flash (reads photos)', 'deepseek-v4-pro (text only: can’t read photos)']);
    await model.selectOption('deepseek-v4-pro');
    await box.getByTestId('deepseek-text-only').waitFor();
    await model.selectOption('deepseek-flash');
    assert.equal(await box.getByTestId('deepseek-text-only').count(), 0);
    // Text boxes are at least 16px on a phone (no zoom on iPhones).
    if (width < 640) assert.equal(await keyField.evaluate((el) => getComputedStyle(el).fontSize), '16px');
    assert.ok(await card.getByLabel('Use AI writing').isChecked(), 'a first key switches it on');
    assert.deepEqual(await overflow(page), []);
    await box.scrollIntoViewIfNeeded();
    await shot(page, `ai-settings-deepseek-${width}`);
    await card.getByRole('button', { name: 'Save AI settings' }).click();
    await card.getByRole('status').filter({ hasText: /^Saved\./ }).waitFor();
    const ai = (await (await api('GET', '/api/admin/settings')).json()).ai;
    assert.equal(ai.value.provider, 'deepseek');
    assert.equal(ai.value.deepseekModel, 'deepseek-flash');
    assert.equal(ai.value.deepseekApiKey, '');
    assert.equal(ai.secretsHint.deepseekApiKey, '••••L4ST');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`product editor at ${width}px: "Write from photo" with DeepSeek fills the fields; each field editable with Use / Use all / Write again; gift lines by festival`, { skip }, async () => {
    // A page left open by a failed run would keep autosaving the draft.
    for (const c of browser.contexts()) await c.close();
    await api('DELETE', '/api/admin/products/drafts/new');
    const { ctx, page, errors } = await hub(width);
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('button', { name: 'Add product' }).first().click();
    // Add product opens quick add; these steps are the full editor's.
    await page.getByRole('button', { name: /Use the full editor/ }).click();
    const editor = page.getByRole('dialog', { name: 'Add a product' });
    await editor.waitFor();
    await editor.getByLabel('Choose photos from the gallery').setInputFiles([{ name: 'sheet-indigo.png', mimeType: 'image/png', buffer: PHOTO }]);
    await editor.getByAltText('Cover photo').waitFor();
    const before = calls.length;
    await editor.getByRole('button', { name: 'Write name & descriptions from photo' }).click();
    await editor.getByText(/filled in from the photo/).waitFor();
    // DeepSeek got the photo as a data URL, JSON asked for, thinking off.
    const call = calls.slice(before).find((c) => c.url === '/chat/completions')!;
    const b = call.body as { model: string; response_format: unknown; thinking: unknown; messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }> };
    assert.equal(b.model, 'deepseek-flash');
    assert.deepEqual(b.thinking, { type: 'disabled' });
    assert.deepEqual(b.response_format, { type: 'json_object' });
    assert.match(b.messages[1].content[0].image_url!.url, /^data:image\/(?:png|jpeg|webp);base64,/);
    const review = editor.getByTestId('ai-preview');
    assert.equal(await review.getByLabel('Name', { exact: true }).inputValue(), ANSWER.title);
    assert.equal(await review.getByLabel('Design', { exact: true }).inputValue(), ANSWER.design);
    assert.equal(await review.getByLabel('Comfort', { exact: true }).inputValue(), ANSWER.comfort);
    assert.equal(await review.getByLabel('Highlights (one per line)').inputValue(), ANSWER.highlights.join('\n'));
    // Edit a field, then Use (that field only) and Use as full description.
    await review.getByLabel('Name', { exact: true }).fill('Indigo Chevron Bed Set');
    await review.getByRole('button', { name: 'Use name' }).click();
    await review.getByLabel('Highlights (one per line)').fill('Hand block printed indigo\nFits a King mattress');
    await review.getByRole('button', { name: 'Use as full description' }).click();
    // Write again (one field): only the comfort paragraph changes back to the AI's.
    await review.getByLabel('Comfort', { exact: true }).fill('mine');
    await review.getByRole('button', { name: 'Write comfort again' }).click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="ai-preview"] textarea[id$="-comfort"]') as HTMLTextAreaElement | null)?.value !== 'mine');
    assert.equal(await review.getByLabel('Comfort', { exact: true }).inputValue(), ANSWER.comfort);
    assert.equal(await review.getByLabel('Name', { exact: true }).inputValue(), 'Indigo Chevron Bed Set', 'other fields untouched');
    // Gift lines: which festival, a picker (now, next, everyday), Write again for one, all at once.
    const giftBox = review.getByTestId('gift-line-box');
    await giftBox.getByText(/Gift line for:/).waitFor();
    const picker = giftBox.getByLabel('Festival for the gift line');
    const options = await picker.locator('option').allTextContents();
    assert.ok(options[options.length - 1].startsWith('Everyday (no festival)'), options.join(' | '));
    await picker.selectOption('everyday');
    await giftBox.getByRole('button', { name: 'Write gift line again' }).click();
    await page.waitForFunction(() => (document.querySelector('[data-testid="gift-line-box"] textarea') as HTMLTextAreaElement | null)?.value === 'A warm housewarming gift.');
    await giftBox.getByRole('button', { name: 'Write gift lines for the next festivals' }).click();
    const festivals = ((await (await api('GET', '/api/admin/products/describe')).json()).festivals as Array<{ id: string }>).slice(0, 3);
    if (festivals.length) {
      await picker.selectOption(festivals[0].id);
      await page.waitForFunction((id) => (document.querySelector('[data-testid="gift-line-box"] textarea') as HTMLTextAreaElement | null)?.value === `A ${id} gift for a calm home.`, festivals[0].id);
      await giftBox.getByLabel('Gift line', { exact: true }).fill(`My own ${festivals[0].id} line.`);
    }
    assert.deepEqual(await overflow(page), [], 'review open');
    await giftBox.scrollIntoViewIfNeeded();
    await shot(page, `gift-line-${width}`);
    await review.getByLabel('Design', { exact: true }).scrollIntoViewIfNeeded();
    await shot(page, `describe-fields-${width}`);
    await review.getByRole('button', { name: 'Use all' }).click();
    // The Details step has what was used.
    await editor.getByRole('button', { name: /^Next: Details/ }).click();
    assert.equal(await editor.getByLabel('Name', { exact: true }).inputValue(), 'Indigo Chevron Bed Set');
    await editor.getByText(/More details/).click();
    const full = await editor.getByLabel('Full description').inputValue();
    assert.match(full, /^Indigo motifs stamped by hand/);
    assert.match(full, /\n\n• Hand block printed indigo\n• Fits a King mattress$/);
    // The gift lines are kept with the draft (and saved with the product on publish).
    // (The draft saves itself a moment after the last change; the SKU filled in by the shop is one too.)
    let draft: { giftLines?: Record<string, string> } = {};
    for (let i = 0; i < 40 && !draft.giftLines?.everyday; i++) {
      await page.waitForTimeout(250);
      draft = (await (await api('GET', '/api/admin/products/drafts/new')).json()).draft?.data ?? {};
    }
    assert.equal(draft.giftLines?.everyday, 'A everyday gift for a calm home.', 'the batch wrote the everyday line too');
    if (festivals.length) assert.equal(draft.giftLines?.[festivals[0].id], `My own ${festivals[0].id} line.`);
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('the shop at 375 and 1280 px: the card and product page show today’s gift line (the themed festival’s, else the everyday one); never the others', { skip }, async () => {
  const pub = await (await fetch(`${server.base}/api/settings/public`)).json();
  const themed: string | null = pub.festival?.festivalId ?? null;
  const img = (await (await api('POST', '/api/admin/images', { image: `data:image/png;base64,${PHOTO.toString('base64')}` })).json()).url as string;
  const sizes = (await (await api('GET', '/api/admin/settings')).json()).catalog.value.sizes.filter((s: { id: string }) => s.id === 'king');
  const giftLines: Record<string, string> = { everyday: 'A warm housewarming gift.', christmas: 'A Christmas gift line.' };
  if (themed && themed !== 'christmas') giftLines[themed] = 'The line for the festival now.';
  const res = await api('POST', '/api/admin/products', { product: { title: 'Gift Line Set', category: 'bedsheets', price: 410, featuredImage: img, galleryImages: [], profiles: sizes, defaultProfileId: 'king', stockBySize: { king: 3 }, active: true, giftLines } });
  assert.equal(res.status, 201, await res.clone().text());
  const expected = themed && giftLines[themed] ? giftLines[themed] : giftLines.everyday;
  const listed = ((await (await fetch(`${server.base}/api/products`)).json()).products as Array<{ title: string; giftLine?: string; giftLines?: unknown }>).find((p) => p.title === 'Gift Line Set')!;
  assert.equal(listed.giftLine, expected);
  assert.equal(listed.giftLines, undefined, 'shoppers never get the other lines');
  for (const width of [375, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    const card = page.locator('main article').filter({ hasText: 'Gift Line Set' });
    await card.getByTestId('gift-line').waitFor();
    assert.equal(await card.getByTestId('gift-line').textContent(), expected);
    assert.deepEqual(await overflow(page), []);
    await card.scrollIntoViewIfNeeded();
    await shot(page, `gift-line-shop-card-${width}`);
    await card.locator('h3').click();
    const sheet = page.getByRole('dialog', { name: 'Gift Line Set' });
    await sheet.getByTestId('gift-line').waitFor();
    assert.equal(await sheet.getByTestId('gift-line').textContent(), expected);
    assert.deepEqual(await overflow(page), []);
    await sheet.getByTestId('gift-line').scrollIntoViewIfNeeded();
    await shot(page, `gift-line-shop-page-${width}`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  assert.ok(!server.log().includes('e2e0123456789abcdef'), 'no key in the log');
});
