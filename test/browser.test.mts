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

/** The order number shown on the confirmation screen. */
async function confirmedOrderId(page: import('playwright').Page): Promise<string> {
  const text = (await page.textContent('body')) || '';
  const id = text.match(/BUH-\d{6}-[A-Z2-9]{6}/)?.[0];
  assert.ok(id, 'order number on the confirmation screen');
  return id!;
}

/** Ask the server (Track Order) about an order: proves it was stored there, not in the browser. */
async function lookup(orderId: string, phone: string) {
  const res = await fetch(`${server.base}/api/orders/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base },
    body: JSON.stringify({ orderId, phone }),
  });
  return (await res.json()) as { found: boolean; order?: { id: string; status: string; total: number; courier: { awbNumber: string; trackingUrl: string } } };
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
    await page.getByText('Thank you for your order').waitFor({ timeout: 10_000 });

    // Stored on the server under the verified number (in any format the customer typed).
    const id = await confirmedOrderId(page);
    const found = await lookup(id, phone);
    assert.equal(found.found, true);
    assert.equal(found.order!.status, 'pending_confirmation');
    assert.equal((await lookup(id, '0509999999')).found, false, 'another number cannot see it');
    // Nothing about the order is kept in the browser any more.
    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert.ok(!keys.some((k) => k.startsWith('buh_orders')), keys.join(','));
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
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await checked;
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
  // (Wait for the page's own session check first: clicking before it answers opens the sign-in, a race under load.)
  const rechecked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await rechecked;
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
    await page.getByText('Thank you for your order').waitFor({ timeout: 10_000 });
  };
  await placeOrder('052 111 2233');
  const firstId = await confirmedOrderId(page);
  const first = (await lookup(firstId, '0521112233')).order!;
  assert.equal(first.courier.awbNumber, '', 'no AWB until the courier is booked');
  assert.equal(first.courier.trackingUrl, '');

  // Done, then a second order in the same visit.
  await page.getByRole('button', { name: /Done|Continue|Close/ }).first().click();
  await page.locator('h3, h4').filter({ hasText: 'Jaipur' }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  assert.equal(await page.getByText('Thank you for your order').count(), 0, 'fresh checkout, not the old confirmation');
  await placeOrder('052 111 2244');
  const secondId = await confirmedOrderId(page);
  assert.notEqual(secondId, firstId);
  assert.equal((await lookup(secondId, '0521112244')).found, true);
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

test('the shop and the admin hub share one store: a customer order reaches the owner, who books it; bank details and visibility flow back', { skip }, async () => {
  // 1. A customer orders in their own browser.
  const shopper = await openCheckout(1280);
  const sp = shopper.page;
  await sp.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Owner Loop Customer');
  await sp.locator('#checkout-phone').fill('056 400 5006');
  await sp.getByRole('button', { name: /Send code/ }).click();
  await sp.getByRole('button', { name: /Test mode/ }).click();
  await sp.getByText('Mobile number verified').waitFor();
  await sp.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Al Barsha');
  await sp.getByPlaceholder('Street name, road, or community number').fill('Street 5');
  await sp.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Villa 7');
  await sp.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('7');
  // No bank account saved yet: bank transfer is not offered (there is no demo account to pay into).
  assert.equal(await sp.getByRole('radio', { name: /Bank transfer/ }).count(), 0);
  await sp.locator('button[type=submit]').click();
  await sp.getByText('Thank you for your order').waitFor({ timeout: 10_000 });
  const orderId = await confirmedOrderId(sp);

  // 2. The owner, in a different browser, sees it and books the courier.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const admin = await ctx.newPage();
  const adminChecked = admin.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await admin.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await adminChecked; // hydrated: the click opens the sign-in
  await admin.locator('input[type=email]').fill('admin@beautifuluaehome.com');
  await admin.locator('input[autocomplete=current-password]').fill('Browser-Owner-Pass-1');
  await admin.getByRole('button', { name: /Unlock Admin Portal/ }).click();
  await admin.getByText(/Orders & Dispatches/).first().waitFor();
  const card = admin.locator('div.rounded-2xl', { hasText: orderId }).last();
  await card.waitFor();
  await card.getByRole('button', { name: /Confirm & Assign Courier/ }).click();
  await admin.getByRole('button', { name: /Confirm Order & Dispatch/ }).click();
  await admin.getByRole('button', { name: 'Close label' }).click();
  await card.getByRole('button', { name: 'Mark dispatched' }).click();
  await card.getByText(/^dispatched$/i).waitFor();
  assert.equal((await lookup(orderId, '0564005006')).order!.status, 'dispatched', 'saved on the server');

  // Backups are visible to the owner.
  await admin.getByRole('status').filter({ hasText: /Backup/ }).waitFor();

  // 3. Bank details saved in the admin show at checkout.
  await admin.getByRole('button', { name: /Settings/ }).first().click();
  await admin.getByRole('button', { name: /Branding & bank/ }).click();
  await admin.getByPlaceholder('Emirates NBD').fill('Mashreq');
  await admin.getByPlaceholder('BEAUTIFUL UAE HOME TEXTILES LLC').fill('BUH TEXTILES LLC');
  await admin.getByPlaceholder('AE07 0331 2345 6789 0123 456').fill('AE07 0331 2345 6789 0123 456');
  await admin.getByRole('button', { name: 'Save bank details' }).click();
  await admin.getByText(/checkout shows these details now/).waitFor();

  // 4. Hiding a product removes it from the shop.
  await admin.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: /^Inventory/ }).click();
  await admin.getByRole('button', { name: /^Stock and actions for/ }).first().click();
  await admin.getByTitle('Shown in the shop: click to hide').first().click();
  await admin.getByTitle('Hidden from the shop: click to show').first().waitFor();

  const fresh = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await fresh.goto(server.base, { waitUntil: 'domcontentloaded' });
  await fresh.locator('h3, h4').first().waitFor();
  const titles = await fresh.locator('h3, h4').allTextContents();
  const hiddenCount = (await (await fetch(`${server.base}/api/products`)).json()).products.length;
  assert.equal(hiddenCount, 3, 'one product hidden from the public catalogue');
  assert.ok(titles.length > 0);
  await fresh.locator('h3, h4').filter({ hasText: /Jaipur|Heritage|Artisans/ }).first().click();
  await fresh.getByRole('button', { name: /Add to Bag/ }).click();
  await fresh.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await fresh.getByRole('radio', { name: /Bank transfer/ }).click();
  await fresh.getByText('AE07 0331 2345 6789 0123 456').waitFor();
  await fresh.getByText('Mashreq Bank Details').waitFor();

  await fresh.close();
  await ctx.close();
  await sp.close();
});

test('regression: a price changed during checkout is shown before the customer is charged', { skip }, async () => {
  // A product still in the shop (an earlier test hides one).
  const products = (await (await fetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; title: string; price: number }>;
  const product = products[0];
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  await page.goto(server.base, { waitUntil: 'domcontentloaded' });
  await page.locator('h3, h4').filter({ hasText: product.title }).first().click();
  await page.getByRole('button', { name: /Add to Bag/ }).click();
  await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
  await page.locator('#checkout-phone').waitFor();
  const submit = page.locator('button[type=submit]');
  await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Price Change Customer');
  await page.locator('#checkout-phone').fill('056 400 7007');
  await page.getByRole('button', { name: /Send code/ }).click();
  await page.getByRole('button', { name: /Test mode/ }).click();
  await page.getByText('Mobile number verified').waitFor();
  await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Al Barsha');
  await page.getByPlaceholder('Street name, road, or community number').fill('Street 5');
  await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Villa 9');
  await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('9');
  const before = (await submit.textContent()) || ''; // "Confirm & Raise Order • AED …"
  assert.match(before, /AED \d/);

  // The owner raises the price while the customer is at checkout.
  const headers = { 'content-type': 'application/json', origin: server.base };
  const login = await fetch(`${server.base}/api/admin/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: 'Browser-Owner-Pass-1' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const patch = (price: number) =>
    fetch(`${server.base}/api/admin/products/${product.id}`, { method: 'PATCH', headers: { ...headers, cookie }, body: JSON.stringify({ product: { price } }) });
  assert.equal((await patch(product.price + 50)).status, 200);
  try {
    await submit.click();
    await page.getByText(/Prices have changed/).waitFor();
    await page.waitForFunction((old) => document.querySelector('button[type=submit]')?.textContent !== old, before);
    assert.notEqual(await submit.textContent(), before, 'the new total is shown');
    await submit.click();
    await page.getByText('Thank you for your order').waitFor({ timeout: 10_000 });
    const id = await confirmedOrderId(page);
    const placed = await lookup(id, '0564007007');
    assert.ok(before.endsWith(`AED ${placed.order!.total - 50}`), 'the old total was shown first');
  } finally {
    await patch(product.price);
    await page.close();
  }
});

test('regression: every admin tab and settings section fits a 375 px phone, SMS settings included', { skip }, async () => {
  const login = await fetch(`${server.base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base },
    body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: 'Browser-Owner-Pass-1' }),
  });
  const [name, value] = (login.headers.get('set-cookie') || '').split(';')[0].split('=');
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 } });
  await ctx.addCookies([{ name, value, url: server.base }]);
  const page = await ctx.newPage();
  // Not "networkidle": the live-updates stream stays open. Wait for the admin session check instead.
  const sessionChecked = page.waitForResponse((r) => r.url().endsWith('/api/admin/session'));
  await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
  await sessionChecked;
  await page.getByRole('status').filter({ hasText: /Backup/ }).waitFor(); // admin data loaded
  // Reported: on a phone the backup card squeezed its explanation into a narrow column beside the button.
  const card = (await page.getByRole('status').filter({ hasText: /Backup/ }).boundingBox())!;
  const detail = (await page.getByTestId('backup-detail').boundingBox())!;
  assert.ok(detail.width >= card.width * 0.8, `backup explanation ${Math.round(detail.width)} px of a ${Math.round(card.width)} px card`);
  const nav = page.getByRole('navigation', { name: 'Admin sections' });
  // On a phone the bar holds Orders, Inventory, Chats and More; Customers and Settings are under More.
  for (const tab of ['Orders', 'Inventory', 'Chats', 'More']) {
    // A real tap at the button's centre (the bar is fixed to the bottom of the screen); every target is at least 44 px.
    const box = (await nav.getByRole('button', { name: new RegExp(`^${tab}`) }).boundingBox())!;
    assert.ok(box.height >= 44 && box.width >= 44, `${tab}: ${box.width}x${box.height}`);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    if (tab === 'More') {
      await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: /^Customers/ }).click();
    } else {
      await nav.locator('button[aria-current=page]', { hasText: new RegExp(`^${tab}`) }).waitFor();
    }
    await page.waitForTimeout(200);
    assert.deepEqual(await overflow(page), [], `${tab} tab`);
  }
  assert.equal(await nav.getByRole('button', { name: /^Settings/ }).count(), 0, 'Settings is under More on a phone');
  await nav.getByRole('button', { name: 'More' }).click();
  await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: /^Settings/ }).click();
  // Every settings section fits too, including the SMS gateway.
  for (const section of ['Store & contact', 'Catalogue', 'Branding & bank', 'Festival themes', 'Phone verification', 'Couriers', 'System & backups']) {
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section }).click();
    await page.waitForTimeout(200);
    assert.deepEqual(await overflow(page), [], `${section} settings`);
  }
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Phone verification' }).click();
  await page.getByText('Choose SMS Gateway Provider').waitFor();
  await ctx.close();
});
