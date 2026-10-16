/**
 * "Once set, the settings keep working": nothing invalid is stored, a mail change that can't
 * connect never replaces working mail settings, autosave keystrokes are one edit session in
 * history, and Undo goes back to before the session.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const settings = await import('@/lib/server/settings');
const guard = await import('@/lib/server/settingsGuard');
const { getDb } = await import('@/lib/server/db');

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e) => (typeof e?.status === 'number' ? e.status : -1));
const ok = async () => {};
const fails = async () => {
  throw new Error('the mail server said: 535 Authentication failed');
};
const historyCount = (key: string) => getDb().prepare('SELECT COUNT(*) FROM settings_history WHERE key = ?').pluck().get(key) as number;

test('a mail change that connects goes live and becomes the working settings', async () => {
  const r = await guard.saveGuarded('email', { smtpHost: '93.184.215.14', smtpPort: 465, smtpSecurity: 'tls', smtpUser: 'shop@shop.ae', smtpPass: 'right-pass', sendTo: 'me@shop.ae' }, { email: ok });
  assert.equal(r.verified, true);
  assert.equal(settings.getSettings('email').smtpPass, 'right-pass');
  assert.equal(guard.isKnownWorking('email'), true);
});

test('a mail change that fails to connect is refused: the working settings stay in use', async () => {
  const status = await statusOf(guard.saveGuarded('email', { smtpPass: 'wrong-pass' }, { email: fails }));
  assert.equal(status, 409);
  assert.equal(settings.getSettings('email').smtpPass, 'right-pass', 'still the working password');
  assert.equal(settings.getSettings('email').smtpHost, '93.184.215.14');
});

test('settings never proven to work are not "protected": the change is kept, with a warning', async () => {
  getDb().prepare("DELETE FROM kv WHERE key = 'settings:good:email'").run();
  const r = await guard.saveGuarded('email', { smtpUser: 'other@shop.ae' }, { email: fails });
  assert.equal(r.verified, false);
  assert.match(r.warning!, /Saved, but the mail server said/);
  assert.equal(settings.getSettings('email').smtpUser, 'other@shop.ae');
});

test('invalid settings are never stored (the last good ones stay), for every group', async () => {
  const before = settings.getSettings('store');
  assert.equal(await statusOf(guard.saveGuarded('store', { whatsappNumber: 'call me' })), 400);
  assert.deepEqual(settings.getSettings('store'), before);
  assert.equal(await statusOf(guard.saveGuarded('delivery', { sameDayFee: -5 })), 400);
  assert.equal(await statusOf(guard.saveGuarded('sms', { isEnabled: true, provider: 'twilio', twilio: { accountSid: '', authToken: '', fromNumber: '' } })), 400);
});

test('autosave: rapid saves are one edit session in history; Undo goes back to before it', async (t) => {
  await settings.updateSettings('store', { whatsappNumber: '+971501111111' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60 * 1000 }); // a new session later
  const startCount = historyCount('store');
  for (const n of ['+97150222', '+971502222', '+9715022222', '+971502222222']) await settings.updateSettings('store', { whatsappNumber: n }, { auto: true });
  assert.equal(historyCount('store'), startCount + 1, 'one history entry for the whole session');
  const undo = settings.undoVersionId('store')!;
  await settings.restoreSettingsVersion(undo);
  assert.equal(settings.getSettings('store').whatsappNumber, '+971501111111', 'Undo: as before the session');
  // The undo itself can be undone (the session's result was kept).
  await settings.restoreSettingsVersion(settings.undoVersionId('store')!);
  assert.equal(settings.getSettings('store').whatsappNumber, '+971502222222');
  t.mock.timers.reset();
});

// ── Review of BUH-02.03.00 ─────────────────────────────────────────────────

test('regression: an autosave never drops a saved key (a half-typed new address needs Save with the key)', async () => {
  await settings.updateSettings('sms', { customWebhook: { endpointUrl: 'https://93.184.215.40/sms', bearerToken: 'webhook-secret' } });
  assert.equal(await statusOf(settings.updateSettings('sms', { customWebhook: { endpointUrl: 'https://93.184.215.4' } }, { auto: true })), 409);
  assert.equal(settings.getSettings('sms').customWebhook.bearerToken, 'webhook-secret', 'the key is still there');
  assert.equal(settings.getSettings('sms').customWebhook.endpointUrl, 'https://93.184.215.40/sms');
  await settings.updateSettings('email', { smtpHost: '93.184.215.14', smtpPass: 'mail-secret', imapHost: '93.184.215.30', imapPass: 'box-secret' });
  assert.equal(await statusOf(settings.updateSettings('email', { imapHost: '93.184.215.31' }, { auto: true })), 409, 'mailbox address');
  assert.equal(await statusOf(settings.updateSettings('email', { smtpHost: '93.184.215.15' }, { auto: true })), 409, 'mail server address');
  assert.equal(settings.getSettings('email').imapPass, 'box-secret');
  // Pressing Save with the new address (and its key) works as before.
  await settings.updateSettings('email', { imapHost: '93.184.215.31', imapPass: 'new-box-secret' });
  assert.equal(settings.getSettings('email').imapPass, 'new-box-secret');
});

test('regression: a slow save (still trying the mail server) never overwrites a newer one', async () => {
  let release: () => void = () => {};
  const slow = async () => new Promise<void>((r) => (release = r));
  getDb().prepare("DELETE FROM kv WHERE key = 'settings:good:email'").run();
  const pending = guard.saveGuarded('email', { smtpUser: 'slow@shop.ae' }, { email: slow });
  await new Promise((r) => setTimeout(r, 20));
  await settings.updateSettings('email', { fromAddress: 'newer@shop.ae' });
  release();
  assert.equal(await statusOf(pending), 409);
  assert.equal(settings.getSettings('email').fromAddress, 'newer@shop.ae', 'the newer save stays');
  assert.notEqual(settings.getSettings('email').smtpUser, 'slow@shop.ae');
});

test('regression: only autosaves merge into a session; every Save is kept in history', async () => {
  const start = historyCount('delivery');
  await settings.updateSettings('delivery', { standardDays: '1–2 days' });
  await settings.updateSettings('delivery', { standardDays: '1–3 days' });
  await settings.updateSettings('delivery', { standardDays: '2 days' });
  assert.equal(historyCount('delivery'), start + 2, 'two Saves after the first: two versions kept');
});

test('regression: "known working" is keyed with the server secret, not a plain hash of the passwords', async () => {
  guard.markWorking('email');
  const stored = (getDb().prepare("SELECT data FROM kv WHERE key = 'settings:good:email'").pluck().get() as string);
  const crypto = await import('node:crypto');
  const plain = crypto.createHash('sha256').update(JSON.stringify(settings.getSettings('email'))).digest('base64url');
  assert.ok(!stored.includes(plain));
  assert.equal(guard.isKnownWorking('email'), true);
});

test('regression: an autosave right after a Save starts a new session, so Undo goes back only to that Save', async () => {
  await settings.updateSettings('catalog', { lowStockThreshold: 2 });
  await settings.updateSettings('catalog', { lowStockThreshold: 3 }); // Save
  await settings.updateSettings('catalog', { lowStockThreshold: 4 }, { auto: true });
  await settings.updateSettings('catalog', { lowStockThreshold: 5 }, { auto: true });
  await settings.restoreSettingsVersion(settings.undoVersionId('catalog')!);
  assert.equal(settings.getSettings('catalog').lowStockThreshold, 3, 'back to the Save, not further');
});

test('reported: TLS on a STARTTLS port gave "ssl3_get_record:wrong version number"; the owner now reads which security setting to pick', async () => {
  const net = await import('node:net');
  const tls = await import('node:tls');
  // A plain-text "mail server" (like port 587 before STARTTLS) answered with TLS gives the real OpenSSL error.
  const server = net.createServer((sock) => sock.end('220 mail.example ESMTP ready\r\n'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const real = await new Promise<Error>((resolve) => {
    const c = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false });
    c.on('error', resolve);
    c.on('secureConnect', () => resolve(new Error('unexpected handshake')));
  });
  server.close();
  assert.match(real.message, /wrong version number|packet length|EPROTO/i);
  const text = guard.explainMailError(real, { smtpPort: 587, smtpSecurity: 'tls' });
  assert.match(text, /port 587 needs Security “STARTTLS”/);
  assert.doesNotMatch(text, /ssl3|openssl/i);
  assert.match(guard.explainMailError(real, { smtpPort: 465, smtpSecurity: 'starttls' }), /port 465 needs Security “TLS”/);
});

test('mail errors in plain words: refused password, unreachable server, unknown name; anything else keeps the server’s own words', () => {
  assert.match(guard.explainMailError(Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 }), { smtpPort: 587, smtpSecurity: 'starttls' }), /app password/);
  assert.match(guard.explainMailError(Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:587'), { code: 'ETIMEDOUT' }), { smtpPort: 587, smtpSecurity: 'starttls' }), /could not reach the mail server on port 587/);
  assert.match(guard.explainMailError(new Error('getaddrinfo ENOTFOUND smtp.gmial.com'), { smtpPort: 587, smtpSecurity: 'starttls' }), /not found/);
  assert.equal(guard.explainMailError(new Error('450 mailbox busy'), { smtpPort: 587, smtpSecurity: 'starttls' }), 'the mail server said: 450 mailbox busy');
});
