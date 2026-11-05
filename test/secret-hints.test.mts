/**
 * Saved keys show their last 4 characters in the hub (asked by the owner, to tell which key is
 * saved): the courier, SMS and Stripe keys like the AI keys already did. Never a password (email),
 * never a short key (4 characters would say too much), never the key itself.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const { adminView, updateSettings } = await import('@/lib/server/settings');

test('courier, SMS and Stripe keys: ••••last4 once saved; the key itself never leaves the server', async () => {
  const jeebly = 'jb_live_9f8e7d6c5b4a3210WXYZ';
  const client = 'client-key-0123456789-ABCD';
  await updateSettings('courier', { jeebly: { apiKey: jeebly, clientKey: client } });
  const c = adminView('courier');
  assert.equal(c.secretsHint?.['jeebly.apiKey'], '••••WXYZ');
  assert.equal(c.secretsHint?.['jeebly.clientKey'], '••••ABCD');
  assert.equal(c.value.jeebly.apiKey, '');
  assert.ok(!JSON.stringify(c).includes(jeebly) && !JSON.stringify(c).includes(client));

  await updateSettings('sms', { infobip: { apiKey: 'infobip-key-123456789-LAST' } });
  assert.equal(adminView('sms').secretsHint?.['infobip.apiKey'], '••••LAST');

  const sk = 'sk_test_51abcdefghijklmnopqrstuvwxyz1234567890QRST';
  await updateSettings('payments', { stripeSecretKey: sk });
  const p = adminView('payments');
  assert.equal(p.secretsHint?.stripeSecretKey, '••••QRST');
  assert.ok(!JSON.stringify(p).includes(sk));
});

test('never a password, never a short key', async () => {
  await updateSettings('email', { smtpPass: 'a-long-mail-password-1234567' });
  const e = adminView('email');
  assert.equal(e.secretsSet.smtpPass, true);
  assert.equal(e.secretsHint?.smtpPass, undefined);
  await updateSettings('courier', { echo: { apiKey: 'short-key-15chr' } });
  const c = adminView('courier');
  assert.equal(c.secretsSet['echo.apiKey'], true);
  assert.equal(c.secretsHint?.['echo.apiKey'], undefined);
});
