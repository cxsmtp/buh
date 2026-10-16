/**
 * The storefront on a phone and a computer (Chromium against the production build): the round
 * "story" chips, the Filter sheet (options from the real catalogue, removable chips, a shareable
 * address, Back and Forward), search, the product sheet (swipe, buttons, keyboard, Back closes
 * it), Add to Bag from the sheet, the phone's tab bar, stock notes, no sideways scrolling and no
 * page errors. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

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
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Storefront-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];

  // A shop like the owner's: one piece sold out, one with a single piece left, one not reduced.
  const patch = (id: string, product: unknown) =>
    fetch(`${server.base}/api/admin/products/${id}`, { method: 'PATCH', headers: { ...h, cookie }, body: JSON.stringify({ product }) }).then((r) => assert.equal(r.status, 200, id));
  const products = (await (await fetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const zero = (id: string, keep: Record<string, number> = {}) => Object.fromEntries(products.find((p) => p.id === id)!.profiles.map((s) => [s.id, keep[s.id] ?? 0]));
  await patch('prod-03', { stockBySize: zero('prod-03') }); // Heritage Paisley: sold out
  await patch('prod-02', { stockBySize: zero('prod-02', { king: 1 }) }); // Jaipur: only 1 left (a king)
  await patch('prod-04', { compareAtPrice: null }); // Artisans Chevron: full price
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const TITLES = { mughal: /Mughal Botanical/, jaipur: /Jaipur Jaal/, paisley: /Heritage Paisley/, chevron: /Artisans Chevron/ };

async function shop(width: number, path = '/') {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_|unsplash/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(`${server.base}${path}`, { waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().waitFor();
  return { ctx, page, errors };
}

/** The product names in the feed, in order. */
const titles = (page: import('playwright').Page) => page.locator('main article h3').allTextContents();

async function overflow(page: import('playwright').Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

/** Is focus inside the open dialog? */
const focusInDialog = (page: import('playwright').Page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]')));

for (const width of [375, 1280]) {
  test(`stories at ${width}px: round chips from the catalogue filter the feed at once; the address bar follows`, { skip }, async () => {
    const { ctx, page, errors } = await shop(width);
    const storyRow = page.getByRole('group', { name: 'Collections' });
    const stories = storyRow.getByRole('button');
    // All, New in, On sale (one piece is full price now), then the categories that have pieces, in the owner's order.
    assert.deepEqual(await stories.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['All', 'New in', 'On sale', 'Hand Block Sets', 'Mughal & Hotel 1000TC', 'Indigo Mud-Resist']);
    assert.equal(await stories.first().getAttribute('aria-pressed'), 'true');
    assert.equal((await titles(page)).length, 4);
    await page.evaluate(() => ((window as unknown as { __mark: number }).__mark = 7));

    await storyRow.getByRole('button', { name: 'Mughal & Hotel 1000TC', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 1);
    assert.match((await titles(page))[0], TITLES.paisley);
    assert.equal(await storyRow.getByRole('button', { name: 'Mughal & Hotel 1000TC', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.match(page.url(), /\?cat=hotel-luxury$/);
    await page.getByText('1 piece', { exact: true }).waitFor();

    await storyRow.getByRole('button', { name: 'On sale', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 3);
    assert.match(page.url(), /\?sale=1$/, 'one story at a time');
    assert.ok(!(await titles(page)).some((t) => TITLES.chevron.test(t)));

    await storyRow.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 4);
    assert.equal(new URL(page.url()).search, '');
    // Back steps through the stories.
    await page.goBack();
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 3);
    await page.goBack();
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 1);
    assert.equal(await page.evaluate(() => (window as unknown as { __mark?: number }).__mark), 7, 'no reload');
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`filter sheet at ${width}px: options from the products, counts, chips, Clear, a shareable address, Back and Forward`, { skip }, async () => {
    const { ctx, page, errors } = await shop(width);
    const filterButton = page.getByRole('button', { name: /^Filter and sort/ });
    await filterButton.click();
    const sheet = page.getByRole('dialog', { name: 'Filter & sort' });
    await sheet.waitFor();
    assert.ok(await focusInDialog(page), 'focus moves into the sheet');
    for (const legend of ['Sort by', 'Category', 'Size', 'Colour', 'Price']) await sheet.getByText(legend, { exact: true }).waitFor();
    // Toggles only when they would make a difference: one piece is sold out, one is full price.
    assert.equal(await sheet.getByRole('switch', { name: /In stock only/ }).count(), 1);
    assert.equal(await sheet.getByRole('switch', { name: /On sale/ }).count(), 1);
    // Only sizes the products come in (no "Custom").
    const sizes = await sheet.locator('fieldset', { hasText: 'Size' }).getByRole('button').allTextContents();
    assert.ok(sizes.some((s) => s.startsWith('King')) && !sizes.some((s) => /Custom/.test(s)), sizes.join('|'));
    assert.deepEqual(await overflow(page), [], 'the sheet fits');

    // King + in stock only: the sold-out set goes; the button says how many are left.
    await sheet.getByRole('button', { name: /^King/ }).click();
    await sheet.getByRole('switch', { name: /In stock only/ }).click();
    assert.equal(await sheet.getByRole('switch', { name: /In stock only/ }).getAttribute('aria-checked'), 'true');
    const show = sheet.getByRole('button', { name: /^Show 3 pieces$/ });
    await show.waitFor();
    // Tab stays inside the sheet.
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    assert.ok(await focusInDialog(page), 'Tab is trapped in the sheet');
    await show.click();
    await sheet.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 3);
    assert.ok(!(await titles(page)).some((t) => TITLES.paisley.test(t)));
    const chips = page.getByRole('group', { name: 'Filters on' });
    await chips.getByRole('button', { name: 'Remove filter: Size: King' }).waitFor();
    await chips.getByRole('button', { name: 'Remove filter: In stock' }).waitFor();
    assert.match(await filterButton.getAttribute('aria-label') || '', /2 on/);
    const shared = page.url();
    assert.match(shared, /size=king/);
    assert.match(shared, /stock=1/);

    // The filtered view, shared: opens the same in another browser.
    const other = await shop(width, new URL(shared).pathname + new URL(shared).search);
    await other.page.waitForFunction(() => document.querySelectorAll('main article').length === 3);
    await other.page.getByRole('button', { name: 'Remove filter: Size: King' }).waitFor();
    await other.ctx.close();

    // Back: everything again; Forward: filtered again.
    await page.goBack();
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 4);
    assert.equal(await chips.count(), 0);
    await page.goForward();
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 3);

    // A chip removes just its filter; Clear all removes the rest.
    await chips.getByRole('button', { name: 'Remove filter: Size: King' }).click();
    await page.waitForFunction(() => !location.search.includes('size='));
    assert.match(page.url(), /stock=1/);
    await filterButton.click();
    await sheet.getByRole('button', { name: 'Price: low to high' }).click();
    await sheet.getByRole('button', { name: /^Show/ }).click();
    await page.waitForFunction(() => location.search.includes('sort=price-asc'));
    const shown = await titles(page);
    assert.match(shown[0], TITLES.mughal, 'cheapest first');
    await chips.getByRole('button', { name: 'Clear all' }).click();
    await page.waitForFunction(() => location.search === '' && document.querySelectorAll('main article').length === 4);

    // Escape closes the sheet without applying, and focus goes back to the Filter button.
    await filterButton.click();
    await sheet.getByRole('button', { name: /^Single/ }).click();
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Filter and sort');
    assert.equal(new URL(page.url()).search, '', 'not applied');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`search at ${width}px: by name, as you type; Enter shows the matches in the shop; a match opens the product`, { skip }, async () => {
    const { ctx, page, errors } = await shop(width);
    const openSearch = () =>
      width < 768 ? page.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: 'Search' }).click() : page.getByRole('button', { name: 'Search products' }).click();
    await openSearch();
    const dialog = page.getByRole('dialog', { name: 'Search the shop' });
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type), 'search', 'ready to type');
    await page.keyboard.type('jaipur');
    await dialog.getByRole('button', { name: /Jaipur Jaal/ }).waitFor();
    assert.equal(await dialog.getByRole('listitem').count(), 1);
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 1);
    assert.match((await titles(page))[0], TITLES.jaipur);
    assert.match(page.url(), /q=jaipur/);
    await page.getByRole('button', { name: 'Remove filter: “jaipur”' }).waitFor();

    // Nothing found says so.
    await openSearch();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('velvet');
    await dialog.getByText(/Nothing called “velvet”/).waitFor();
    // A match opens the product sheet straight away.
    await page.keyboard.press('Control+A');
    await page.keyboard.type('paisley');
    await dialog.getByRole('button', { name: /Heritage Paisley/ }).click();
    await page.getByRole('dialog', { name: /Heritage Paisley/ }).waitFor();
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`product sheet at ${width}px: photos swipe, buttons and arrow keys; keyboard stays inside; Escape and Back close it`, { skip }, async () => {
    const { ctx, page, errors } = await shop(width);
    const card = page.locator('main article a', { hasText: TITLES.mughal });
    await card.click();
    const sheet = page.getByRole('dialog', { name: TITLES.mughal });
    await sheet.waitFor();
    assert.match(page.url(), /\?p=prod-01$/, 'a shareable link to the open product');
    assert.ok(await focusInDialog(page));
    const track = sheet.getByTestId('photo-track');
    const at = async () => Number(((await track.getAttribute('aria-label')) || '').match(/Photo (\d+) of/)![1]);
    const count = Number(((await track.getAttribute('aria-label')) || '').match(/of (\d+)/)![1]);
    assert.ok(count >= 3, `${count} photos`);
    assert.equal(await at(), 1);
    assert.equal(await sheet.getByRole('button', { name: 'Previous photo' }).isDisabled(), true);

    // Every number the photo counter shows, in order (screen readers hear each one).
    await page.evaluate(() => {
      const t = document.querySelector('[data-testid=photo-track]')!;
      const w = window as unknown as { __seen: number[] };
      w.__seen = [];
      new MutationObserver(() => w.__seen.push(Number(t.getAttribute('aria-label')!.match(/Photo (\d+)/)![1]))).observe(t, { attributes: true, attributeFilter: ['aria-label'] });
    });
    const seen = () => page.evaluate(() => (window as unknown as { __seen: number[] }).__seen.splice(0));
    // Settled on photo n: the counter says n and the photo has finished sliding into place.
    const settled = (n: number) =>
      page.waitForFunction((want) => {
        const t = document.querySelector('[data-testid=photo-track]') as HTMLElement;
        return t.getAttribute('aria-label')!.startsWith(`Photo ${want} of`) && Math.abs(t.scrollLeft - (want - 1) * t.clientWidth) < 2;
      }, n);

    // Regression (flaky under load): Next, then the arrow key while the photo is still sliding.
    // The counter used to follow the scroll position back to photo 1 mid-slide, so the arrow key
    // counted from 1 and stopped at 2. It now counts from the photo being slid to.
    await sheet.getByRole('button', { name: 'Next photo' }).click();
    await track.focus();
    await page.keyboard.press('ArrowRight');
    await settled(3);
    assert.deepEqual(await seen(), [2, 3], 'the counter only moves forward');
    await page.keyboard.press('Home');
    await settled(1);
    assert.deepEqual(await seen(), [1]);
    // A swipe (dragged with the mouse here; fingers use the browser's own scrolling).
    const box = (await track.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 6 });
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await settled(2);
    await sheet.getByRole('button', { name: 'Show photo 3' }).click();
    await settled(3);
    await sheet.getByRole('button', { name: 'Previous photo' }).click();
    await settled(2);

    // Sizes and the ask buttons are there; Tab never leaves the sheet.
    await sheet.getByRole('button', { name: /^King Size Bed/ }).waitFor();
    await sheet.getByRole('button', { name: 'Ask in chat' }).waitFor();
    for (let i = 0; i < 60; i++) await page.keyboard.press('Tab');
    assert.ok(await focusInDialog(page), 'Tab is trapped in the sheet');
    assert.deepEqual(await overflow(page), []);

    // Escape closes it, back where the shopper was, focus on the card.
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    await page.waitForFunction(() => !location.search.includes('p='));
    await page.waitForFunction(() => document.activeElement?.tagName === 'A');
    assert.match((await page.evaluate(() => document.activeElement?.textContent)) || '', TITLES.mughal);

    // The phone's Back button closes it too (and Forward opens it again).
    await card.click();
    await sheet.waitFor();
    await page.goBack();
    await sheet.waitFor({ state: 'detached' });
    await page.goForward();
    await sheet.waitFor();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await sheet.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`add to bag from the sheet at ${width}px: the chosen size goes in the bag; the counts update`, { skip }, async () => {
    const { ctx, page, errors } = await shop(width);
    await page.locator('main article a', { hasText: TITLES.jaipur }).click();
    const sheet = page.getByRole('dialog', { name: TITLES.jaipur });
    // Only the king is left: the sheet opens on it; the others are sold out.
    await sheet.getByRole('button', { name: /^King.*only 1 left/ }).waitFor();
    assert.equal(await sheet.getByRole('button', { name: /^King/ }).getAttribute('aria-pressed'), 'true');
    await sheet.getByRole('button', { name: /^Queen.*sold out/ }).click();
    await sheet.getByText('Queen sold out · Ask us').waitFor();
    assert.equal(await sheet.getByRole('button', { name: /Add to Bag/ }).count(), 0);
    await sheet.getByRole('button', { name: /^King/ }).click();
    assert.equal(await sheet.getByRole('button', { name: 'One more' }).isDisabled(), true, 'only one to add');
    await sheet.getByRole('button', { name: 'Add to Bag (King)' }).click();
    await sheet.waitFor({ state: 'detached' });
    await page.getByText('Your bag').waitFor();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'View shopping bag, 1 piece' }).count(), 1);
    if (width < 768) assert.equal(await page.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: 'Bag, 1 piece' }).count(), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`feed and tab bar at ${width}px: stock notes from real stock; the tab bar is for phones and covers nothing`, { skip }, async () => {
    const { ctx, page, errors } = await shop(width);
    const note = (t: RegExp) => page.locator('main article', { hasText: t }).locator('p').last().textContent();
    assert.equal(await note(TITLES.paisley), 'Sold out');
    assert.equal(await note(TITLES.jaipur), 'Only 1 left');
    // Reduced price: both prices; full price: one.
    await page.locator('main article', { hasText: TITLES.mughal }).getByText('AED 495').first().waitFor();
    assert.equal(await page.locator('main article', { hasText: TITLES.chevron }).locator('.line-through').count(), 0);
    // Photos load lazily after the first screenful, at the size of the card.
    const imgs = await page.locator('main article img').evaluateAll((els) => els.map((e) => [(e as HTMLImageElement).loading, (e as HTMLImageElement).sizes]));
    assert.equal(imgs[0][0], 'eager');
    assert.ok(imgs.every(([, sizes]) => sizes.includes('50vw')), JSON.stringify(imgs));

    const nav = page.getByRole('navigation', { name: 'Shop' });
    if (width >= 768) {
      assert.equal(await nav.isVisible(), false, 'no tab bar on a computer');
    } else {
      for (const name of ['Home', 'Search', 'Bag', 'Orders']) await nav.getByRole('button', { name: new RegExp(`^${name}`) }).waitFor();
      // Help takes the tab bar's right-hand slot (regression: it floated over the second card).
      const navBox = (await nav.boundingBox())!;
      const help = (await page.getByRole('button', { name: 'Help and chat' }).boundingBox())!;
      assert.ok(help.y >= navBox.y && help.y + help.height <= navBox.y + navBox.height && help.x + help.width <= 375, `Help ${JSON.stringify(help)} sits in the tab bar ${JSON.stringify(navBox)}`);
      const tabs = await nav.getByRole('button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right));
      assert.ok(Math.max(...tabs) <= help.x + 1, 'no tab under the Help button');
      // At every scroll position, every product name, price and the Filter button that is on screen
      // above the tab bar is really on top (nothing floats over it: not Help, not the version badge).
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      let checked = 0;
      for (let y = 0; y <= height; y += 150) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        const covered = await page.evaluate((barTop) => {
          const out: string[] = [];
          let n = 0;
          for (const el of document.querySelectorAll('main article h3, main article p, main button')) {
            const r = el.getBoundingClientRect();
            if (r.height === 0 || r.top < 60 || r.bottom > barTop) continue; // under the sticky header or the bar
            n++;
            for (const [x, yy] of [[r.left + 2, r.top + 2], [r.right - 2, r.bottom - 2], [r.left + r.width / 2, r.top + r.height / 2]]) {
              const hit = document.elementFromPoint(x, yy);
              if (hit && !el.contains(hit) && !hit.contains(el)) out.push(`${(el.textContent || '').slice(0, 30)} under ${hit.tagName}.${String(hit.className).slice(0, 40)}`);
            }
          }
          return { out, n };
        }, navBox.y);
        checked += covered.n;
        assert.deepEqual(covered.out, [], `scrolled to ${y}`);
      }
      assert.ok(checked > 30, `${checked} names, prices and buttons checked`);
      // Scrolled to the very bottom, the last thing on the page (the footer with the version) sits above the tab bar.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      const badge = (await page.getByLabel(/^Version BUH-/).boundingBox())!;
      assert.ok(badge.y + badge.height <= navBox.y, `the footer (${badge.y + badge.height}) ends above the tab bar (${navBox.y})`);
      // Home goes back to the top; Orders opens Track Order.
      await nav.getByRole('button', { name: 'Home' }).click();
      await page.waitForFunction(() => window.scrollY === 0);
      await nav.getByRole('button', { name: 'Orders' }).click();
      await page.getByText('Track your order').waitFor();
    }
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('reduced motion: no ticker, no sliding sheets', { skip }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('main h3').first().click();
  await page.getByRole('dialog').waitFor();
  const [ticker, sheet] = await page.evaluate(() => [
    getComputedStyle(document.querySelector('.animate-marquee-runner')!).animationName,
    getComputedStyle(document.querySelector('[role=dialog]')!).animationName,
  ]);
  assert.equal(ticker, 'none');
  assert.equal(sheet, 'none');
  await ctx.close();
});
