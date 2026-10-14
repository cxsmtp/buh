import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const settings = await import('@/lib/server/settings');
const products = await import('@/lib/server/products');
const { readImage } = await import('@/lib/server/images');

test('starter settings carry no sample keys and do not go live by themselves', () => {
  const c = settings.getSettings('courier');
  assert.equal(c.jeebly.apiKey, '');
  assert.equal(c.echo.apiKey, '');
  assert.equal(c.jeebly.isLive, false);
  assert.equal(settings.getSettings('sms').isEnabled, false);
});

test('keys are write-only: blank keeps, a value replaces, null clears; reads never return them', async () => {
  await settings.updateSettings('courier', { jeebly: { apiKey: 'KEY-1', clientKey: 'C-1' }, echo: { apiKey: 'E-1' } });
  let view = settings.adminView('courier');
  assert.equal(view.value.jeebly.apiKey, '');
  assert.deepEqual(view.secretsSet, { 'jeebly.apiKey': true, 'jeebly.clientKey': true, 'echo.apiKey': true });
  await settings.updateSettings('courier', { jeebly: { apiKey: '', pickupLocationName: 'Studio' }, echo: {} });
  assert.equal(settings.getSettings('courier').jeebly.apiKey, 'KEY-1', 'blank keeps');
  await settings.updateSettings('courier', { jeebly: { apiKey: 'KEY-2' }, echo: { apiKey: null } });
  assert.equal(settings.getSettings('courier').jeebly.apiKey, 'KEY-2');
  view = settings.adminView('courier');
  assert.equal(view.secretsSet['echo.apiKey'], false, 'null clears');
  assert.equal(settings.withStoredSecrets('courier', { jeebly: { apiKey: '' } }).jeebly && (settings.withStoredSecrets('courier', { jeebly: { apiKey: '' } }) as { jeebly: { apiKey: string } }).jeebly.apiKey, 'KEY-2');
});

test('settings survive a restart (stored in the database)', async () => {
  settings._clearSettingsCache();
  assert.equal(settings.getSettings('courier').jeebly.pickupLocationName, 'Studio');
});

test('an SMS key follows its host: a new webhook address without a new key drops the old key', async () => {
  await settings.updateSettings('sms', { customWebhook: { endpointUrl: 'https://8.8.8.8/sms', bearerToken: 'TOKEN-A' } });
  assert.equal(settings.getSettings('sms').customWebhook.bearerToken, 'TOKEN-A');
  await settings.updateSettings('sms', { customWebhook: { endpointUrl: 'https://1.1.1.1/sms' } });
  assert.equal(settings.getSettings('sms').customWebhook.bearerToken, '');
  await assert.rejects(settings.updateSettings('sms', { customWebhook: { endpointUrl: 'https://169.254.169.254/x' } }));
});

test('settings are validated', async () => {
  await assert.rejects(settings.updateSettings('bank', { iban: 'GB33BUKB20201555555555' }), /UAE IBAN/);
  // AE + 21 digits but the checksum is wrong (one digit mistyped): refused.
  await assert.rejects(settings.updateSettings('bank', { iban: 'AE070331234567890123457' }), /does not add up/);
  await settings.updateSettings('bank', { iban: 'ae07 0331 2345 6789 0123 456' });
  assert.equal(settings.getSettings('bank').iban, 'AE07 0331 2345 6789 0123 456');
  await assert.rejects(settings.updateSettings('brand', { accentColor: 'red; background:url(x)' }));
  await assert.rejects(settings.updateSettings('sms', { twilio: { accountSid: 'not-a-sid' } }));
  await assert.rejects(settings.updateSettings('courier', { jeebly: { pickupEmirate: 'Narnia' } }));
  await settings.updateSettings('brand', { storeName: 'X'.repeat(500), marquee: { messages: Array(50).fill('hi'), speedSeconds: 9999 } });
  const brand = settings.getSettings('brand');
  assert.equal(brand.storeName.length, 60);
  assert.equal(brand.marquee.messages.length, 10);
  assert.equal(brand.marquee.speedSeconds, 120);
  // Prototype keys are ignored.
  await settings.updateSettings('bank', JSON.parse('{"__proto__":{"polluted":true},"bankName":"ENBD"}'));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('an uploaded logo is stored as a file and served by URL', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  await settings.updateSettings('brand', { logoType: 'image', logoImageUrl: `data:image/png;base64,${png.toString('base64')}` });
  const url = settings.getSettings('brand').logoImageUrl!;
  assert.match(url, /^\/api\/images\/[a-f0-9]{64}\.png$/);
  assert.ok(readImage(url.split('/').pop()!));
  assert.equal(readImage('../shop.db'), null);
  await assert.rejects(settings.updateSettings('brand', { logoImageUrl: 'javascript:alert(1)' }));
});

test('catalogue: seeded once, validated, hidden products left out of the shop', () => {
  const all = products.listProducts({ includeHidden: true });
  assert.ok(all.length >= 4);
  const p = all[0];
  assert.throws(() => products.updateProduct(p.id, { price: -5 }));
  assert.throws(() => products.updateProduct(p.id, { stockCount: 1.5 }));
  assert.throws(() => products.updateProduct(p.id, { profiles: [] }));
  assert.throws(() => products.updateProduct(p.id, { defaultProfileId: 'custom' }));
  assert.throws(() => products.updateProduct(p.id, { featuredImage: 'javascript:alert(1)' }));
  assert.throws(() => products.updateProduct('nope', { price: 1 }), (e: { status?: number }) => e.status === 404);
  products.updateProduct(p.id, { active: false });
  assert.equal(products.listProducts().some((x) => x.id === p.id), false);
  products.updateProduct(p.id, { active: true });
});

test('a new product gets a server id, its photo stored as a file, and goes first', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
  const template = products.listProducts()[0];
  const created = products.createProduct({
    ...template,
    id: 'attacker-chosen',
    title: 'New Linen Set',
    featuredImage: `data:image/png;base64,${png.toString('base64')}`,
    galleryImages: [],
    rawOriginalImage: 'data:image/png;base64,AAAA',
    stockCount: 7,
  });
  assert.match(created.id, /^prod-[a-f0-9]{12}$/);
  assert.match(created.featuredImage, /^\/api\/images\//);
  assert.equal((created as unknown as Record<string, unknown>).rawOriginalImage, undefined);
  assert.equal(products.listProducts()[0].id, created.id);
  assert.ok(fs.readdirSync(path.join(dir, 'images')).length >= 1);
});
