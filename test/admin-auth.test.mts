import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.SESSION_SECRET;

const auth = await import('@/lib/server/adminAuth');
const { hashPassword, verifyPassword, passwordProblem } = await import('@/lib/server/password');

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e) => (typeof e?.status === "number" ? e.status : -1));

// Capture the one-time password printed on first start.
async function firstRunPassword(): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    await auth.signIn('nobody@example.com', 'x').catch(() => {}); // loads (creates) the account
  } finally {
    console.log = original;
  }
  const match = lines.join('\n').match(/Password: (\S+)/);
  assert.ok(match, 'first-run password printed');
  return match![1];
}

test('scrypt hashes verify and reject', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem('aaaaaaaaaaaaaaaa'));
  assert.equal(passwordProblem('a-Much-Better-Passphrase'), null);
});

test('first run: random password, stored hashed with owner-only permissions, must be changed', async () => {
  const password = await firstRunPassword();
  const file = path.join(dir, 'admin.json');
  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes(password), 'password is not stored in clear');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const result = await auth.signIn('ADMIN@beautifuluaehome.com', password);
  assert.equal(result.mustChangePassword, true);
  const session = await auth.verifySessionToken(result.token);
  assert.equal(session?.mustChangePassword, true);

  // Same answer for an unknown account as for a wrong password: no enumeration.
  assert.equal(await statusOf(auth.signIn('nobody@example.com', password)), 401);
  assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', 'nope')), 401);

  const fresh = await auth.changePassword(password, 'A-new-Admin-Passphrase!');
  assert.ok(await auth.verifySessionToken(fresh));
  assert.equal(await auth.verifySessionToken(result.token), null, 'older sessions end on password change');
  assert.equal((await auth.verifySessionToken(fresh))?.mustChangePassword, false);
});

test('lockout after 5 failures; only the right password learns about it', async () => {
  for (let i = 0; i < 5; i++) assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', `bad-${i}`)), 401);
  assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', 'still-bad')), 401);
  assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!')), 423);
  // After the lock period it works again.
  const later = Date.now() + 16 * 60 * 1000;
  const ok = await auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!', later);
  assert.ok(ok.token);
});

test('session tokens: tampered, expired and malformed tokens are rejected', async () => {
  const ok = await auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!', Date.now() + 20 * 60 * 1000);
  const [body, sig] = ok.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), exp: Date.now() + 1e9 })).toString('base64url');
  assert.equal(await auth.verifySessionToken(`${forged}.${sig}`), null);
  assert.equal(await auth.verifySessionToken(`${body}.${sig}x`), null);
  assert.equal(await auth.verifySessionToken('garbage'), null);
  assert.equal(await auth.verifySessionToken(ok.token, Date.now() + auth.SESSION_TTL_MS + 25 * 60 * 1000), null);

  const cookie = auth.sessionCookie(ok.token);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
});
