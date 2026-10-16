/**
 * Checkout's area field and "Use My GPS" on a phone and a computer (Chromium against the production
 * build). Reported from Discovery Gardens, Dubai: the GPS said "near Arabian Ranches (about 2 km
 * accuracy)" and the area list had no Discovery Gardens. Skipped without a build or Playwright.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !pw;

let server: RunningServer;
let browser: import('playwright').Browser;

before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await pw!.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const AREA = 'e.g. Dubai Marina, Saadiyat, JVC';

async function checkout(width: number, geolocation?: { latitude: number; longitude: number; accuracy: number }) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 600 ? 812 : 900 },
    ...(geolocation ? { geolocation, permissions: ['geolocation'] } : {}),
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_|unsplash/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  const p = (await (await fetch(`${server.base}/api/products`)).json()).products[0];
  await page.locator('h3, h4').filter({ hasText: p.title }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  return { ctx, page, errors };
}

async function overflow(page: import('playwright').Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

const emirate = (page: import('playwright').Page) => page.locator('#checkout-emirate').inputValue();

for (const width of [375, 1280]) {
  test(`area at ${width}px: "discov" offers Discovery Gardens, chosen with the keyboard; Escape closes the list, not checkout`, { skip }, async () => {
    const { ctx, page, errors } = await checkout(width);
    const area = page.getByRole('combobox', { name: /Area \/ Neighborhood/ });
    assert.equal(await area.getAttribute('placeholder'), AREA);
    await area.click();
    await area.pressSequentially('discov');
    const list = page.getByRole('listbox', { name: 'Area suggestions' });
    await list.waitFor();
    assert.equal(await list.getByRole('option').first().textContent(), 'Discovery Gardens');
    assert.equal(await area.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowDown');
    assert.equal(await list.getByRole('option').first().getAttribute('aria-selected'), 'true');
    assert.equal(await area.getAttribute('aria-activedescendant'), await list.getByRole('option').first().getAttribute('id'));
    await page.keyboard.press('Enter');
    assert.equal(await area.inputValue(), 'Discovery Gardens');
    await list.waitFor({ state: 'hidden' });
    await page.getByText('We deliver to Discovery Gardens, Dubai').waitFor();

    // A short name finds the full one; Escape closes the list and keeps checkout open.
    await area.fill('');
    await area.pressSequentially('JLT');
    await list.waitFor();
    assert.match((await list.getByRole('option').first().textContent()) || '', /Jumeirah Lake Towers \(JLT\)/);
    await page.keyboard.press('Escape');
    await list.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#checkout-phone').count(), 1, 'checkout still open');
    assert.equal(await area.inputValue(), 'JLT', 'what was typed is kept');
    await page.getByText('We deliver to JLT, Dubai').waitFor();

    // Any area can be typed: the list only suggests.
    await area.fill('Nad Al Sheba 3, Street 14');
    await page.getByText('We deliver to Nad Al Sheba 3, Street 14, Dubai').waitFor();
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`area at ${width}px: choosing an area in another emirate switches the emirate (tap or keyboard)`, { skip }, async () => {
    const { ctx, page, errors } = await checkout(width);
    const area = page.getByRole('combobox', { name: /Area \/ Neighborhood/ });
    assert.equal(await emirate(page), 'Dubai');
    await area.click();
    await area.pressSequentially('yas isl');
    const option = page.getByRole('listbox', { name: 'Area suggestions' }).getByRole('option', { name: /Yas Island/ });
    await option.first().waitFor();
    assert.match((await option.first().textContent()) || '', /Abu Dhabi/, 'the emirate is shown');
    await option.first().click();
    assert.equal(await area.inputValue(), 'Yas Island');
    assert.equal(await emirate(page), 'Abu Dhabi');
    await page.getByText('Emirate changed to Abu Dhabi for Yas Island.').waitFor();
    await page.getByText('We deliver to Yas Island, Abu Dhabi').waitFor();

    // Al Nahda is in Dubai and Sharjah: the chosen emirate's comes first.
    await page.locator('#checkout-emirate').selectOption('Sharjah');
    await area.fill('');
    await area.pressSequentially('nahda');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await area.inputValue(), 'Al Nahda (Sharjah)');
    assert.equal(await emirate(page), 'Sharjah');
    // Drop pin: searchable, with the same names.
    await page.getByRole('button', { name: /Drop Pin on Map/ }).click();
    await page.getByRole('searchbox', { name: 'Search communities' }).fill('discovery');
    await page.getByRole('button', { name: /Discovery Gardens/ }).click();
    assert.equal(await area.inputValue(), 'Discovery Gardens');
    assert.equal(await emirate(page), 'Dubai');
    await page.getByText(/Pin dropped on: Discovery Gardens, Dubai/).waitFor();
    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test(`regression (reported) at ${width}px: a ±2 km GPS reading is saved for the driver but guesses no area`, { skip }, async () => {
    // Near Arabian Ranches, as a laptop's Wi-Fi location reported for a customer in Discovery Gardens.
    const { ctx, page, errors } = await checkout(width, { latitude: 25.0534, longitude: 55.2655, accuracy: 2000 });
    await page.getByRole('button', { name: /Use My GPS/ }).click();
    await page.getByText('Your device gave an approximate location (± 2 km), so we saved it for the driver but didn’t guess your area. Please choose it below.').waitFor();
    const area = page.getByRole('combobox', { name: /Area \/ Neighborhood/ });
    assert.equal(await area.inputValue(), '', 'no guessed area');
    assert.equal(await emirate(page), 'Dubai');
    assert.doesNotMatch((await page.textContent('body')) || '', /Arabian Ranches, Dubai/);
    // The pin is kept for the driver.
    await page.getByRole('button', { name: /Drop Pin on Map/ }).click();
    await page.getByText('25.0534°N, 55.2655°E').waitFor();

    assert.deepEqual(await overflow(page), []);
    assert.deepEqual(errors, []);
    await ctx.close();

    // A precise phone GPS reading in Discovery Gardens fills it in.
    const precise = await checkout(width, { latitude: 25.0405, longitude: 55.1452, accuracy: 20 });
    await precise.page.getByRole('button', { name: /Use My GPS/ }).click();
    await precise.page.getByText(/in or near Discovery Gardens, Dubai/).waitFor();
    assert.equal(await precise.page.getByRole('combobox', { name: /Area \/ Neighborhood/ }).inputValue(), 'Discovery Gardens');
    assert.deepEqual(precise.errors, []);
    await precise.ctx.close();
  });
}
