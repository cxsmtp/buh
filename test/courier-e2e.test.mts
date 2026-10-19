/**
 * Reported: "I placed an order, accepted it from admin, put it dispatched. Why are the courier
 * tracking details not shown? … The label is not real." Against the real build, with Jeebly's
 * Scheduled API standing in with its exact replies (test/fixtures/jeebly-mock.mjs, preloaded):
 * - "Enter tracking number" (POST /api/admin/orders/<id>/tracking): the door and a session first,
 *   allow-listed and validated fields, audited before it is reported done, shown in Track Order;
 *   replacing a real booking needs the owner's confirm (also audited).
 * - Jeebly Live mode: refused without the live address and a passed Sandbox check; the typed
 *   override is audited. Sandbox keys never come back to the browser.
 * - A live booking: Jeebly's AWB, its label PDF through the hub, tracking, Track Order's events,
 *   cancelled with the order (audited). A size with no weight is never booked with a guess.
 * - In Chromium at 375 and 1280 px: the Sandbox check run from Couriers, the dispatch dialog in
 *   Test and Live mode with the weight worked out, both labels, Enter tracking number, Track Order
 *   with Jeebly's events, a size's weight in the product editor: no sideways scroll, Escape closes,
 *   the keyboard reaches the fields. With SHOTS_DIR set, screenshots are saved there.
 * Skipped without a build.
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
const skipBrowser = !hasBuild || !pw;
const SHOTS = process.env.SHOTS_DIR || '';

let server: RunningServer;
let cookie = '';

before(async () => {
  if (skip) return;
  // Jeebly's Scheduled API stands in with its exact replies (test/fixtures/jeebly-mock.mjs).
  server = await startServer({ JEEBLY_MOCK: '1' }, { preload: ['test/fixtures/jeebly-mock.mjs'] });
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Courier-Owner-Pass-1' }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
});
after(() => server?.stop());

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
function auditActions(): string[] {
  return fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l).action as string);
}

let phoneN = 0;
/** A COD order through the real checkout (WhatsApp mode, the default), confirmed by the owner. */
async function confirmedOrder(): Promise<{ id: string; phone: string }> {
  const phone = `+97150770${String(++phoneN).padStart(4, '0')}`;
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await rawFetch(`${server.base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      customer: { fullName: 'Noura Test', phone, emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Marina Gate 1', flatVillaNo: '1402', landmark: 'Next to the tram stop' },
      items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
    }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { order } = await res.json();
  const ok = await api('PATCH', `/api/admin/orders/${order.id}`, { status: 'confirmed', shipUnconfirmed: true });
  assert.equal(ok.status, 200, await ok.clone().text());
  return { id: order.id, phone };
}
const lookup = async (orderId: string, phone: string) => (await (await rawFetch(`${server.base}/api/orders/lookup`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify({ orderId, phone }) })).json()).order;

test('Enter tracking number: door and session first, validated, audited, then in Track Order; replacing needs a confirm', { skip }, async () => {
  const { id, phone } = await confirmedOrder();
  const url = `/api/admin/orders/${id}/tracking`;
  const good = { carrier: 'jeebly', awb: 'JB-44556677' };
  assert.equal((await rawFetch(`${server.base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base, cookie }, body: JSON.stringify(good) })).status, 404, 'no door: an unknown address');
  assert.equal((await fetch(`${server.base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: server.base }, body: JSON.stringify(good) })).status, 401, 'no session');
  assert.equal((await api('POST', url, good, { origin: 'https://evil.example' })).status, 403, 'cross-site');
  for (const [label, body] of [
    ['extra field', { ...good, status: 'delivered' }],
    ['bad AWB', { carrier: 'jeebly', awb: 'JB 1' }],
    ['unknown courier', { carrier: 'dhl', awb: 'JB-44556677' }],
    ['http link', { ...good, trackingUrl: 'http://track.example.com/x' }],
    ['private link', { ...good, trackingUrl: 'https://10.0.0.1/track' }],
    ['other without name', { carrier: 'other', awb: 'JB-44556677' }],
  ] as const) {
    assert.equal((await api('POST', url, body)).status, 400, label);
  }
  assert.equal((await api('POST', '/api/admin/orders/BUH-000000-NOPE00/tracking', good)).status, 404);
  const big = await api('POST', url, { ...good, carrierName: 'x'.repeat(5000) });
  assert.equal(big.status, 413, 'size-capped');

  assert.equal((await lookup(id, phone)).courier.awbNumber, '', 'nothing yet');
  const saved = await api('POST', url, good);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json()).order.courier.awbNumber, 'JB-44556677');
  assert.ok(auditActions().includes('order.tracking_entered'));
  const seen = await lookup(id, phone);
  assert.equal(seen.courier.awbNumber, 'JB-44556677');
  assert.equal(seen.courier.carrier, undefined);

  const other = { carrier: 'other', carrierName: 'Aramex', awb: 'ARX12345678', trackingUrl: 'https://1.1.1.1/track/ARX12345678' };
  const ask = await api('POST', url, other);
  assert.equal(ask.status, 409);
  assert.equal((await ask.json()).code, 'tracking_replace');
  assert.equal((await lookup(id, phone)).courier.awbNumber, 'JB-44556677', 'unchanged without the confirm');
  const replaced = await api('POST', url, { ...other, replace: true });
  assert.equal(replaced.status, 200, await replaced.clone().text());
  assert.ok(auditActions().includes('order.tracking_replaced'));
  const after2 = await lookup(id, phone);
  assert.equal(after2.courier.awbNumber, 'ARX12345678');
  assert.equal(after2.courier.trackingUrl, 'https://1.1.1.1/track/ARX12345678');
  assert.equal(after2.courier.carrier, 'Aramex');
});

test('Jeebly Live mode: refused without a passed Sandbox check (route and settings save); the typed override is audited first', { skip }, async () => {
  const noAddress = await api('POST', '/api/courier/live', { on: true, override: 'TURN ON WITHOUT SANDBOX CHECK' });
  assert.equal((await noAddress.json()).code, 'live_base_required', "never without Jeebly's live address");
  assert.equal((await api('PUT', '/api/admin/settings/courier', { settings: { jeebly: { liveBaseUrl: 'http://evil.example' } } })).status, 400);
  assert.equal((await api('PUT', '/api/admin/settings/courier', { settings: { jeebly: { liveBaseUrl: 'https://live.jeebly.com' } } })).status, 200);
  const refused = await api('POST', '/api/courier/live', { on: true });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.code, 'sandbox_check_required');
  assert.match(body.message, /Run the Sandbox check first/);
  const viaSettings = await api('PUT', '/api/admin/settings/courier', { settings: { jeebly: { isLive: true } } });
  assert.equal(viaSettings.status, 409, 'the settings save enforces it too');
  assert.equal((await api('POST', '/api/courier/live', { on: true, override: 'yes please' })).status, 400, 'the exact phrase only');
  assert.equal((await api('POST', '/api/courier/live', { on: true, extra: 1 })).status, 400);

  const check = await api('POST', '/api/courier/sandbox-check', {});
  assert.equal(check.status, 200);
  const result = (await check.json()).check;
  assert.equal(result.passed, false, 'no sandbox keys saved: it fails and says why');
  assert.match(result.steps[0].said, /sandbox keys/);
  assert.ok(auditActions().includes('courier.sandbox_check'));
  assert.equal((await (await api('GET', '/api/courier/sandbox-check')).json()).check.passed, false, 'kept');

  const before = auditActions().length;
  const on = await api('POST', '/api/courier/live', { on: true, override: 'TURN ON WITHOUT SANDBOX CHECK' });
  assert.equal(on.status, 200, await on.clone().text());
  const added = auditActions().slice(before);
  assert.ok(added.indexOf('courier.live_override') > -1 && added.indexOf('courier.live_override') < added.indexOf('courier.live'), 'override audited before Live is switched on');
  assert.equal((await (await api('GET', '/api/admin/settings')).json()).courier.value.jeebly.isLive, true);
  assert.equal((await api('POST', '/api/courier/live', { on: false })).status, 200);
});

test('sandbox keys are saved on the server and never come back to the browser', { skip }, async () => {
  const put = await api('PUT', '/api/admin/settings/courier', { settings: { jeebly: { sandboxApiKey: 'SANDBOX-KEY-ABCDEF123', sandboxClientKey: 'SANDBOX-CLIENT-987654' } } });
  assert.equal(put.status, 200, await put.clone().text());
  assert.ok(!(await put.clone().text()).includes('SANDBOX-KEY-ABCDEF'));
  const text = await (await api('GET', '/api/admin/settings')).text();
  assert.ok(!text.includes('SANDBOX-KEY-ABCDEF') && !text.includes('SANDBOX-CLIENT-98'));
  const courier = JSON.parse(text).courier;
  assert.equal(courier.value.jeebly.sandboxApiKey, '');
  assert.equal(courier.secretsSet['jeebly.sandboxApiKey'], true);
  assert.equal(courier.secretsSet['jeebly.sandboxClientKey'], true);
  assert.equal((await api('PUT', '/api/admin/settings/courier', { settings: { jeebly: { sandboxApiKey: null, sandboxClientKey: null } } })).status, 200);
});

const PICKUP = { pickupPhone: '+971 50 123 4567', pickupUnit: 'Shop 4', pickupBuilding: 'Barsha Heights Tower', pickupArea: 'Al Barsha 1', pickupLandmark: 'Next to the metro', pickupAddress: 'Street 12' };
const KEYS = { sandboxApiKey: 'SB-KEY-1234567', sandboxClientKey: 'SB-CLIENT-1234567', apiKey: 'LIVE-KEY-1234567', clientKey: 'LIVE-CLIENT-1234567', liveBaseUrl: 'https://live.jeebly.com' };
/** Keys and pickup saved, the Sandbox check run (it passes against the stand-in), then Live on or off. */
async function goLive(on: boolean) {
  assert.equal((await api('PUT', '/api/admin/settings/courier', { settings: { jeebly: { ...PICKUP, ...KEYS } } })).status, 200);
  if (on) {
    const check = (await (await api('POST', '/api/courier/sandbox-check', {})).json()).check;
    assert.equal(check.passed, true, JSON.stringify(check.steps));
  }
  const res = await api('POST', '/api/courier/live', { on });
  assert.equal(res.status, 200, await res.clone().text());
}

test("a live Jeebly booking: Jeebly's AWB, its label PDF through the hub, tracking, Track Order events, cancelled with the order", { skip }, async () => {
  await goLive(true);
  const { id, phone } = await confirmedOrder();
  const ask = await api('POST', '/api/courier/dispatch', { orderId: id, provider: 'jeebly', shipUnconfirmed: true });
  assert.equal((await ask.json()).code, 'weight_required', 'no weight on the sizes: never guessed');
  const res = await api('POST', '/api/courier/dispatch', { orderId: id, provider: 'jeebly', shipUnconfirmed: true, weightKg: 2.6 });
  const booked = await res.json();
  assert.equal(res.status, 200, JSON.stringify(booked));
  assert.match(booked.awbNumber, /^JB\d+$/);
  assert.equal(booked.isSimulated, false);

  const label = await api('GET', `/api/admin/orders/${id}/carrier-label`);
  assert.equal(label.status, 200);
  assert.equal(label.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await label.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.ok(auditActions().includes('courier.label_printed'));
  assert.equal((await rawFetch(`${server.base}/api/admin/orders/${id}/carrier-label`, { headers: { cookie } })).status, 404, 'no door: unknown');

  const tracking = await (await api('GET', `/api/admin/orders/${id}/carrier-tracking`)).json();
  assert.equal(tracking.tracking.lastStatus, 'Pickup Scheduled');
  const seen = await lookup(id, phone);
  assert.equal(seen.courier.awbNumber, booked.awbNumber);
  assert.equal(seen.courier.live.lastStatus, 'Pickup Scheduled');
  assert.equal(seen.courier.live.events[0].hub, 'DXB');
  assert.doesNotMatch(JSON.stringify(seen), /phone"|rider|pod_image|signature/i);

  const cancel = await api('PATCH', `/api/admin/orders/${id}`, { status: 'cancelled' });
  const cancelled = await cancel.json();
  assert.equal(cancel.status, 200);
  assert.equal(cancelled.carrierCancel.cancelled, true);
  assert.match(cancelled.carrierCancel.message, /Jeebly cancelled the shipment/);
  assert.ok(auditActions().includes('courier.cancel'));
  await goLive(false);
});

test('review M5: the Jeebly label opens in Chromium (200, application/pdf, nosniff, no CSP sandbox, which stops its PDF viewer)', { skip: skipBrowser }, async (t) => {
  await goLive(true);
  const { id } = await confirmedOrder();
  const res = await api('POST', '/api/courier/dispatch', { orderId: id, provider: 'jeebly', shipUnconfirmed: true, weightKg: 1 });
  assert.equal(res.status, 200, await res.clone().text());
  const awb = (await res.json()).awbNumber as string;
  const browser = await pw!.chromium.launch();
  try {
    const context = await browser.newContext();
    const url = new URL(server.base);
    await context.addCookies(
      [server.door, cookie].map((c) => {
        const [name, ...v] = c.split('=');
        return { name, value: v.join('='), domain: url.hostname, path: '/' };
      })
    );
    const page = await context.newPage();
    // Headless Chromium has no PDF viewer: it may hand the PDF over as a download, after the response.
    const seen = page.waitForResponse((r) => r.url().endsWith(`/api/admin/orders/${id}/carrier-label`));
    await page.goto(`${server.base}/api/admin/orders/${id}/carrier-label`).catch(() => null);
    const response = await seen;
    const h = await response.allHeaders();
    assert.equal(response.status(), 200);
    assert.equal(h['content-type'], 'application/pdf');
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['content-disposition'], `inline; filename="${awb}.pdf"`);
    assert.match(h['content-security-policy'], /default-src 'none'/);
    assert.doesNotMatch(h['content-security-policy'], /sandbox/);
    t.diagnostic(`content-security-policy: ${h['content-security-policy']}`);
  } finally {
    await browser.close();
    await goLive(false);
  }
});

async function overflow(page: import('playwright').Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`page ${document.documentElement.scrollWidth}px wide`);
    for (const d of Array.from(document.querySelectorAll('[role="dialog"] > *'))) {
      if (d.scrollWidth > d.clientWidth + 1) out.push(`dialog ${d.scrollWidth} > ${d.clientWidth}`);
    }
    return out;
  });
}
const shot = async (page: import('playwright').Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};

for (const width of [375, 1280]) {
  test(`courier screens at ${width}px: Sandbox check, Test and Live booking dialogs with the weight, both labels, Enter tracking number, Track Order with Jeebly's events, a size's weight`, { skip: skipBrowser }, async () => {
    // The first size of the first product weighs 1.2 kg (Inventory → the size → Weight).
    const shopProduct = (await (await rawFetch(`${server.base}/api/products`)).json()).products[0] as { id: string };
    const product = ((await (await api('GET', '/api/admin/products')).json()).products as Array<{ id: string; title: string; profiles: Array<Record<string, unknown>> }>).find((x) => x.id === shopProduct.id)!;
    const weighed = await api('PATCH', `/api/admin/products/${product.id}`, { product: { profiles: product.profiles.map((s, i) => (i === 0 ? { ...s, weightGrams: 1200 } : s)) } });
    assert.equal(weighed.status, 200, await weighed.clone().text());
    const sizeName = String(product.profiles[0].name);

    await goLive(false); // sandbox keys saved: Test mode books in Jeebly's demo system
    const a = await confirmedOrder();
    const b = await confirmedOrder();
    const c = await confirmedOrder();
    assert.equal((await api('PATCH', `/api/admin/orders/${c.id}`, { status: 'dispatched' })).status, 200);

    const browser = await pw!.chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 812 : 900 }, hasTouch: width < 768 });
      const [name, value] = cookie.split('=');
      await ctx.addCookies([{ name, value, url: server.base }]);
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const dialogs: string[] = [];
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        void d.accept();
      });
      await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });

      // 1. Couriers: the Sandbox check, run from the hub, each step with Jeebly's reply.
      await openAdminSection(page, /^Settings/);
      await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Couriers' }).click();
      await page.getByTestId('jeebly-mode').getByText('Jeebly: Test mode (sandbox)').waitFor();
      await page.getByRole('button', { name: 'Run the Sandbox check' }).click();
      const check = page.getByTestId('sandbox-check');
      await check.getByText(/^Passed on /).waitFor();
      for (const step of ['Create a TEST shipment', 'Fetch its label', 'Fetch its tracking', 'Cancel it']) await check.getByText(step).waitFor();
      await check.getByText(/Shipment cancelled successfully/).waitFor();
      assert.deepEqual(await overflow(page), [], 'Couriers: no sideways scroll');
      await check.scrollIntoViewIfNeeded();
      await shot(page, `couriers-sandbox-check-${width}`);

      // 2. Test mode: the dialog says so, with the weight worked out; the test label.
      await openAdminSection(page, /^Orders/);
      const card = (id: string, button: string) => page.locator('div.rounded-2xl').filter({ hasText: id }).filter({ has: page.getByRole('button', { name: button }) }).first();
      await card(a.id, 'Book courier').getByRole('button', { name: 'Book courier' }).click();
      const dispatch = page.getByRole('dialog', { name: 'Book the courier' });
      await dispatch.getByTestId('booking-mode').getByText('Jeebly: Test (sandbox) mode').waitFor();
      await dispatch.getByTestId('weight-breakdown').getByText(`1 × ${sizeName} 1.2 kg + packaging 0.2 kg = 1.4 kg → 2 kg for Jeebly`).waitFor();
      assert.equal(await dispatch.getByLabel('Weight (kg)').inputValue(), '1.4');
      assert.deepEqual(await overflow(page), [], 'dispatch dialog: no sideways scroll');
      await dispatch.getByTestId('booking-mode').scrollIntoViewIfNeeded();
      await shot(page, `dispatch-test-mode-weight-${width}`);
      await dispatch.getByRole('button', { name: /Make a TEST booking \(not sent to Jeebly\)/ }).click();
      const testLabel = page.getByRole('dialog', { name: /Test label/ });
      await testLabel.waitFor();
      assert.ok(dialogs.some((m) => /TEST booking made \(JB\d+\)\. It was NOT sent to Jeebly/.test(m)), 'told it was a test');
      await testLabel.getByText('TEST BOOKING – NOT A REAL SHIPMENT – DO NOT SEND', { exact: true }).waitFor();
      await testLabel.getByRole('link', { name: "Print Jeebly's sandbox label (PDF, TEST)" }).waitFor();
      assert.equal(await testLabel.locator('svg[data-barcode^="JB"]').count(), 1, 'a real Code 128 of the AWB');
      assert.deepEqual(await overflow(page), [], 'test label: no sideways scroll');
      await shot(page, `label-test-booking-${width}`);
      await page.keyboard.press('Escape');
      await testLabel.waitFor({ state: 'detached' });

      // 3. Live mode: the dialog says so; Jeebly's own label is the main action.
      await goLive(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openAdminSection(page, /^Orders/);
      await card(b.id, 'Book courier').getByRole('button', { name: 'Book courier' }).click();
      await dispatch.getByTestId('booking-mode').getByText('Jeebly: Live mode').waitFor();
      await dispatch.getByRole('button', { name: /Book with Jeebly \(real shipment\)/ }).waitFor();
      await dispatch.getByTestId('booking-mode').scrollIntoViewIfNeeded();
      await shot(page, `dispatch-live-mode-${width}`);
      await dispatch.getByRole('button', { name: /Book with Jeebly \(real shipment\)/ }).click();
      const realLabel = page.getByRole('dialog', { name: 'Shipping label' });
      await realLabel.waitFor();
      const pdf = realLabel.getByRole('link', { name: 'Print Jeebly label (PDF)' });
      assert.equal(await pdf.getAttribute('href'), `/api/admin/orders/${b.id}/carrier-label`);
      await realLabel.getByRole('button', { name: 'Print packing slip (4 × 6 in)' }).waitFor();
      assert.equal(await realLabel.getByText(/TEST BOOKING/).count(), 0);
      assert.deepEqual(await overflow(page), [], 'real label: no sideways scroll');
      await shot(page, `label-real-booking-${width}`);
      await page.keyboard.press('Escape');
      await realLabel.waitFor({ state: 'detached' });
      await card(b.id, 'Refresh tracking').getByRole('button', { name: 'Refresh tracking' }).click();
      await page.getByTestId('carrier-tracking').getByText('Jeebly: Pickup Scheduled').waitFor();

      // 4. Enter tracking number (keyboard only) on the dispatched order.
      await card(c.id, 'Enter tracking number').getByRole('button', { name: 'Enter tracking number' }).click();
      const enter = page.getByRole('dialog', { name: 'Enter tracking number' });
      await enter.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT', 'focus starts in the dialog');
      await page.keyboard.press('Tab');
      await page.keyboard.type(`JB-${width}0099`);
      assert.deepEqual(await overflow(page), [], 'Enter tracking number: no sideways scroll');
      await shot(page, `enter-tracking-number-${width}`);
      await page.keyboard.press('Enter');
      await enter.waitFor({ state: 'detached' });

      // 5. The customer's Track Order: the AWB with Copy and Jeebly's own events.
      const shop = await ctx.newPage();
      await shop.goto(server.base, { waitUntil: 'domcontentloaded' });
      await shop.locator('main h3').first().waitFor();
      await (width < 768 ? shop.getByRole('navigation', { name: 'Shop' }).getByRole('button', { name: /Orders/ }) : shop.getByRole('button', { name: /Track Order/ })).click();
      const track = shop.getByRole('dialog', { name: 'Track your order' });
      await track.getByLabel('Order number').fill(b.id);
      await track.getByLabel('Mobile number on the order').fill(b.phone);
      await track.getByRole('button', { name: 'Track', exact: true }).click();
      await track.getByTestId('tracking-status').getByText('Pickup Scheduled').waitFor();
      await track.getByTestId('tracking-events').getByText('Pickup Scheduled · DXB').waitFor();
      await track.getByRole('button', { name: 'Copy tracking number' }).waitFor();
      assert.deepEqual(await overflow(shop), [], 'Track Order: no sideways scroll');
      await shot(shop, `track-order-jeebly-events-${width}`);
      // The test-booked order: nothing for the customer; the dispatched one without a number: said so.
      await track.getByLabel('Order number').fill(a.id);
      await track.getByLabel('Mobile number on the order').fill(a.phone);
      await track.getByRole('button', { name: 'Track', exact: true }).click();
      await track.getByText('The tracking number will appear here once your order is with the courier.').waitFor();
      assert.equal(await track.getByTestId('tracking-awb').count(), 0, 'a test booking never reaches the customer');

      // 6. A size's weight in the product editor (next to its measurements).
      await openAdminSection(page, /^Inventory/);
      await page.getByRole('heading', { name: 'Inventory' }).waitFor();
      await page.getByRole('searchbox', { name: 'Search name or SKU' }).fill(product.title.slice(0, 20));
      await page.getByRole('button', { name: `Stock and actions for ${product.title}` }).click();
      await page.getByRole('button', { name: `Edit ${product.title}` }).click();
      const editor = page.getByRole('dialog', { name: `Edit ${product.title}` });
      await editor.getByRole('button', { name: /^Next: Details/ }).click();
      await editor.getByRole('button', { name: /^Next: Sizes/ }).click();
      await editor.getByRole('button', { name: 'Measurements & price' }).first().click();
      const weight = editor.getByLabel('Weight (g)').first();
      assert.equal(await weight.inputValue(), '1200');
      await editor.getByText(/Packed weight of one set, for the courier/).first().waitFor();
      await weight.scrollIntoViewIfNeeded();
      assert.deepEqual(await overflow(page), [], 'editor: no sideways scroll');
      await shot(page, `product-size-weight-${width}`);
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally {
      await browser.close();
      await goLive(false);
    }
  });
}
