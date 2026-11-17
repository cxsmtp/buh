/**
 * The fuller festive look (asked by the owner: "I don't see any festival theme except a small
 * banner… the website should feel home and festive as per the festival calendar"), in Chromium
 * against the production build at 375 px (a phone) and 1280 px (a laptop):
 *  - Festive (the default): the festival's motif as a garland under the header, the whole greeting
 *    with the days to go, a soft wash of the festival's colour behind the top of the shop, and the
 *    greeting again at the foot;
 *  - Subtle (Settings → Festival themes): one slim greeting line, as before, and none of the above;
 *  - a day of remembrance is always calm, whatever the setting;
 *  - the everyday look (no festival) carries none of it;
 *  - nothing moves on a device set to reduce motion; no sideways scroll; no page errors;
 *  - the setting is checked on the server, and a setting saved before the choice existed is Festive.
 * Skipped without a build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';

const OWNER_PASSWORD = ownerPassword();
type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild || !pw;
type Page = import('playwright').Page;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${server.base}${path}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const theme = async (settings: Record<string, unknown>) => {
  const res = await api('PUT', '/api/admin/settings/theme', { settings });
  assert.equal(res.status, 200, await res.clone().text());
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  browser = await pw!.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

async function open(width: number, opts: { reducedMotion?: 'reduce' | 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: opts.reducedMotion ?? 'no-preference' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().waitFor();
  return { ctx, page, errors };
}

test('the setting: Festive unless the owner chose Subtle; checked on the server; shoppers are told which', { skip }, async () => {
  const before = (await (await api('GET', '/api/admin/settings')).json()) as { theme: { value: { festiveLook?: string } } };
  assert.equal(before.theme.value.festiveLook, 'full', 'Festive by default');
  assert.equal((await api('PUT', '/api/admin/settings/theme', { settings: { festiveLook: 'loud' } })).status, 400);
  await theme({ mode: 'manual', themeId: 'diwali', festiveLook: 'subtle' });
  let pub = (await (await fetch(`${server.base}/api/settings/public`)).json()) as { festival: { festivalId: string; look: string; solemn: boolean } };
  assert.deepEqual([pub.festival.festivalId, pub.festival.look, pub.festival.solemn], ['diwali', 'subtle', false]);
  // Another field saved without the choice: the choice stays.
  await theme({ showMarquee: true });
  pub = (await (await fetch(`${server.base}/api/settings/public`)).json()) as typeof pub;
  assert.equal(pub.festival.look, 'subtle');
  await theme({ mode: 'manual', themeId: 'commemoration-day', festiveLook: 'full' });
  pub = (await (await fetch(`${server.base}/api/settings/public`)).json()) as typeof pub;
  assert.deepEqual([pub.festival.look, pub.festival.solemn], ['full', true]);
});

for (const width of [375, 1280]) {
  test(`Festive at ${width} px: a garland under the header, the whole greeting, the wash, the greeting at the foot; nothing wider than the screen`, { skip }, async () => {
    await theme({ mode: 'manual', themeId: 'diwali', festiveLook: 'full', showBanner: true });
    const { ctx, page, errors } = await open(width);
    const garland = page.getByTestId('festive-garland');
    await garland.waitFor();
    // Under the header, across the page, and only decoration.
    const top = await page.getByTestId('shop-top').boundingBox();
    const g = await garland.boundingBox();
    assert.ok(top && g && g.y >= top.y + top.height - 1, 'the garland hangs under the header');
    assert.ok(g!.width >= width - 2, 'across the whole page');
    assert.equal(await garland.getAttribute('aria-hidden'), 'true');
    const shown = await garland.locator('[data-garland-swag]').evaluateAll((els) => els.filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0).length);
    assert.equal(shown, width < 640 ? 4 : 9, 'four swags on a phone, more on a wide screen');
    assert.ok(g!.height >= 50, 'a garland, not a hairline');
    await page.getByTestId('festive-divider').waitFor();
    // The whole greeting, not the slim line: its motif in a ring, the greeting in the serif.
    const note = page.getByRole('note').first();
    assert.match((await note.textContent()) ?? '', /Happy Diwali/);
    assert.ok((await note.boundingBox())!.height >= 90, 'the larger band');
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/festive-${width}.png` });
    // The wash of the festival's tint, and the greeting again at the foot of the shop.
    const root = page.locator('[data-festive-look="full"]');
    assert.match(await root.evaluate((el) => getComputedStyle(el).backgroundImage), /linear-gradient/);
    await page.getByTestId('festive-footer').scrollIntoViewIfNeeded();
    assert.match((await page.getByTestId('festive-footer').textContent()) ?? '', /Happy Diwali/);
    // It twinkles (each motif on its own beat)…
    assert.notEqual(await garland.locator('.festive-twinkle').first().evaluate((el) => getComputedStyle(el).animationName), 'none');
    assert.equal(await overflow(page), 0, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await ctx.close();
    // …and is still on a device that asks for less motion.
    const calm = await open(width, { reducedMotion: 'reduce' });
    assert.equal(await calm.page.getByTestId('festive-garland').locator('.festive-twinkle').first().evaluate((el) => getComputedStyle(el).animationName), 'none');
    await calm.ctx.close();
  });

  test(`Subtle, a day of remembrance, and the everyday look at ${width} px: one slim line or none, and no garland`, { skip }, async () => {
    await theme({ mode: 'manual', themeId: 'diwali', festiveLook: 'subtle', showBanner: true });
    let { ctx, page, errors } = await open(width);
    assert.match((await page.getByRole('note').first().textContent()) ?? '', /Happy Diwali/);
    assert.ok((await page.getByRole('note').first().boundingBox())!.height < 60, 'the slim line');
    assert.equal(await page.getByTestId('festive-garland').count(), 0);
    assert.equal(await page.getByTestId('festive-footer').count(), 0);
    assert.equal(await page.getByTestId('festive-divider').count(), 0);
    assert.equal(await page.locator('[data-festive-look]').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();

    // A day of remembrance: calm, though the look is set to Festive.
    await theme({ mode: 'manual', themeId: 'commemoration-day', festiveLook: 'full' });
    ({ ctx, page, errors } = await open(width));
    await page.getByRole('note').first().waitFor();
    assert.equal(await page.getByTestId('festive-garland').count(), 0);
    assert.equal(await page.getByTestId('festive-footer').count(), 0);
    assert.deepEqual(errors, []);
    await ctx.close();

    // The greeting switched off: nothing festive is added either.
    await theme({ mode: 'manual', themeId: 'diwali', festiveLook: 'full', showBanner: false });
    ({ ctx, page, errors } = await open(width));
    assert.equal(await page.getByTestId('festive-garland').count(), 0);
    await ctx.close();

    // No festival: the everyday shop.
    await theme({ mode: 'off', showBanner: true });
    ({ ctx, page, errors } = await open(width));
    assert.equal(await page.getByTestId('festive-garland').count(), 0);
    assert.equal(await page.getByRole('note').count(), 0);
    assert.equal(await overflow(page), 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('upcoming festivals say how near they are; the hub offers Festive and Subtle', { skip }, async () => {
  await theme({ mode: 'auto', festiveLook: 'full', showBanner: true, disabledFestivals: [] });
  const pub = (await (await fetch(`${server.base}/api/settings/public`)).json()) as { festival: { festivalId: string | null; phase: string; daysToStart: number | null; solemn: boolean } };
  const { ctx, page } = await open(1280);
  if (pub.festival.festivalId && !pub.festival.solemn && (pub.festival.phase === 'during' || (pub.festival.phase === 'upcoming' && pub.festival.daysToStart))) {
    const text = (await page.getByTestId('festive-countdown').textContent()) ?? '';
    assert.match(text, pub.festival.phase === 'during' ? /Celebrating now/ : pub.festival.daysToStart === 1 ? /Tomorrow/ : new RegExp(`In ${pub.festival.daysToStart} days`));
  } else {
    assert.equal(await page.getByTestId('festive-countdown').count(), 0, 'no festival near today: nothing to count down to');
  }
  await ctx.close();
});
