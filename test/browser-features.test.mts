/**
 * Real-browser checks for BUH-01.03.00 (Chromium against the production build):
 * the product editor and per-size stock, the settings console (WhatsApp,
 * festival theme), live updates, saved checkout details and bag links, at
 * phone width. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
const OWNER_PASSWORD = 'Feature-Owner-Pass-1';

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await pw!.chromium.launch();
  // First admin sign-in: the one-time password from the log, then our own.
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${server.base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: server.base, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function adminPage(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const [name, value] = cookie.split('=');
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.locator('header button:has-text("Admin Hub")').click();
  await page.getByRole('status').filter({ hasText: /Backup/ }).waitFor();
  return { ctx, page, errors };
}

async function overflow(page: import('playwright').Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

/** A small valid PNG (a 64x48 gradient) for the photo upload. */
function png(): Buffer {
  const w = 64;
  const h = 48;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([x * 4, y * 5, 150], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
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

test('the owner adds a one-of-a-kind product on a phone, sets pieces per size, and edits it', { skip }, async () => {
  const { ctx, page, errors } = await adminPage(375);
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: /^\+ Add/ }).click();
  const editor = page.getByRole('dialog', { name: 'Add a product' });
  await editor.waitFor();
  assert.deepEqual(await overflow(page), [], 'editor fits a phone');
  await editor.locator('input[type=file]').setInputFiles({ name: 'sheet.png', mimeType: 'image/png', buffer: png() });
  await editor.getByAltText('Photo 1').waitFor();
  await editor.getByLabel('Name', { exact: true }).fill('Ajrakh Indigo One-Off');
  await editor.getByLabel('Price (AED)').fill('420');
  await editor.getByRole('button', { name: /Queen Size Bed/ }).click(); // add the Queen preset
  await editor.getByRole('button', { name: 'One more King Size Bed (Most Popular)' }).click(); // King 1 → 2
  await editor.getByRole('button', { name: 'Add to the shop' }).click();
  await editor.waitFor({ state: 'detached' });

  const card = page.locator('div.rounded-2xl', { hasText: 'Ajrakh Indigo One-Off' }).last();
  await card.getByText(/King \(180x200\): 2/).waitFor();
  await card.getByText(/Queen \(160x200\): 1/).waitFor();
  await card.getByRole('button', { name: /One fewer King/ }).click();
  await card.getByText(/King \(180x200\): 1/).waitFor();

  await card.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: /Edit Ajrakh Indigo One-Off/ });
  await edit.getByLabel('Price (AED)').fill('450');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await edit.waitFor({ state: 'detached' });
  await card.getByText('AED 450').first().waitFor();

  const p = (await (await fetch(`${server.base}/api/products`)).json()).products.find((x: { title: string }) => x.title === 'Ajrakh Indigo One-Off');
  assert.deepEqual(p.stockBySize, { king: 1, queen: 1 });
  assert.equal(p.price, 450);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('settings console: WhatsApp number and a festival theme show on the storefront straight away', { skip }, async () => {
  const { ctx, page } = await adminPage(1280);
  await page.getByRole('button', { name: /⚙️ Settings/ }).click();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await nav.getByRole('button', { name: 'Store & contact' }).click();
  await page.getByLabel('WhatsApp number').fill('050 765 4321');
  await page.getByRole('button', { name: 'Save store settings' }).click();
  await page.getByText(/Saved\. Customers see it straight away\./).waitFor();

  await nav.getByRole('button', { name: 'Festival themes' }).click();
  await page.getByText('Always this look').click();
  await page.getByLabel('Theme to show').selectOption('diwali');
  await page.getByText(/Saved\. The shop shows it now\./).waitFor();
  await ctx.close();

  const shopper = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await shopper.goto(server.base, { waitUntil: 'domcontentloaded' });
  const wa = shopper.getByRole('link', { name: 'Chat with us on WhatsApp' });
  await wa.waitFor();
  assert.match((await wa.getAttribute('href')) || '', /^https:\/\/wa\.me\/971507654321\?text=/);
  await shopper.getByRole('note').getByText(/Diwali/i).first().waitFor();
  assert.deepEqual(await overflow(shopper), []);
  await shopper.close();
  await api('PUT', '/api/admin/settings/theme', { settings: { mode: 'auto' } });
});

test('a sold-out size cannot be bought; "Only 1 left" shows; the price updates live without a reload', { skip }, async () => {
  const p = (await (await fetch(`${server.base}/api/products`)).json()).products.find((x: { title: string }) => x.title === 'Ajrakh Indigo One-Off');
  await api('POST', `/api/admin/products/${p.id}/stock`, { sizeId: 'queen', delta: -1 });
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('h3, h4').filter({ hasText: 'Ajrakh Indigo One-Off' }).first().click();
  await page.getByRole('button', { name: /Queen.*sold out/ }).click();
  await page.getByText(/sold out · Ask us/).waitFor();
  assert.equal(await page.getByRole('button', { name: /Add to Bag/ }).count(), 0);
  await page.getByRole('button', { name: /King.*only 1 left/ }).click();
  await page.getByRole('button', { name: /Add to Bag/ }).waitFor();
  await page.getByRole('button', { name: 'Close' }).first().click().catch(() => page.keyboard.press('Escape'));
  await page.keyboard.press('Escape').catch(() => {});

  // The owner changes the price; the open page shows it within seconds, no reload.
  const marker = await page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 42));
  await api('PATCH', `/api/admin/products/${p.id}`, { product: { price: 470 } });
  await page.getByText('AED 470').first().waitFor({ timeout: 10_000 });
  assert.equal(await page.evaluate(() => (window as unknown as { __mark?: number }).__mark), marker, 'same page, not reloaded');
  await page.close();
});

test('checkout remembers the customer’s details; a bag link restores the bag in another browser', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  const p = (await (await fetch(`${server.base}/api/products`)).json()).products[0];
  await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Returning Customer');
  await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('JLT');
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /bag/i }).first().click().catch(() => {});
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  assert.equal(await page.getByPlaceholder('e.g. Fatima Al Mansoori').inputValue(), 'Returning Customer');
  await page.getByText('Your details from last time are filled in.').waitFor();
  await ctx.close();

  // A bag link opened in a fresh browser (e.g. Safari after Instagram's in-app browser).
  const bag = Buffer.from(JSON.stringify([[p.id, p.defaultProfileId, '', 1]])).toString('base64url');
  const fresh = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await fresh.goto(`${server.base}/?bag=${bag}`, { waitUntil: 'domcontentloaded' });
  await fresh.getByText('Your Shopping Bag').waitFor();
  await fresh.getByText(p.title).first().waitFor();
  assert.ok(!fresh.url().includes('bag='), 'the link is tidied away');
  await fresh.close();
});

test('a product link opens the shop with that product, ready to share', { skip }, async () => {
  const p = (await (await fetch(`${server.base}/api/products`)).json()).products[0];
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await page.goto(`${server.base}/p/${p.id}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Add to Bag/ }).waitFor();
  await page.getByRole('button', { name: 'Share' }).waitFor();
  assert.deepEqual(await overflow(page), []);
  await page.close();
});

test('forgot password on a phone: the same answer for any email; a reset link opens "choose a new password" and is tidied away', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await checked;
  await page.locator('header button:has-text("Admin Hub")').click();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.locator('#admin-forgot-email').fill('stranger@example.com');
  await page.getByRole('button', { name: 'Email Me a Reset Link' }).click();
  await page.getByRole('status').filter({ hasText: /If that is the admin email/ }).waitFor();
  assert.deepEqual(await overflow(page), []);
  await page.close();

  const reset = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await reset.goto(`${server.base}/?reset=not-a-real-token`, { waitUntil: 'domcontentloaded' });
  await reset.locator('#admin-reset-password').waitFor();
  assert.ok(!reset.url().includes('reset='), 'the token leaves the address bar at once');
  await reset.locator('#admin-reset-password').fill('Another-Long-Passphrase-9');
  await reset.locator('#admin-reset-confirm').fill('Another-Long-Passphrase-9');
  await reset.getByRole('button', { name: 'Set New Password' }).click();
  await reset.getByText(/expired or was already used/).waitFor();
  assert.deepEqual(errors, []);
  await reset.close();
});

test('settings → Email & admin account: a private mail server is refused; the sign-in email is shown', { skip }, async () => {
  const { ctx, page, errors } = await adminPage(375);
  await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: /Settings/ }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Email & admin account' }).click();
  await page.getByLabel('Server').fill('10.0.0.5');
  await page.getByRole('button', { name: 'Save email settings' }).click();
  await page.getByText('The mail server must be a public address.').waitFor();
  assert.equal(await page.getByLabel('Sign-in email').inputValue(), 'admin@beautifuluaehome.com');
  assert.deepEqual(await overflow(page), []);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('version badge: bottom left for everyone; for the owner it opens Settings → Versions with every release', { skip }, async () => {
  const shopper = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await shopper.goto(server.base, { waitUntil: 'domcontentloaded' });
  const badge = shopper.getByLabel(/^Version BUH-\d{2}\.\d{2}\.\d{2}$/);
  await badge.waitFor();
  const box = (await badge.boundingBox())!;
  assert.ok(box.x < 20 && box.y > 600, `bottom left (${box.x}, ${box.y})`);
  assert.deepEqual(await overflow(shopper), []);
  await shopper.close();

  for (const width of [375, 1280]) {
    const { ctx, page, errors } = await adminPage(width);
    await page.getByRole('button', { name: /^BUH-\d{2}\.\d{2}\.\d{2}$/ }).click();
    await page.getByText('BUH-01.00.00').first().waitFor();
    await page.getByText(/Automatic updates are not running on this server/).waitFor();
    assert.equal(await page.getByText('Running', { exact: true }).count(), 1);
    assert.deepEqual(await overflow(page), [], `no sideways scroll at ${width}px`);
    assert.deepEqual(errors, []);
    await ctx.close();
  }
});
