/**
 * Every screen readable, on any device: text contrast measured in a real browser, in light and
 * dark mode (a phone or laptop set to dark mode once made labels invisible on white cards),
 * at phone and desktop width. Covers the shop (its filter sheet, filtered view and search), the
 * "Install the app" offer, a product and its full-screen photo, the bag, checkout, the chat, the
 * admin sign-in, the offline page and every Admin Hub tab and settings section.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
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
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Contrast-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
});
after(async () => {
  await browser?.close();
  server?.stop();
});

/**
 * Wait until nothing on the page is still sliding or fading (a sheet coming up, a button's colour
 * changing): every finite CSS animation and transition has finished. Endless ones (a spinner, the
 * ticker) are left out. Measuring mid-slide reads colours that are on their way.
 */
async function settled(page: import('playwright').Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((an) => an.playState !== 'running' || an.effect?.getComputedTiming().iterations === Infinity)
  );
}

/** Text whose contrast against what is behind it is below `min` (WCAG ratio). */
async function lowContrast(page: import('playwright').Page, where: string, min = 3): Promise<string[]> {
  // Plain script text: the test runner's compiler would otherwise add helpers the page doesn't have.
  return page.evaluate(`(${AUDIT})(${JSON.stringify(where)}, ${min})`) as Promise<string[]>;
}

const AUDIT = `function (where, min) {
  var cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  var cx = cv.getContext('2d', { willReadFrequently: true });
  var cache = {};
  function parse(c) {
    // Any CSS colour (rgb, oklch, lab…): the browser paints one pixel and we read it back.
    if (!c || c === 'transparent') return null;
    if (cache[c]) return cache[c];
    var alpha = 1;
    var am = c.match(/\\/\\s*([\\d.]+)(%?)\\s*\\)$/) || c.match(/^rgba\\([^,]+,[^,]+,[^,]+,\\s*([\\d.]+)\\)$/);
    if (am) alpha = am[2] === '%' ? parseFloat(am[1]) / 100 : parseFloat(am[1]);
    if (alpha === 0) return null;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#fff';
    cx.fillStyle = c;
    var solid = cx.fillStyle;
    cx.globalAlpha = 1;
    cx.fillRect(0, 0, 1, 1);
    var d = cx.getImageData(0, 0, 1, 1).data;
    // Painted colours are pre-composited on nothing: undo the alpha the canvas applied.
    var a = d[3] / 255;
    var out = a > 0 ? { r: d[0], g: d[1], b: d[2], a: alpha } : null;
    void solid;
    cache[c] = out;
    return out;
  }
  function lum(c) {
    function f(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function overImage(el, r) {
    // Text laid over a photo (badges on product pictures): its background can't be measured here.
    var stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    var i = stack.indexOf(el);
    for (var k = i + 1; k < stack.length; k++) {
      var t = stack[k].tagName;
      if (t === 'IMG' || t === 'VIDEO' || t === 'CANVAS' || t === 'PICTURE') return true;
      var c = parse(getComputedStyle(stack[k]).backgroundColor);
      if (c && c.a >= 1) return false;
    }
    return false;
  }
  function background(el) {
    var layers = [];
    for (var e = el; e; e = e.parentElement) {
      var s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      var c = parse(s.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    var out = { r: 255, g: 255, b: 255 };
    layers.reverse().forEach(function (l) { out = { r: l.r * l.a + out.r * (1 - l.a), g: l.g * l.a + out.g * (1 - l.a), b: l.b * l.a + out.b * (1 - l.a) }; });
    return out;
  }
  var bad = [];
  var seen = new Set();
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var n = walker.nextNode(); n; n = walker.nextNode()) {
    var el = n.parentElement;
    var text = (n.textContent || '').trim();
    if (!el || seen.has(el) || !text) continue;
    seen.add(el);
    if (el.closest('script,style,noscript,[aria-hidden="true"],.sr-only,option')) continue;
    var s = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if (s.visibility === 'hidden' || s.display === 'none' || r.width === 0 || r.height === 0) continue;
    var faded = false;
    for (var e = el; e; e = e.parentElement) if (+getComputedStyle(e).opacity < 0.5) faded = true;
    if (faded || el.closest('[disabled],:disabled')) continue;
    if (r.bottom < 0 || r.top > innerHeight || overImage(el, r)) continue;
    var fg = parse(s.color);
    var bg = background(el);
    if (!fg || !bg) continue;
    var f = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    var a = lum(f), b = lum(bg);
    var ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < min) bad.push(where + ': "' + text.slice(0, 50) + '" ' + ratio.toFixed(2) + ':1 (' + s.color + ' on rgb(' + (bg.r | 0) + ',' + (bg.g | 0) + ',' + (bg.b | 0) + '))');
  }
  return bad;
}`;

for (const colorScheme of ['dark', 'light'] as const) {
  for (const width of [375, 1280]) {
    test(`every screen is readable (${colorScheme} mode, ${width} px)`, { skip }, async () => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const page = await ctx.newPage();
      const problems: string[] = [];
      const ready = page.waitForResponse((r) => r.url().endsWith('/api/settings/public'));
      await page.goto(server.base, { waitUntil: 'domcontentloaded' });
      await ready;
      await page.waitForTimeout(500);
      problems.push(...(await lowContrast(page, 'shop')));
      // The "Install the app" offer (the phone's install event, stood in for here).
      await page.evaluate(() => {
        const e = new Event('beforeinstallprompt') as Event & { prompt?: () => Promise<void>; userChoice?: Promise<unknown> };
        e.prompt = async () => {};
        e.userChoice = Promise.resolve({ outcome: 'dismissed' });
        window.dispatchEvent(e);
      });
      const install = page.getByRole('region', { name: 'Install the app' });
      await install.waitFor({ timeout: 9000 });
      await page.waitForTimeout(400); // risen into place
      problems.push(...(await lowContrast(page, 'install offer')));
      await install.getByRole('button', { name: 'Not now' }).click();
      // The Filter sheet, a story chosen with chips showing, and search with its matches.
      await page.getByRole('button', { name: /^Filter and sort/ }).click();
      const filters = page.getByRole('dialog', { name: 'Filter & sort' });
      await filters.waitFor();
      await filters.getByRole('button', { name: /^King/ }).click();
      await page.waitForTimeout(400); // the chosen pill's colour change has finished
      problems.push(...(await lowContrast(page, 'filters')));
      await filters.getByRole('button', { name: /^Show/ }).click();
      await page.getByRole('group', { name: 'Filters on' }).waitFor();
      await page.getByRole('group', { name: 'Collections' }).getByRole('button').nth(1).click();
      await page.waitForTimeout(300);
      problems.push(...(await lowContrast(page, 'filtered shop')));
      if (width < 768) await page.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: 'Search' }).click();
      else await page.getByRole('button', { name: 'Search products' }).click();
      await page.keyboard.type('set');
      await page.getByRole('dialog', { name: 'Search the shop' }).getByRole('listitem').first().waitFor();
      problems.push(...(await lowContrast(page, 'search')));
      await page.keyboard.press('Escape');
      await page.goto(server.base, { waitUntil: 'domcontentloaded' });
      await page.locator('main h3').first().waitFor();
      const p = (await (await fetch(`${server.base}/api/products`)).json()).products[0];
      await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
      await page.getByRole('button', { name: /Add to Bag/ }).waitFor();
      problems.push(...(await lowContrast(page, 'product')));
      await page.getByRole('button', { name: 'Zoom photo' }).click();
      await page.getByTestId('photo-zoom').waitFor();
      problems.push(...(await lowContrast(page, 'photo zoom')));
      await page.keyboard.press('Escape');
      await page.getByTestId('photo-zoom').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: /Add to Bag/ }).click();
      await page.getByRole('button', { name: /Proceed to Checkout/ }).waitFor();
      problems.push(...(await lowContrast(page, 'bag')));
      await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
      await page.locator('#checkout-phone').waitFor();
      problems.push(...(await lowContrast(page, 'checkout')));
      // The area suggestions, with one highlighted and another emirate's areas shown.
      await page.locator('#checkout-area').click();
      await page.keyboard.type('al n');
      await page.getByRole('listbox', { name: 'Area suggestions' }).waitFor();
      await page.keyboard.press('ArrowDown');
      problems.push(...(await lowContrast(page, 'checkout area list')));
      await page.keyboard.press('Escape'); // closes the list
      await page.getByRole('listbox', { name: 'Area suggestions' }).waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Help and chat' }).click();
      await page.getByRole('dialog', { name: 'Chat with the shop' }).waitFor();
      problems.push(...(await lowContrast(page, 'chat')));
      await page.keyboard.press('Escape');
      // The Admin Hub's sign-in, at its private link (the shop itself has no way in).
      await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
      await page.getByText('Admin Hub Security Access').waitFor();
      problems.push(...(await lowContrast(page, 'sign-in')));
      // What the installed app shows without a connection.
      await page.goto(`${server.base}/offline`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'You are offline' }).waitFor();
      problems.push(...(await lowContrast(page, 'offline page')));
      await ctx.close();

      // The Admin Hub: every tab and every settings section.
      const admin = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
      const [n, v] = cookie.split('=');
      await admin.addCookies([{ name: n, value: v, url: server.base }]);
      const a = await admin.newPage();
      const signed = a.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
      await a.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
      await signed;
      const nav = a.getByRole('navigation', { name: 'Admin sections' });
      await nav.waitFor();
      for (const tab of ['Orders', 'Chats', 'Inventory', 'Customers', 'Settings']) {
        await openAdminSection(a, new RegExp(`^${tab}`));
        await settled(a);
        problems.push(...(await lowContrast(a, `admin ${tab}`)));
        if (tab === 'Inventory') {
          // The phone inventory: a product opened with its steppers, the Undo toast, Received stock,
          // the history, the step-by-step editor, and the More menu.
          await a.getByRole('button', { name: /^Stock and actions for/ }).first().click();
          await a.getByRole('button', { name: /^One more/ }).first().click();
          await a.getByRole('button', { name: 'Undo' }).waitFor();
          await settled(a);
          problems.push(...(await lowContrast(a, 'inventory open, Undo toast')));
          await a.getByRole('button', { name: /^Received stock for/ }).first().click();
          await a.getByRole('dialog', { name: 'Received stock' }).waitFor();
          await settled(a);
          problems.push(...(await lowContrast(a, 'received stock')));
          await a.keyboard.press('Escape');
          await a.getByRole('button', { name: /^Stock history of/ }).first().click();
          await a.getByRole('dialog', { name: 'Stock history' }).getByText(/by /).first().waitFor();
          await settled(a);
          problems.push(...(await lowContrast(a, 'stock history')));
          await a.keyboard.press('Escape');
          await a.getByRole('button', { name: 'Add product' }).first().click();
          const wizard = a.getByRole('dialog', { name: 'Add a product' });
          await wizard.waitFor();
          await settled(a);
          problems.push(...(await lowContrast(a, 'editor: photos')));
          for (const step of ['Details', 'Sizes', 'Publish']) {
            await wizard.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: new RegExp(step) }).click();
            await settled(a);
          }
          problems.push(...(await lowContrast(a, 'editor: step shown')));
          await a.keyboard.press('Escape');
          if (width < 640) {
            await nav.getByRole('button', { name: 'More' }).click();
            await a.getByRole('dialog', { name: 'More' }).waitFor();
            await settled(a);
            problems.push(...(await lowContrast(a, 'more menu')));
            await a.keyboard.press('Escape');
          }
        }
      }
      await a.getByRole('navigation', { name: 'Settings sections' }).waitFor(); // loaded with the Admin Hub, on demand
      const sections = a.getByRole('navigation', { name: 'Settings sections' }).getByRole('button');
      const count = await sections.count();
      assert.ok(count >= 10);
      for (let i = 0; i < count; i++) {
        const name = (await sections.nth(i).textContent())?.trim();
        await sections.nth(i).click();
        await a.waitForTimeout(400);
        problems.push(...(await lowContrast(a, `settings ${name}`)));
      }
      await admin.close();
      assert.deepEqual(problems, [], `${problems.length} hard-to-read texts`);
    });
  }
}

// Every festival look on the shop (greeting band, story ring, announcement bar), at phone and
// desktop width: the accents stay readable on the shop's ivory.
for (const width of [360, 1280]) {
  test(`festival looks are readable (${width} px)`, { skip }, async () => {
    const problems: string[] = [];
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const h = { 'content-type': 'application/json', origin: server.base, cookie };
    const { FESTIVALS } = await import('@/lib/festivals/catalog');
    const palettes = new Set<string>();
    for (const f of FESTIVALS) {
      // One festival per curated accent, plus the ones the owner named and a solemn day.
      if (palettes.has(f.theme.palette) && !['eid-al-fitr', 'diwali', 'uae-national-day', 'good-friday'].includes(f.id)) continue;
      palettes.add(f.theme.palette);
      await fetch(`${server.base}/api/admin/settings/theme`, { method: 'PUT', headers: h, body: JSON.stringify({ settings: { mode: 'manual', themeId: f.id, showBanner: true, showMarquee: true } }) });
      await page.goto(server.base, { waitUntil: 'domcontentloaded' });
      await page.getByRole('note').first().waitFor();
      await page.locator('main h3').first().waitFor();
      await settled(page);
      problems.push(...(await lowContrast(page, `shop in ${f.id}`)));
      // The greeting itself at the stricter 4.5:1 of body text.
      problems.push(...(await lowContrast(page, `greeting in ${f.id}`, 4.5)).filter((p) => p.includes(f.theme.greeting.slice(0, 12)) || p.includes(f.theme.headline.slice(0, 12))));
    }
    await fetch(`${server.base}/api/admin/settings/theme`, { method: 'PUT', headers: h, body: JSON.stringify({ settings: { mode: 'auto' } }) });
    await ctx.close();
    assert.deepEqual(problems, [], `${problems.length} hard-to-read texts`);
  });
}
