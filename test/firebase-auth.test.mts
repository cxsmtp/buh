import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { jsonRequest, tempDataDir } from './helpers.mjs';

tempDataDir();
const { verifyFirebaseIdToken, FirebaseTokenError } = await import('@/lib/server/firebaseAuth');
const { confirmFirebasePhone } = await import('@/lib/server/firebasePhone');
const settings = await import('@/lib/server/settings');
const { verifyPhoneToken } = await import('@/lib/server/phoneToken');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const publicSettings = await import('@/app/api/settings/public/route');
const firebaseRoute = await import('@/app/api/otp/firebase/route');

// ── fixtures: an RSA key, a self-signed X.509 certificate for it, and signed tokens ──

const PROJECT = 'buh-shop-test';
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const NOW_SEC = NOW / 1000;

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

/** Minimal DER encoder, enough for a self-signed certificate (Node cannot create one itself). */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  let len: Buffer;
  if (body.length < 128) len = Buffer.from([body.length]);
  else {
    const bytes: number[] = [];
    for (let n = body.length; n; n >>= 8) bytes.unshift(n & 255);
    len = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
function selfSignedCert(pub: crypto.KeyObject, priv: crypto.KeyObject): string {
  const seq = (...p: Buffer[]) => der(0x30, ...p);
  const algId = seq(Buffer.from('06092a864886f70d01010b', 'hex'), Buffer.from([5, 0])); // sha256WithRSAEncryption
  const name = seq(der(0x31, seq(Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('securetoken test')))));
  const validity = seq(der(0x17, Buffer.from('250101000000Z')), der(0x17, Buffer.from('350101000000Z')));
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), algId, name, validity, name, pub.export({ type: 'spki', format: 'der' }));
  const cert = seq(tbs, algId, der(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, priv)));
  return `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
}
const CERT = selfSignedCert(publicKey, privateKey);
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    auth_time: NOW_SEC - 30,
    user_id: 'uid-123',
    sub: 'uid-123',
    iat: NOW_SEC - 10,
    exp: NOW_SEC + 3600,
    phone_number: '+971501234567',
    firebase: { identities: { phone: ['+971501234567'] }, sign_in_provider: 'phone' },
    ...over,
  };
}

function sign(payload: Record<string, unknown>, { kid = 'k1', key = privateKey, alg = 'RS256' }: { kid?: string; key?: crypto.KeyObject; alg?: string } = {}): string {
  const head = `${b64({ alg, kid, typ: 'JWT' })}.${b64(payload)}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), key).toString('base64url')}`;
}

/** A fresh fetcher per test (the certificate cache is per fetcher), counting calls. */
function fetcher(keys: Record<string, string> | (() => Record<string, string>), maxAgeSec = 3600) {
  const f = Object.assign(
    async () => {
      f.calls += 1;
      return { keys: typeof keys === 'function' ? keys() : keys, maxAgeSec };
    },
    { calls: 0 }
  );
  return f;
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'accepted';
  } catch (err) {
    return err instanceof FirebaseTokenError ? err.reason : `other: ${(err as Error).message}`;
  }
};

// ── the verifier ────────────────────────────────────────────────────────────

test('a valid Firebase phone token is accepted, against an X.509 certificate or a PEM public key', async () => {
  for (const pem of [CERT, PUBLIC_PEM]) {
    const user = await verifyFirebaseIdToken(sign(claims()), PROJECT, { fetchCerts: fetcher({ k1: pem }), now: NOW });
    assert.deepEqual(user, { phone: '+971501234567', uid: 'uid-123' });
  }
});

test('a token for another project, or from another issuer, is refused', async () => {
  const f = fetcher({ k1: CERT });
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims({ aud: 'someone-else' })), PROJECT, { fetchCerts: f, now: NOW })), 'audience');
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims({ iss: 'https://securetoken.google.com/someone-else' })), PROJECT, { fetchCerts: f, now: NOW })), 'issuer');
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims({ iss: 'https://evil.example/' + PROJECT })), PROJECT, { fetchCerts: f, now: NOW })), 'issuer');
  // A genuine token for project A is not valid for project B.
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims()), 'another-shop', { fetchCerts: f, now: NOW })), 'issuer');
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims()), '', { fetchCerts: f, now: NOW })), 'no project configured');
});

test('expired tokens and tokens from the future are refused (60 s skew for iat / auth_time)', async () => {
  const f = fetcher({ k1: CERT });
  const check = (c: Record<string, unknown>) => reason(verifyFirebaseIdToken(sign(claims(c)), PROJECT, { fetchCerts: f, now: NOW }));
  assert.equal(await check({ exp: NOW_SEC - 1 }), 'expired');
  assert.equal(await check({ exp: NOW_SEC }), 'expired');
  assert.equal(await check({ exp: undefined }), 'expired');
  assert.equal(await check({ iat: NOW_SEC + 120 }), 'issued in the future');
  assert.equal(await check({ iat: NOW_SEC + 30 }), 'accepted', 'within the skew');
  assert.equal(await check({ auth_time: NOW_SEC + 120 }), 'auth_time in the future');
  assert.equal(await check({ auth_time: NOW_SEC - 3600 }), 'sign-in too old');
});

test('a bad signature, or a token signed by another key, is refused', async () => {
  const f = fetcher({ k1: CERT });
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims(), { key: other.privateKey }), PROJECT, { fetchCerts: f, now: NOW })), 'signature');
  // Payload swapped after signing.
  const [h, , s] = sign(claims()).split('.');
  const tampered = `${h}.${b64(claims({ phone_number: '+971509999999' }))}.${s}`;
  assert.equal(await reason(verifyFirebaseIdToken(tampered, PROJECT, { fetchCerts: f, now: NOW })), 'signature');
  assert.equal(await reason(verifyFirebaseIdToken('a.b', PROJECT, { fetchCerts: f, now: NOW })), 'not a signed JWT');
  assert.equal(await reason(verifyFirebaseIdToken(42, PROJECT, { fetchCerts: f, now: NOW })), 'missing token');
});

test('alg none and HS256 (public key as HMAC secret) are refused without touching the network', async () => {
  const f = fetcher({ k1: CERT });
  const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.`;
  assert.equal(await reason(verifyFirebaseIdToken(none, PROJECT, { fetchCerts: f, now: NOW })), 'not a signed JWT');
  const noneSig = `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.eA`;
  assert.equal(await reason(verifyFirebaseIdToken(noneSig, PROJECT, { fetchCerts: f, now: NOW })), 'algorithm');
  const head = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(claims())}`;
  const hs = `${head}.${crypto.createHmac('sha256', PUBLIC_PEM).update(head).digest('base64url')}`;
  assert.equal(await reason(verifyFirebaseIdToken(hs, PROJECT, { fetchCerts: f, now: NOW })), 'algorithm');
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims(), { alg: 'RS512' }), PROJECT, { fetchCerts: f, now: NOW })), 'algorithm');
  assert.equal(f.calls, 0);
});

test('missing phone_number, empty sub or a non-phone sign-in is refused', async () => {
  const f = fetcher({ k1: CERT });
  const check = (c: Record<string, unknown>) => reason(verifyFirebaseIdToken(sign(claims(c)), PROJECT, { fetchCerts: f, now: NOW }));
  assert.equal(await check({ phone_number: undefined }), 'no phone number');
  assert.equal(await check({ phone_number: '0501234567' }), 'no phone number');
  assert.equal(await check({ sub: '' }), 'subject');
  assert.equal(await check({ firebase: { sign_in_provider: 'password' } }), 'not a phone sign-in');
});

test('certificates are cached for max-age; an unknown kid refetches once (not on every forged kid)', async () => {
  let published: Record<string, string> = { k1: CERT };
  const f = fetcher(() => published, 3600);
  const k2 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const opts = (now: number) => ({ fetchCerts: f, now });

  assert.equal(await reason(verifyFirebaseIdToken(sign(claims()), PROJECT, opts(NOW))), 'accepted');
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims()), PROJECT, opts(NOW + 1000))), 'accepted');
  assert.equal(f.calls, 1, 'cached');

  // Google rotates: k2 appears. Within a minute of the last fetch, an unknown kid is not refetched.
  published = { k1: CERT, k2: k2.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const t2 = (now: number) => sign(claims({ iat: Math.floor(now / 1000) - 5, auth_time: Math.floor(now / 1000) - 5, exp: Math.floor(now / 1000) + 3600 }), { kid: 'k2', key: k2.privateKey });
  assert.equal(await reason(verifyFirebaseIdToken(t2(NOW + 2000), PROJECT, opts(NOW + 2000))), 'unknown kid');
  assert.equal(f.calls, 1);
  // Later, the unknown kid triggers one refetch, and then verifies.
  const later = NOW + 2 * 60 * 1000;
  assert.equal(await reason(verifyFirebaseIdToken(t2(later), PROJECT, opts(later))), 'accepted');
  assert.equal(f.calls, 2);
  // A forged kid right after does not refetch again.
  assert.equal(await reason(verifyFirebaseIdToken(sign(claims(), { kid: 'forged' }), PROJECT, opts(later + 1000))), 'unknown kid');
  assert.equal(f.calls, 2);
  // After max-age the set is fetched again.
  const expired = later + 3601 * 1000;
  await reason(verifyFirebaseIdToken(t2(expired), PROJECT, opts(expired)));
  assert.equal(f.calls, 3);
});

test('a certificate fetch failure is an error, not a refusal (the route answers 503)', async () => {
  const failing = async () => {
    throw new Error('network down');
  };
  assert.match(await reason(verifyFirebaseIdToken(sign(claims()), PROJECT, { fetchCerts: failing, now: NOW })), /^other: network down/);
});

// ── settings ────────────────────────────────────────────────────────────────

const GOOD = { apiKey: 'AIza' + 'A'.repeat(35), authDomain: `${PROJECT}.firebaseapp.com`, projectId: PROJECT, appId: '1:123456789012:web:abcdef0123456789' };
const status = (p: Promise<unknown>) => p.then(() => 0, (e) => (typeof e?.status === 'number' ? e.status : -1));

test('settings: the Firebase block is validated strictly', async () => {
  settings._clearSettingsCache();
  for (const bad of [
    { apiKey: 'AIzaTooShort' },
    { apiKey: GOOD.apiKey + 'X' },
    { apiKey: 'BIza' + 'A'.repeat(35) },
    { projectId: 'UPPER-case' },
    { projectId: 'a/b' },
    { authDomain: 'https://x.firebaseapp.com' },
    { authDomain: 'x.firebaseapp.com/path' },
    { authDomain: 'localhost' },
    { authDomain: 'auth.shop.local' },
    { authDomain: '10.0.0.1' },
    { appId: 'my-app' },
    { appId: '1:123:ios:abc' },
  ]) {
    assert.equal(await status(settings.updateSettings('sms', { provider: 'firebase', isEnabled: false, firebase: bad })), 400, JSON.stringify(bad));
  }
  await settings.updateSettings('sms', { provider: 'firebase', isEnabled: false, firebase: { ...GOOD, authDomain: 'login.example.com' } });
  assert.equal(settings.getSettings('sms').firebase?.authDomain, 'login.example.com');
  await settings.updateSettings('sms', { provider: 'firebase', isEnabled: false, firebase: { authDomain: 'Buh-Shop-Test.FirebaseApp.com' } });
  assert.equal(settings.getSettings('sms').firebase?.authDomain, 'buh-shop-test.firebaseapp.com', 'lower-cased; other fields kept');
  assert.equal(settings.getSettings('sms').firebase?.apiKey, GOOD.apiKey);
});

test('settings: Firebase can only be switched on with all four values', async () => {
  settings._clearSettingsCache();
  await settings.updateSettings('sms', { provider: 'firebase', isEnabled: false, firebase: { apiKey: '', authDomain: '', projectId: '', appId: '' } });
  for (const missing of ['apiKey', 'authDomain', 'projectId', 'appId'] as const) {
    const partial = { ...GOOD, [missing]: '' };
    const err = await settings.updateSettings('sms', { provider: 'firebase', isEnabled: true, firebase: partial }).catch((e) => e);
    assert.equal(err?.status, 400, missing);
    assert.match(err.message, /every field/);
  }
  await settings.updateSettings('sms', { provider: 'firebase', isEnabled: true, firebase: GOOD });
  assert.equal(settings.getSettings('sms').isEnabled, true);
  await settings.updateSettings('sms', { isEnabled: false });
});

// ── public config and the route logic ─────────────────────────────────────

async function publicConfig() {
  const res = publicSettings.GET();
  return ((await res.json()) as { phoneVerification: { method: string; firebase?: Record<string, string> } }).phoneVerification;
}

test('/api/settings/public exposes the Firebase config only while Firebase is switched on', async () => {
  settings._clearSettingsCache();
  await settings.updateSettings('sms', { provider: 'firebase', isEnabled: false, firebase: GOOD });
  // Settings → Phone check "WhatsApp (free)" (the default): no code at all, so no Firebase config either.
  await settings.updateSettings('sms', { isEnabled: true });
  assert.deepEqual(await publicConfig(), { method: 'server', check: 'whatsapp', cancelHours: 24 });
  await settings.updateSettings('phoneCheck', { mode: 'sms_code' });
  await settings.updateSettings('sms', { isEnabled: false });
  assert.deepEqual(await publicConfig(), { method: 'server', check: 'sms_code' });

  await settings.updateSettings('sms', { isEnabled: true });
  assert.deepEqual(await publicConfig(), { method: 'firebase', firebase: GOOD, check: 'sms_code' });

  // A gateway in the server environment takes precedence, as for every other option.
  process.env.SMS_WEBHOOK_URL = 'https://sms.example.com/send';
  try {
    assert.deepEqual(await publicConfig(), { method: 'server', check: 'sms_code' });
  } finally {
    delete process.env.SMS_WEBHOOK_URL;
  }

  await settings.updateSettings('sms', { provider: 'twilio', isEnabled: false });
  assert.deepEqual(await publicConfig(), { method: 'server', check: 'sms_code' });
  await settings.updateSettings('phoneCheck', { mode: 'whatsapp' });
});

test('route logic: a UAE mobile gets the same signed phone token as /api/otp/verify; others are refused', async () => {
  settings._clearSettingsCache();
  await settings.updateSettings('sms', { provider: 'twilio', isEnabled: false });
  const f = fetcher({ k1: CERT });
  // Not switched on: no token is accepted at all.
  assert.equal(await status(confirmFirebasePhone(sign(claims()), { fetchCerts: f, now: NOW })), 404);

  await settings.updateSettings('sms', { provider: 'firebase', isEnabled: true, firebase: GOOD });
  // WhatsApp (free), the default: Firebase is never used, so no token is accepted either.
  assert.equal(await status(confirmFirebasePhone(sign(claims()), { fetchCerts: f, now: NOW })), 404);
  await settings.updateSettings('phoneCheck', { mode: 'sms_code' });
  const ok = await confirmFirebasePhone(sign(claims()), { fetchCerts: f, now: NOW });
  assert.equal(ok.valid, true);
  assert.equal(ok.phone, '+971501234567');
  assert.equal(verifyPhoneToken(ok.verificationToken), '+971501234567');

  const uk = claims({ phone_number: '+447700900123', firebase: { sign_in_provider: 'phone' } });
  assert.equal(await status(confirmFirebasePhone(sign(uk), { fetchCerts: f, now: NOW })), 400, 'non-UAE number');
  const landline = claims({ phone_number: '+97142345678' });
  assert.equal(await status(confirmFirebasePhone(sign(landline), { fetchCerts: f, now: NOW })), 400, 'UAE landline');
  const foreignProject = claims({ aud: 'another-shop', iss: 'https://securetoken.google.com/another-shop' });
  assert.equal(await status(confirmFirebasePhone(sign(foreignProject), { fetchCerts: f, now: NOW })), 401, 'another project');
  const down = async () => {
    throw new Error('timeout');
  };
  assert.equal(await status(confirmFirebasePhone(sign(claims()), { fetchCerts: down, now: NOW })), 503);
  await settings.updateSettings('sms', { isEnabled: false });
});

test('POST /api/otp/firebase: same-origin only, size-capped, and closed while Firebase is off', async () => {
  _clearAllRateLimits();
  settings._clearSettingsCache();
  await settings.updateSettings('sms', { provider: 'firebase', isEnabled: false, firebase: GOOD });
  const call = (body: unknown, headers: Record<string, string> = {}) =>
    firebaseRoute.POST(jsonRequest(body, headers, 'http://shop.test/api/otp/firebase') as never);
  assert.equal((await call({ idToken: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ idToken: 'x'.repeat(9000) }, { origin: 'http://shop.test' })).status, 413);
  const off = await call({ idToken: sign(claims()) }, { origin: 'http://shop.test' });
  assert.equal(off.status, 404);
  assert.equal(((await off.json()) as { valid: boolean }).valid, false);
});

test('CSP: only the Firebase phone-auth hosts (and Stripe’s, for card payments) are added, nothing else is loosened', async () => {
  const { contentSecurityPolicy } = await import('@/lib/csp');
  const csp = contentSecurityPolicy();
  const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(name + ' ')) ?? '';
  assert.match(directive('script-src'), /https:\/\/www\.google\.com\/recaptcha\/ https:\/\/www\.gstatic\.com\/recaptcha\/ https:\/\/apis\.google\.com https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com$/);
  assert.match(directive('connect-src'), /^connect-src 'self'.* https:\/\/identitytoolkit\.googleapis\.com https:\/\/securetoken\.googleapis\.com .* https:\/\/api\.stripe\.com$/);
  assert.match(directive('frame-src'), /^frame-src 'self' https:\/\/www\.google\.com\/recaptcha\/ .*https:\/\/\*\.firebaseapp\.com https:\/\/js\.stripe\.com https:\/\/\*\.js\.stripe\.com https:\/\/hooks\.stripe\.com$/);
  for (const d of csp.split('; ')) assert.ok(!/\s(\*|https:)(\s|$)/.test(d) || d.startsWith('img-src'), `no wildcard source in ${d}`);
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
});
