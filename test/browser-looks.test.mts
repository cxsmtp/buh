/**
 * Settings → Look in a real browser against the production build: the shop and the Admin Hub follow
 * the device (Playwright's colorScheme) or the owner's fixed choice, at 375 and 1280 px, with no
 * sideways scroll and no white or black surfaces left in dark; the look arrives with the page
 * (/look.css, no flash, no script); a festival's accent shows, lifted, on dark; the owner switches
 * looks and switches back from the hub; and the storefront carries none of it beyond the stylesheet.
 * The screens added since (test/newer-screens.mts: card option, confirmation, /pay, order panels,
 * Money, Settings → Phone check, Payments and Look) are walked the same way.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { LOOK_PRESETS, contrast, festiveAccentForDark } from '@/lib/design/themes';
import { PALETTE } from '@/lib/design/tokens';
import { FESTIVALS } from '@/lib/festivals/catalog';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { prepareNewerScreens, walkNewerScreens, type NewerScreens } from './newer-screens.mjs';
import { startStripeMock, type StripeMock } from './stripe-mock.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';
let stripe: StripeMock;
let newer: NewerScreens;
const h = () => ({ 'content-type': 'application/json', origin: server.base, cookie });

before(async () => {
  if (skip) return;
  stripe = await startStripeMock();
  server = await startServer({ BUH_TEST_STRIPE_API: stripe.url, CARD_SWEEP_DISABLED: '1' });
  browser = await pw!.chromium.launch();
  const j = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: j, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: j, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...j, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Looks-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  newer = await prepareNewerScreens(server, cookie);
});
after(async () => {
  await browser?.close();
  server?.stop();
  await stripe?.close();
});

async function setLook(preset: string, mode: string) {
  const r = await fetch(`${server.base}/api/admin/look`, { method: 'PUT', headers: h(), body: JSON.stringify({ preset, mode }) });
  assert.equal(r.status, 200, await r.text());
}

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

/**
 * Big visible boxes painted pure white or pure black (a surface the look forgot), outside photos,
 * the photo zoom's own black frame and paper (a shipping label).
 */
const STARK = `function () {
  var out = [];
  var all = document.querySelectorAll('body *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    if (el.closest('.look-paper,img,video,canvas,svg,picture')) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 32 || r.height < 24 || r.bottom < 0 || r.top > innerHeight) continue;
    var s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') continue;
    var bg = s.backgroundColor;
    if (bg === 'rgb(255, 255, 255)' || bg === 'rgb(0, 0, 0)') out.push(el.tagName.toLowerCase() + '.' + (el.getAttribute('class') || '').split(/\\s+/).slice(0, 4).join('.') + ' ' + bg);
  }
  return out;
}`;

async function check(page: Page, where: string, bodyBg: string): Promise<string[]> {
  const problems: string[] = [];
  const got = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (got !== bodyBg) problems.push(`${where}: page is ${got}, not ${bodyBg}`);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (sideways > 0) problems.push(`${where}: scrolls sideways by ${sideways}px`);
  for (const s of (await page.evaluate(`(${STARK})()`)) as string[]) problems.push(`${where}: stark surface ${s}`);
  return problems;
}

/** The shop (front, a product, the bag, checkout) and the hub (every tab, Settings → Look). */
async function walk(colorScheme: 'light' | 'dark', width: number, bodyBg: string): Promise<string[]> {
  const problems: string[] = [];
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, colorScheme });
  const page = await ctx.newPage();
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().waitFor();
  await page.waitForTimeout(400);
  problems.push(...(await check(page, `shop ${colorScheme} ${width}`, bodyBg)));
  const p = (await (await fetch(`${server.base}/api/products`)).json()).products[0];
  await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).waitFor();
  await page.waitForTimeout(400);
  problems.push(...(await check(page, `product ${colorScheme} ${width}`, bodyBg)));
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).waitFor();
  await page.waitForTimeout(400);
  problems.push(...(await check(page, `bag ${colorScheme} ${width}`, bodyBg)));
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  await page.waitForTimeout(400);
  problems.push(...(await check(page, `checkout ${colorScheme} ${width}`, bodyBg)));
  await ctx.close();

  const admin = await browser.newContext({ viewport: { width, height: 860 }, colorScheme });
  const [n, v] = cookie.split('=');
  await admin.addCookies([{ name: n, value: v, url: server.base }]);
  const a = await admin.newPage();
  await a.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await a.getByRole('navigation', { name: 'Admin sections' }).waitFor();
  for (const tab of ['Orders', 'Inventory', 'Settings']) {
    await openAdminSection(a, new RegExp(`^${tab}`));
    await a.waitForTimeout(400);
    problems.push(...(await check(a, `hub ${tab} ${colorScheme} ${width}`, bodyBg)));
  }
  await a.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look' }).click();
  await a.getByTestId('look-current').waitFor();
  await a.waitForTimeout(300);
  problems.push(...(await check(a, `hub Look ${colorScheme} ${width}`, bodyBg)));
  await admin.close();
  return problems;
}

test('/look.css: the chosen look, light and dark by the device, checked with the server (304 when unchanged)', { skip }, async () => {
  const r = await fetch(`${server.base}/look.css`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /^text\/css/);
  assert.match(r.headers.get('cache-control') || '', /max-age=0, must-revalidate/);
  const css = await r.text();
  assert.match(css, /Ivory & Gold, Match the device/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  const etag = r.headers.get('etag')!;
  assert.equal((await fetch(`${server.base}/look.css`, { headers: { 'if-none-match': etag } })).status, 304);
  // The front page links it in its head, before the page's own styles are used.
  const html = await (await fetch(server.base)).text();
  assert.match(html, /<head>[\s\S]*<link rel="stylesheet" href="\/look.css"\/>[\s\S]*<\/head>/);
  assert.match(html, /<meta name="theme-color" content="#2b2127" media="\(prefers-color-scheme: light\)"\/>/);
  assert.match(html, new RegExp(`<meta name="theme-color" content="${LOOK_PRESETS['ivory-gold'].dark.colors.ivory}" media="\\(prefers-color-scheme: dark\\)"/>`));
  await setLook('noir-champagne', 'dark');
  const after = await fetch(`${server.base}/look.css`, { headers: { 'if-none-match': etag } });
  assert.equal(after.status, 200);
  assert.match(await after.text(), /Noir & Champagne, Always dark/);
  // The installed app opens in the fixed dark look.
  const m = await (await fetch(`${server.base}/manifest.webmanifest`)).json();
  assert.equal(m.background_color, LOOK_PRESETS['noir-champagne'].dark.colors.ivory);
  await setLook('ivory-gold', 'system');
  const m2 = await (await fetch(`${server.base}/manifest.webmanifest`)).json();
  assert.deepEqual([m2.theme_color, m2.background_color], [PALETTE.ink, PALETTE.ivory]);
  // Admin only: the door and a session, an allow-list, nothing extra.
  assert.equal((await fetch(`${server.base}/api/admin/look`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: server.base }, body: '{"preset":"sand-rose","mode":"dark"}' })).status, 401);
  assert.equal((await fetch(`${server.base}/api/admin/look`, { method: 'PUT', headers: h(), body: '{"preset":"neon","mode":"dark"}' })).status, 400);
  assert.equal((await fetch(`${server.base}/api/admin/look`, { method: 'PUT', headers: h(), body: '{"preset":"sand-rose","mode":"dark","changedBy":"someone"}' })).status, 400);
  assert.equal((await fetch(`${server.base}/api/admin/look`, { method: 'POST', headers: h(), body: '{"switchBack":"x"}' })).status, 400);
});

test('light Ivory & Gold paints exactly the palette from before looks', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().waitFor();
  const vars = await page.evaluate((names) => names.map((t) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${t}`).trim().toLowerCase()), Object.keys(PALETTE));
  assert.deepEqual(vars, Object.values(PALETTE));
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
  await ctx.close();
});

for (const [preset, mode] of [['ivory-gold', 'system'], ['noir-champagne', 'system'], ['pearl-emerald', 'system'], ['sand-rose', 'system']] as const) {
  test(`${preset}: the shop and the hub match the device, light and dark, at 375 and 1280 px`, { skip }, async () => {
    await setLook(preset, mode);
    const problems: string[] = [];
    for (const width of [375, 1280]) {
      problems.push(...(await walk('light', width, rgb(LOOK_PRESETS[preset].light.colors.ivory))));
      problems.push(...(await walk('dark', width, rgb(LOOK_PRESETS[preset].dark.colors.ivory))));
    }
    await setLook('ivory-gold', 'system');
    assert.deepEqual(problems, []);
  });
}

const NEWER_RUNS: Array<{ preset: keyof typeof LOOK_PRESETS; colorScheme: 'light' | 'dark'; width: number }> = [
  { preset: 'ivory-gold', colorScheme: 'light', width: 375 },
  { preset: 'ivory-gold', colorScheme: 'dark', width: 375 },
  { preset: 'ivory-gold', colorScheme: 'dark', width: 1280 },
  { preset: 'noir-champagne', colorScheme: 'dark', width: 375 },
  { preset: 'pearl-emerald', colorScheme: 'dark', width: 1280 },
];
const SHOTS = process.env.LOOKS_SCREENSHOTS;
for (const { preset, colorScheme, width } of NEWER_RUNS) {
  test(`${preset} ${colorScheme} at ${width} px: the newer screens (card option, confirmation, /pay, order panels, Money, Phone check, Payments, Look) wear the look`, { skip }, async () => {
    await setLook(preset, 'system');
    const problems: string[] = [];
    try {
      await walkNewerScreens(browser, server, cookie, newer, colorScheme, width, async (page, where) => {
        problems.push(...(await check(page, `${where} ${colorScheme} ${width}`, rgb(LOOK_PRESETS[preset][colorScheme].colors.ivory))));
        if (SHOTS) {
          fs.mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: path.join(SHOTS, `${preset}-${colorScheme}-${width}-${where.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.png`) });
        }
      });
    } finally {
      await setLook('ivory-gold', 'system');
    }
    assert.deepEqual(problems, []);
  });
}

test('Always dark wins over a light device, Always light over a dark one; the hub follows too', { skip }, async () => {
  await setLook('pearl-emerald', 'dark');
  let problems = await walk('light', 375, rgb(LOOK_PRESETS['pearl-emerald'].dark.colors.ivory));
  await setLook('pearl-emerald', 'light');
  problems = problems.concat(await walk('dark', 375, rgb(LOOK_PRESETS['pearl-emerald'].light.colors.ivory)));
  await setLook('ivory-gold', 'system');
  assert.deepEqual(problems, []);
});

test('a festival accent shows on dark, lifted to read on the dark page', { skip }, async () => {
  const f = FESTIVALS.find((x) => x.id === 'eid-al-fitr')!;
  await fetch(`${server.base}/api/admin/settings/theme`, { method: 'PUT', headers: h(), body: JSON.stringify({ settings: { mode: 'manual', themeId: f.id, showBanner: true, showMarquee: true } }) });
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 375, height: 800 }, colorScheme });
      const page = await ctx.newPage();
      await page.goto(server.base, { waitUntil: 'domcontentloaded' });
      const note = page.getByRole('note').first();
      await note.waitFor();
      const accent = await note.locator('.text-festive').first().evaluate((el) => getComputedStyle(el).color);
      const band = await note.evaluate((el) => getComputedStyle(el).backgroundColor);
      const want = colorScheme === 'light' ? f.theme.accent : festiveAccentForDark(f.theme.accent);
      assert.equal(accent, rgb(want), `${colorScheme} accent`);
      const toHex = (c: string) => '#' + (c.match(/\d+/g) || []).slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('');
      assert.ok(contrast(toHex(accent), toHex(band)) >= 4.5, `${colorScheme}: ${accent} on ${band}`);
      if (colorScheme === 'dark') assert.notEqual(band, rgb(f.theme.accentSoft), 'the band is a dark tint, not the light one');
      await ctx.close();
    }
  } finally {
    await fetch(`${server.base}/api/admin/settings/theme`, { method: 'PUT', headers: h(), body: JSON.stringify({ settings: { mode: 'auto' } }) });
  }
});

test('the owner changes the look in the hub and switches back to the look before themes', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 860 }, colorScheme: 'dark' });
  const [n, v] = cookie.split('=');
  await ctx.addCookies([{ name: n, value: v, url: server.base }]);
  const a = await ctx.newPage();
  a.on('dialog', (d) => void d.accept());
  await a.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await openAdminSection(a, /^Settings/);
  await a.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look' }).click();
  await a.getByTestId('look-current').waitFor();
  assert.match(await a.getByTestId('look-current').textContent() || '', /Current: Ivory & Gold · Match the device · since \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d/);
  // Keyboard: the looks are one radio group.
  await a.getByRole('radio', { name: /Ivory & Gold/ }).focus();
  await a.keyboard.press('ArrowDown');
  assert.equal(await a.getByRole('radio', { name: /Noir & Champagne/ }).isChecked(), true);
  await a.locator('label').filter({ hasText: 'Always light' }).click();
  assert.equal(await a.getByRole('radio', { name: 'Always light' }).isChecked(), true);
  await a.getByRole('button', { name: 'Save look' }).click();
  await a.getByRole('status').filter({ hasText: 'Saved: Noir & Champagne · Always light' }).waitFor();
  assert.match(await a.getByTestId('look-current').textContent() || '', /Noir & Champagne · Always light .* by admin@beautifuluaehome\.com/);
  // The hub itself turns light at once, on a dark device.
  await a.waitForFunction((bg) => getComputedStyle(document.body).backgroundColor === bg, rgb(LOOK_PRESETS['noir-champagne'].light.colors.ivory));
  // Switch back to the look from before themes.
  await a.getByRole('button', { name: /^Switch back to Ivory & Gold — the look before themes/ }).click();
  await a.getByRole('status').filter({ hasText: 'Switched back to Ivory & Gold · Always light' }).waitFor();
  const now = await (await fetch(`${server.base}/api/admin/look`, { headers: h() })).json();
  assert.equal(now.current.preset, 'ivory-gold');
  assert.equal(now.current.mode, 'light');
  assert.equal(now.current.label, 'Switched back to: Ivory & Gold — the look before themes');
  assert.ok(now.earlier.some((e: { label: string; pinned: boolean }) => e.pinned && e.label === 'Ivory & Gold — the look before themes'));
  await a.waitForFunction((bg) => getComputedStyle(document.body).backgroundColor === bg, rgb(PALETTE.ivory));
  // The change is audited and in Settings → System → History.
  const hist = await (await fetch(`${server.base}/api/admin/settings/history`, { headers: h() })).json();
  assert.ok(hist.versions.some((x: { key: string }) => x.key === 'look'));
  const auditLog = fs.readdirSync(server.dataDir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8')).join('\n');
  assert.match(auditLog, /"look\.changed"/);
  assert.match(auditLog, /"look\.switched_back"/);
  await ctx.close();
  await setLook('ivory-gold', 'system');
});

test('the storefront carries no Look settings code: only the small stylesheet', { skip }, async () => {
  const html = await (await fetch(server.base)).text();
  const scripts = [...new Set(html.match(/\/_next\/static\/[^"'\s<>]+\.js/g) || [])];
  assert.ok(scripts.length > 0);
  let bytes = 0;
  for (const s of scripts) {
    const js = await (await fetch(`${server.base}${s}`)).text();
    bytes += js.length;
    for (const word of ['Earlier looks', 'Switch back to', '/api/admin/look', 'Save look']) assert.ok(!js.includes(word), `${s} carries "${word}"`);
  }
  const css = await (await fetch(`${server.base}/look.css`)).text();
  assert.ok(css.length < 4096, `look.css is ${css.length} bytes`);
  console.log(`storefront first-load scripts: ${scripts.length} files, ${bytes} bytes; look.css ${css.length} bytes`);
});
