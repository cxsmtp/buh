/**
 * One container image serves any shop: the support email and the shop's
 * address come from the environment when the server starts, not from the
 * machine that built it. Runs against the production build.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasBuild, setPhoneCheck, startServer } from './server.mjs';

test('regression: support email and shop address are read at start-up, not frozen into the build', { skip: !hasBuild }, async () => {
  const server = await startServer({ NEXT_PUBLIC_SUPPORT_EMAIL: 'help@myshop.example', NEXT_PUBLIC_APP_URL: 'https://myshop.example' });
  try {
    const settings = await (await fetch(`${server.base}/api/settings/public`)).json();
    assert.equal(settings.supportEmail, 'help@myshop.example');
    // The SMS-code checkout (Settings → Phone check), where international numbers are sent to the email.
    await setPhoneCheck(server, 'sms_code');

    const post = (origin: string) =>
      fetch(`${server.base}/api/otp/send`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ phone: '+44 7700 900123' }) });
    const intl = await post(server.base);
    assert.match((await intl.json()).message, /help@myshop\.example/, 'international customers are sent to this shop');
    // The configured public address counts as this site (behind a proxy the Host may differ).
    assert.notEqual((await post('https://myshop.example')).status, 403);
    assert.equal((await post('https://elsewhere.example')).status, 403);
  } finally {
    server.stop();
  }
});

test('a bad or missing support email falls back to the default', { skip: !hasBuild }, async () => {
  const server = await startServer({ NEXT_PUBLIC_SUPPORT_EMAIL: 'not an email' });
  try {
    assert.equal((await (await fetch(`${server.base}/api/settings/public`)).json()).supportEmail, 'orders@beautifuluaehome.com');
  } finally {
    server.stop();
  }
});
