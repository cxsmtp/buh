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
  const size = p.profiles[0].id;
  const stockOf = () => products.getProduct(p.id)!.stockBySize[size];
  products.updateProduct(p.id, { stockBySize: { [size]: 18 } });
  const seen = stockOf(); // what the admin hub shows
  order('+971503000001', [{ productId: p.id, profileId: size, quantity: 2 }]);
  products.updateProduct(p.id, { price: p.price + 1 });
  assert.equal(stockOf(), 16, 'price-only save leaves stock alone');
  assert.equal(statusOf(() => products.updateProduct(p.id, { stockBySize: { [size]: 30 }, expectedStockBySize: { [size]: seen } })), 409);
  assert.equal(stockOf(), 16);
  products.updateProduct(p.id, { stockBySize: { [size]: 30 }, expectedStockBySize: { [size]: 16 } });
  assert.equal(stockOf(), 30);
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

test('the order is refused, not charged, when the total differs from the one checkout showed', () => {
  const p = products.listProducts()[0];
  const line = { productId: p.id, profileId: p.profiles[0].id, quantity: 1 };
  const shown = p.price + p.profiles[0].priceDelta;
  const stockBefore = products.getProduct(p.id)!.stockCount;
  products.updateProduct(p.id, { price: p.price + 100 }); // the owner changes the price meanwhile
  try {
    order('+971503000010', [line], { expectedTotal: shown });
    assert.fail('should have been refused');
  } catch (e) {
    const err = e as { status: number; details: { code: string; total: number } };
    assert.equal(err.status, 409);
    assert.equal(err.details.code, 'price_changed');
    assert.equal(err.details.total, shown + 100);
  }
  assert.equal(products.getProduct(p.id)!.stockCount, stockBefore, 'no stock taken');
  assert.equal(order('+971503000010', [line], { expectedTotal: shown + 100 }).order.total, shown + 100);
  products.updateProduct(p.id, { price: p.price });
});

test('bank transfer is only offered once the real account is saved, the demo account is gone, and the account is never public', async () => {
  const publicSettings = async () => (await (await import('@/app/api/settings/public/route')).GET().json()) as Record<string, unknown>;
  assert.equal(settings.getSettings('bank').iban, '', 'no sample IBAN');
  assert.equal((await publicSettings()).bankTransfer, false, 'checkout does not offer it');
  assert.equal(statusOf(() => order('+971503000011', undefined, { paymentMethod: 'bank_transfer' })), 400);
  await settings.updateSettings('bank', { bankName: 'Test Bank', accountName: 'BUH LLC', iban: 'AE070331234567890123456' });
  const pub = await publicSettings();
  assert.equal(pub.bankTransfer, true, 'offered once saved');
  const text = JSON.stringify(pub);
  for (const secret of ['AE07', '0331234567890123456', 'BUH LLC', 'Test Bank']) assert.ok(!text.includes(secret), `the public settings never carry ${secret}`);
  const placed = order('+971503000011', undefined, { paymentMethod: 'bank_transfer' }).order;
  assert.equal(placed.paymentMethod, 'bank_transfer');
  assert.equal(placed.bankTransfer?.state, 'awaiting');
  assert.match(placed.bankTransfer?.payPath ?? '', /^\/pay\/[A-Za-z0-9_-]{43}$/, 'a private page instead');
  assert.ok(!JSON.stringify(orders.customerView(placed)).includes('AE07'), 'nor does the order answer');
});

test('SMS: Unifonic cannot be chosen, only the chosen gateway is used, and an incomplete one cannot be switched on', async () => {
  const { gatewaysFromSettings } = await import('@/lib/otpService');
  await assert.rejects(settings.updateSettings('sms', { provider: 'unifonic', isEnabled: true }), /Twilio, Infobip, a webhook or Firebase/);
  await assert.rejects(settings.updateSettings('sms', { provider: 'twilio', isEnabled: true, twilio: { accountSid: '' } }), /every field/);
  const both = {
    ...settings.getSettings('sms'),
    provider: 'twilio' as const,
    twilio: { accountSid: 'AC' + '0'.repeat(32), authToken: 'tok', fromNumber: '+15550001111', verifyServiceSid: '' },
  };
  const g = await gatewaysFromSettings(both);
  assert.ok(g.twilio);
  assert.equal(g.webhook, undefined, 'the saved webhook is not used when Twilio is chosen');
});

test('cart money is summed in fils: no floating-point noise', async () => {
  const { cartFils, formatAed } = await import('@/lib/money');
  const item = { product: { price: 99.99 }, selectedProfile: { priceDelta: 0 }, quantity: 3 } as never;
  assert.equal(formatAed(cartFils([item])), '299.97');
  assert.equal(formatAed(49000), '490');
});

test('a failing backup emails once, not every 15 minutes', async () => {
  const { SMTPServer } = await import('smtp-server');
  let mails = 0;
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _s, cb) {
      stream.resume();
      stream.on('end', () => {
        mails++;
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', BACKUP_EMAIL: 'owner@test' });
  const dir = path.join(process.env.DATA_DIR!, 'backups');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, 'not a folder'); // every backup now fails
  try {
    const first = await backup.runBackup('scheduled');
    assert.ok(first.lastError);
    await backup.runBackup('scheduled');
    await backup.runBackup('scheduled');
    assert.equal(mails, 1, 'one failure email for the same error');
    await backup.runBackup('manual');
    assert.equal(mails, 2, '"Back up now" always reports');
  } finally {
    fs.rmSync(dir, { force: true });
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'BACKUP_EMAIL']) delete process.env[k];
  }
});
