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

test('5 wrong passwords pause sign-in from that address only, without checking the password', async () => {
  const PW = 'A-new-Admin-Passphrase!';
  const attacker = { ip: '203.0.113.9' };
  for (let i = 0; i < 5; i++) assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', `bad-${i}`, attacker)), 401);
  // Paused: the right and the wrong password get the same answer (no oracle).
  assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', 'still-bad', attacker)), 429);
  assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', PW, attacker)), 429);
  // The owner on another address is not locked out by the stranger.
  assert.ok((await auth.signIn('admin@beautifuluaehome.com', PW, { ip: '198.51.100.7' })).token);
  // The pause ends after 15 minutes.
  assert.ok((await auth.signIn('admin@beautifuluaehome.com', PW, { ...attacker, now: Date.now() + 16 * 60 * 1000 })).token);
});

test('unknown emails are paused the same way (no hint that the account exists)', async () => {
  const ip = { ip: '203.0.113.50' };
  for (let i = 0; i < 5; i++) assert.equal(await statusOf(auth.signIn('nobody@example.com', `x${i}`, ip)), 401);
  assert.equal(await statusOf(auth.signIn('nobody@example.com', 'x', ip)), 429);
});

test('a guess spread over many addresses pauses the account everywhere after 50 failures', async () => {
  for (let i = 0; i < 50; i++) {
    await auth.signIn('admin@beautifuluaehome.com', 'bad', { ip: `192.0.2.${i}` }).catch(() => {});
  }
  assert.equal(await statusOf(auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!', { ip: '198.51.100.99' })), 429);
  auth._resetAdminAuthState();
});

test('signing out ends every session, including copied cookies', async () => {
  const a = await auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!', { ip: '198.51.100.1' });
  const b = await auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!', { ip: '198.51.100.2' });
  assert.ok(await auth.verifySessionToken(a.token));
  auth.endAllSessions();
  assert.equal(await auth.verifySessionToken(a.token), null);
  assert.equal(await auth.verifySessionToken(b.token), null);
  const c = await auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!', { ip: '198.51.100.1' });
  assert.ok(await auth.verifySessionToken(c.token), 'signing in again works');
});

test('session tokens: tampered, expired and malformed tokens are rejected', async () => {
  const ok = await auth.signIn('admin@beautifuluaehome.com', 'A-new-Admin-Passphrase!', { ip: '198.51.100.3' });
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
