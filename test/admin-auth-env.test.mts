import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const { hashPassword } = await import('@/lib/server/password');
process.env.ADMIN_EMAIL = 'Owner@Shop.ae';
process.env.ADMIN_PASSWORD_HASH = await hashPassword('Owner-Env-Passphrase');
process.env.SESSION_SECRET = 'x'.repeat(40);
const auth = await import('@/lib/server/adminAuth');

test('an environment-managed account signs in without a forced change, and cannot be changed in the app', async () => {
  const ok = await auth.signIn(' owner@shop.ae ', 'Owner-Env-Passphrase');
  assert.equal(ok.mustChangePassword, false);
  assert.ok(await auth.verifySessionToken(ok.token));
  await assert.rejects(auth.changePassword('Owner-Env-Passphrase', 'Another-Passphrase-1'), (e: { status?: number }) => e.status === 409);
});

test('rotating ADMIN_PASSWORD_HASH ends existing sessions', async () => {
  const before = await auth.signIn('owner@shop.ae', 'Owner-Env-Passphrase');
  process.env.ADMIN_PASSWORD_HASH = await hashPassword('Rotated-Env-Passphrase');
  auth._resetAdminAuthState();
  assert.equal(await auth.verifySessionToken(before.token), null);
  assert.ok((await auth.signIn('owner@shop.ae', 'Rotated-Env-Passphrase')).token);
});

test('cookies are Secure in production', () => {
  const env = process.env as Record<string, string | undefined>;
  const before = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    assert.equal(auth.sessionCookie('t').secure, true);
    assert.equal(auth.clearedSessionCookie().maxAge, 0);
  } finally {
    env.NODE_ENV = before;
  }
});

test('a recovery code still signs in to an environment-managed account, but the password stays in the environment', async () => {
  const { createRecoveryCodes } = await import('@/lib/server/recoveryCodes');
  const [code] = createRecoveryCodes();
  const result = await auth.signInWithRecoveryCode('owner@shop.ae', code);
  assert.equal(result.managedByEnv, true);
  assert.equal(result.mustChangePassword, false, 'nothing to choose here: the hash is in .env.production');
  const session = (await auth.verifySessionToken(result.token))!;
  assert.equal(session.recoveryPending, false);
  assert.equal(session.mustChangePassword, false);
  await assert.rejects(auth.setPasswordAfterRecovery(session, 'Another-Passphrase-1'), (e: { status?: number }) => e.status === 409);
});

test('a short SESSION_SECRET is refused rather than used', async () => {
  auth._resetAdminAuthState();
  process.env.SESSION_SECRET = 'short';
  assert.throws(() => auth.createSessionToken({ email: 'a', passwordHash: 'h' }), /32 characters/);
  process.env.SESSION_SECRET = 'x'.repeat(40);
  auth._resetAdminAuthState();
});
