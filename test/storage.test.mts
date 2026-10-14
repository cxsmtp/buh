import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// A minimal browser: localStorage that can be corrupted, filled up or blocked.
class FakeStorage {
  data = new Map<string, string>();
  failWrites = false;
  getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}
const storage = new FakeStorage();
Object.assign(globalThis, { window: globalThis, localStorage: storage });

const s = await import('@/lib/storage');
const { INITIAL_PRODUCTS, INITIAL_BRAND_SETTINGS, INITIAL_SMS_SETTINGS } = await import('@/data/initialData');

beforeEach(() => {
  storage.data.clear();
  storage.failWrites = false;
});

test('first visit: defaults are returned and saved', () => {
  assert.deepEqual(s.getStoredProducts(), INITIAL_PRODUCTS);
  assert.ok(storage.getItem('buh_products_v1'));
});

test('corrupted or wrong-shaped saves fall back to defaults instead of crashing', () => {
  storage.data.set('buh_products_v1', '{not json');
  assert.deepEqual(s.getStoredProducts(), INITIAL_PRODUCTS);
  storage.data.set('buh_orders_v1', '{"an":"object"}');
  assert.ok(Array.isArray(s.getStoredOrders()));
  storage.data.set('buh_orders_v1', '[null, 3, {"id":"BUH-1"}]');
  assert.deepEqual(s.getStoredOrders(), [{ id: 'BUH-1' }], 'non-object entries dropped');
  storage.data.set('buh_courier_settings_v1', '[1,2]');
  assert.equal(Array.isArray(s.getCourierSettings()), false);
});

test('partial brand and SMS settings are merged with defaults', () => {
  storage.data.set('buh_brand_settings_v1', JSON.stringify({ storeName: 'X', marquee: { enabled: false } }));
  const brand = s.getBrandSettings();
  assert.equal(brand.storeName, 'X');
  assert.equal(brand.marquee.enabled, false);
  assert.deepEqual(brand.marquee.messages, INITIAL_BRAND_SETTINGS.marquee.messages);

  storage.data.set('buh_sms_settings_v1', JSON.stringify({ twilio: { accountSid: 'AC1' } }));
  const sms = s.getSmsSettings();
  assert.equal(sms.twilio.accountSid, 'AC1');
  assert.deepEqual(sms.infobip, INITIAL_SMS_SETTINGS.infobip);
});

test('a full or blocked storage never throws from a save', () => {
  storage.failWrites = true;
  assert.doesNotThrow(() => s.saveStoredProducts(INITIAL_PRODUCTS));
  assert.doesNotThrow(() => s.getStoredProducts());
});

test('placing an order adds the customer once and updates them on repeat orders', () => {
  storage.data.set('buh_customers_v1', '[]');
  storage.data.set('buh_orders_v1', '[]');
  const order = {
    id: 'BUH-1',
    createdAt: '2026-10-14T00:00:00Z',
    total: 100,
    customer: { fullName: 'A', phone: '+971 50 123 4567', emirate: 'Dubai', area: 'Marina', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
  } as never;
  s.addOrder(order);
  s.addOrder({ ...(order as object), id: 'BUH-2', total: 50, customer: { ...(order as { customer: object }).customer, phone: '+971501234567' } } as never);
  const customers = s.getStoredCustomers();
  assert.equal(customers.length, 1);
  assert.equal(customers[0].totalOrders, 2);
  assert.equal(customers[0].totalSpent, 150);
  assert.equal(s.getStoredOrders().length, 2);
});
