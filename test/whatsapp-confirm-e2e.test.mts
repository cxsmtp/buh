/**
 * BUH-02.09 against the real build: "Confirm on WhatsApp". The owner's confirm / mismatch route
 * (door + session + same site, size-capped body, allow-listed fields, unknown order 404,
 * idempotent, audited); the customer's "opened" note (order number + its phone only, same
 * answer either way, rate-limited, can't touch another order); the code never in the server's
 * log. In Chromium at 375 and 1280 px: the checkout's confirmation screen shows the button
 * (visible, no sideways scroll, reachable with the keyboard) with the right wa.me link, and
 * tapping it is noted on the order; then the hub's phone view shows the badge with the code
 * and confirms in one tap, with a "Reply on WhatsApp" link. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBuild, rawFetch, setPhoneCheck, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;

const SHOP_WA = '+971 50 999 8877';
let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

before(async () => {
  if (skip) return;
  server = await startServer();
  // These tests drive the SMS-code checkout (Settings → Phone check "SMS code"; the default is WhatsApp).
  await setPhoneCheck(server, 'sms_code');
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'WhatsApp-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  await setStore({ whatsappNumber: SHOP_WA, confirmOrdersOnWhatsApp: true, holdUntilWhatsAppConfirmed: false });
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
  customer: { phone: string };
  whatsappCheck?: { status: string; code: string; hold: boolean };
}
let phoneN = 0;
/** A checkout through the real routes (test-mode SMS code), with a fresh phone. */
async function placeOrder(): Promise<PlacedOrder> {
  const phone = `+97150770${String(++phoneN).padStart(4, '0')}`;
  const sent = await (await post('/api/otp/send', { phone })).json();
  const { verificationToken } = await (await post('/api/otp/verify', { phone, code: sent.devOtpCode })).json();
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    verificationToken,
    customer: { fullName: 'Noura Test', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).order;
}
const adminOrder = async (id: string) => (await (await api('GET', `/api/admin/orders/${id}`)).json()) as { order: PlacedOrder & { whatsappCheck?: { openedAt?: string; checkedBy?: string; status: string } }; events: Array<{ event: string; actor: string }> };
function auditLines(): string[] {
  return fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean));
}

test('a placed order carries the server’s 4-digit code; no number or switched off: none', { skip }, async () => {
  const o = await placeOrder();
  assert.equal(o.whatsappCheck?.status, 'awaiting');
  assert.match(o.whatsappCheck!.code, /^\d{4}$/);
  assert.equal(o.whatsappCheck!.hold, false);
  const tracked = await (await post('/api/orders/lookup', { orderId: o.id, phone: o.customer.phone })).json();
  assert.deepEqual(tracked.order.whatsappCheck, o.whatsappCheck);

  await setStore({ confirmOrdersOnWhatsApp: false });
  assert.equal((await placeOrder()).whatsappCheck, undefined, 'switched off');
  await setStore({ confirmOrdersOnWhatsApp: true, whatsappNumber: '' });
  assert.equal((await placeOrder()).whatsappCheck, undefined, 'no WhatsApp number');
  await setStore({ whatsappNumber: SHOP_WA });
  // The public settings say so, so the shop can show the button.
  const pub = await (await rawFetch(`${server.base}/api/settings/public`)).json();
  assert.equal(pub.store.confirmOrdersOnWhatsApp, true);
  assert.equal(pub.store.holdUntilWhatsAppConfirmed, false);
  // The code never reaches the server's log.
  assert.ok(!server.log().includes(`code ${o.whatsappCheck!.code}`) && !server.log().includes(`"${o.whatsappCheck!.code}"`));
});

test('the owner’s confirm route: door, session and same site; body validated; unknown order 404; idempotent and audited', { skip }, async () => {
  const o = await placeOrder();
  const url = `/api/admin/orders/${o.id}/whatsapp`;
  const unknown = await rawFetch(`${server.base}/api/no-such-${crypto.randomBytes(4).toString('hex')}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: '{}' });
  const noDoor = await rawFetch(`${server.base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: JSON.stringify({ result: 'confirmed' }) });
  assert.equal(noDoor.status, 404, 'without the door: an unknown address');
  assert.equal(await noDoor.text(), await unknown.text());
  assert.equal((await post(url, { result: 'confirmed' }, { cookie: server.door })).status, 401, 'the door but no session');
  assert.equal((await api('POST', url, { result: 'confirmed' }, { origin: 'https://evil.example' })).status, 403, 'cross-site');
  assert.equal((await api('POST', url, {})).status, 400);
  assert.equal((await api('POST', url, { result: 'yes' })).status, 400);
  assert.equal((await api('POST', url, { result: 'confirmed', by: 'someone' })).status, 400, 'fields outside the allow-list');
  assert.equal((await fetch(`${server.base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: JSON.stringify({ result: 'confirmed', pad: 'x'.repeat(4000) }) })).status, 413, 'size-capped');
  const missing = await api('POST', '/api/admin/orders/BUH-000000-NOSUCH/whatsapp', { result: 'confirmed' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { success: false, message: 'Order not found.' });
  assert.equal(await adminOrder(o.id).then((x) => x.order.whatsappCheck!.status), 'awaiting', 'nothing changed by the refused calls');

  const before = auditLines().length;
  const first = await api('POST', url, { result: 'confirmed' });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.changed, true);
  assert.equal(body.order.whatsappCheck.status, 'confirmed');
  assert.equal(body.order.whatsappCheck.checkedBy, 'admin@beautifuluaehome.com');
  const again = await (await api('POST', url, { result: 'confirmed' })).json();
  assert.equal(again.changed, false);
  assert.equal(again.order.whatsappCheck.checkedAt, body.order.whatsappCheck.checkedAt, 'a second tap changes nothing');
  const added = auditLines().slice(before).map((l) => JSON.parse(l));
  assert.deepEqual(added.map((e) => e.action), ['order.whatsapp_confirmed']);
  assert.equal(added[0].details.orderId, o.id);
  const { events } = await adminOrder(o.id);
  assert.deepEqual(events.map((e) => e.event), ['created', 'whatsapp_asked', 'whatsapp_confirmed']);
});

test('hold until confirmed: confirming or booking is refused until the owner’s tap, then released', { skip }, async () => {
  await setStore({ holdUntilWhatsAppConfirmed: true });
  const o = await placeOrder();
  await setStore({ holdUntilWhatsAppConfirmed: false });
  assert.equal(o.whatsappCheck!.hold, true);
  const refused = await api('PATCH', `/api/admin/orders/${o.id}`, { status: 'confirmed' });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).message, /held until the customer confirms on WhatsApp/);
  assert.equal((await api('POST', '/api/courier/dispatch', { orderId: o.id, provider: 'jeebly' })).status, 409);
  assert.equal((await api('POST', `/api/admin/orders/${o.id}/whatsapp`, { result: 'confirmed' })).status, 200);
  const ok = await api('PATCH', `/api/admin/orders/${o.id}`, { status: 'confirmed' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).order.status, 'confirmed');
});

test('the customer’s "opened" note: only that order with its phone, the same answer either way, rate-limited', { skip }, async () => {
  const mine = await placeOrder();
  const theirs = await placeOrder();
  const ping = (orderId: string, phone: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => post('/api/orders/whatsapp-opened', { orderId, phone, ...extra }, headers);
  const wrong = await ping(theirs.id, mine.customer.phone);
  assert.equal(wrong.status, 200);
  assert.deepEqual(await wrong.json(), { ok: true }, 'tells a guesser nothing');
  assert.equal((await adminOrder(theirs.id)).order.whatsappCheck!.openedAt, undefined, 'another order untouched');
  assert.equal((await ping(mine.id, mine.customer.phone, { status: 'confirmed' })).status, 400, 'allow-listed fields only');
  assert.equal((await ping(mine.id, mine.customer.phone, {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/orders/whatsapp-opened', 'x'.repeat(2000))).status, 413);
  const right = await ping(mine.id.toLowerCase(), mine.customer.phone.replace('+971', '0'));
  assert.equal(right.status, 200);
  const after = await adminOrder(mine.id);
  assert.ok(after.order.whatsappCheck!.openedAt, 'noted');
  assert.equal(after.order.whatsappCheck!.status, 'awaiting', 'only the opened time');
  assert.ok(after.events.some((e) => e.event === 'whatsapp_opened' && e.actor === 'customer'));
  assert.equal((await adminOrder(theirs.id)).order.whatsappCheck!.openedAt, undefined);
  // Per order: 10 in 15 minutes (one used above), then 429.
  let last = 0;
  for (let i = 0; i < 10 && last !== 429; i++) last = (await ping(theirs.id, '+971500000000')).status;
  assert.equal(last, 429);
});

async function overflow(page: Page) {
  return page.evaluate(() => (document.documentElement.scrollWidth > document.documentElement.clientWidth ? [`${document.documentElement.scrollWidth}px wide`] : []));
}

/** Tab through the page until the element is focused (keyboard reachable). */
async function tabTo(page: Page, name: RegExp): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText || '');
    if (name.test(label)) return true;
  }
  return false;
}

for (const [width, phone] of [[375, '050 771 2001'], [1280, '055 771 2002']] as const) {
  test(`at ${width}px: the confirmation screen’s "Confirm on WhatsApp" (visible, keyboard, right link, noted), then one tap in the hub’s phone view`, { skip: skip || skipBrowser }, async () => {
    const ctx = await browser.newContext({ viewport: { width, height: 860 }, hasTouch: width < 800 });
    // WhatsApp itself is not opened in the test: its address answers with a stub page.
    await ctx.route('https://wa.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>wa</title>' }));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.base, { waitUntil: 'domcontentloaded' });
    await page.locator('h3, h4').filter({ hasText: 'Mughal' }).first().click();
    await page.getByRole('button', { name: /Add to Bag/ }).click();
    await page.getByRole('button', { name: /Proceed to Checkout/ }).click();
    await page.locator('#checkout-phone').waitFor();
    await page.getByPlaceholder('e.g. Fatima Al Mansoori').fill('Hessa Test');
    await page.locator('#checkout-phone').fill(phone);
    await page.getByRole('button', { name: /Send code/ }).click();
    await page.getByRole('button', { name: /Test mode/ }).click();
    await page.getByText('Mobile number verified').waitFor();
    await page.getByPlaceholder('e.g. Dubai Marina, Saadiyat, JVC').fill('Dubai Marina');
    await page.getByPlaceholder('Street name, road, or community number').fill('Marina Walk');
    await page.getByPlaceholder('e.g. Marina Gate 1 or Villa 24').fill('Marina Gate 1');
    await page.getByPlaceholder('e.g. Apt 1402 or Villa 24').fill('1402');
    await page.locator('button[type=submit]').click();
    await page.locator('#order-confirmed-title').waitFor({ timeout: 10_000 });

    const button = page.getByRole('link', { name: /Confirm (my order )?on WhatsApp/ });
    await button.waitFor();
    assert.ok(await button.isVisible());
    await page.getByText('One last step').waitFor();
    await page.getByText('Your order is placed either way.').waitFor();
    assert.deepEqual(await overflow(page), [], 'no sideways scroll');
    const box = (await button.boundingBox())!;
    assert.ok(box.x >= 0 && box.x + box.width <= width && box.height >= 44, `a large button inside the screen: ${JSON.stringify(box)}`);
    const href = (await button.getAttribute('href'))!;
    const id = href.match(/BUH-\d{6}-[A-Z2-9]{6}/)?.[0];
    assert.ok(id, href);
    const { order } = await adminOrder(id!);
    assert.equal(href, `https://wa.me/971509998877?text=${encodeURIComponent(`Confirm my order ${id} · code ${order.whatsappCheck!.code}`)}`);
    assert.equal(await page.getByRole('link', { name: /Send WhatsApp Order Update/ }).count(), 0, 'one WhatsApp button, not two');
    // Keyboard: Tab reaches it.
    assert.ok(await tabTo(page, /Confirm (my order )?on WhatsApp/), 'reachable with Tab');
    // Tapping it notes "Customer opened WhatsApp" on the order.
    const noted = page.waitForResponse((r) => r.url().endsWith('/api/orders/whatsapp-opened'));
    const popup = ctx.waitForEvent('page');
    await button.click();
    assert.equal((await noted).status(), 200);
    await (await popup).close();
    let opened: string | undefined;
    for (let i = 0; i < 30 && !opened; i++) {
      opened = (await adminOrder(id!)).order.whatsappCheck!.openedAt;
      if (!opened) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(opened, 'opened noted');
    assert.deepEqual(errors, []);
    await ctx.close();

    // The owner's phone view of the hub: the badge with the code, one tap, then a reply link.
    const hub = await browser.newContext({ viewport: { width: 375, height: 860 }, hasTouch: true });
    const [name, value] = cookie.split('=');
    await hub.addCookies([{ name, value, url: server.base }]);
    const hp = await hub.newPage();
    const hubErrors: string[] = [];
    hp.on('pageerror', (e) => hubErrors.push(e.message));
    await hp.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(hp, /^Orders/);
    const filter = hp.getByRole('button', { name: /Awaiting WhatsApp/ });
    await filter.click();
    const card = hp.locator('div.rounded-2xl').filter({ hasText: id! }).filter({ has: hp.getByRole('button', { name: 'Confirmed on WhatsApp' }) }).last();
    await card.getByText(`Awaiting WhatsApp confirmation · code ${order.whatsappCheck!.code}`).waitFor();
    await card.getByText(/Customer opened WhatsApp at/).waitFor();
    assert.ok(await card.getByText(order.customer.phone).first().isVisible(), 'the phone to compare with the sender');
    assert.deepEqual(await overflow(hp), [], 'hub: no sideways scroll');
    await card.getByRole('button', { name: 'Confirmed on WhatsApp' }).click();
    await hp.getByText(/Confirmed on WhatsApp by admin@beautifuluaehome\.com/).first().waitFor();
    const reply = hp.getByRole('link', { name: 'Reply on WhatsApp' }).first();
    const digits = order.customer.phone.replace(/\D/g, '');
    assert.equal(await reply.getAttribute('href'), `https://wa.me/${digits}?text=${encodeURIComponent(`Thank you, your order ${id} is confirmed ✓`)}`);
    const after = await adminOrder(id!);
    assert.equal(after.order.whatsappCheck!.status, 'confirmed');
    assert.deepEqual(hubErrors, []);
    await hub.close();
  });
}
