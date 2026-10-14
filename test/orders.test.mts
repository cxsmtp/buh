import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const orders = await import('@/lib/server/orders');
const { listProducts, updateProduct } = await import('@/lib/server/products');
const { issuePhoneToken, verifyPhoneToken } = await import('@/lib/server/phoneToken');

const status = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

let n = 0;
function body(over: Record<string, unknown> = {}, phone = '+971501234567') {
  const p = listProducts()[0];
  return {
    idempotencyKey: `unit-test-key-${++n}-${Date.now()}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Fatima Al Mansoori', email: 'f@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '12' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
    ...over,
  };
}

test('phone proof: signed, expires, cannot be forged', () => {
  const t = issuePhoneToken('+971501234567');
  assert.equal(verifyPhoneToken(t), '+971501234567');
  assert.equal(verifyPhoneToken(t, Date.now() + 31 * 60 * 1000), null, 'expired');
  const [b, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ p: '+971559999999', exp: Date.now() + 1e6 })).toString('base64url');
  assert.equal(verifyPhoneToken(`${forged}.${sig}`), null);
  assert.equal(verifyPhoneToken(`${b}.${sig}x`), null);
  assert.equal(verifyPhoneToken(undefined), null);
});

test('prices, totals and phone come from the server, not the request', () => {
  const p = listProducts()[0];
  const profile = p.profiles[p.profiles.length - 1];
  const { order } = orders.placeOrder(
    body({ items: [{ productId: p.id, profileId: profile.id, quantity: 3, unitPrice: 1, totalPrice: 3 }], total: 3, subtotal: 3, customer: { ...body().customer, phone: '+971000000000' } })
  );
  const unit = p.price + profile.priceDelta;
  assert.equal(order.items[0].unitPrice, unit);
  assert.equal(order.total, unit * 3);
  assert.equal(order.customer.phone, '+971501234567', 'the verified number, not one from the body');
  assert.equal(order.customer.phoneVerified, true);
  assert.equal(order.status, 'pending_confirmation');
  assert.equal(order.courier.awbNumber, '');
  assert.match(order.id, /^BUH-\d{6}-[A-Z2-9]{6}$/);
});

test('one checkout reference = one order, and another phone cannot reuse it', () => {
  const b = body();
  const first = orders.placeOrder(b);
  const again = orders.placeOrder(b);
  assert.equal(again.created, false);
  assert.equal(again.order.id, first.order.id);
  assert.equal(status(() => orders.placeOrder({ ...b, verificationToken: issuePhoneToken('+971551112222') })), 409);
});

test('stock is reserved; the last item cannot be sold twice; cancelling returns it', () => {
  const p = listProducts()[1];
  updateProduct(p.id, { stockCount: 2 });
  const a = orders.placeOrder(body({ items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 2 }] }));
  assert.equal(listProducts().find((x) => x.id === p.id)!.stockCount, 0);
  assert.equal(status(() => orders.placeOrder(body({ items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }] }))), 409);
  orders.updateOrderByAdmin(a.order.id, { status: 'cancelled' }, 'test');
  assert.equal(listProducts().find((x) => x.id === p.id)!.stockCount, 2);
  // Cancelling again does not add stock twice (cancelled is final).
  assert.equal(status(() => orders.updateOrderByAdmin(a.order.id, { status: 'confirmed' }, 'test')), 409);
  assert.equal(listProducts().find((x) => x.id === p.id)!.stockCount, 2);
});

test('a failing line rolls back the whole order (no stock taken for the others)', () => {
  const [p0, p1] = listProducts();
  const before = p0.stockCount;
  updateProduct(p1.id, { stockCount: 0 });
  const code = status(() =>
    orders.placeOrder(body({ items: [{ productId: p0.id, profileId: p0.profiles[0].id, quantity: 1 }, { productId: p1.id, profileId: p1.profiles[0].id, quantity: 1 }] }))
  );
  assert.equal(code, 409);
  assert.equal(listProducts().find((x) => x.id === p0.id)!.stockCount, before);
  updateProduct(p1.id, { stockCount: 20 });
});

test('bad orders are refused', () => {
  const p = listProducts()[0];
  const cases: Array<[string, Record<string, unknown>]> = [
    ['no phone proof', { verificationToken: 'nope' }],
    ['empty bag', { items: [] }],
    ['fractional quantity', { items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1.5 }] }],
    ['huge quantity', { items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 999 }] }],
    ['unknown product', { items: [{ productId: 'nope', profileId: 'king', quantity: 1 }] }],
    ['unknown size', { items: [{ productId: p.id, profileId: 'custom', quantity: 1 }] }],
    ['unknown colour', { items: [{ productId: p.id, profileId: p.profiles[0].id, color: 'Neon', quantity: 1 }] }],
    ['payment method', { paymentMethod: 'online_card' }],
    ['emirate', { customer: { ...body().customer, emirate: 'Narnia' } }],
    ['missing address', { customer: { ...body().customer, streetAddress: '' } }],
    ['bad email', { customer: { ...body().customer, email: 'not-an-email' } }],
    ['pin outside the UAE', { customer: { ...body().customer, gpsCoordinates: { lat: 51.5, lng: -0.1 } } }],
    ['bad checkout reference', { idempotencyKey: 'x' }],
    ['fake receipt', { paymentMethod: 'bank_transfer', receipt: `data:application/pdf;base64,${Buffer.from('not a pdf').toString('base64')}` }],
  ];
  for (const [label, over] of cases) assert.notEqual(status(() => orders.placeOrder(body(over))), 0, label);
});

test('hidden products cannot be ordered', () => {
  const p = listProducts()[2];
  updateProduct(p.id, { active: false });
  assert.equal(status(() => orders.placeOrder(body({ items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }] }))), 409);
  updateProduct(p.id, { active: true });
});

test('bank transfer with a PDF receipt: stored, and only the admin URL is recorded', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32)]).toString('base64');
  const { order } = orders.placeOrder(body({ paymentMethod: 'bank_transfer', bankTransferRef: 'ENBD-1', receipt: `data:application/pdf;base64,${pdf}` }));
  assert.equal(order.paymentStatus, 'receipt_uploaded');
  assert.equal(order.paymentReceiptUrl, `/api/admin/orders/${order.id}/receipt`);
  assert.equal(orders.readReceipt(order.id)!.mime, 'application/pdf');
  assert.equal(orders.readReceipt('../../etc/passwd'), null);
  assert.equal((orders.customerView(order) as Record<string, unknown>).paymentReceiptUrl, undefined);
});

test('status moves follow the allowed steps and are recorded', () => {
  const { order } = orders.placeOrder(body());
  assert.equal(status(() => orders.updateOrderByAdmin(order.id, { status: 'delivered' }, 'owner')), 409);
  orders.updateOrderByAdmin(order.id, { status: 'confirmed' }, 'owner');
  orders.updateOrderByAdmin(order.id, { status: 'dispatched' }, 'owner');
  const done = orders.updateOrderByAdmin(order.id, { status: 'delivered', adminNotes: 'Left with guard' }, 'owner');
  assert.equal(done.status, 'delivered');
  assert.ok(done.courier.deliveredAt);
  assert.equal(status(() => orders.updateOrderByAdmin(order.id, { status: 'cancelled' }, 'owner')), 409, 'delivered is final');
  assert.equal(status(() => orders.updateOrderByAdmin(order.id, { paymentStatus: 'free' }, 'owner')), 400);
  const events = orders.orderEvents(order.id);
  assert.deepEqual(events.map((e) => e.event), ['created', 'updated', 'updated', 'updated']);
  assert.equal(events[1].actor, 'owner');
});

test('Track Order needs the matching phone and reveals no address or email', () => {
  const { order } = orders.placeOrder(body({}, '+971527778888'));
  assert.equal(orders.lookupOrder(order.id, '+971501234567'), null);
  const seen = orders.lookupOrder(order.id.toLowerCase(), '+971527778888')!;
  assert.equal(seen.id, order.id);
  const text = JSON.stringify(seen);
  assert.ok(!text.includes('Walk 1') && !text.includes('f@example.com') && !text.includes('Al Mansoori'));
  assert.equal(seen.firstName, 'Fatima');
});

test('customers are built from orders: one per phone, cancelled orders not counted', () => {
  const list = orders.listCustomers();
  const fatima = list.find((c) => c.phone === '+971501234567')!;
  assert.ok(fatima.totalOrders >= 3);
  assert.ok(fatima.totalSpent > 0);
  assert.equal(new Set(list.map((c) => c.phone)).size, list.length);
});
