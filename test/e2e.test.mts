/**
 * End-to-end: starts the real production build (`npm run build` first) and
 * calls it the way the browser does. Skipped when there is no build.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { hasBuild, startServer, type RunningServer } from './server.mjs';

let server: RunningServer;
let BASE = '';
const log = () => server.log();

before(async () => {
  if (!hasBuild) return;
  server = await startServer();
  BASE = server.base;
});
after(() => server?.stop());

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

test('the one-time admin password is in the log as soon as the server starts', { skip: !hasBuild }, async () => {
  assert.match(log(), /first admin account created[\s\S]*Password: \S+/);
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
  const password = log().match(/Password: (\S+)/)?.[1];
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

async function adminCookie(): Promise<string> {
  const res = await post('/api/admin/login', { email: 'admin@beautifuluaehome.com', password: 'E2E-Owner-Passphrase' });
  assert.equal(res.status, 200, 'signed in with the password chosen above');
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const ORDER = {
  id: 'BUH-2026-1001',
  createdAt: '2026-10-14T10:00:00Z',
  customer: { fullName: 'Fatima Al Mansoori', phone: '+971501234567', emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Marina Gate 1', flatVillaNo: '1402' },
  items: [{ productId: 'p1', title: 'Mughal Garden Set', image: '', profileId: 'king', profileName: 'King', mattressSize: '180x200', fittedSheet: '180x200x40', flatSheet: '260x270', pillowcases: '2', unitPrice: 365, quantity: 1, totalPrice: 365 }],
  subtotal: 365, deliveryFee: 0, codFee: 0, discount: 0, total: 365,
  paymentMethod: 'cod', paymentStatus: 'cod_pending', status: 'pending_confirmation',
  courier: { provider: 'jeebly', pickupDate: '2026-10-15', weightKg: 2.5, pieces: 1 },
};

test('dispatch: a sandbox booking is labelled simulated; bad input is refused', { skip: !hasBuild }, async () => {
  const cookie = await adminCookie();
  const settings = { jeebly: { isLive: false }, echo: { isLive: false } };
  const ok = await post('/api/courier/dispatch', { provider: 'jeebly', order: ORDER, settings }, { cookie });
  assert.equal(ok.status, 200);
  const booked = await ok.json();
  assert.equal(booked.isSimulated, true);
  assert.match(booked.awbNumber, /^GPY-DXB-\d{6}$/);
  assert.equal(booked.rawResponse, undefined, 'carrier raw replies stay on the server');

  for (const [label, body] of [
    ['unknown courier', { provider: 'fedex', order: ORDER, settings }],
    ['no items', { provider: 'jeebly', order: { ...ORDER, items: [] }, settings }],
    ['negative total', { provider: 'jeebly', order: { ...ORDER, total: -5 }, settings }],
    ['bad pickup date', { provider: 'jeebly', order: { ...ORDER, courier: { pickupDate: 'tomorrow' } }, settings }],
  ] as const) {
    assert.equal((await post('/api/courier/dispatch', body, { cookie })).status, 400, label);
  }
  const wrongType = await fetch(`${BASE}/api/courier/dispatch`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: BASE, cookie }, body: '{}' });
  assert.equal(wrongType.status, 415);
});

test('courier connection test masks keys in its reply', { skip: !hasBuild }, async () => {
  const cookie = await adminCookie();
  const res = await post('/api/courier/test', { provider: 'jeebly', settings: { jeebly: { apiKey: 'SUPERSECRETKEY1234', clientKey: 'CLIENTKEY9876' }, echo: {} } }, { cookie });
  const text = await res.text();
  assert.ok(!text.includes('SUPERSECRETKEY') && !text.includes('CLIENTKEY98'), 'keys are not echoed');
  assert.match(text, /1234/);
});

test('AI studio accepts only real images', { skip: !hasBuild }, async () => {
  const cookie = await adminCookie();
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`;
  assert.equal((await post('/api/ai-transform', { image: svg }, { cookie })).status, 400);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]).toString('base64');
  const ok = await post('/api/ai-transform', { image: `data:image/png;base64,${png}`, presetId: '__proto__' }, { cookie });
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).transformedUrl, /^https:\/\/images\.unsplash\.com\//);
});

test('public helpers: health, serviceability, API caching headers', { skip: !hasBuild }, async () => {
  const health = await fetch(`${BASE}/api/health`);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const svc = await fetch(`${BASE}/api/courier/serviceability?emirate=Sharjah&area=Al%20Nahda`).then((r) => r.json());
  assert.equal(svc.serviceable, true);
  assert.equal(svc.matchedEmirate, 'Sharjah');
  const london = await post('/api/courier/serviceability', { emirate: 'Dubai', lat: 51.5, lng: -0.12 }).then((r) => r.json());
  assert.equal(london.serviceable, false);
});

test('signing out ends the session on the server, so a copied cookie stops working', { skip: !hasBuild }, async () => {
  const cookie = await adminCookie();
  const copy = cookie;
  assert.equal((await fetch(`${BASE}/api/admin/session`, { headers: { cookie: copy } }).then((r) => r.json())).authenticated, true);
  const out = await post('/api/admin/logout', {}, { cookie });
  assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/i);
  assert.equal((await fetch(`${BASE}/api/admin/session`, { headers: { cookie: copy } }).then((r) => r.json())).authenticated, false);
  assert.equal((await post('/api/courier/test', { provider: 'jeebly', settings: {} }, { cookie: copy })).status, 401);
});

test('over HTTP: 5 wrong passwords pause sign-in, and the pause does not reveal the right password', { skip: !hasBuild }, async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await post('/api/admin/login', { email: 'admin@beautifuluaehome.com', password: `wrong-${i}` })).status, 401);
  }
  const wrong = await post('/api/admin/login', { email: 'admin@beautifuluaehome.com', password: 'still-wrong' });
  const right = await post('/api/admin/login', { email: 'admin@beautifuluaehome.com', password: 'E2E-Owner-Passphrase' });
  assert.equal(wrong.status, 429);
  assert.equal(right.status, 429, 'same answer for the right password');
  assert.deepEqual(await wrong.json(), await right.json());
  assert.equal(right.headers.get('set-cookie'), null);
});
