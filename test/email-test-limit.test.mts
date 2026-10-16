/**
 * Reported: after a few failed tries with wrong mail settings, "Send a test email" said
 * "Too many test emails. Try again later." although none had been sent. Only emails that
 * were actually sent count towards the hourly limit now.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasBuild, startServer } from './server.mjs';

const limits = await import('@/lib/server/rateLimit');

test('limits: peeking counts nothing; recorded hits are what fill the limit', () => {
  const key = 'test:sent';
  for (let i = 0; i < 20; i++) assert.equal(limits.peekLimit(key, 10, 60_000).ok, true, 'a peek never counts');
  for (let i = 0; i < 10; i++) limits.recordHit(key);
  const full = limits.peekLimit(key, 10, 60_000);
  assert.equal(full.ok, false);
  assert.ok(full.retryAfterSec > 0 && full.retryAfterSec <= 60);
});

test('failed test emails do not use up the limit: 15 failed tries in a row each get the reason, never "too many"', { skip: !hasBuild }, async () => {
  // A mail server whose name doesn't exist: every try fails quickly and nothing is sent.
  const shop = await startServer({ TRUST_PROXY: '1', SMTP_HOST: 'mail.invalid', SMTP_PORT: '587', SMTP_USER: 'shop@example.com', SMTP_PASS: 'x', BACKUP_EMAIL: 'owner@example.com' });
  try {
    const headers = (cookie = '') => ({ 'content-type': 'application/json', origin: shop.base, 'x-real-ip': '203.0.113.7', ...(cookie ? { cookie } : {}) });
    await fetch(`${shop.base}/api/admin/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
    let found: RegExpMatchArray | null = null;
    for (let i = 0; i < 150 && !(found = shop.log().match(/Password: (\S+)/)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(found, 'the one-time password was printed');
    const login = await fetch(`${shop.base}/api/admin/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: 'admin@beautifuluaehome.com', password: found[1] }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const changed = await fetch(`${shop.base}/api/admin/password`, { method: 'POST', headers: headers(cookie), body: JSON.stringify({ currentPassword: found[1], newPassword: 'Owner-Own-Passphrase-1' }) });
    const session = (changed.headers.get('set-cookie') || '').split(';')[0] || cookie;
    for (let i = 1; i <= 15; i++) {
      const res = await fetch(`${shop.base}/api/admin/email-test`, { method: 'POST', headers: headers(session), body: '{}' });
      const body = (await res.json()) as { message?: string };
      assert.notEqual(res.status, 429, `try ${i}: ${body.message}`);
      assert.ok(res.status >= 400, `try ${i} failed as expected (${res.status})`);
      assert.doesNotMatch(String(body.message), /too many/i);
    }
  } finally {
    shop.stop();
  }
});
