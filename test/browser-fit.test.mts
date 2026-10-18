/**
 * Every screen fits every phone (reported: "things are going out of bounds and you have to scroll
 * sideways to click a cross button"). In Chromium against the production build, at 320, 360, 375,
 * 390, 412 and 430 px upright, one phone held sideways, and 390 px with the text at 200 %, this opens
 * every screen and overlay: the shop, the install card, filter, search, a product and its zoomed
 * photo, the bag, each part of checkout (phone code, GPS, the area list, bank transfer, the
 * confirmation), order tracking, the chat, admin sign-in and recovery, the offline page, and the whole
 * Admin Hub (every tab, every settings section, the inventory sheets and the editor's steps).
 *
 * On each it checks: the page never scrolls sideways; no scrolling sheet scrolls sideways; every
 * visible close button and the screen's main action are wholly on the screen (not under the edge,
 * not below the fold of a sheet). Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, setPhoneCheck, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;
type Page = import('playwright').Page;

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  // These screens go through the SMS-code checkout (Settings → Phone check "SMS code"; the default, WhatsApp, is test/phone-check-e2e.test.mts).
  await setPhoneCheck(server, 'sms_code');
  browser = await pw!.chromium.launch();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  await new Promise((r) => setTimeout(r, 300));
  const once = server.log().match(/Password: (\S+)/)![1];
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Fit-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  // A real bank account (so checkout offers bank transfer, with its long IBAN) and long store details.
  await fetch(`${server.base}/api/admin/settings/bank`, {
    method: 'PUT',
    headers: { ...h, cookie },
    body: JSON.stringify({ settings: { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES TRADING LLC', iban: 'AE07 0331 2345 6789 0123 456', accountNumber: '1012345678901', swiftCode: 'EBILAEADXXX' } }),
  });
});
after(async () => {
  await browser?.close();
  server?.stop();
});

/** Problems on the screen as it is now: sideways scroll, and close buttons off the screen. */
const AUDIT = `function (where) {
  var out = [];
  var W = document.documentElement.clientWidth, H = innerHeight;
  function desc(el) {
    var c = (el.getAttribute('class') || '').split(/\\s+/).slice(0, 4).join('.');
    var t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + (c ? '.' + c : '') + (t ? ' "' + t + '"' : '');
  }
  function clipped(el) {
    // Inside something that scrolls or clips sideways on purpose (a carousel, the story chips).
    for (var e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      var s = getComputedStyle(e);
      if (s.overflowX !== 'visible') return e;
    }
    return null;
  }
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    for (var e = el; e; e = e.parentElement) {
      var s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    }
    return true;
  }
  var de = document.documentElement;
  if (de.scrollWidth > de.clientWidth || document.body.scrollWidth > de.clientWidth) {
    var wide = [];
    document.querySelectorAll('body *').forEach(function (el) {
      if (wide.length >= 3) return;
      var r = el.getBoundingClientRect();
      if ((r.right > W + 1 || r.left < -1) && r.width && !clipped(el) && getComputedStyle(el).position !== 'fixed') wide.push(desc(el) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    });
    out.push(where + ': page scrolls sideways (' + de.scrollWidth + ' > ' + de.clientWidth + ') ' + wide.join(' | '));
  }
  // Overlays: dialogs, and anything fixed over the whole screen.
  var overlays = Array.prototype.filter.call(document.querySelectorAll('[role="dialog"], [aria-modal="true"], body *'), function (el) {
    if (el.matches('[role="dialog"], [aria-modal="true"]')) return visible(el);
    var s = getComputedStyle(el);
    if (s.position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
    return r.width >= W * 0.9 && r.height >= H * 0.9 && visible(el);
  });
  overlays.forEach(function (o) {
    var r = o.getBoundingClientRect();
    if (o.matches('[role="dialog"]') && (r.right > W + 1 || r.left < -1)) out.push(where + ': dialog wider than the screen ' + desc(o) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    [o].concat(Array.prototype.slice.call(o.querySelectorAll('*'))).forEach(function (el) {
      var s = getComputedStyle(el);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') return;
      if (el.scrollHeight <= el.clientHeight + 1) return; // not a vertical scroller
      if (el.scrollWidth > el.clientWidth + 1) {
        var inner = [];
        el.querySelectorAll('*').forEach(function (c) {
          if (inner.length >= 2) return;
          var cr = c.getBoundingClientRect(), er = el.getBoundingClientRect();
          if (cr.right > er.right + 1 && cr.width && clipped(c) === el) inner.push(desc(c));
        });
        out.push(where + ': sheet scrolls sideways ' + desc(el) + ' (' + el.scrollWidth + ' > ' + el.clientWidth + ') ' + inner.join(' | '));
      }
    });
  });
  // Close buttons on the screen: wholly inside it.
  document.querySelectorAll('button, a[role="button"]').forEach(function (b) {
    var name = (b.getAttribute('aria-label') || b.textContent || '').trim();
    if (!/^(close|cancel|dismiss|not now|back to the shop|done)\\b|^[✕×]$/i.test(name)) return;
    if (!visible(b)) return;
    var inOverlay = overlays.some(function (o) { return o.contains(b); });
    if (!inOverlay) return;
    // A button further down a scrolling list (a Cancel at the end of a form) is reached by scrolling.
    for (var e = b.parentElement; e; e = e.parentElement) {
      var s = getComputedStyle(e);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1 && !/^close\\b|^[✕×]$/i.test(name)) return;
    }
    var r = b.getBoundingClientRect();
    if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5) out.push(where + ': "' + name.slice(0, 30) + '" off the screen at ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' (screen ' + W + 'x' + H + ')');
  });
  return out;
}`;

async function settled(page: Page) {
  await page
    .waitForFunction(() => document.getAnimations().every((an) => an.playState !== 'running' || an.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 3000 })
    .catch(() => {});
}

/** Check the screen; `primary` names the main action(s) that must be wholly on the screen. */
async function fit(page: Page, problems: string[], where: string, primary: Array<RegExp | import('playwright').Locator> = []) {
  await settled(page);
  problems.push(...((await page.evaluate(`(${AUDIT})(${JSON.stringify(where)})`)) as string[]));
  const vp = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: innerHeight }));
  for (const p of primary) {
    const loc = p instanceof RegExp ? page.getByRole('button', { name: p }) : p;
    const box = await loc.first().boundingBox().catch(() => null);
    if (!box) {
      problems.push(`${where}: main action ${String(p)} not found`);
      continue;
    }
    if (box.x < -0.5 || box.y < -0.5 || box.x + box.width > vp.w + 0.5 || box.y + box.height > vp.h + 0.5)
      problems.push(`${where}: main action ${String(p)} off the screen at ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)} (screen ${vp.w}x${vp.h})`);
  }
}

interface Shape {
  name: string;
  width: number;
  height: number;
  zoom?: boolean;
}
const SHAPES: Shape[] = [
  { name: '320', width: 320, height: 568 },
  { name: '360', width: 360, height: 740 },
  { name: '375', width: 375, height: 667 },
  { name: '390', width: 390, height: 844 },
  { name: '412', width: 412, height: 915 },
  { name: '430', width: 430, height: 932 },
  { name: 'landscape 844x390', width: 844, height: 390 },
  { name: '390 at 200% text', width: 390, height: 844, zoom: true },
];

/**
 * Large text, like Android's text scaling at 200%: every piece of text twice as big, the layout
 * (spacing, boxes) as it was. Chromium on a phone honours text-size-adjust exactly so.
 */
const ZOOM_CSS = 'html { -webkit-text-size-adjust: 200% !important; text-size-adjust: 200% !important; }';

let phoneN = 0;
const nextPhone = () => `056 41${String(++phoneN).padStart(1, '0')} ${String(1000 + phoneN * 7).slice(-4)}`;

for (const shape of SHAPES) {
  test(`every shop screen fits at ${shape.name}`, { skip }, async () => {
    const ctx = await browser.newContext({
      viewport: { width: shape.width, height: shape.height },
      isMobile: true,
      hasTouch: true,
      geolocation: { latitude: 25.0805, longitude: 55.1403, accuracy: 30 },
      permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    if (shape.zoom) await page.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
      });
    }, ZOOM_CSS);
    const problems: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const at = (s: string) => `${s} @${shape.name}`;
    try {

    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.locator('main h3').first().waitFor();
    await fit(page, problems, at('shop'));
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await fit(page, problems, at('shop, bottom'));
    await page.evaluate(() => window.scrollTo(0, 0));

    // The install card.
    await page.evaluate(() => {
      const e = new Event('beforeinstallprompt') as Event & { prompt?: () => Promise<void>; userChoice?: Promise<unknown> };
      e.prompt = async () => {};
      e.userChoice = Promise.resolve({ outcome: 'dismissed' });
      window.dispatchEvent(e);
    });
    const install = page.getByRole('region', { name: 'Install the app' });
    if (await install.waitFor({ timeout: 9000 }).then(() => true, () => false)) {
      await page.waitForTimeout(400);
      await fit(page, problems, at('install card'), [install.getByRole('button', { name: 'Not now' })]);
      await install.getByRole('button', { name: 'Not now' }).click();
    } else problems.push(at('install card: did not show'));

    // Filter.
    await page.getByRole('button', { name: /^Filter and sort/ }).click();
    const filters = page.getByRole('dialog', { name: 'Filter & sort' });
    await filters.waitFor();
    await fit(page, problems, at('filter'), [filters.getByRole('button', { name: /^Show/ })]);
    await filters.getByRole('button', { name: /^Show/ }).click();

    // Search.
    const searchBtn = page.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: 'Search' });
    if (await searchBtn.isVisible()) await searchBtn.click();
    else await page.getByRole('button', { name: 'Search products' }).click();
    await page.keyboard.type('set');
    await page.getByRole('dialog', { name: 'Search the shop' }).getByRole('listitem').first().waitFor();
    await fit(page, problems, at('search'));
    await page.keyboard.press('Escape');

    // A product and its zoomed photo.
    const p = (await (await fetch(`${server.base}/api/products`)).json()).products[0];
    await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
    await page.getByRole('button', { name: /Add to Bag/ }).waitFor();
    await fit(page, problems, at('product'), [/Add to Bag/]);
    await page.getByRole('button', { name: 'Zoom photo' }).click();
    await page.getByTestId('photo-zoom').waitFor();
    await fit(page, problems, at('photo zoom'));
    await page.keyboard.press('Escape');
    await page.getByTestId('photo-zoom').waitFor({ state: 'detached' });

    // The bag.
    await page.getByRole('button', { name: /Add to Bag/ }).click();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).waitFor();
    await fit(page, problems, at('bag'), [/Proceed to Checkout/]);

    // Checkout, part by part.
    await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
    await page.locator('#checkout-phone').waitFor();
    const submit = page.locator('button[type=submit]').last();
    await fit(page, problems, at('checkout'), [submit]);
    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Fatima Al Mansoori bint Mohammed Al Falasi');
    await page.locator('#checkout-phone').fill(nextPhone());
    await page.getByRole('button', { name: /Send code/ }).click();
    await page.getByLabel('Digit 1').waitFor();
    await fit(page, problems, at('checkout: phone code'), [submit]);
    await page.getByRole('button', { name: /Test mode/ }).click();
    await page.getByRole('button', { name: /Use My GPS/ }).click();
    await page.waitForTimeout(600);
    await fit(page, problems, at('checkout: GPS'), [submit]);
    await page.locator('#checkout-area').fill('');
    await page.locator('#checkout-area').pressSequentially('al n');
    await page.getByRole('listbox', { name: 'Area suggestions' }).waitFor();
    await fit(page, problems, at('checkout: area list'), [submit]);
    await page.keyboard.press('Escape');
    await page.locator('#checkout-area').fill('Dubai Marina');
    await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
    // Bank transfer: the account is never shown at checkout (it comes privately, on the order's own page).
    await page.getByText(/bank transfer/i).last().click();
    await page.getByTestId('bank-transfer-note').waitFor();
    await page.getByTestId('bank-transfer-note').scrollIntoViewIfNeeded();
    assert.equal(await page.getByText(/AE07 0331/).count(), 0, 'no IBAN at checkout');
    await fit(page, problems, at('checkout: bank transfer'), [submit]);
    await submit.click();
    await page.getByRole('button', { name: 'Done' }).waitFor({ timeout: 15000 });
    const payLink = page.getByRole('link', { name: 'Upload your transfer screenshot' });
    await fit(page, problems, at('checkout: confirmation'), [page.getByRole('button', { name: 'Done' })]);
    await payLink.scrollIntoViewIfNeeded();
    await fit(page, problems, at('checkout: confirmation, transfer link'), [payLink]);
    // The order's private page, with the long account name and IBAN.
    const payPage = await page.context().newPage();
    await payPage.goto(`${server.base}${await payLink.getAttribute('href')}`, { waitUntil: 'domcontentloaded' });
    await payPage.getByText('AE07 0331 2345 6789 0123 456').waitFor();
    await payPage.getByRole('button', { name: 'Copy IBAN' }).scrollIntoViewIfNeeded();
    await fit(payPage, problems, at('private bank-transfer page'), [payPage.getByRole('button', { name: 'Copy IBAN' })]);
    // Below the details (pay first, then upload): scrolled to, it fits too.
    await payPage.getByText('Choose screenshot or PDF').scrollIntoViewIfNeeded();
    await fit(payPage, problems, at('private bank-transfer page: upload'), [payPage.getByText('Choose screenshot or PDF')]);
    await payPage.close();
    await page.getByRole('button', { name: 'Done' }).click();

    // Order tracking.
    const track = page.getByRole('button', { name: /^(Track Order|Orders)$/ });
    for (let i = 0; i < (await track.count()); i++) {
      if (await track.nth(i).isVisible()) {
        await track.nth(i).click();
        break;
      }
    }
    await page.getByRole('button', { name: 'Close Track Order' }).waitFor();
    await fit(page, problems, at('order tracking'));
    await page.getByRole('button', { name: 'Close Track Order' }).click();

    // The chat.
    await page.getByRole('button', { name: 'Help and chat' }).click();
    await page.getByRole('dialog', { name: 'Chat with the shop' }).waitFor();
    await fit(page, problems, at('chat'), [page.getByRole('button', { name: 'Send' })]);
    await page.keyboard.press('Escape');

    // Admin sign-in, forgotten password and a recovery code.
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await page.getByText('Admin Hub Security Access').waitFor();
    await fit(page, problems, at('sign-in'), [/Unlock Admin Portal/]);
    await page.getByRole('button', { name: /Use a recovery code/ }).click();
    await page.waitForTimeout(200);
    await fit(page, problems, at('sign-in: recovery code'));

    await page.goto(`${server.base}/offline`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'You are offline' }).waitFor();
    await fit(page, problems, at('offline page'));
    } catch (e) {
      problems.push(at(`could not go on: ${String((e as Error).message).replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(0, 16).join(" ")}`));
    }
    await ctx.close();

    console.log(problems.length ? `fit ${shape.name}:\n  ${problems.join('\n  ')}` : `fit ${shape.name}: ok`);
    assert.deepEqual(errors, []);
    assert.deepEqual(problems, [], `${problems.length} screens do not fit at ${shape.name}`);
  });

  test(`every Admin Hub screen fits at ${shape.name}`, { skip }, async () => {
    const admin = await browser.newContext({ viewport: { width: shape.width, height: shape.height }, isMobile: true, hasTouch: true });
    const [n, v] = cookie.split('=');
    await admin.addCookies([{ name: n, value: v, url: server.base }]);
    const a = await admin.newPage();
    a.setDefaultTimeout(10000);
    if (shape.zoom) await a.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
      });
    }, ZOOM_CSS);
    const problems: string[] = [];
    const at = (s: string) => `${s} @${shape.name}`;
    try {
    const signed = a.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
    await a.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await signed;
    const nav = a.getByRole('navigation', { name: 'Admin sections' });
    await nav.waitFor();
    await a.waitForTimeout(500);
    await fit(a, problems, at('admin hub, as it opens (orders)'));
    for (const tab of ['Orders', 'Chats', 'Inventory', 'Customers', 'Settings']) {
      await openAdminSection(a, new RegExp(`^${tab}`));
      await a.waitForTimeout(300);
      await fit(a, problems, at(`admin ${tab}`));
      if (tab === 'Inventory') {
        await a.getByRole('button', { name: /^Stock and actions for/ }).first().click();
        await fit(a, problems, at('inventory: product open'));
        await a.getByRole('button', { name: /^Received stock for/ }).first().click();
        await a.getByRole('dialog', { name: 'Received stock' }).waitFor();
        await fit(a, problems, at('inventory: received stock'));
        await a.keyboard.press('Escape');
        await a.getByRole('button', { name: /^Stock history of/ }).first().click();
        await a.getByRole('dialog', { name: 'Stock history' }).waitFor();
        await fit(a, problems, at('inventory: history'));
        await a.keyboard.press('Escape');
        await a.getByRole('button', { name: 'Add product' }).first().click();
        const wizard = a.getByRole('dialog', { name: 'Add a product' });
        await wizard.waitFor();
        await fit(a, problems, at('editor: Photos'));
        for (const step of ['Details', 'Sizes', 'Publish']) {
          await wizard.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: new RegExp(step) }).click();
          await a.waitForTimeout(200);
          await fit(a, problems, at(`editor: ${step}`));
        }
        await a.keyboard.press('Escape');
        if (await nav.getByRole('button', { name: 'More' }).isVisible()) {
          await nav.getByRole('button', { name: 'More' }).click();
          await a.getByRole('dialog', { name: 'More' }).waitFor();
          await fit(a, problems, at('admin More menu'));
          await a.keyboard.press('Escape');
        }
      }
    }
    const sections = a.getByRole('navigation', { name: 'Settings sections' }).getByRole('button');
    await sections.first().waitFor();
    const count = await sections.count();
    for (let i = 0; i < count; i++) {
      const name = (await sections.nth(i).textContent())?.trim().slice(0, 30);
      await sections.nth(i).click();
      await a.waitForTimeout(400);
      await fit(a, problems, at(`settings ${name}`));
    }
    } catch (e) {
      problems.push(at(`could not go on: ${String((e as Error).message).replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(0, 16).join(" ")}`));
    }
    await admin.close();
    console.log(problems.length ? `fit admin ${shape.name}:\n  ${problems.join('\n  ')}` : `fit admin ${shape.name}: ok`);
    assert.deepEqual(problems, [], `${problems.length} admin screens do not fit at ${shape.name}`);
  });
}
