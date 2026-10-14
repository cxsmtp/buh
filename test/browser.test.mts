/**
 * Real-browser checks (Chromium via Playwright) against the production build:
 * the full checkout with phone verification at phone and desktop width, the
 * international email path, and the admin sign-in. Skipped when there is no
 * build or Playwright is not installed.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

type PW = typeof import('playwright');
async function loadPlaywright(): Promise<PW | null> {
  try {
    return await import('playwright');
  } catch {
    return null; // not installed: these tests are skipped
  }
}
const pw = hasBuild ? await loadPlaywright() : null;
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

async function openCheckout(width: number) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_|unsplash/i.test(m.text())) errors.push(m.text());
  });
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('h3, h4').filter({ hasText: 'Mughal' }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  return { page, errors };
}

/** Does the page scroll sideways? (Decorative and scroll-row content clipped by its parent is fine.) */
async function overflow(page: import('playwright').Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth ? [`page is ${doc.scrollWidth}px wide on a ${doc.clientWidth}px screen`] : [];
  });
}

for (const [width, phone] of [[375, '050 123 4567'], [1280, '055 765 4321']] as const) {
  test(`checkout at ${width}px: order is blocked until the UAE mobile is verified, then placed`, { skip }, async () => {
    const { page, errors } = await openCheckout(width);
    const submit = page.locator('button[type=submit]');
    assert.equal(await submit.isDisabled(), true, 'locked before verification');
    assert.match((await submit.textContent()) || '', /Verify your UAE mobile/);

    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Fatima Al Mansoori');
    await page.locator('#checkout-phone').fill(phone);
    await page.getByRole('button', { name: /Send code/ }).click();
    await page.getByLabel('Digit 1').waitFor();

    // A wrong code is refused and the boxes clear.
    await page.getByLabel('Digit 1').fill('000000');
    const alert = page.locator('p[role=alert]');
    await alert.waitFor();
    assert.match((await alert.textContent()) || '', /Incorrect|attempt/i);

    // Test mode (no SMS gateway) offers the code; tapping it verifies.
    await page.getByRole('button', { name: /Test mode/ }).click();
    await page.getByText('Mobile number verified').waitFor();
    assert.equal(await submit.isDisabled(), false);

    await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Dubai Marina');
    await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
    assert.deepEqual(await overflow(page), [], 'no horizontal overflow');
    await submit.click();
    await page.getByText('Thank You for Your Order!').waitFor({ timeout: 10_000 });

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('buh_orders_v1') || '[]')[0]);
    assert.equal(saved.customer.phoneVerified, true);
    assert.match(saved.customer.phone, /^\+9715\d{8}$/, 'stored in E.164');
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test('international numbers are offered email instead of a code', { skip }, async () => {
  const { page, errors } = await openCheckout(375);
  await page.locator('#checkout-phone').fill('+44 7700 900123');
  await page.getByText('Ordering from outside the UAE?').waitFor();
  assert.equal(await page.getByRole('button', { name: /Send code/ }).isDisabled(), true);
  const href = await page.getByRole('link', { name: /Email / }).getAttribute('href');
  assert.match(href || '', /^mailto:orders@beautifuluaehome\.com\?subject=/);
  assert.match(decodeURIComponent(href || ''), /Mughal/, 'the bag is listed in the email');
  assert.deepEqual(errors, []);
  await page.close();
});

test('admin: one-time password, forced change, then the hub opens with its version', { skip }, async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('header button:has-text("Admin Hub")').click();
  await page.locator('input[type=email]').fill('admin@beautifuluaehome.com');
  await page.locator('input[autocomplete=current-password]').fill('definitely-wrong');
  await page.getByRole('button', { name: /Unlock Admin Portal/ }).click();
  await page.getByText('Wrong email or password.').waitFor();

  const oneTime = server.log().match(/Password: (\S+)/)?.[1];
  assert.ok(oneTime);
  await page.locator('input[autocomplete=current-password]').fill(oneTime!);
  await page.getByRole('button', { name: /Unlock Admin Portal/ }).click();
  await page.locator('#admin-new-password').fill('Browser-Owner-Pass-1');
  await page.locator('#admin-confirm-password').fill('Browser-Owner-Pass-1');
  await page.getByRole('button', { name: /Save Password/ }).click();
  await page.getByText(/Orders & Dispatches/).first().waitFor();
  assert.match((await page.textContent('body')) || '', /BUH-\d{2}\.\d{2}\.\d{2}/);

  // The page never kept the old forgeable flag or the credentials.
  const keys = await page.evaluate(() => Object.keys(localStorage));
  assert.ok(!keys.includes('buh_admin_auth') && !keys.includes('buh_admin_creds'));

  // A reload keeps the session (HttpOnly cookie checked by the server).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('header button:has-text("Admin Hub")').click();
  await page.getByText(/Orders & Dispatches/).first().waitFor();
  await page.close();
});

test('regression: checkout can be closed (X and Escape), and a second order starts fresh', { skip }, async () => {
  const { page, errors } = await openCheckout(375);
  await page.getByRole('button', { name: 'Close checkout' }).click();
  await page.locator('#checkout-phone').waitFor({ state: 'detached' });

  await page.getByRole('button', { name: /Proceed to Checkout|Checkout/ }).last().click().catch(() => {});
  // Re-open from the bag if the drawer closed.
  if (!(await page.locator('#checkout-phone').count())) {
    await page.getByRole('button', { name: /View shopping bag|Bag/ }).first().click();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  }
  await page.locator('#checkout-phone').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#checkout-phone').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('regression: a placed order carries no made-up AWB, and a second order is not stuck on the first', { skip }, async () => {
  const { page } = await openCheckout(1280);
  const placeOrder = async (phone: string) => {
    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Repeat Customer');
    await page.locator('#checkout-phone').fill(phone);
    await page.getByRole('button', { name: /Send code/ }).click();
    await page.getByRole('button', { name: /Test mode/ }).click();
    await page.getByText('Mobile number verified').waitFor();
    await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('JVC');
    await page.getByPlaceholder('Street name, road, or community number').fill('Street 1');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Tower A');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('101');
    await page.locator('button[type=submit]').click();
    await page.getByText('Thank You for Your Order!').waitFor({ timeout: 10_000 });
  };
  await placeOrder('052 111 2233');
  const first = await page.evaluate(() => JSON.parse(localStorage.getItem('buh_orders_v1') || '[]')[0]);
  assert.equal(first.courier.awbNumber, '', 'no AWB until the courier is booked');
  assert.equal(first.courier.trackingUrl, '');
  assert.match(first.id, /^BUH-\d{6}-[A-Z2-9]{6}$/);

  // Done, then a second order in the same visit.
  await page.getByRole('button', { name: /Done|Continue|Close/ }).first().click();
  await page.locator('h3, h4').filter({ hasText: 'Jaipur' }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  assert.equal(await page.getByText('Thank You for Your Order!').count(), 0, 'fresh checkout, not the old confirmation');
  await placeOrder('052 111 2244');
  const orders = await page.evaluate(() => JSON.parse(localStorage.getItem('buh_orders_v1') || '[]'));
  assert.equal(orders.length, 2, 'production build: no demo orders, just the two placed');
  assert.notEqual(orders[0].id, orders[1].id);
  await page.close();
});

test('regression: a new number is not held by the old number\'s resend wait; paste and Arabic digits work', { skip }, async () => {
  const { page } = await openCheckout(375);
  const phone = page.locator('#checkout-phone');
  await phone.fill('٠٥٤ ٣٣٣ ٤٤٥٥'); // Arabic-Indic digits
  await page.getByText(/\+971 54 333 4455/).waitFor();
  await page.getByRole('button', { name: /Send code/ }).click();
  await page.getByLabel('Digit 1').waitFor();
  const code = ((await page.getByRole('button', { name: /Test mode/ }).textContent()) || '').match(/\d{6}/)![0];

  // Paste the whole code into the 4th box.
  await page.getByLabel('Digit 4').focus();
  await page.evaluate((c) => {
    const box = document.activeElement as HTMLInputElement;
    const data = new DataTransfer();
    data.setData('text', `${c.slice(0, 3)} ${c.slice(3)}`);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, code);
  await page.getByText('Mobile number verified').waitFor();

  await page.getByRole('button', { name: /Change/ }).click();
  await phone.fill('056 999 8877');
  const send = page.getByRole('button', { name: /Send code/ });
  assert.equal(await send.isDisabled(), false, 'no wait for a different number');
  await page.close();
});
