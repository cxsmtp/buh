/**
 * Settings → Phone check "WhatsApp (free)" (the default) against the real build. The public
 * settings say so; /api/otp/send refuses; an order is placed with no code (unverified, awaiting
 * WhatsApp, with its cancel time). The owner's confirm route takes "call" and "use_sender" (number
 * validated, allow-listed fields, audited); booking an unconfirmed COD order answers "ship anyway?"
 * and, with the owner's yes, records it. In Chromium at 375 and 1280 px: checkout shows the number
 * field with "We confirm orders over WhatsApp." and no code step, places the order without calling
 * /api/otp/*, and the confirmation says the WhatsApp message is the confirmation, with the hours
 * (no sideways scroll, reachable with the keyboard); then the hub shows "Awaiting WhatsApp —
 * auto-cancels in …", "Ask to confirm" and "Confirmed by phone call", and Settings → Phone check
 * warns when no WhatsApp number is set (and, with no TRUST_PROXY, that limits are stricter). Review
 * fixes: the sooner "never opened WhatsApp" time, "Correct the phone number" (the confirm box shows
 * the number as it will be saved), Track Order with an earlier number, the order PATCH allow-list,
 * nothing confirmed on a cancelled order, and the hub's one-time "now on WhatsApp" notice for a
 * shop with an SMS gateway that never chose. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

const SHOP_WA = '+971 50 999 8866';
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  // An SMS gateway in the environment, and no phone check ever chosen: the hub's one-time notice.
  server = await startServer({ SMS_WEBHOOK_URL: 'https://sms.example.com/hook' });
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Phone-Check-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  await setStore({ whatsappNumber: SHOP_WA });
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  rawFetch(`${server.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
async function setStore(settings: Record<string, unknown>) {
  const res = await api('PUT', '/api/admin/settings/store', { settings });
  assert.equal(res.status, 200, await res.text());
}

interface PlacedOrder {
  id: string;
  createdAt: string;
  customer: { phone: string; phoneVerified?: boolean };
  whatsappCheck?: { status: string; code: string; hold: boolean; cancelAt?: string; openBy?: string; method?: string };
}
let phoneN = 0;
/** A checkout through the real route, as the WhatsApp-mode page sends it: the number, no code. */
async function placeOrder(): Promise<PlacedOrder> {
  const phone = `+97150880${String(++phoneN).padStart(4, '0')}`;
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    customer: { fullName: 'Reem Test', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).order;
}
const adminOrder = async (id: string) => (await (await api('GET', `/api/admin/orders/${id}`)).json()) as { order: PlacedOrder; events: Array<{ event: string; actor: string; detail: Record<string, unknown> | null }> };
function auditLines(): string[] {
  return fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean));
}

test('the default is WhatsApp: public settings say so, no code is sent, an order needs none (unverified, awaiting, cancel time)', { skip }, async () => {
  const pub = await (await rawFetch(`${server.base}/api/settings/public`)).json();
  assert.deepEqual(pub.phoneVerification, { method: 'server', check: 'whatsapp', cancelHours: 24 });
  const send = await post('/api/otp/send', { phone: '0501234567' });
  assert.equal(send.status, 409);
  assert.equal((await send.json()).code, 'phone_codes_off');
  const o = await placeOrder();
  assert.equal(o.customer.phoneVerified, false);
  assert.equal(o.whatsappCheck?.status, 'awaiting');
  assert.ok(o.whatsappCheck?.cancelAt);
  const hours = (Date.parse(o.whatsappCheck!.cancelAt!) - Date.parse(o.createdAt)) / 3600_000;
  assert.ok(Math.abs(hours - 24) < 0.01, `${hours}`);
  const tracked = await (await post('/api/orders/lookup', { orderId: o.id, phone: o.customer.phone })).json();
  assert.equal(tracked.order.whatsappCheck.cancelAt, o.whatsappCheck!.cancelAt, 'Track Order has the confirm button and the time');
  // The owner's settings: the group is there, validated on the server.
  const st = await (await api('GET', '/api/admin/settings')).json();
  assert.deepEqual(st.phoneCheck.value, { mode: 'whatsapp', unconfirmedCancelHours: 24, unopenedCancelHours: 6 });
  assert.deepEqual(st.phoneCheckInfo, { behindProxy: false, whatsappNotice: true }, 'no TRUST_PROXY here; a gateway and no choice yet');
  assert.ok(o.whatsappCheck?.openBy, 'cancelled sooner if WhatsApp is never opened');
  assert.equal((await api('PUT', '/api/admin/settings/phoneCheck', { settings: { unopenedCancelHours: 30 } })).status, 400, 'never later than the main hours');
  assert.equal((await api('PUT', '/api/admin/settings/phoneCheck', { settings: { mode: 'carrier-pigeon' } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/settings/phoneCheck', { settings: { unconfirmedCancelHours: 500 } })).status, 400);
  assert.equal((await rawFetch(`${server.base}/api/admin/settings/phoneCheck`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: server.base, cookie: server.door }, body: JSON.stringify({ settings: { mode: 'sms_code' } }) })).status, 401, 'needs a session');
});

test('the owner’s confirm route: "call" and "use_sender" (number validated, fields allow-listed), audited; booking asks "ship anyway?"', { skip }, async () => {
  const o = await placeOrder();
  const url = `/api/admin/orders/${o.id}/whatsapp`;
  assert.equal((await api('POST', url, { result: 'call', phone: '0501234567' })).status, 400, 'a phone only with use_sender');
  assert.equal((await api('POST', url, { result: 'use_sender' })).status, 400, 'use_sender needs the number');
  assert.equal((await api('POST', url, { result: 'use_sender', phone: '0501234567', note: 'x' })).status, 400, 'allow-listed');
  assert.equal((await api('POST', url, { result: 'mismatch' })).status, 200);
  const bad = await api('POST', url, { result: 'use_sender', phone: '+44 7700 900123' });
  assert.equal(bad.status, 400);
  const before = auditLines().length;
  const good = await (await api('POST', url, { result: 'use_sender', phone: '056 880 9999' })).json();
  assert.equal(good.order.customer.phone, '+971568809999');
  assert.equal(good.order.whatsappCheck.status, 'confirmed');
  const added = auditLines().slice(before).map((l) => JSON.parse(l).action);
  assert.deepEqual(added, ['order.phone_changed', 'order.whatsapp_confirmed']);
  const { events } = await adminOrder(o.id);
  assert.ok(events.some((e) => e.event === 'phone_changed' && e.detail?.from === o.customer.phone), 'the old number in the history');
  // Track Order still finds it with the number it was placed with.
  assert.equal((await post('/api/orders/lookup', { orderId: o.id, phone: o.customer.phone })).status, 200);
  // A wrong number can be corrected later (validated, audited); never on a cancelled order.
  assert.equal((await api('POST', url, { result: 'correct_phone' })).status, 400, 'needs the number');
  const fixed = await api('POST', url, { result: 'correct_phone', phone: '056 880 9998' });
  assert.equal(fixed.status, 200, await fixed.clone().text());
  assert.equal((await fixed.json()).order.customer.phone, '+971568809998');
  assert.equal((await post('/api/orders/lookup', { orderId: o.id, phone: '+971568809999' })).status, 200, 'and with the one before');
  // The order PATCH takes only its own fields.
  const odd = await api('PATCH', `/api/admin/orders/${o.id}`, { adminNotes: 'ok', total: 1 });
  assert.equal(odd.status, 400);
  assert.match((await odd.json()).message, /Unexpected field: total/);
  assert.equal((await api('PATCH', `/api/admin/orders/${o.id}`, { status: 'cancelled' })).status, 200);
  const closed = await api('POST', url, { result: 'correct_phone', phone: '056 880 9997' });
  assert.equal(closed.status, 409);
  assert.equal((await api('POST', url, { result: 'call' })).status, 409, 'nothing to confirm on a cancelled order');

  const c = await placeOrder();
  const call = await (await api('POST', `/api/admin/orders/${c.id}/whatsapp`, { result: 'call' })).json();
  assert.equal(call.order.whatsappCheck.method, 'call');
  assert.equal((await (await api('POST', `/api/admin/orders/${c.id}/whatsapp`, { result: 'call' })).json()).changed, false, 'idempotent');

  // Booking a COD order not confirmed: the question first, then the owner's yes, recorded.
  const u = await placeOrder();
  const ask = await api('POST', '/api/courier/dispatch', { orderId: u.id, provider: 'jeebly' });
  assert.equal(ask.status, 409);
  const askBody = await ask.json();
  assert.equal(askBody.code, 'whatsapp_unconfirmed');
  assert.match(askBody.message, /hasn't confirmed .* on WhatsApp yet — ship anyway\?/);
  const mark = auditLines().length;
  const yes = await api('POST', '/api/courier/dispatch', { orderId: u.id, provider: 'jeebly', shipUnconfirmed: true, testBooking: true });
  assert.equal(yes.status, 200, await yes.clone().text());
  const actions = auditLines().slice(mark).map((l) => JSON.parse(l).action);
  assert.equal(actions[0], 'order.ship_unconfirmed');
  assert.ok(actions.includes('courier.dispatch'));
});

async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}
async function tabTo(page: Page, name: RegExp): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText || '');
    if (name.test(label)) return true;
  }
  return false;
}

for (const [width, phone] of [[375, '050 881 2001'], [1280, '055 881 2002']] as const) {
  test(`at ${width}px: checkout with no code (no /api/otp call), the confirmation is the WhatsApp message; the hub shows the time left and the call option`, { skip: skip || skipBrowser }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    await ctx.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
    const page = await ctx.newPage();
    const errors: string[] = [];
    const otpCalls: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (r.url().includes('/api/otp/')) otpCalls.push(r.url());
    });
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.locator('h3, h4').filter({ hasText: 'Mughal' }).first().click();
    await page.getByRole('button', { name: /Add to Bag/ }).click();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
    await page.locator('#checkout-phone').waitFor();
    await page.getByText('We confirm orders over WhatsApp.').waitFor();
    assert.equal(await page.getByRole('button', { name: /Send code/ }).count(), 0, 'no code step');
    assert.deepEqual(await overflow(page), [], 'checkout: no sideways scroll');
    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Hind Test');
    // Keyboard: the number field is reached with Tab from the name.
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'checkout-phone', 'Tab from the name reaches the number');
    await page.keyboard.type(phone);
    await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Dubai Marina');
    await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
    // The email: optional, recommended, and why (reported: it should be advised).
    await page.getByText('(recommended)').waitFor();
    await page.getByText(/Not required, but we advise it: get your order confirmation and a link to track your order by email\./).waitFor();
    const submit = page.locator('button[type=submit]');
    await submit.getByText(/Place order/).waitFor();
    await submit.click();
    await page.locator('#order-confirmed-title').waitFor({ timeout: 10_000 });
    // Not "thank you, confirmed": the last step is the main action (reported: it was not clear).
    await page.getByRole('heading', { name: 'Confirm your order on WhatsApp' }).waitFor();
    await page.getByText('Last step · not confirmed yet').waitFor();
    // Reported: the action must stand out. The label in red, the heading in the button's green, and "click the green button".
    await page.getByText('Click the green button below to confirm your order').waitFor();
    const colour = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
    const background = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const rgb = (c: string) => c.match(/\d+/g)!.slice(0, 3).map(Number);
    const [lr, lg, lb] = rgb(await colour('[data-testid="order-last-step-label"]'));
    assert.ok(lr > lg + 40 && lr > lb + 40, `the last-step line is red: ${lr},${lg},${lb}`);
    assert.equal(await colour('#order-confirmed-title'), await background('[data-testid="wa-confirm-button"]'), 'the heading in the button’s green');
    await page.getByText(/Please tap within 6 hours: orders not confirmed within 24 hours are cancelled \(after 6 hours if WhatsApp is never opened\)\./).waitFor();
    assert.equal(await page.getByText('Thank you for your order').count(), 0, 'not thanked as if it were confirmed');
    const button = page.getByRole('link', { name: /Confirm (my order )?on WhatsApp/ });
    assert.ok(await button.isVisible());
    assert.deepEqual(await overflow(page), [], 'confirmation: no sideways scroll');
    assert.ok(await tabTo(page, /Confirm (my order )?on WhatsApp/), 'reachable with Tab');
    const href = (await button.getAttribute('href'))!;
    const id = href.match(/BUH-\d{6}-[A-Z2-9]{6}/)?.[0];
    assert.ok(id, href);
    assert.deepEqual(otpCalls, [], 'no request to /api/otp/*');
    assert.deepEqual(errors, []);
    const { order } = await adminOrder(id!);
    assert.equal(order.customer.phoneVerified, false);
    assert.equal(order.whatsappCheck!.status, 'awaiting');
    // Tapped: "your order is in process" (and the button to open WhatsApp again, if not sent).
    const popup = ctx.waitForEvent('page');
    await button.click();
    await (await popup).close();
    await page.getByRole('heading', { name: 'Your order is in process' }).waitFor();
    await page.getByText(/will confirm it shortly on WhatsApp/).waitFor();
    await page.getByRole('link', { name: /Didn’t send it\? Open WhatsApp again/ }).waitFor();
    assert.deepEqual(await overflow(page), [], 'in process: no sideways scroll');
    await ctx.close();

    // The hub (phone view): the time left, "Ask to confirm" to the customer, and "Confirmed by phone call".
    const hub = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const hubErrors: string[] = [];
    hp.on('pageerror', (e) => hubErrors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    await hp.getByRole('button', { name: /Awaiting WhatsApp/ }).click();
    const card = hp.getByTestId('whatsapp-check').filter({ hasText: order.customer.phone }).first();
    // The customer tapped (WhatsApp opened), so the 24-hour deadline applies, not the 6-hour one.
    await card.getByText(/Awaiting WhatsApp — auto-cancels in 2[34] h/).waitFor();
    assert.equal(await card.getByText(/unless the customer opens WhatsApp/).count(), 0);
    const ask = card.getByRole('link', { name: 'Ask to confirm' });
    const digits = order.customer.phone.replace(/\D/g, '');
    assert.equal(await ask.getAttribute('href'), `https://wa.me/${digits}?text=${encodeURIComponent(`Hello Hind, please confirm your order ${id} from Beautiful UAE Home by replying YES. Thank you!`)}`);
    assert.deepEqual(await overflow(hp), [], 'hub: no sideways scroll');
    await card.getByRole('button', { name: 'Confirmed by phone call' }).click();
    await hp.getByText(/Confirmed by phone call by admin@beautifuluaehome\.com/).first().waitFor();
    assert.equal((await adminOrder(id!)).order.whatsappCheck!.method, 'call');
    // "Correct the phone number": the confirm dialog shows the number as the server will store it.
    const done = hp.getByTestId('whatsapp-check').filter({ hasText: order.customer.phone }).first();
    await done.getByText('Correct the phone number').click();
    await done.getByLabel('The correct phone number').fill(width < 800 ? '050 881 3001' : '00971 55 881 3002');
    const want = width < 800 ? '+971508813001' : '+971558813002';
    let asked = '';
    hp.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    assert.deepEqual(await overflow(hp), [], 'hub: no sideways scroll with the form open');
    await done.getByLabel('The correct phone number').press('Enter');
    await hp.getByText(want).first().waitFor();
    assert.ok(asked.includes(`to ${want}?`), asked);
    assert.equal((await adminOrder(id!)).order.customer.phone, want);
    assert.deepEqual(hubErrors, []);
    await hub.close();
  });
}

test('the hub’s one-time notice at 375 and 1280 px: "Customers now confirm on WhatsApp instead of an SMS code"; Got it hides it for good', { skip: skip || skipBrowser }, async () => {
  for (const width of [1280, 375]) {
    const hub = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const errors: string[] = [];
    hp.on('pageerror', (e) => errors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    const notice = hp.getByTestId('phone-check-notice');
    await notice.getByText('Customers now confirm on WhatsApp instead of an SMS code').waitFor();
    assert.match(await notice.innerText(), /— change in Settings → Phone check\./);
    assert.deepEqual(await overflow(hp), [], 'no sideways scroll');
    if (width === 1280) {
      await notice.getByRole('button', { name: 'Open Phone check' }).click();
      await hp.getByTestId('phone-check-card').waitFor();
    } else {
      // By keyboard.
      await notice.getByRole('button', { name: 'Got it' }).focus();
      await hp.keyboard.press('Enter');
      await notice.waitFor({ state: 'detached' });
      await hp.reload({ waitUntil: 'domcontentloaded' });
      await openAdminSection(hp, /^Orders/);
      assert.equal(await hp.getByTestId('phone-check-notice').count(), 0, 'gone for good');
      const st = await (await api('GET', '/api/admin/settings')).json();
      assert.equal(st.phoneCheckInfo.whatsappNotice, false);
    }
    assert.deepEqual(errors, []);
    await hub.close();
  }
});

test('Settings → Phone check at 375 px: WhatsApp (free) chosen, and a warning while no WhatsApp number is set', { skip: skip || skipBrowser }, async () => {
  await setStore({ whatsappNumber: '' });
  try {
    const hub = await browser.newContext({ viewport: { width: 375, height: 860 }, hasTouch: true });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Settings/);
    await hp.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Phone check' }).click();
    const card = hp.getByTestId('phone-check-card');
    await card.waitFor();
    assert.equal(await card.getByRole('radio', { name: /WhatsApp \(free\)/ }).isChecked(), true);
    await card.getByText(/No WhatsApp number is set in Settings → Store & contact/).waitFor();
    // No TRUST_PROXY on this server: the stricter limits are said; the sooner hours are there.
    await card.getByTestId('phone-check-no-proxy').getByText(/Behind no proxy, the shop can't tell customers apart: limits are stricter/).waitFor();
    assert.equal(await card.getByLabel('If the customer never opens WhatsApp, cancel after (hours)').inputValue(), '6');
    assert.deepEqual(await overflow(hp), [], 'no sideways scroll');
    await hub.close();
    // The server is safe too: the order is taken, flagged, never verified.
    const o = await placeOrder();
    assert.equal(o.whatsappCheck, undefined);
    const { order } = await adminOrder(o.id);
    assert.equal((order as unknown as { attention?: { kind: string } }).attention?.kind, 'call_customer');
  } finally {
    await setStore({ whatsappNumber: SHOP_WA });
  }
});
