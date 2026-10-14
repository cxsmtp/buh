/**
 * End-to-end: starts the real production build (`npm run build` first) and
 * calls it the way the browser does. Skipped when there is no build.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const SERVER = path.resolve('.next/standalone/server.js');
const hasBuild = fs.existsSync(SERVER);
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess | undefined;
let log = '';

before(async () => {
  if (!hasBuild) return;
  for (const dir of ['public', '.next/static']) {
    fs.cpSync(dir, path.join('.next/standalone', dir), { recursive: true });
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-e2e-'));
  server = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: { ...process.env, PORT: String(PORT), HOSTNAME: '127.0.0.1', DATA_DIR: dataDir, INSECURE_COOKIES: '1', OTP_DEV_MODE: 'true', TRUST_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.on('data', (d) => (log += d));
  server.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
});
after(() => server?.kill());

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...headers }, body: JSON.stringify(body) });

test('pages carry a locked-down CSP and security headers', { skip: !hasBuild }, async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get('content-security-policy') || '';
  for (const directive of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
  const html = await res.text();
  assert.ok(!html.includes('UAEHome2026'), 'no default admin password shipped to browsers');
});

test('admin routes refuse anonymous and cross-site callers', { skip: !hasBuild }, async () => {
  for (const p of ['/api/courier/dispatch', '/api/courier/test', '/api/admin/sms-test', '/api/ai-transform']) {
    assert.equal((await post(p, {})).status, 401, p);
  }
  assert.equal((await post('/api/admin/login', { email: 'a@b.c', password: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/admin/login', { email: 'admin@beautifuluaehome.com', password: 'UAEHome2026!#' })).status, 401);
});

test('first sign-in must change the one-time password; sessions then work and end', { skip: !hasBuild }, async () => {
  await post('/api/admin/login', { email: 'nobody@x.y', password: 'x' }); // creates the account
  const password = log.match(/Password: (\S+)/)?.[1];
  assert.ok(password, 'one-time password printed to the server log');

  const login = await post('/api/admin/login', { email: 'admin@beautifuluaehome.com', password });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(login.headers.get('set-cookie') || '', /HttpOnly/i);
  assert.equal((await login.json()).mustChangePassword, true);
  assert.equal((await post('/api/courier/test', { provider: 'jeebly', settings: {} }, { cookie })).status, 403);

  const change = await post('/api/admin/password', { currentPassword: password, newPassword: 'E2E-Owner-Passphrase' }, { cookie });
  assert.equal(change.status, 200);
  const fresh = (change.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await fetch(`${BASE}/api/admin/session`, { headers: { cookie } }).then((r) => r.json())).authenticated, false, 'old session ended');
  assert.equal((await fetch(`${BASE}/api/admin/session`, { headers: { cookie: fresh } }).then((r) => r.json())).authenticated, true);

  const ssrf = await post('/api/admin/sms-test', { phone: '0501234567', settings: { customWebhook: { endpointUrl: 'https://169.254.169.254/' } } }, { cookie: fresh });
  assert.equal(ssrf.status, 400);
});

test('checkout OTP: UAE only, 6 digits, single use, throttled, attacker gateways ignored', { skip: !hasBuild }, async () => {
  const intl = await post('/api/otp/send', { phone: '+44 7700 900123' });
  assert.equal(intl.status, 400);
  assert.match((await intl.json()).message, /email/i);

  const sent = await post('/api/otp/send', { phone: '056 777 8899', settings: { customWebhook: { endpointUrl: 'https://attacker.example' } } });
  const body = await sent.json();
  assert.equal(body.provider, 'Sandbox / Demo Gateway', 'body gateway settings are ignored');
  assert.match(body.devOtpCode, /^\d{6}$/);
  assert.equal((await post('/api/otp/send', { phone: '0567778899' })).status, 429);

  assert.equal((await (await post('/api/otp/verify', { phone: '+971567778899', code: body.devOtpCode })).json()).valid, true);
  assert.equal((await (await post('/api/otp/verify', { phone: '+971567778899', code: body.devOtpCode })).json()).valid, false);

  const big = await fetch(`${BASE}/api/otp/send`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ phone: 'x'.repeat(100_000) }) });
  assert.equal(big.status, 413);
});
