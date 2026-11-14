/**
 * Review fixes for the Admin Hub's orders, customers, chats and data loading (findings 1, 5, 6, 7),
 * against the real build and in a real browser at 375 and 1280 px, with more orders than the hub
 * loads at once (262: the two oldest still open):
 *  1. the hub has every open order; the header's sales, the badge and the to-dos come from the
 *     server's count of every order; an old order is found by number, name or phone; Delivered and
 *     Cancelled filters with paging;
 *  5. the order actions, filter chips and chat buttons are 44 px tall on a phone and compact on a
 *     laptop; the list draws 30 cards at a time; a failed Close in chats says so;
 *  6. nothing is re-downloaded on a timer while the live stream is open (a slow poll only while it is
 *     down), and a live event reloads only what changed;
 *  7. Customers: a page at a time; a customer opens with the keyboard into a dialog that is in view
 *     on a phone, with every order of theirs from the server and a card called a card; the shop's
 *     own name in the WhatsApp greetings.
 * The new routes are the owner's, with checked input. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';
import { openAdminSection } from './helpers.mjs';
import { ownerPassword, wrongLogin } from './fixtures/fake.mjs';
const OWNER_PASSWORD = ownerPassword();

type PW = typeof import('playwright');
const pw: PW | null = hasBuild ? await import('playwright').catch(() => null) : null;
const skip = !hasBuild;
const skipBrowser = !pw;
type Page = import('playwright').Page;
const EMAIL = 'admin@beautifuluaehome.com';
const SHOP = 'Layla Linen House';

let server: RunningServer;
let browser: import('playwright').Browser;
let cookie = '';

const api = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.base}${p}`, { method, headers: { 'content-type': 'application/json', origin: server.base, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = async (p: string) => {
  const res = await api('GET', p);
  return { status: res.status, data: await res.json() };
};
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

const REGULAR = '+971501234567'; // 35 orders (one by card), most older than the hub's list
const SEEDED = 262;
const idOf = (i: number) => `BUH-260101-S${String(i).padStart(5, '0')}`;

/** Orders written straight into the shop's database: i hours after 1 Jan 2026. 0 and 1 are still open. */
function seedOrders() {
  const db = new Database(path.join(server.dataDir, 'shop.db'));
  const ins = db.prepare('INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, idempotency_key, data) VALUES (?,?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 0; i < SEEDED; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString();
      const status = i === 0 ? 'pending_confirmation' : i === 1 ? 'confirmed' : i % 10 === 0 ? 'cancelled' : 'delivered';
      const regular = i >= 2 && i % 7 === 3 && i < 2 + 7 * 35;
      const phone = regular ? REGULAR : `+9715${String(20_000_000 + i).padStart(8, '0')}`;
      const method = i === 3 ? 'online_card' : 'cod';
      const o = {
        id: idOf(i),
        createdAt: at,
        status,
        paymentMethod: method,
        paymentStatus: 'cod_pending',
        total: 100,
        subtotal: 100,
        deliveryFee: 0,
        codFee: 0,
        discount: 0,
        items: [{ productId: '', title: 'Indigo sheet set', profileName: 'King', quantity: 1, unitPrice: 100, totalPrice: 100 }],
        customer: { fullName: regular ? 'Reem Al Suwaidi' : i === 0 ? 'Mariam Oldopen' : `Customer ${i}`, phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: `Tower ${i}`, flatVillaNo: '9' },
        courier: { provider: 'jeebly', awbNumber: '', pieces: 1, weightKg: 1 },
      };
      ins.run(o.id, at, at, phone, status, method, o.paymentStatus, 10_000, `seed-${i}`, JSON.stringify(o));
    }
    // Paid by card (so it counts as a sale, like the others).
    db.prepare("UPDATE orders SET card_state = 'paid', paid_fils = 10000, paid_at = created_at, card_livemode = 1, payment_ref = 'pi_seed_3' WHERE id = ?").run(idOf(3));
    // The live counter, as the shop does on every order change.
    db.prepare("INSERT INTO kv (key, data, updated_at) VALUES ('v:orders', '1', ?) ON CONFLICT(key) DO UPDATE SET data = CAST(CAST(data AS INTEGER) + 1 AS TEXT)").run(new Date().toISOString());
  })();
  db.close();
}
const CANCELLED = Array.from({ length: SEEDED }, (_, i) => i).filter((i) => i >= 2 && i % 10 === 0).length;
const SALES_FILS = (SEEDED - CANCELLED) * 10_000;
/** As the hub writes an amount (src/lib/money.ts formatAed): "490" or "299.97". */
const money = (fils: number) => (fils % 100 === 0 ? String(fils / 100) : (fils / 100).toFixed(2));

before(async () => {
  if (skip) return;
  server = await startServer();
  const h = { 'content-type': 'application/json', origin: server.base };
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify(wrongLogin()) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h, body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h, cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: OWNER_PASSWORD }) });
  cookie = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  assert.equal((await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998877' } })).status, 200);
  // The shop's own name (Settings → Branding): the WhatsApp greetings use it.
  const brand = (await (await rawFetch(`${server.base}/api/settings/public`)).json()).brand;
  const saved = await api('PUT', '/api/admin/settings/brand', { settings: { ...brand, storeName: SHOP } });
  assert.equal(saved.status, 200, await saved.clone().text());
  seedOrders();
  // A chat with a phone number, waiting for a person.
  const chat = await rawFetch(`${server.base}/api/chat`, { method: 'POST', headers: h, body: JSON.stringify({ message: 'I want to talk to a person', name: 'Hessa', contact: '+971501119999' }) });
  assert.equal(chat.status, 200, await chat.clone().text());
  if (pw) browser = await pw.chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.stop();
});

async function placeOrder(): Promise<{ id: string; total: number }> {
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const res = await rawFetch(`${server.base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.base },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      customer: { fullName: 'Rohini R Nair', phone: `+97150885${String(Math.floor(Math.random() * 9000) + 1000)}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
      items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, text);
  return JSON.parse(text).order;
}

test('the routes: every open order and the totals; search, customers and a customer’s orders, the owner’s only, with checked input', { skip }, async () => {
  const hub = await get('/api/admin/orders');
  assert.equal(hub.status, 200);
  const ids = new Set((hub.data.orders as Array<{ id: string }>).map((o) => o.id));
  assert.ok(ids.has(idOf(0)) && ids.has(idOf(1)), 'the two oldest orders are open: both are there');
  assert.equal(hub.data.orders.length, 202, 'every open order and the newest 200 finished');
  assert.ok(hub.data.older);
  assert.equal(hub.data.totals.orders, SEEDED);
  assert.equal(hub.data.totals.toConfirm, 1);
  assert.equal(hub.data.totals.toDispatch, 1);
  assert.equal(hub.data.totals.salesFils, SALES_FILS);
  // As before, for anything that asks for a status or a number of orders.
  assert.equal((await get('/api/admin/orders?status=confirmed')).data.orders.length, 1);
  assert.equal((await get('/api/admin/orders?limit=5')).data.orders.length, 5);

  const found = await get(`/api/admin/orders/search?q=${encodeURIComponent('s00004')}`);
  assert.deepEqual(found.data.orders.map((o: { id: string }) => o.id), [idOf(4)]);
  const older = await get(`/api/admin/orders/search?status=finished&limit=30&before=${encodeURIComponent(hub.data.older)}`);
  assert.equal(older.data.orders.length, 30);
  assert.ok(older.data.orders.every((o: { id: string }) => !ids.has(o.id)));
  for (const bad of ['?q=a', '?status=nope', '?kind=bulk', '?before=x', '?limit=abc', '?sort=id', `?q=${'x'.repeat(61)}`]) {
    assert.equal((await get(`/api/admin/orders/search${bad}`)).status, 400, bad);
  }

  const customers = await get('/api/admin/customers');
  assert.equal(customers.data.customers.length, 60, 'a page, not everyone');
  assert.equal(customers.data.next, 60);
  assert.equal(customers.data.total, hub.data.totals.customers);
  const reem = (await get('/api/admin/customers?q=reem')).data.customers;
  assert.equal(reem.length, 1);
  assert.equal(reem[0].phone, REGULAR);
  const hers = await get(`/api/admin/customers/orders?phone=${encodeURIComponent(REGULAR)}`);
  assert.equal(hers.data.orders.length, 30);
  const rest = await get(`/api/admin/customers/orders?phone=${encodeURIComponent(REGULAR)}&before=${encodeURIComponent(hers.data.next)}`);
  assert.equal(rest.data.orders.length, 5);
  assert.equal(rest.data.next, null);
  for (const bad of ['/api/admin/customers?offset=-1', '/api/admin/customers?limit=x', '/api/admin/customers?page=2', '/api/admin/customers/orders', '/api/admin/customers/orders?phone=abc', `/api/admin/customers/orders?phone=${encodeURIComponent(REGULAR)}&before=x`, `/api/admin/customers/orders?phone=${encodeURIComponent(REGULAR)}&all=1`]) {
    assert.equal((await get(bad)).status, 400, bad);
  }

  // The owner's only: no session, no answer (the door alone is not enough); without the door, not even that.
  for (const p of ['/api/admin/orders/search?q=s00004', '/api/admin/customers', `/api/admin/customers/orders?phone=${encodeURIComponent(REGULAR)}`]) {
    assert.equal((await fetch(`${server.base}${p}`)).status, 401, p);
    assert.equal((await rawFetch(`${server.base}${p}`)).status, 404, p);
  }
});

async function openHub(width: number): Promise<{ page: Page; errors: string[]; calls: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 800 });
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, url: server.base }]);
  const page = await context.newPage();
  const errors: string[] = [];
  const calls: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) calls.push(u.pathname);
  });
  return { page, errors, calls, close: () => context.close() };
}
const heights = (loc: import('playwright').Locator) => loc.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().height)));

test('at 375 and 1280 px: totals from every order, search and paging in Orders, 44 px actions on a phone, compact on a laptop', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const { page, errors, close } = await openHub(width);
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    // The header's sales: every order, not the 202 the hub holds.
    await page.waitForFunction((want) => document.querySelector('[data-testid="hub-sales"]')?.textContent?.replace(/[^\d.]/g, '') === want, money(SALES_FILS));
    if (width >= 1280) {
      await openAdminSection(page, /^Overview/);
      assert.match((await page.getByTestId('money-highlights').textContent()) ?? '', /Today/);
    }
    await openAdminSection(page, /^Orders/);
    if (width < 800) {
      // The phone's to-dos: the old order to confirm and the one to dispatch are counted.
      assert.match((await page.getByTestId('todo-confirm').textContent()) ?? '', /^1\s*order to confirm/);
      assert.match((await page.getByTestId('todo-dispatch').textContent()) ?? '', /^1\s*to dispatch/);
    }
    // All Orders: 30 cards at a time, never hundreds.
    const cards = page.getByTestId('order-card');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 30);
    assert.match((await page.getByTestId('order-filter-all').textContent()) ?? '', new RegExp(`${SEEDED}$`));
    assert.match((await page.getByTestId('orders-shown').textContent()) ?? '', new RegExp(`Showing 30\\s*of ${SEEDED}`));
    await page.getByTestId('orders-more').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="order-card"]').length === 60);

    // The chips' numbers are the server's; "Needs Confirmation" shows the old open order.
    assert.match((await page.getByTestId('order-filter-pending').textContent()) ?? '', /1$/);
    await page.getByTestId('order-filter-pending').click();
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.first().getAttribute('data-order-id'), idOf(0));

    // Tap targets: 44 px on a phone; compact (as the owner asked) on a laptop.
    const actions = cards.first().getByTestId('order-actions').locator(':scope button, :scope a');
    const actionHeights = await heights(actions);
    assert.ok(actionHeights.length >= 4, 'the order has its actions');
    const chipHeights = await heights(page.locator('[data-testid^="order-filter-"]'));
    if (width < 800) {
      assert.ok(actionHeights.every((h) => h >= 44), `order actions 44 px tall on a phone: ${actionHeights}`);
      assert.ok(chipHeights.every((h) => h >= 44), `filter chips 44 px tall on a phone: ${chipHeights}`);
      assert.ok(((await page.getByTestId('order-search').boundingBox())?.height ?? 0) >= 44);
    } else {
      assert.ok(actionHeights.every((h) => h <= 32), `order actions stay compact on a laptop: ${actionHeights}`);
      // One line (two at most): rows counted by where each action's middle is (an icon makes a button a little taller).
      const middles = await cards.first().getByTestId('order-actions').locator(':scope button, :scope a').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => Math.round((r.top + r.bottom) / 2)));
      const rows = middles.sort((a, b) => a - b).filter((m, i, all) => i === 0 || m - all[i - 1] > 12).length;
      assert.ok(rows <= 2, `actions in one line (two at most), got ${rows} rows`);
    }

    // Search: an old finished order (not in the hub's list) by number, by name and by phone; an open one too.
    await page.getByTestId('order-filter-all').click();
    const search = page.getByTestId('order-search');
    for (const [typed, want] of [[idOf(4).slice(-6), idOf(4)], ['customer 12', idOf(12)], ['052 000 0014', idOf(14)], ['oldopen', idOf(0)]] as Array<[string, string]>) {
      await search.fill(typed);
      await page.waitForFunction((id) => Boolean(document.querySelector(`[data-testid="order-card"][data-order-id="${id}"]`)), want);
    }
    // The regular's 35 orders: found over more than one page.
    await search.fill('+971501234567');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="order-card"]').length === 30);
    await page.getByTestId('orders-more').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="order-card"]').length === 35);
    assert.equal(await page.getByTestId('orders-more').count(), 0, 'nothing more to load');
    await search.fill('nobody-by-this-name');
    await page.getByTestId('orders-empty').filter({ hasText: /No order matches/ }).waitFor();
    await search.fill('');

    // Cancelled: every cancelled order, a page at a time, the older ones from the server.
    await page.getByTestId('order-filter-cancelled').click();
    assert.match((await page.getByTestId('order-filter-cancelled').textContent()) ?? '', new RegExp(`${CANCELLED}$`));
    await cards.first().waitFor();
    const shown = new Set<string>();
    for (let i = 0; i < 6 && (await page.getByTestId('orders-more').count()); i++) {
      const before = await cards.count();
      await page.getByTestId('orders-more').click();
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="order-card"]').length > n || !document.querySelector('[data-testid="orders-more"]'), before);
    }
    for (const id of await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-order-id') ?? ''))) shown.add(id);
    assert.equal(shown.size, CANCELLED, 'every cancelled order was reached');
    await page.getByTestId('order-filter-delivered').click();
    await cards.first().waitFor();
    assert.equal(await cards.count(), 30);
    assert.ok((await cards.evaluateAll((els) => els.map((e) => e.textContent ?? ''))).every((t) => /delivered/i.test(t)));
    assert.equal(await overflow(page), false, `orders at ${width}: no sideways scroll`);

    // Card payments: the only card order is an old finished one (not in the hub's own list): it is fetched.
    await page.getByTestId('order-filter-card').click();
    await page.waitForFunction((id) => Boolean(document.querySelector(`[data-testid="order-card"][data-order-id="${id}"]`)), idOf(3));
    assert.equal(await cards.count(), 1);

    // The Photo orders tab and the latest deal links still work (none here: the form is there).
    await page.getByTestId('order-filter-photo').click();
    assert.equal(await page.getByTestId('order-filter-photo').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(errors, []);
    await close();
  }
});

test('at 375 and 1280 px: Customers a page at a time; a customer opens with the keyboard into a dialog in view, with every order and real payment names', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const { page, errors, calls, close } = await openHub(width);
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(page, /^Customers/);
    const cards = page.getByTestId('customer-card');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 60, 'a page of customers, not all of them');
    await page.getByTestId('customers-more').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="customer-card"]').length === 120);

    await page.getByTestId('customer-search').fill('reem');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="customer-card"]').length === 1);
    const card = cards.first();
    assert.match((await card.textContent()) ?? '', /Reem Al Suwaidi/);
    // 35 orders, four of them cancelled (not counted), AED 100 each.
    assert.match((await card.textContent()) ?? '', /31 orders/);
    assert.match((await card.textContent()) ?? '', /AED 3100/);
    // The WhatsApp greeting carries the shop's own name, and nothing about what it sells.
    const href = decodeURIComponent((await card.getByTestId('customer-whatsapp').getAttribute('href')) ?? '');
    assert.match(href, new RegExp(`^https://wa\\.me/971501234567\\?text=Hello Reem Al Suwaidi, greetings from ${SHOP}!`));
    assert.doesNotMatch(href, /Beautiful UAE Home|hand-block/);
    assert.ok(((await card.getByTestId('customer-whatsapp').boundingBox())?.height ?? 0) >= 44);

    // Keyboard: the card is a button; Enter opens the history in a dialog, in view, with focus inside.
    const open = card.getByTestId('customer-open');
    assert.equal(await open.evaluate((e) => e.tagName), 'BUTTON');
    await open.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Orders of Reem Al Suwaidi' });
    await dialog.waitFor();
    // (It slides in: measured once it has arrived, with her orders in it.)
    await dialog.getByTestId('customer-order').first().waitFor();
    await dialog.evaluate((d) => Promise.all(d.getAnimations().map((a) => a.finished)).then(() => undefined));
    const box = (await dialog.boundingBox())!;
    assert.ok(box.y >= 0 && box.y + box.height <= 900 + 1 && box.x >= 0 && box.x + box.width <= width + 1, `the history is on screen at ${width}: ${JSON.stringify(box)}`);
    assert.equal(await dialog.evaluate((d) => d.contains(document.activeElement)), true, 'focus moved into the dialog');
    const rows = dialog.getByTestId('customer-order');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 30);
    await dialog.getByTestId('customer-orders-more').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="customer-order"]').length === 35);
    assert.equal(await dialog.getByTestId('customer-orders-more').count(), 0);
    assert.ok(calls.includes('/api/admin/customers/orders'), 'her orders came from the server');
    // The oldest is the card order: "Card", never "Bank Transfer".
    const last = rows.last();
    assert.match((await last.textContent()) ?? '', new RegExp(idOf(3)));
    assert.equal(await last.getByTestId('customer-order-payment').textContent(), 'Card');
    assert.equal(await rows.first().getByTestId('customer-order-payment').textContent(), 'Cash on Delivery');
    assert.equal(await dialog.getByText('Bank Transfer').count(), 0);
    assert.equal(await overflow(page), false, `customer history at ${width}: no sideways scroll`);
    // Tab stays inside; Escape closes and focus goes back to the customer.
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate((d) => d.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await open.evaluate((e) => e === document.activeElement), true, 'focus is back on the customer');
    assert.equal(await overflow(page), false, `customers at ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await close();
  }
});

test('at 375 and 1280 px: chat buttons are 44 px tall on a phone, a failed Close says so, the greeting uses the shop’s name', { skip: skip || skipBrowser }, async () => {
  for (const width of [375, 1280]) {
    const { page, errors, close } = await openHub(width);
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await openAdminSection(page, /^Chats/);
    const filters = page.getByRole('button', { name: /^(Open|All)$/ });
    await filters.first().waitFor();
    await page.getByRole('button', { name: /Hessa/ }).click();
    const closeChat = page.getByRole('button', { name: 'Close', exact: true });
    await closeChat.waitFor();
    const wa = page.getByRole('link', { name: 'WhatsApp' });
    assert.match(decodeURIComponent((await wa.getAttribute('href')) ?? ''), new RegExp(`this is ${SHOP} replying to your chat`));
    if (width < 800) {
      for (const [what, loc] of [['Close', closeChat], ['WhatsApp', wa], ['Back to assistant', page.getByRole('button', { name: /Back to assistant/ })], ['Back', page.getByRole('button', { name: 'Back to the list' })], ['Send', page.getByRole('button', { name: /Send/ })]] as Array<[string, import('playwright').Locator]>) {
        const box = await loc.boundingBox();
        assert.ok(box && box.height >= 44, `${what}: 44 px tall on a phone, got ${box?.height}`);
      }
    }
    // The server can't be reached for the Close: the owner is told, and the chat stays open.
    await page.route('**/api/admin/chats/*', (route) => (route.request().method() === 'PATCH' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Something went wrong. Please try again.' }) }) : route.continue()));
    await closeChat.click();
    const problem = page.getByTestId('chat-error');
    await problem.waitFor();
    assert.match((await problem.textContent()) ?? '', /Something went wrong\. Please try again\./);
    assert.equal(await closeChat.count(), 1, 'still open');
    await page.unroute('**/api/admin/chats/*');
    if (width < 800) {
      await page.getByRole('button', { name: 'Back to the list' }).click();
      assert.ok((await heights(page.getByRole('button', { name: /^(Open|All)$/ }))).every((h) => h >= 44));
    }
    assert.equal(await overflow(page), false, `chats at ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await close();
  }
});

test('nothing is re-downloaded on a timer while the live stream is open; a live event reloads only what changed; a slow poll only while the stream is down', { skip: skip || skipBrowser }, async () => {
  const data = (calls: string[]) => ({
    orders: calls.filter((c) => c === '/api/admin/orders').length,
    products: calls.filter((c) => c === '/api/admin/products').length,
    settings: calls.filter((c) => c === '/api/admin/settings').length,
    customers: calls.filter((c) => c.startsWith('/api/admin/customers')).length,
  });
  {
    const { page, errors, calls, close } = await openHub(1280);
    await page.clock.install();
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('hub-overview').waitFor();
    await page.waitForFunction((want) => document.querySelector('[data-testid="hub-sales"]')?.textContent?.replace(/[^\d.]/g, '') === want, money(SALES_FILS));
    await page.waitForTimeout(1500); // the stream is open by now
    const start = data(calls);
    assert.deepEqual(start, { orders: 1, products: 1, settings: 1, customers: 0 }, 'one load of each; customers only when their tab is open');
    // Five minutes pass: with the stream open, nothing is asked again.
    await page.clock.fastForward(5 * 60_000);
    await page.waitForTimeout(500);
    assert.deepEqual(data(calls), start, 'no reload on a timer');

    // A new order: the orders are loaded again (and the stock it took), not the settings.
    const o = await placeOrder();
    await page.waitForFunction((want) => document.querySelector('[data-testid="hub-sales"]')?.textContent?.replace(/[^\d.]/g, '') === want, money(SALES_FILS + Math.round(o.total * 100)), { timeout: 20_000 });
    await page.waitForTimeout(800);
    const afterOrder = data(calls);
    assert.equal(afterOrder.orders, start.orders + 1, 'the orders, once');
    assert.equal(afterOrder.settings, start.settings, 'not the settings');
    assert.equal(afterOrder.customers, 0, 'not the customers');
    assert.ok(afterOrder.products <= start.products + 1);

    // A setting changed elsewhere: the settings are loaded again, not the orders.
    assert.equal((await api('PUT', '/api/admin/settings/store', { settings: { whatsappNumber: '+971509998866' } })).status, 200);
    for (let i = 0; i < 100 && data(calls).settings === afterOrder.settings; i++) await page.waitForTimeout(100);
    await page.waitForTimeout(800);
    const afterSetting = data(calls);
    assert.equal(afterSetting.settings, afterOrder.settings + 1, 'the settings, once');
    assert.equal(afterSetting.orders, afterOrder.orders, 'not the orders');
    assert.equal(afterSetting.products, afterOrder.products, 'not the products');
    assert.deepEqual(errors, []);
    await close();
  }
  {
    // The stream can't be opened (a proxy that blocks it, a browser without it): the hub asks again, slowly.
    const { page, calls, close } = await openHub(1280);
    await page.route('**/api/admin/events', (route) => route.abort());
    await page.clock.install();
    await page.goto(server.adminUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('hub-overview').waitFor();
    await page.waitForFunction(() => /\d{4}/.test(document.querySelector('[data-testid="hub-sales"]')?.textContent ?? ''));
    await page.waitForTimeout(1000);
    const start = data(calls);
    await page.clock.fastForward(30_000);
    await page.waitForTimeout(500);
    assert.equal(data(calls).orders, start.orders, 'not faster than once a minute');
    await page.clock.fastForward(35_000);
    for (let i = 0; i < 50 && data(calls).orders === start.orders; i++) await page.waitForTimeout(100);
    assert.equal(data(calls).orders, start.orders + 1, 'the fallback poll, while the stream is down');
    assert.equal(data(calls).customers, 0);
    await close();
  }
});
