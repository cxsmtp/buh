import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

// Regression tests for the security and correctness review of the server-side shop.
tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const settings = await import('@/lib/server/settings');
const backup = await import('@/lib/server/backup');
const { writeTar } = await import('@/lib/server/tar');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');

const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

let n = 0;
function order(phone: string, items?: unknown[], over: Record<string, unknown> = {}) {
  const p = products.listProducts()[0];
  return orders.placeOrder({
    idempotencyKey: `review-fix-${++n}-${Date.now()}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Test Person', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: items ?? [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
    ...over,
  });
}

test('courier and SMS keys are blanked in backups (the live database keeps them)', async () => {
  await settings.updateSettings('courier', { jeebly: { apiKey: 'JEEBLY-SECRET-123456', clientKey: 'CLIENT-SECRET-654321' } });
  const result = await backup.createBackup();
  const db = backup.openBackup(fs.readFileSync(result.file)).find((e) => e.name === 'shop.db')!;
  assert.ok(!db.data.includes('JEEBLY-SECRET-123456'), 'API key not in the backup, not even in free pages');
  assert.ok(!db.data.includes('CLIENT-SECRET-654321'));
  assert.ok(db.data.includes('"jeebly"'), 'the rest of the courier settings are kept');
  assert.equal(settings.getSettings('courier').jeebly.apiKey, 'JEEBLY-SECRET-123456', 'live settings untouched');
});

test('a test connection aimed at a new host does not get the saved key', async () => {
  await settings.updateSettings('sms', { customWebhook: { endpointUrl: 'https://93.184.216.34/sms', bearerToken: 'BEARER-SAVED-1' } });
  const same = settings.withStoredSecrets('sms', { customWebhook: { endpointUrl: 'https://93.184.216.34/other', bearerToken: '' } }) as { customWebhook: { bearerToken: string } };
  assert.equal(same.customWebhook.bearerToken, 'BEARER-SAVED-1', 'same host: saved key used');
  const moved = settings.withStoredSecrets('sms', { customWebhook: { endpointUrl: 'https://attacker.example/x', bearerToken: '' } }) as { customWebhook: { bearerToken: string } };
  assert.equal(moved.customWebhook.bearerToken, '', 'new host: no saved key');
  const omitted = settings.withStoredSecrets('sms', {}) as { customWebhook: { bearerToken: string } };
  assert.equal(omitted.customWebhook.bearerToken, 'BEARER-SAVED-1', 'no URL typed: the saved one applies');
});

test('saving a price does not overwrite stock sold in the meantime; a stale stock edit is refused', () => {
  const p = products.listProducts()[0];
  products.updateProduct(p.id, { stockCount: 18 });
  const seen = products.getProduct(p.id)!.stockCount; // what the admin hub shows
  order('+971503000001', [{ productId: p.id, profileId: p.profiles[0].id, quantity: 2 }]);
  products.updateProduct(p.id, { price: p.price + 1 });
  assert.equal(products.getProduct(p.id)!.stockCount, 16, 'price-only save leaves stock alone');
  assert.equal(statusOf(() => products.updateProduct(p.id, { stockCount: 30, expectedStock: seen })), 409);
  assert.equal(products.getProduct(p.id)!.stockCount, 16);
  products.updateProduct(p.id, { stockCount: 30, expectedStock: 16 });
  assert.equal(products.getProduct(p.id)!.stockCount, 30);
  products.updateProduct(p.id, { price: p.price });
});

test('one product cannot exceed the quantity cap by splitting it over lines', () => {
  const p = products.listProducts()[0];
  const line = { productId: p.id, profileId: p.profiles[0].id, quantity: 15 };
  assert.equal(statusOf(() => order('+971503000002', [line, line])), 400);
});

test('a phone can have at most 3 orders waiting for confirmation', () => {
  const phone = '+971503000003';
  for (let i = 0; i < orders.MAX_OPEN_PER_PHONE; i++) order(phone);
  assert.equal(statusOf(() => order(phone)), 429);
  const first = orders.listOrders().find((o) => o.customer.phone === phone)!;
  orders.updateOrderByAdmin(first.id, { status: 'confirmed' }, 'admin@test');
  assert.equal(statusOf(() => order(phone)), 0, 'once one is confirmed, a new order is allowed');
});

test('backups and the customer list include every order, not only the newest 2,000', () => {
  assert.equal(orders.allOrders().length, orders.listOrders({ limit: 2000 }).length);
  assert.ok(typeof orders.allOrders === 'function');
});

function craftedBackup(name: string, data: Buffer): string {
  const entries = [{ name: 'shop.db', data: Buffer.from('x') }, { name, data }];
  const manifest = entries.map((e) => `${crypto.createHash('sha256').update(e.data).digest('hex')}  ${e.data.length}  ${e.name}`).join('\n') + '\n';
  entries.push({ name: 'MANIFEST.sha256', data: Buffer.from(manifest) });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buh-crafted-')), 'b.tar.gz');
  fs.writeFileSync(file, zlib.gzipSync(writeTar(entries)));
  return file;
}

test('restore refuses files that would replace the shop keys or admin account', () => {
  for (const name of ['audit/session.key', 'audit/audit.key', 'audit/admin.json', 'audit/session-state.json', 'images/..', 'receipts/.']) {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-'));
    const r = spawnSync(process.execPath, ['scripts/restore-backup.mjs', craftedBackup(name, Buffer.from('evil')), target]);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr.toString(), /Unexpected file/, name);
    assert.deepEqual(fs.readdirSync(target), [], `${name}: nothing written`);
  }
});
