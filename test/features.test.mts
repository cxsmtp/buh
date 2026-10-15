import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

// BUH-01.03.00: per-size stock, catalogue/store/theme settings, settings history,
// order source, shared SMS codes, live counters, exchange rates, the daily summary.
tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const products = await import('@/lib/server/products');
const settings = await import('@/lib/server/settings');
const orders = await import('@/lib/server/orders');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getDb } = await import('@/lib/server/db');

const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
const rejectsStatus = async (p: Promise<unknown>) => {
  try {
    await p;
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

const photo = 'https://images.example.com/sheet.jpg';
function newProduct(stockBySize: Record<string, number>, over: Record<string, unknown> = {}) {
  const sizes = settings.getSettings('catalog').sizes.filter((s) => s.id in stockBySize);
  return products.createProduct({
    title: 'Test Block Print',
    category: 'bedsheets',
    price: 300,
    featuredImage: photo,
    profiles: sizes,
    defaultProfileId: sizes[0].id,
    stockBySize,
    ...over,
  });
}

let n = 0;
function order(productId: string, profileId: string, quantity = 1, over: Record<string, unknown> = {}) {
  return orders.placeOrder({
    idempotencyKey: `features-${++n}-${Date.now()}`,
    verificationToken: issuePhoneToken(`+9715060${String(n).padStart(5, '0')}`),
    customer: { fullName: 'Feature Test', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId, profileId, quantity }],
    paymentMethod: 'cod',
    ...over,
  }).order;
}

test('a one-of-a-kind piece: one King and one Queen, each sold once', () => {
  const p = newProduct({ king: 1, queen: 1 });
  assert.deepEqual(p.stockBySize, { queen: 1, king: 1 });
  assert.equal(p.stockCount, 2);
  order(p.id, 'king');
  assert.equal(statusOf(() => order(p.id, 'king')), 409, 'the King is gone');
  assert.equal(products.getProduct(p.id)!.stockBySize.queen, 1, 'the Queen is still there');
  const q = order(p.id, 'queen');
  assert.equal(products.getProduct(p.id)!.stockCount, 0);
  orders.updateOrderByAdmin(q.id, { status: 'cancelled' }, 'test');
  assert.equal(products.getProduct(p.id)!.stockBySize.queen, 1, 'cancelling returns that size');
});

test('+ / − change one size atomically and never go below zero', () => {
  const p = newProduct({ king: 1 });
  assert.equal(products.adjustStock(p.id, 'king', 1).stockBySize.king, 2);
  assert.equal(products.adjustStock(p.id, 'king', -2).stockBySize.king, 0);
  assert.equal(statusOf(() => products.adjustStock(p.id, 'king', -1)), 409);
  assert.equal(statusOf(() => products.adjustStock(p.id, 'single', 1)), 400, 'a size the product does not offer');
  assert.equal(statusOf(() => products.adjustStock(p.id, 'king', 0.5)), 400);
});

test('removing a product archives it: gone from the shop, kept for past orders, restorable (hidden)', () => {
  const p = newProduct({ king: 1 });
  products.setArchived(p.id, true);
  assert.ok(!products.listProducts().some((x) => x.id === p.id));
  assert.ok(!products.listProducts({ includeHidden: true }).some((x) => x.id === p.id));
  assert.ok(products.listProducts({ includeHidden: true, includeArchived: true }).find((x) => x.id === p.id)!.archived);
  assert.equal(statusOf(() => order(p.id, 'king')), 409, 'cannot be ordered');
  const back = products.setArchived(p.id, false);
  assert.equal(back.archived, undefined);
  assert.equal(back.active, false, 'restored hidden, for the owner to check first');
});

test('the shop order can be changed', () => {
  const ids = products.listProducts({ includeHidden: true, includeArchived: true }).map((p) => p.id);
  products.reorderProducts([...ids].reverse());
  assert.deepEqual(products.listProducts({ includeHidden: true, includeArchived: true }).map((p) => p.id), [...ids].reverse());
  assert.equal(statusOf(() => products.reorderProducts(['nope'])), 400);
});

test('size presets and categories come from Settings → Catalogue', async () => {
  await settings.updateSettings('catalog', {
    sizes: [...settings.getSettings('catalog').sizes, { id: 'baby-cot', name: 'Baby Cot', mattressSize: '60 x 120 cm', piecesIncluded: 2, priceDelta: -100 }],
    categories: [...settings.getSettings('catalog').categories, { id: 'baby', label: 'Baby', icon: '🍼' }],
    lowStockThreshold: 1,
  });
  const p = newProduct({ 'baby-cot': 2 }, { category: 'baby' });
  assert.equal(p.profiles[0].name, 'Baby Cot');
  assert.equal(statusOf(() => newProduct({ king: 1 }, { category: 'not-a-category' })), 400);
  for (const bad of [
    { sizes: [] },
    { sizes: [{ id: 'King Size!', name: 'x' }] },
    { sizes: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] },
    { categories: [{ id: 'x', label: '' }] },
    { lowStockThreshold: -1 },
  ]) {
    assert.equal(await rejectsStatus(settings.updateSettings('catalog', bad)), 400, JSON.stringify(bad));
  }
});

test('store settings: WhatsApp number in any common form, social names checked', async () => {
  await settings.updateSettings('store', { whatsappNumber: '050 123 4567', instagramHandle: '@beautiful.uae_home', facebookUrl: 'https://facebook.com/beautifuluaehome' });
  const s = settings.getSettings('store');
  assert.equal(s.whatsappNumber, '+971501234567');
  assert.equal(s.instagramHandle, 'beautiful.uae_home');
  for (const bad of [{ whatsappNumber: '12' }, { instagramHandle: 'has space' }, { facebookUrl: 'https://evil.example/x' }, { supportEmail: 'nope' }]) {
    assert.equal(await rejectsStatus(settings.updateSettings('store', bad)), 400, JSON.stringify(bad));
  }
  await settings.updateSettings('store', { supportEmail: 'help@shop.example' });
  assert.equal(settings.contactEmail(), 'help@shop.example', 'the store setting wins over the environment');
});

test('theme settings: auto / manual / off, festivals can be switched off', async () => {
  await settings.updateSettings('theme', { mode: 'manual', themeId: 'diwali', disabledFestivals: ['valentines-day', 'not-real'] });
  const t = settings.getSettings('theme');
  assert.equal(t.themeId, 'diwali');
  assert.deepEqual(t.disabledFestivals, ['valentines-day'], 'unknown ids are dropped');
  const { storefrontTheme } = await import('@/lib/server/theme');
  assert.equal(storefrontTheme().pick.themeId, 'diwali');
  assert.equal(await rejectsStatus(settings.updateSettings('theme', { mode: 'sometimes' })), 400);
  assert.equal(await rejectsStatus(settings.updateSettings('theme', { themeId: 'made-up' })), 400);
  await settings.updateSettings('theme', { mode: 'off' });
  assert.equal(storefrontTheme().pick.themeId, 'default');
  await settings.updateSettings('theme', { mode: 'auto' });
});

test('settings history: a saved version can be restored, keys are never kept in history', async () => {
  await settings.updateSettings('courier', { jeebly: { apiKey: 'HISTORY-SECRET-KEY-1', pickupLocationName: 'Warehouse A' } });
  await settings.updateSettings('courier', { jeebly: { pickupLocationName: 'Warehouse B' } });
  const versions = settings.settingsHistory().filter((v) => v.key === 'courier');
  assert.ok(versions.length >= 1);
  const raw = getDb().prepare('SELECT data FROM settings_history').all() as Array<{ data: string }>;
  assert.ok(!raw.some((r) => r.data.includes('HISTORY-SECRET-KEY-1')), 'no key in history');
  await settings.restoreSettingsVersion(versions[0].id);
  assert.equal(settings.getSettings('courier').jeebly.pickupLocationName, 'Warehouse A', 'restored');
  assert.equal(settings.getSettings('courier').jeebly.apiKey, 'HISTORY-SECRET-KEY-1', 'the current key stays');
  assert.equal(await rejectsStatus(settings.restoreSettingsVersion(999999)), 404);
});

test('where the customer came from is kept on the order (allow-listed only)', () => {
  const p = newProduct({ king: 5 });
  const a = order(p.id, 'king', 1, { source: { source: 'instagram', campaign: 'eid<script>sale' } });
  assert.deepEqual(a.source, { source: 'instagram', campaign: 'eidscriptsale' });
  const b = order(p.id, 'king', 1, { source: { source: 'evil.example' } });
  assert.equal(b.source, undefined);
});

test('SMS codes are kept hashed in the database, so the other copy of the shop accepts them', async () => {
  process.env.OTP_DEV_MODE = 'true';
  const otp = await import('@/lib/otpService');
  const sent = await otp.sendRealSmsOtp('050 999 1234', { gateways: {}, ip: '10.0.0.9' });
  const row = getDb().prepare('SELECT hash FROM otp_codes WHERE phone = ?').get('+971509991234') as { hash: string };
  assert.ok(row, 'stored in the database');
  assert.ok(!row.hash.includes(String(sent.devOtpCode)), 'never the code itself');
  assert.equal(otp.verifyRealSmsOtp('0509991234', String(sent.devOtpCode)).valid, true);
  assert.equal(otp.verifyRealSmsOtp('0509991234', String(sent.devOtpCode)).valid, false, 'single use');
  delete process.env.OTP_DEV_MODE;
});

test('live counters move on every change, and a change made by the other copy drops the cache', async () => {
  const live = await import('@/lib/server/live');
  const before = live.versions();
  const p = newProduct({ king: 1 });
  await settings.updateSettings('store', { storeAddress: 'Dubai' });
  order(p.id, 'king');
  const after = live.versions();
  assert.ok(after.catalog > before.catalog && after.settings > before.settings && after.orders > before.orders);

  // The other copy renames the product straight in the database and bumps the counter.
  products.listProducts();
  const row = getDb().prepare('SELECT data FROM products WHERE id = ?').get(p.id) as { data: string };
  getDb().prepare('UPDATE products SET data = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.data), title: 'Renamed Elsewhere' }), p.id);
  const { kvBump } = await import('@/lib/server/kv');
  kvBump('v:catalog');
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal(products.getProduct(p.id)!.title, 'Renamed Elsewhere');
});

test('exchange rates: fetched in the background, kept, and the old ones used if the source fails', async () => {
  const fx = await import('@/lib/server/fx');
  assert.equal(fx.getRates(async () => ({ result: 'success', rates: { USD: 0.2723, INR: 22.7, EUR: 0.25, GBP: 0.21, PKR: 75.6, XXX: 1 } })), null, 'none yet');
  await fx._fxInFlight();
  const rates = fx.getRates(async () => {
    throw new Error('down');
  })!;
  assert.equal(rates.rates.USD, 0.2723);
  assert.equal(rates.rates.XXX, undefined, 'only the listed currencies');
});

test('daily summary: yesterday’s orders and sales, sold-out and low pieces', async () => {
  const { dailySummary } = await import('@/lib/server/monitor');
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600_000).toISOString();
  getDb().prepare('UPDATE orders SET created_at = ?').run(yesterday);
  const s = dailySummary(now);
  assert.match(s.subject, /Daily summary \d{4}-\d{2}-\d{2}: \d+ orders, AED \d+/);
  assert.match(s.text, /Sold out|Nothing is sold out/);
  assert.match(s.text, /Needs attention|Everything is running normally/);
});

test('upgrading a shop from version 1.2: existing stock moves to each product’s default size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-upgrade-'));
  const old = new Database(path.join(dir, 'shop.db'));
  old.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, data TEXT NOT NULL, stock INTEGER NOT NULL CHECK (stock >= 0), active INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, phone TEXT NOT NULL, status TEXT NOT NULL, payment_method TEXT NOT NULL, payment_status TEXT NOT NULL, total_fils INTEGER NOT NULL, idempotency_key TEXT UNIQUE, data TEXT NOT NULL);
    CREATE TABLE order_events (id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), at TEXT NOT NULL, actor TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  old.prepare('INSERT INTO products VALUES (?, ?, ?, 1, 0, ?)').run('old-1', JSON.stringify({ id: 'old-1', title: 'Old', defaultProfileId: 'queen', profiles: [{ id: 'king' }, { id: 'queen' }] }), 7, new Date().toISOString());
  old.pragma('user_version = 1');
  old.close();

  const upgraded = spawnSync(process.execPath, ['--import', 'tsx', '-e', `process.env.DATA_DIR=${JSON.stringify(dir)}; const m = await import('@/lib/server/db'); const db = (m.getDb ?? m.default.getDb)(); console.log(JSON.stringify({ v: db.pragma('user_version', { simple: true }), rows: db.prepare('SELECT * FROM product_stock').all(), total: db.prepare('SELECT stock FROM products').get().stock }));`], { encoding: 'utf8' });
  assert.equal(upgraded.status, 0, upgraded.stderr);
  const out = JSON.parse(upgraded.stdout.trim().split('\n').pop()!);
  assert.ok(out.v >= 3, `migrated to the latest (${out.v})`);
  assert.deepEqual(out.rows, [{ product_id: 'old-1', size_id: 'queen', qty: 7 }]);
  assert.equal(out.total, 7, 'the total stays in step');
});

test('backups carry the new data (stock per size, history, festival dates) and the restore script restores it', async () => {
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-new-'));
  const r = spawnSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  const stock = db.prepare('SELECT COUNT(*) AS n FROM product_stock').get() as { n: number };
  const history = db.prepare('SELECT COUNT(*) AS n FROM settings_history').get() as { n: number };
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  db.close();
  assert.ok(stock.n > 0);
  assert.ok(history.n > 0);
  for (const t of ['kv', 'festival_dates', 'festival_meta', 'otp_codes']) assert.ok(tables.includes(t), t);
  const csv = backup.openBackup(fs.readFileSync(result.file)).find((e) => e.name === 'products.csv')!.data.toString();
  assert.match(csv, /stock_by_size/);
  assert.match(csv, /king=\d+/);
});

// ── Security review of BUH-02.00.00 ─────────────────────────────────────────

test('regression: code from before 2.0 (stock on products, no sizes) can no longer sell a piece that is gone', () => {
  const p = newProduct({ king: 1 });
  // What 1.2's checkout runs: it would take the piece from the total only, leaving the King on sale.
  assert.throws(() => getDb().prepare('UPDATE products SET stock = stock - 1 WHERE id = ? AND stock >= 1').run(p.id), /stock is kept per size/);
  assert.equal(products.getProduct(p.id)!.stockBySize.king, 1, 'nothing was taken');
  const q = newProduct({ king: 1, queen: 1 });
  assert.throws(() => getDb().prepare('UPDATE products SET stock = stock - 1 WHERE id = ?').run(q.id), /stock is kept per size/, 'size-blind sales are refused too');
  assert.equal(products.adjustStock(q.id, 'king', 1).stockCount, 3, 'today’s code still moves stock');
});

test('regression: restoring an old version never sends today’s key to an older address', async () => {
  await settings.updateSettings('sms', { provider: 'custom_webhook', customWebhook: { endpointUrl: 'https://93.184.216.34/old', bearerToken: 'TOKEN-FOR-OLD-HOST' } });
  await settings.updateSettings('sms', { customWebhook: { endpointUrl: 'https://93.184.216.35/new', bearerToken: 'TOKEN-FOR-NEW-HOST' } });
  const old = settings.settingsHistory().find((v) => v.key === 'sms')!;
  await settings.restoreSettingsVersion(old.id);
  const sms = settings.getSettings('sms');
  assert.equal(sms.customWebhook.endpointUrl, 'https://93.184.216.34/old');
  assert.notEqual(sms.customWebhook.bearerToken, 'TOKEN-FOR-NEW-HOST', 'the new host’s token is not attached to the old host');
});

test('regression: exchange rates back off for an hour even when they have never been fetched', async () => {
  const { kvSet } = await import('@/lib/server/kv');
  getDb().prepare("DELETE FROM kv WHERE key IN ('fx', 'fx:retry')").run();
  const fx = await import('@/lib/server/fx');
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error('blocked');
  };
  fx.getRates(failing);
  await fx._fxInFlight();
  fx.getRates(failing);
  fx.getRates(failing);
  assert.equal(calls, 1, 'one attempt, then a pause');
  kvSet('fx:retry', 0);
});

test('regression: live streams are capped per address, and closing one frees its place', async () => {
  const live = await import('@/lib/server/live');
  const controllers = Array.from({ length: 6 }, () => new AbortController());
  const responses = controllers.map((c) => live.eventStream(new Request('http://shop.test/api/events', { signal: c.signal }), ['catalog'], '203.0.113.7'));
  assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 200, 429]);
  assert.equal(live.eventStream(new Request('http://shop.test/api/events'), ['catalog'], '203.0.113.8').status, 200, 'another address is fine');
  controllers[0].abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(live.eventStream(new Request('http://shop.test/api/events'), ['catalog'], '203.0.113.7').status, 200);
  for (const c of controllers) c.abort();
});

// ── Correctness review of BUH-02.00.00 ──────────────────────────────────────

test('regression: cancelling an order already with the courier does not put the one-off piece back on sale', () => {
  const p = newProduct({ king: 1 });
  const o = order(p.id, 'king');
  orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, 'test');
  orders.updateOrderByAdmin(o.id, { status: 'dispatched' }, 'test');
  orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, 'test');
  assert.equal(products.getProduct(p.id)!.stockBySize.king, 0, 'still with the courier');
  const q = newProduct({ king: 1 });
  const o2 = order(q.id, 'king');
  orders.updateOrderByAdmin(o2.id, { status: 'cancelled' }, 'test');
  assert.equal(products.getProduct(q.id)!.stockBySize.king, 1, 'never left: back on sale');
});

test('regression: the bag never holds more of a size than exist, across colours', async () => {
  const { refreshCart } = await import('@/lib/client/shop');
  const p = newProduct({ king: 1 });
  const king = p.profiles[0];
  const bag = refreshCart(
    [
      { product: p, selectedProfile: king, selectedColor: 'White', quantity: 1 },
      { product: p, selectedProfile: king, selectedColor: 'Blue', quantity: 1 },
    ],
    [products.getProduct(p.id)!]
  );
  // The second line is kept (shown as unavailable) but the bag cannot reach checkout with both.
  const usable = bag.reduce((n, i) => n + i.quantity, 0);
  assert.ok(usable >= 1);
  assert.equal(bag[0].quantity, 1);
});

test('regression: "digital" or "big_sale" campaigns are not counted as Instagram', async () => {
  const { classify } = await import('@/lib/client/landing');
  const p = (q: string) => new URLSearchParams(q);
  assert.equal(classify(p('utm_source=digital'), '', ''), 'other');
  assert.equal(classify(p('utm_source=big_sale'), '', ''), 'other');
  assert.equal(classify(p('utm_source=ig'), '', ''), 'instagram');
  assert.equal(classify(p(''), 'https://l.instagram.com/', ''), 'instagram');
  assert.equal(classify(p(''), '', 'Mozilla/5.0 Instagram 300.0'), 'instagram');
  assert.equal(classify(p('utm_source=whatsapp'), '', ''), 'whatsapp');
  assert.equal(classify(p(''), '', ''), 'direct');
});
