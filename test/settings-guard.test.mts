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
  for (const n of ['+97150222', '+971502222', '+9715022222', '+971502222222']) await settings.updateSettings('store', { whatsappNumber: n });
  assert.equal(historyCount('store'), startCount + 1, 'one history entry for the whole session');
  const undo = settings.undoVersionId('store')!;
  await settings.restoreSettingsVersion(undo);
  assert.equal(settings.getSettings('store').whatsappNumber, '+971501111111', 'Undo: as before the session');
  // The undo itself can be undone (the session's result was kept).
  await settings.restoreSettingsVersion(settings.undoVersionId('store')!);
  assert.equal(settings.getSettings('store').whatsappNumber, '+971502222222');
  t.mock.timers.reset();
});
