/**
 * Quick add (Inventory → Add product) and Settings → AI pictures' new controls, in Chromium against
 * the production build, at 375 px (a phone) and 1280 px (a laptop): the basics only, a name asked
 * for while AI writing is not set up, Add saves and the form is ready for the next one (price and
 * sizes kept, photos and name cleared), the full editor one tap away; the numbered angles found in
 * the picture prompt and the "New products" switch. No sideways scroll, no page errors. Skipped
 * without a build or Playwright.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Quick-Add-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });

async function adminPage(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
  return { ctx, page, errors };
}

const overflow = (page: import('playwright').Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** A small valid PNG, different for each seed. */
function png(seed: number): Buffer {
  const w = 64;
  const h = 48;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([(x * 4 + seed * 9) % 256, y * 5, 150], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const width of [375, 1280]) {
  test(`quick add at ${width} px: the basics only, a name asked for without AI writing, ready for the next one at once (no waiting for the upload); the full editor one tap away`, { skip }, async () => {
    const { ctx, page, errors } = await adminPage(width);
    await openAdminSection(page, /^Inventory/);
    await page.getByRole('button', { name: 'Add product' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Quick add' });
    await sheet.waitFor();
    assert.equal(await overflow(page), 0, 'fits the screen');
    await sheet.getByLabel('Choose photos from the gallery').setInputFiles({ name: 'sheet.png', mimeType: 'image/png', buffer: png(width) });
    await sheet.getByAltText(/Photo 1/).waitFor();
    // The set's pieces (reported: pillow covers are redesigned): a pillow cover photo, and the comforter
    // off by default (its photo only once switched on).
    const pieces = sheet.getByTestId('set-pieces');
    assert.equal(await pieces.getByTestId('set-has-comforter').isChecked(), false, 'no comforter unless switched on');
    assert.equal(await pieces.getByTestId('set-piece-comforter').count(), 0);
    await pieces.getByLabel('Pillow cover photo: choose it from the gallery').setInputFiles({ name: 'pillow.png', mimeType: 'image/png', buffer: png(width + 7) });
    await pieces.getByAltText('Pillow cover photo').waitFor();
    await pieces.getByTestId('set-has-comforter').check();
    await pieces.getByLabel('Comforter photo: choose it from the gallery').setInputFiles({ name: 'comforter.png', mimeType: 'image/png', buffer: png(width + 9) });
    await pieces.getByAltText('Comforter photo').waitFor();
    assert.equal(await overflow(page), 0, 'set pieces: no sideways scroll');
    await sheet.getByLabel('Price (AED)').fill('245');
    // No AI writing set up in this shop: the name is needed, and it says so.
    await sheet.getByTestId('quick-add-save').click();
    await sheet.getByRole('alert').filter({ hasText: /Give it a name/ }).waitFor();
    const title = `Quick Rose Percale ${width}`;
    await sheet.getByLabel(/^Name/).fill(title);
    // Add at once, without waiting for anything: the form is ready for the next one straight away
    // (photos and name cleared, the price kept), and the item is sent in the background.
    await sheet.getByTestId('quick-add-save').click();
    await sheet.getByTestId('quick-added').filter({ hasText: /Add the next item/ }).waitFor();
    // Back at the top, the camera ready (reported: after Add the form stayed scrolled down).
    await page.waitForFunction(() => (document.querySelector('[data-testid="quick-add"]') as HTMLElement).scrollTop === 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Take a photo with the camera');
    assert.ok(await sheet.getByLabel('Take a photo with the camera').evaluate((el) => el.closest('label')!.getBoundingClientRect().top < window.innerHeight), 'the camera button is in view');
    assert.equal(await sheet.getByTestId('quick-photos').count(), 0);
    assert.equal(await sheet.getByAltText('Pillow cover photo').count(), 0, 'the pieces cleared for the next item');
    assert.equal(await sheet.getByTestId('set-has-comforter').isChecked(), false);
    assert.equal(await sheet.getByLabel(/^Name/).inputValue(), '');
    assert.equal(await sheet.getByLabel('Price (AED)').inputValue(), '245');
    // The next one can be started while the first is still on its way.
    await sheet.getByLabel('Choose photos from the gallery').setInputFiles({ name: 'next.png', mimeType: 'image/png', buffer: png(width + 1) });
    await sheet.getByAltText(/Photo 1/).waitFor();
    type Row = { title: string; active: boolean; price: number; stockBySize: Record<string, number>; material: string; setPhotos?: { pillow?: string; comforter?: string } };
    let p: Row | undefined;
    for (let i = 0; i < 50 && !p; i++) {
      p = ((await (await api('GET', '/api/admin/products')).json()).products as Row[]).find((x) => x.title === title);
      if (!p) await page.waitForTimeout(200);
    }
    assert.ok(p, 'saved in the background');
    assert.equal(p.active, true, 'in the shop at once (nothing left for the AI to do)');
    assert.equal(p.price, 245);
    assert.equal(Object.values(p.stockBySize).reduce((a, b) => a + b, 0), 1);
    assert.equal(p.material, '', 'no fabric invented');
    assert.match(p.setPhotos?.pillow ?? '', /^\/api\/images\//, 'the pillow cover photo saved with it');
    assert.match(p.setPhotos?.comforter ?? '', /^\/api\/images\//, 'the comforter photo saved with it');
    await sheet.getByTestId('quick-sending').waitFor({ state: 'detached' });
    assert.equal(await overflow(page), 0);
    // The full editor is one tap away.
    await sheet.getByRole('button', { name: /Use the full editor/ }).click();
    await page.getByRole('dialog', { name: 'Add a product' }).waitFor();
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('Settings → AI pictures: the angles found in the prompt, one picture each; the "New products" switch and where AI pictures go, at 375 and 1280 px', { skip }, async () => {
  const look = 'A luxury bedroom with a king-size bed. Output three separate images from three angles: 1. Straight-on eye-level view of the made bed; 2. 45-degree three-quarter view of the side drape; 3. High diagonal angle from the foot of the bed. Exactly two matching pillows.';
  const saved = await api('PUT', '/api/admin/settings/aiPictures', { settings: { look } });
  assert.equal(saved.status, 200, await saved.text());
  for (const width of [375, 1280]) {
    const { ctx, page, errors } = await adminPage(width);
    await openAdminSection(page, /^Settings/);
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI pictures', exact: true }).click();
    const angles = page.getByTestId('pictures-angles');
    await angles.waitFor();
    assert.match((await angles.textContent()) ?? '', /3 angles found: 3 pictures, one request each/);
    const box = page.getByTestId('pictures-new-products');
    assert.equal(await box.getByRole('checkbox').isChecked(), true, 'on by default');
    assert.equal(await box.getByRole('radio', { name: /First, with your own photo last/ }).isChecked(), true);
    assert.equal(await overflow(page), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
