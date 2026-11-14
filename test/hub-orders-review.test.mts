/**
 * Review fixes for the Admin Hub's orders, customers and data loading (findings 1, 6 and 7), on the
 * server side:
 *  1. with more orders than the hub loads, every open order is still in the hub's list, any old order
 *     is found by number, name or phone a page at a time, and the header sales, badges, to-dos and
 *     money highlights are counted over every order;
 *  6. the customers are worked out by the database a page at a time (the same figures as the full
 *     listCustomers), and the totals are only counted again when an order changed;
 *  7. a customer's history is every order of theirs (however old), and a card is called a card.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
process.env.MONITOR_DISABLED = 'true';
const orders = await import('@/lib/server/orders');
const { getDb } = await import('@/lib/server/db');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { hubTotalsOf, moneyHighlights, orderMatchesSearch, orderSearchTerms, paymentName, todosFrom } = await import('@/lib/hubToday');
const { saleFils } = await import('@/lib/orderMoney');

const status = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

/** An order written straight into the table (as the reviewer's proof did), `i` hours after 1 Jan 2026. */
function seed(i: number, st: string, over: { name?: string; phone?: string; total?: number; method?: string; photo?: boolean; updatedAt?: string } = {}) {
  const at = new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString();
  const phone = over.phone ?? `+9715${String(10_000_000 + (i % 40)).padStart(8, '0')}`;
  const total = over.total ?? 100;
  const o = {
    id: `BUH-260101-S${String(i).padStart(5, '0')}`,
    createdAt: at,
    status: st,
    paymentMethod: over.method ?? 'cod',
    paymentStatus: 'cod_pending',
    total,
    subtotal: total,
    deliveryFee: 0,
    codFee: 0,
    discount: 0,
    items: [],
    customer: { fullName: over.name ?? `Customer ${i % 40}`, phone, emirate: 'Dubai', area: `Area ${i % 3}`, streetAddress: 'Street', buildingVilla: `Building ${i}`, flatVillaNo: '1' },
    courier: { provider: 'jeebly', awbNumber: '', pieces: 1, weightKg: 1 },
    ...(over.photo ? { photoOrder: { photos: 1, pieces: 1, agreedTotal: total, note: '' } } : {}),
  };
  getDb()
    .prepare('INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, idempotency_key, data) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(o.id, at, over.updatedAt ?? at, phone, st, o.paymentMethod, o.paymentStatus, Math.round(total * 100), `seed-${i}`, JSON.stringify(o));
  return o;
}

// 510 orders: the two OLDEST are still open (one to confirm, one to dispatch), then 508 finished.
const toConfirm = seed(0, 'pending_confirmation', { name: 'Mariam Old-Open', phone: '+971501110001' });
const toDispatch = seed(1, 'confirmed', { name: 'Noura Dispatch', phone: '+971501110002' });
getDb().transaction(() => {
  for (let i = 2; i < 510; i++) seed(i, i % 10 === 0 ? 'cancelled' : 'delivered', i === 5 ? { name: 'Zainab Al Hashimi', phone: '+971507654321', total: 250 } : i === 7 ? { method: 'online_card' } : i === 9 ? { photo: true } : {});
})();
const { bump } = await import('@/lib/server/live');
bump('orders');

test('finding 1: every open order is in the hub, however many orders there are (the two oldest of 510 were invisible)', () => {
  assert.equal(orders.listOrders({ limit: 500 }).some((o) => o.id === toConfirm.id), false, 'the old list (newest 500) does not hold them');
  const hub = orders.listHubOrders();
  const ids = new Set(hub.orders.map((o) => o.id));
  assert.ok(ids.has(toConfirm.id) && ids.has(toDispatch.id), 'both open orders are there');
  assert.equal(hub.orders.filter((o) => o.status === 'pending_confirmation').length, 1);
  assert.equal(hub.orders.filter((o) => o.status === 'confirmed').length, 1);
  assert.equal(hub.orders.filter((o) => o.status === 'delivered' || o.status === 'cancelled').length, 200, 'and the newest 200 finished ones');
  assert.equal(hub.orders.length, 202, 'not everything: the rest is a search or a page away');
  assert.ok(hub.older, 'more finished orders follow on the server');
  // Newest first.
  const dates = hub.orders.map((o) => o.createdAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
  // With few orders nothing follows.
  assert.equal(orders.listHubOrders({ recent: 1000 }).older, null);
});

test('finding 1: the older finished orders continue from the hub’s list, a page at a time, with nothing lost or repeated', () => {
  const hub = orders.listHubOrders();
  const seen = new Set(hub.orders.map((o) => o.id));
  let before: string | null = hub.older;
  let pages = 0;
  while (before) {
    const page = orders.searchOrders({ status: 'finished', before, limit: 100 });
    assert.ok(page.orders.length <= 100);
    for (const o of page.orders) {
      assert.equal(seen.has(o.id), false, `${o.id} is not repeated`);
      seen.add(o.id);
    }
    before = page.next;
    assert.ok(++pages < 20);
  }
  assert.equal(seen.size, 510, 'every order was reached');
  assert.equal(pages, 4, '308 older finished orders, 100 at a time');
});

test('finding 1: any old order is found by its number, the customer’s name or phone; Delivered and Cancelled filters', () => {
  const byId = orders.searchOrders({ q: 's00005' });
  assert.deepEqual(byId.orders.map((o) => o.id), ['BUH-260101-S00005']);
  assert.deepEqual(orders.searchOrders({ q: 'zainab al' }).orders.map((o) => o.id), ['BUH-260101-S00005'], 'name, any case');
  for (const typed of ['050 765 4321', '+971507654321', '7654321', '+971 50 765-4321']) {
    assert.deepEqual(orders.searchOrders({ q: typed }).orders.map((o) => o.id), ['BUH-260101-S00005'], `phone typed as ${typed}`);
  }
  assert.deepEqual(orders.searchOrders({ q: 'old-open' }).orders.map((o) => o.id), [toConfirm.id], 'open orders too');
  assert.equal(orders.searchOrders({ q: 'nobody-by-this-name' }).orders.length, 0);
  // % and _ are letters here, not wildcards.
  assert.equal(orders.searchOrders({ q: '%%' }).orders.length, 0);
  assert.equal(orders.searchOrders({ q: 'BUH_260101' }).orders.length, 0);

  const cancelled = orders.searchOrders({ status: 'cancelled', limit: 100 });
  assert.equal(cancelled.orders.length, 50);
  assert.ok(cancelled.orders.every((o) => o.status === 'cancelled'));
  assert.equal(cancelled.next, null);
  const delivered = orders.searchOrders({ status: 'delivered', limit: 30 });
  assert.equal(delivered.orders.length, 30);
  assert.ok(delivered.next);
  assert.ok(orders.searchOrders({ status: 'delivered', limit: 30, before: delivered.next! }).orders.every((o) => o.status === 'delivered' && !delivered.orders.some((x) => x.id === o.id)));
  // Card payments and photo orders, however old (the Orders tab's chips).
  assert.deepEqual(orders.searchOrders({ kind: 'card' }).orders.map((o) => o.id), ['BUH-260101-S00007']);
  assert.deepEqual(orders.searchOrders({ kind: 'photo', status: 'finished' }).orders.map((o) => o.id), ['BUH-260101-S00009']);

  // Checked input: an unknown status, kind or page, or one letter, is refused (never passed to the database).
  assert.equal(status(() => orders.searchOrders({ status: "x' OR 1=1" })), 400);
  assert.equal(status(() => orders.searchOrders({ kind: 'bulk' as never })), 400);
  assert.equal(status(() => orders.searchOrders({ before: 'yesterday' })), 400);
  assert.equal(status(() => orders.searchOrders({ before: "2026-01-01T00:00:00.000Z|x' --" })), 400);
  assert.equal(status(() => orders.searchOrders({ q: 'a' })), 400);
  assert.equal(orders.searchOrders({ limit: 100_000 }).orders.length, 100, 'a page is 100 at most');
});

test('finding 1: the hub’s own search rule is the server’s', () => {
  assert.equal(orderSearchTerms(' a '), null);
  const o = { id: 'BUH-260101-S00005', customer: { fullName: 'Zainab Al Hashimi', phone: '+971507654321' } } as never;
  for (const [q, hit] of [['s00005', true], ['ZAINAB', true], ['050 765 4321', true], ['0551234567', false], ['mariam', false], ['76', false]] as Array<[string, boolean]>) {
    assert.equal(orderMatchesSearch(o, orderSearchTerms(q)!), hit, q);
    assert.equal(orders.searchOrders({ q }).orders.some((x) => x.id === 'BUH-260101-S00005'), hit, `server: ${q}`);
  }
});

test('finding 1: sales, badges, to-dos and money highlights are counted over every order, not the shortened list', () => {
  const totals = orders.hubTotals();
  const all = orders.allOrders();
  assert.equal(totals.orders, 510);
  assert.equal(totals.toConfirm, 1, 'the old order to confirm is counted');
  assert.equal(totals.toDispatch, 1, 'and the one to dispatch');
  assert.equal(totals.byStatus.delivered + totals.byStatus.cancelled, 508);
  assert.equal(totals.byStatus.cancelled, 50);
  assert.equal(totals.card, 1);
  assert.equal(totals.photo, 1);
  const expected = all.reduce((s, o) => s + saleFils(o), 0);
  assert.equal(totals.salesFils, expected, 'the header’s Sales: every order');
  assert.equal(expected, (510 - 50) * 10_000 + 15_000);
  const listed = orders.listHubOrders().orders.reduce((s, o) => s + saleFils(o), 0);
  assert.ok(listed < expected, 'the hub’s own list would have shown less');
  assert.equal(totals.customers, new Set(all.map((o) => o.customer.phone)).size);
  assert.deepEqual(todosFrom(totals, [], 2), { toConfirm: 1, toDispatch: 1, lowStock: 0, soldOut: 0 });

  // Money highlights: UAE dates, over every order (here: as on 22 Jan 2026, 02:00 in Dubai).
  const now = Date.parse('2026-01-21T22:00:00Z');
  const at = orders.hubTotals(now);
  assert.deepEqual(at.highlights, moneyHighlights(all, now));
  assert.deepEqual(at.highlights, hubTotalsOf(all, now).highlights);
  assert.equal(at.highlights[2].label, 'This month');
  assert.ok(at.highlights[2].orders > 400, 'more orders this month than the hub lists');
  assert.ok(at.highlights[0].orders > 0 && at.highlights[0].orders < at.highlights[1].orders && at.highlights[1].orders < at.highlights[2].orders);
});

test('finding 6: the totals are counted again only when an order changed (the live counter), not on every call', () => {
  const first = orders.hubTotals();
  assert.equal(orders.hubTotals(), first, 'the same answer object: nothing was read again');
  // A change that did not go through the shop (no live counter): still the kept answer…
  getDb().prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run('BUH-260101-S00011');
  assert.equal(orders.hubTotals(), first);
  getDb().prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run('BUH-260101-S00011');
  // …and a real order (placed through the shop, which bumps the counter) is counted at once.
  const p = listProducts()[0];
  const phone = '+971502223344';
  const { order } = orders.placeOrder({
    idempotencyKey: `hub-review-${Date.now()}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Fatima New', email: 'fatima@example.com', emirate: 'Sharjah', area: 'Al Majaz', streetAddress: 'Corniche', buildingVilla: 'Tower 4', flatVillaNo: '12' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  });
  const next = orders.hubTotals();
  assert.notEqual(next, first);
  assert.equal(next.orders, 511);
  assert.equal(next.toConfirm, 2);
  assert.equal(next.salesFils, first.salesFils + Math.round(order.total * 100));
  assert.equal(next.highlights[0].orders, first.highlights[0].orders + 1, 'today');
  assert.ok(orders.listHubOrders().orders.some((o) => o.id === order.id));
  // An old finished order changed in the last day stays in the hub's list (e.g. just delivered or cancelled).
  const old = 'BUH-260101-S00013';
  assert.equal(orders.listHubOrders().orders.some((o) => o.id === old), false);
  getDb().prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), old);
  assert.equal(orders.listHubOrders().orders.some((o) => o.id === old), true);
});

test('finding 6: customers are worked out by the database, a page at a time, with the same figures as the full list', () => {
  const full = orders.listCustomers();
  const paged: Array<(typeof full)[number]> = [];
  let offset: number | null = 0;
  let total = 0;
  while (offset !== null) {
    const page = orders.customersPage({ offset, limit: 15 });
    assert.ok(page.customers.length <= 15);
    paged.push(...page.customers);
    total = page.total;
    offset = page.next;
  }
  assert.equal(total, full.length);
  assert.equal(paged.length, full.length);
  assert.equal(new Set(paged.map((c) => c.phone)).size, paged.length, 'one per phone');
  const byPhone = new Map(full.map((c) => [c.phone, c]));
  for (const c of paged) assert.deepEqual({ ...c }, { ...byPhone.get(c.phone)! }, c.phone);
  const dates = paged.map((c) => c.lastOrderDate);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'latest order first');
  // Cancelled orders are not counted (Customer 0's orders 10, 50, 90… are cancelled).
  const c0 = paged.find((c) => c.fullName === 'Customer 10')!;
  assert.ok(c0.totalOrders < orders.customerOrders(c0.phone, { limit: 100 }).orders.length);

  // Search: name, phone (as typed), emirate, area.
  assert.deepEqual(orders.customersPage({ q: 'zainab' }).customers.map((c) => c.phone), ['+971507654321']);
  assert.deepEqual(orders.customersPage({ q: '050 765 4321' }).customers.map((c) => c.phone), ['+971507654321']);
  assert.deepEqual(orders.customersPage({ q: 'sharjah' }).customers.map((c) => c.fullName), ['Fatima New']);
  assert.deepEqual(orders.customersPage({ q: 'al majaz' }).customers.map((c) => c.fullName), ['Fatima New']);
  assert.equal(orders.customersPage({ q: 'fatima' }).customers[0].email, 'fatima@example.com');
  assert.equal(orders.customersPage({ q: 'no-such-customer' }).customers.length, 0);
  assert.equal(orders.customersPage({ q: '%' }).customers.length, 0, '% is a letter, not a wildcard');
  assert.equal(orders.customersPage({ limit: 5 }).customers.length, 5);
  assert.equal(orders.customersPage({ limit: 5 }).next, 5);
});

test('finding 7: a customer’s history is every order of theirs, however old, and a card is called a card', () => {
  // "Customer 3" ordered 13 times across the 510 (most of them older than the hub's list).
  const c = orders.customersPage({ q: 'Customer 3' }).customers.find((x) => x.fullName === 'Customer 3')!;
  const expected = orders.allOrders().filter((o) => o.customer.phone === c.phone).map((o) => o.id);
  assert.ok(expected.length >= 12);
  const inHub = orders.listHubOrders().orders.filter((o) => o.customer.phone === c.phone).length;
  assert.ok(inHub < expected.length, 'the hub’s list holds only some of them');
  const got: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = orders.customerOrders(c.phone, { before, limit: 5 });
    got.push(...page.orders.map((o) => o.id));
    if (!page.next) break;
    before = page.next;
  }
  assert.deepEqual(got, expected, 'all of them, newest first, none twice');
  assert.equal(orders.customerOrders('+971500000000').orders.length, 0);
  assert.equal(status(() => orders.customerOrders(c.phone, { before: 'x' })), 400);

  assert.equal(paymentName('online_card'), 'Card');
  assert.equal(paymentName('cod'), 'Cash on Delivery');
  assert.equal(paymentName('bank_transfer'), 'Bank Transfer');
});
