/**
 * The owner can always get back into the Admin Hub: one-time recovery codes
 * and passkeys (WebAuthn), checked against a software authenticator.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { SoftAuthenticator } from './fixtures/soft-authenticator.mjs';

const dir = tempDataDir();
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
delete process.env.SESSION_SECRET;
delete process.env.NEXT_PUBLIC_APP_URL;
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'BACKUP_EMAIL', 'SMTP_FROM']) delete process.env[k];

const auth = await import('@/lib/server/adminAuth');
const codes = await import('@/lib/server/recoveryCodes');
const passkeys = await import('@/lib/server/passkeys');
const { getDb } = await import('@/lib/server/db');

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e) => (typeof e?.status === 'number' ? e.status : -1));
const EMAIL = 'admin@beautifuluaehome.com';
const PW = 'Owner-Own-Passphrase-1';

async function setUp() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    await auth.signIn('nobody@example.com', 'x', { ip: '192.0.2.250' }).catch(() => {});
  } finally {
    console.log = original;
  }
  await auth.changePassword(lines.join('\n').match(/Password: (\S+)/)![1], PW);
  auth._resetAdminAuthState(); // forget the setup's failed attempt
}
await setUp();

// ── Recovery codes ───────────────────────────────────────────────────────────

test('recovery codes: 10 readable codes with 80 random bits each; only hashes are stored', () => {
  const set = codes.createRecoveryCodes();
  assert.equal(set.length, 10);
  assert.equal(new Set(set).size, 10);
  for (const c of set) assert.match(c, /^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/, 'grouped, no 0/O/1/I');
  // 16 characters from a 32-letter alphabet = 80 bits.
  assert.equal(c16(set[0]).length, 16);
  const rows = getDb().prepare('SELECT * FROM admin_recovery_codes').all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 10);
  const stored = JSON.stringify(rows);
  for (const c of set) {
    assert.ok(!stored.includes(c) && !stored.includes(c16(c)), 'no code in clear');
  }
  assert.deepEqual({ ...codes.recoveryCodeStatus(), createdAt: null }, { total: 10, remaining: 10, createdAt: null });
});

function c16(code: string) {
  return code.replace(/-/g, '');
}

test('a recovery code signs in once, ends every other session, and asks for a new password (no current password)', async () => {
  const set = codes.createRecoveryCodes();
  const before = await auth.signIn(EMAIL, PW, { ip: '198.51.100.10' });

  // Typed loosely: lower case, spaces instead of dashes.
  const result = await auth.signInWithRecoveryCode(` ${EMAIL.toUpperCase()} `, set[0].toLowerCase().replace(/-/g, ' '), { ip: '198.51.100.10' });
  assert.equal(result.mustChangePassword, true);
  assert.equal(result.managedByEnv, false);
  assert.equal(result.remaining, 9);
  assert.equal(await auth.verifySessionToken(before.token), null, 'other sessions end');

  const session = (await auth.verifySessionToken(result.token))!;
  assert.equal(session.method, 'recovery');
  assert.equal(session.recoveryPending, true);
  assert.equal(session.mustChangePassword, true, 'nothing else until a new password is chosen');
  assert.ok(session.expiresAt - session.issuedAt <= auth.RECOVERY_SESSION_TTL_MS);

  // The same code again: refused.
  assert.equal(await statusOf(auth.signInWithRecoveryCode(EMAIL, set[0], { ip: '198.51.100.10' })), 401);

  const fresh = await auth.setPasswordAfterRecovery(session, 'Recovered-Passphrase-22');
  assert.equal(await auth.verifySessionToken(result.token), null, 'the recovery session ends with the change');
  const normal = (await auth.verifySessionToken(fresh))!;
  assert.equal(normal.method, 'password');
  assert.equal(normal.mustChangePassword, false);
  assert.ok((await auth.signIn(EMAIL, 'Recovered-Passphrase-22', { ip: '198.51.100.10' })).token);
  // A normal session can't skip the current password.
  assert.equal(await statusOf(auth.setPasswordAfterRecovery(normal, 'Sneaky-Passphrase-333')), 400);
  await auth.changePassword('Recovered-Passphrase-22', PW, { ip: '198.51.100.10' });
});

test('a code works for the admin email only, and a wrong email does not use it up', async () => {
  const set = codes.createRecoveryCodes();
  assert.equal(await statusOf(auth.signInWithRecoveryCode('someone@else.com', set[1], { ip: '198.51.100.11' })), 401);
  assert.equal(codes.recoveryCodeStatus().remaining, 10, 'not used up');
  assert.ok((await auth.signInWithRecoveryCode(EMAIL, set[1], { ip: '198.51.100.11' })).token);
});

test('a new set voids the old one', async () => {
  const old = codes.createRecoveryCodes();
  const fresh = codes.createRecoveryCodes();
  assert.equal(await statusOf(auth.signInWithRecoveryCode(EMAIL, old[2], { ip: '198.51.100.12' })), 401);
  assert.equal(codes.recoveryCodeStatus().remaining, 10);
  assert.ok((await auth.signInWithRecoveryCode(EMAIL, fresh[2], { ip: '198.51.100.12' })).token);
  assert.equal(codes.recoveryCodeStatus().remaining, 9);
});

test('one code used twice at the same moment: only one sign-in succeeds', async () => {
  const set = codes.createRecoveryCodes();
  const results = await Promise.all([
    statusOf(auth.signInWithRecoveryCode(EMAIL, set[3], { ip: '198.51.100.13' })),
    statusOf(auth.signInWithRecoveryCode(EMAIL, set[3], { ip: '198.51.100.14' })),
    statusOf(auth.signInWithRecoveryCode(EMAIL, set[3], { ip: '198.51.100.15' })),
  ]);
  assert.deepEqual(results.sort(), [0, 401, 401]);
  assert.equal(codes.recoveryCodeStatus().remaining, 9);
});

test('two copies of the shop sharing the database use one code at the same moment: exactly one wins', async () => {
  const set = codes.createRecoveryCodes();
  for (let round = 0; round < 3; round++) {
    const startAt = Date.now() + 1500;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('test/fixtures/consume-recovery-code.mts'), set[round], String(startAt)], {
          env: { ...process.env, DATA_DIR: dir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
      });
    const outcomes = await Promise.all([run(), run()]);
    assert.deepEqual(outcomes.sort(), ['false', 'true'], `round ${round}`);
  }
  assert.equal(codes.recoveryCodeStatus().remaining, 7);
});

test('wrong recovery codes are paused exactly like wrong passwords, and a pause reveals nothing', async () => {
  auth._resetAdminAuthState();
  const set = codes.createRecoveryCodes();
  const attacker = { ip: '203.0.113.77' };
  // Wrong passwords and wrong codes count together.
  for (let i = 0; i < 2; i++) assert.equal(await statusOf(auth.signIn(EMAIL, `bad-${i}`, attacker)), 401);
  for (let i = 0; i < 3; i++) assert.equal(await statusOf(auth.signInWithRecoveryCode(EMAIL, 'ABCD-EFGH-JKLM-NPQR', attacker)), 401);
  // Paused: a right code gets the same answer as a wrong one, and is not used up.
  assert.equal(await statusOf(auth.signInWithRecoveryCode(EMAIL, 'WXYZ-WXYZ-WXYZ-WXYZ', attacker)), 429);
  assert.equal(await statusOf(auth.signInWithRecoveryCode(EMAIL, set[0], attacker)), 429);
  assert.equal(codes.recoveryCodeStatus().remaining, 10, 'not even looked at while paused');
  assert.equal(await statusOf(auth.signIn(EMAIL, PW, attacker)), 429, 'the password is paused too');
  // The owner elsewhere is not locked out; the pause ends after 15 minutes.
  assert.ok((await auth.signInWithRecoveryCode(EMAIL, set[0], { ip: '198.51.100.16' })).token);
  assert.ok((await auth.signInWithRecoveryCode(EMAIL, set[1], { ...attacker, now: Date.now() + 16 * 60 * 1000 })).token);
  auth._resetAdminAuthState();
});

test('creating codes needs the current password, or a passkey sign-in in the last 10 minutes', async () => {
  const password = (await auth.verifySessionToken((await auth.signIn(EMAIL, PW, { ip: '198.51.100.17' })).token))!;
  assert.equal(await statusOf(auth.confirmOwner(password, '', { allowFreshPasskey: true })), 400);
  assert.equal(await statusOf(auth.confirmOwner(password, 'wrong-password', { ip: '198.51.100.17' })), 400, 'a 400: the owner stays signed in');
  assert.equal(await statusOf(auth.confirmOwner(password, PW, { ip: '198.51.100.17' })), 0);
  const viaPasskey = (await auth.verifySessionToken((await auth.passkeySession()).token))!;
  assert.equal(viaPasskey.method, 'passkey');
  assert.equal(await statusOf(auth.confirmOwner(viaPasskey, '', { allowFreshPasskey: true })), 0);
  assert.equal(await statusOf(auth.confirmOwner(viaPasskey, '')), 400, 'adding a passkey always asks for the password');
  assert.equal(auth.isFreshPasskeySession(viaPasskey, viaPasskey.issuedAt + 11 * 60 * 1000), false);
});

// ── Passkeys ─────────────────────────────────────────────────────────────────

const RP = { rpID: 'shop.example', origin: 'https://shop.example' };
const binding = 'session-binding-1';

async function addPasskey(device: SoftAuthenticator, name = 'My phone') {
  const { options, challengeId } = await passkeys.startPasskeyRegistration({ rp: RP, email: EMAIL, boundTo: binding });
  assert.equal(options.authenticatorSelection?.userVerification, 'required');
  assert.equal(options.authenticatorSelection?.residentKey, 'required');
  const response = passkeys.parseRegistrationResponse(device.register(options as never, RP.origin));
  return passkeys.finishPasskeyRegistration({ rp: RP, challengeId, boundTo: binding, response, name });
}

async function passkeySignIn(device: SoftAuthenticator, origin = RP.origin, rpId = RP.rpID) {
  const { options, challengeId } = await passkeys.startPasskeySignIn({ rp: RP });
  assert.equal(options.userVerification, 'required');
  assert.deepEqual(options.allowCredentials ?? [], [], 'discoverable: no list of passkeys handed out');
  const answer = device.signIn(options as never, origin, rpId);
  return { challengeId, answer, finish: (id = challengeId) => passkeys.finishPasskeySignIn({ rp: RP, challengeId: id, response: passkeys.parseAuthenticationResponse(answer) }) };
}

test('passkey: add, sign in, last used recorded; only the public key is kept', async () => {
  const phone = new SoftAuthenticator({ countsUses: true });
  const added = await addPasskey(phone, '  My\u0000 iPhone  ');
  assert.equal(added.name, 'My iPhone', 'name cleaned');
  assert.equal(added.lastUsedAt, null);
  assert.equal(added.synced, true);
  assert.deepEqual(passkeys.listPasskeys(RP.rpID).map((p) => p.name), ['My iPhone']);

  const attempt = await passkeySignIn(phone);
  const used = await attempt.finish();
  assert.equal(used.name, 'My iPhone');
  assert.ok(passkeys.listPasskeys()[0].lastUsedAt);
  const session = await auth.passkeySession();
  assert.ok(await auth.verifySessionToken(session.token), 'the same kind of session as a password sign-in');

  // The same phone can't be added twice.
  const again = await passkeys.startPasskeyRegistration({ rp: RP, email: EMAIL, boundTo: binding });
  assert.deepEqual(again.options.excludeCredentials?.map((c) => c.id), [phone.id]);
  assert.equal(await statusOf(passkeys.finishPasskeyRegistration({ rp: RP, challengeId: again.challengeId, boundTo: binding, response: passkeys.parseRegistrationResponse(phone.register(again.options as never, RP.origin)), name: 'x' })), 409);
});

test('passkey: a replayed challenge, a wrong origin, a wrong domain, no user verification and an unknown passkey are refused', async () => {
  const phone = new SoftAuthenticator({ countsUses: true });
  await addPasskey(phone, 'Laptop');

  const ok = await passkeySignIn(phone);
  await ok.finish();
  assert.equal(await statusOf(ok.finish()), 400, 'the challenge was used up: a replay is refused');

  const phishing = await passkeySignIn(phone, 'https://shop-example.evil');
  assert.equal(await statusOf(phishing.finish()), 401, 'wrong origin');
  assert.equal(await statusOf(phishing.finish()), 400, 'and that challenge is gone too');

  const otherDomain = await passkeySignIn(phone, RP.origin, 'evil.example');
  assert.equal(await statusOf(otherDomain.finish()), 401, 'signed for another domain');

  phone.verifyUser = false;
  const noUv = await passkeySignIn(phone);
  assert.equal(await statusOf(noUv.finish()), 401, 'fingerprint/PIN required');
  phone.verifyUser = true;

  const stranger = new SoftAuthenticator();
  stranger.userHandle = 'c29tZW9uZQ';
  assert.equal(await statusOf((await passkeySignIn(stranger)).finish()), 401, 'not one of this shop’s passkeys');

  assert.equal(await statusOf(passkeys.finishPasskeySignIn({ rp: RP, challengeId: null, response: passkeys.parseAuthenticationResponse(phone.signIn({ challenge: 'x', rpId: RP.rpID }, RP.origin)) })), 400, 'no challenge cookie');
});

test('passkey: a counter that goes backwards (a copied key) is refused; synced passkeys without a counter are fine', async () => {
  const key = new SoftAuthenticator({ countsUses: true });
  await addPasskey(key, 'Security key');
  await (await passkeySignIn(key)).finish();
  await (await passkeySignIn(key)).finish();
  key.counter = 0; // the copy has an older counter
  await assert.rejects((await passkeySignIn(key)).finish(), (e: unknown) => e instanceof passkeys.PasskeyCloneSuspected);

  const synced = new SoftAuthenticator(); // iCloud / Google passkeys always say 0
  await addPasskey(synced, 'Synced');
  await (await passkeySignIn(synced)).finish();
  await (await passkeySignIn(synced)).finish();
});

test('passkey: adding is tied to the session that asked, and challenges expire after 5 minutes', async () => {
  const phone = new SoftAuthenticator();
  const { options, challengeId } = await passkeys.startPasskeyRegistration({ rp: RP, email: EMAIL, boundTo: binding });
  const response = passkeys.parseRegistrationResponse(phone.register(options as never, RP.origin));
  assert.equal(await statusOf(passkeys.finishPasskeyRegistration({ rp: RP, challengeId, boundTo: 'another-session', response, name: 'x' })), 400);

  const late = await passkeys.startPasskeySignIn({ rp: RP, now: Date.now() - 6 * 60 * 1000 });
  assert.equal(await statusOf(passkeys.finishPasskeySignIn({ rp: RP, challengeId: late.challengeId, response: passkeys.parseAuthenticationResponse(phone.signIn(late.options as never, RP.origin)) })), 400);
});

test('passkey: the challenge cookie is HttpOnly, SameSite=Strict, and forged ids are ignored', () => {
  const cookie = passkeys.challengeCookie('abc123');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(passkeys.challengeIdFromCookie(cookie.value), 'abc123');
  assert.equal(passkeys.challengeIdFromCookie('abc123.forged'), null);
  assert.equal(passkeys.challengeIdFromCookie(undefined), null);
});

test('passkey: the domain comes from NEXT_PUBLIC_APP_URL, never from an untrusted Host header', () => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  assert.ok('problem' in passkeys.relyingParty('shop.example'), 'a public Host header alone is not trusted');
  assert.deepEqual(passkeys.relyingParty('localhost:3000'), { rpID: 'localhost', origin: 'http://localhost:3000' });
  process.env.NEXT_PUBLIC_APP_URL = 'https://Shop.Example/';
  assert.deepEqual(passkeys.relyingParty('evil.example'), { rpID: 'shop.example', origin: 'https://shop.example' });
  process.env.NEXT_PUBLIC_APP_URL = 'http://shop.example';
  assert.match((passkeys.relyingParty('shop.example') as { problem: string }).problem, /https:\/\//);
  process.env.NEXT_PUBLIC_APP_URL = 'https://203.0.113.5';
  assert.ok('problem' in passkeys.relyingParty(null));
  delete process.env.NEXT_PUBLIC_APP_URL;
});

test('passkey: removing one stops it working', async () => {
  const phone = new SoftAuthenticator();
  const added = await addPasskey(phone, 'Old phone');
  assert.equal(passkeys.removePasskey(added.id)?.name, 'Old phone');
  assert.equal(passkeys.removePasskey(added.id), null);
  assert.equal(await statusOf((await passkeySignIn(phone)).finish()), 401);
});

test('only WebAuthn fields are accepted from the browser', () => {
  assert.throws(() => passkeys.parseAuthenticationResponse({ id: 'a', rawId: 'a', type: 'password', response: {} }), /not valid/);
  assert.throws(() => passkeys.parseAuthenticationResponse({ id: 'a b', rawId: 'a', type: 'public-key', response: { clientDataJSON: 'a', authenticatorData: 'a', signature: 'a' } }), /not valid/);
  const parsed = passkeys.parseAuthenticationResponse({ id: 'a', rawId: 'a', type: 'public-key', extra: 'x', response: { clientDataJSON: 'a', authenticatorData: 'a', signature: 'a', sneaky: 1 }, clientExtensionResults: { x: 1 } });
  assert.deepEqual(parsed, { id: 'a', rawId: 'a', type: 'public-key', response: { clientDataJSON: 'a', authenticatorData: 'a', signature: 'a' }, clientExtensionResults: {} });
  assert.ok(fs.existsSync(path.join(dir, 'shop.db')));
});
