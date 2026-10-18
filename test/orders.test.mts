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
// A fresh phone per order by default: a phone may only have MAX_OPEN_PER_PHONE unconfirmed orders.
function body(over: Record<string, unknown> = {}, phone = `+9715020${String(n + 1).padStart(5, '0')}`) {
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
    body(
      { items: [{ productId: p.id, profileId: profile.id, quantity: 3, unitPrice: 1, totalPrice: 3 }], total: 3, subtotal: 3, customer: { ...body().customer, phone: '+971000000000' } },
      '+971501234567'
    )
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

test('stock is reserved per size; the last piece cannot be sold twice; cancelling returns it', () => {
  const p = listProducts()[1];
  const [king, other] = [p.profiles[0].id, p.profiles[1].id];
  updateProduct(p.id, { stockBySize: { ...Object.fromEntries(p.profiles.map((s) => [s.id, 0])), [king]: 2, [other]: 1 } });
  const stockOf = (size: string) => listProducts().find((x) => x.id === p.id)!.stockBySize[size];
  const a = orders.placeOrder(body({ items: [{ productId: p.id, profileId: king, quantity: 2 }] }));
  assert.equal(stockOf(king), 0);
  assert.equal(stockOf(other), 1, 'another size is untouched');
  assert.equal(status(() => orders.placeOrder(body({ items: [{ productId: p.id, profileId: king, quantity: 1 }] }))), 409);
  orders.updateOrderByAdmin(a.order.id, { status: 'cancelled' }, 'test');
  assert.equal(stockOf(king), 2);
  // Cancelling again does not add stock twice (cancelled is final).
  assert.equal(status(() => orders.updateOrderByAdmin(a.order.id, { status: 'confirmed' }, 'test')), 409);
  assert.equal(stockOf(king), 2);
  assert.equal(listProducts().find((x) => x.id === p.id)!.stockCount, 3, 'the total is the sum of the sizes');
});

test('a failing line rolls back the whole order (no stock taken for the others)', () => {
  const [p0, p1] = listProducts();
  const before = p0.stockCount;
  updateProduct(p1.id, { stockBySize: { [p1.profiles[0].id]: 0 } });
  const code = status(() =>
    orders.placeOrder(body({ items: [{ productId: p0.id, profileId: p0.profiles[0].id, quantity: 1 }, { productId: p1.id, profileId: p1.profiles[0].id, quantity: 1 }] }))
  );
  assert.equal(code, 409);
  assert.equal(listProducts().find((x) => x.id === p0.id)!.stockCount, before);
  updateProduct(p1.id, { stockBySize: { [p1.profiles[0].id]: 20 } });
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

test('bank transfer: checkout takes no receipt any more (it is uploaded on the private page); one sent by an older checkout page is still kept as the first upload', async () => {
  const { updateSettings } = await import('@/lib/server/settings');
  await updateSettings('bank', { bankName: 'Test Bank', accountName: 'BUH LLC', iban: 'AE070331234567890123456' });
  const plain = orders.placeOrder(body({ paymentMethod: 'bank_transfer' })).order;
  assert.equal(plain.paymentStatus, 'pending');
  assert.deepEqual({ state: plain.bankTransfer?.state, uploads: plain.bankTransfer?.uploads }, { state: 'awaiting', uploads: 0 });
  assert.equal(orders.readReceipt(plain.id), null);
  // A checkout page from before this version (still open during the update) sends its PDF with the order.
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32)]).toString('base64');
  const { order } = orders.placeOrder(body({ paymentMethod: 'bank_transfer', bankTransferRef: 'ENBD-1', receipt: `data:application/pdf;base64,${pdf}` }));
  assert.equal(order.paymentStatus, 'receipt_uploaded');
  assert.deepEqual({ state: order.bankTransfer?.state, uploads: order.bankTransfer?.uploads }, { state: 'uploaded', uploads: 1 });
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
  for (let i = 0; i < 2; i++) orders.placeOrder(body({}, '+971501234567'));
  const list = orders.listCustomers();
  const fatima = list.find((c) => c.phone === '+971501234567')!;
  assert.ok(fatima.totalOrders >= 3);
  assert.ok(fatima.totalSpent > 0);
  assert.equal(new Set(list.map((c) => c.phone)).size, list.length);
});
