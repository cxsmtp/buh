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

/** A real order, placed the way the shop does it: SMS code (sandbox), verify, then /api/orders. */
async function placeTestOrder(phone: string, quantity = 1) {
  const sent = await (await post('/api/otp/send', { phone })).json();
  const verified = await (await post('/api/otp/verify', { phone, code: sent.devOtpCode })).json();
  assert.ok(verified.verificationToken, 'phone proof issued');
  const products = (await (await fetch(`${BASE}/api/products`)).json()).products;
  const res = await post('/api/orders', {
    idempotencyKey: crypto.randomUUID(),
    verificationToken: verified.verificationToken,
    customer: { fullName: 'Fatima Al Mansoori', emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Marina Gate 1', flatVillaNo: '1402' },
    items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity }],
    paymentMethod: 'cod',
  });
  assert.equal(res.status, 201);
  return (await res.json()).order as { id: string; total: number };
}

test('dispatch: books a stored order (sandbox, labelled simulated); bad input is refused', { skip: !hasBuild }, async () => {
  const cookie = await adminCookie();
  const order = await placeTestOrder('0507000001');
  const ok = await post('/api/courier/dispatch', { orderId: order.id, provider: 'jeebly' }, { cookie });
  assert.equal(ok.status, 200);
  const booked = await ok.json();
  assert.equal(booked.isSimulated, true);
  assert.match(booked.awbNumber, /^GPY-DXB-\d{6}$/);
  assert.equal(booked.order.status, 'confirmed');
  assert.equal(booked.rawResponse, undefined, 'carrier raw replies stay on the server');

  for (const [label, body, status] of [
    ['unknown courier', { orderId: order.id, provider: 'fedex' }, 400],
    ['unknown order', { orderId: 'BUH-000000-NOPE00', provider: 'jeebly' }, 404],
    ['bad pickup date', { orderId: order.id, provider: 'jeebly', pickupDate: 'tomorrow' }, 400],
    ['negative weight', { orderId: order.id, provider: 'jeebly', weightKg: -1 }, 400],
  ] as const) {
    assert.equal((await post('/api/courier/dispatch', body, { cookie })).status, status, label);
  }
  const wrongType = await fetch(`${BASE}/api/courier/dispatch`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: BASE, cookie }, body: '{}' });
  assert.equal(wrongType.status, 415);
});

test('orders: the server sets prices and stock; a forged price is ignored; a retry is one order', { skip: !hasBuild }, async () => {
  const products = (await (await fetch(`${BASE}/api/products`)).json()).products;
  const p = products[0];
  const stockBefore = p.stockCount;
  const sent = await (await post('/api/otp/send', { phone: '0507000002' })).json();
  const { verificationToken } = await (await post('/api/otp/verify', { phone: '0507000002', code: sent.devOtpCode })).json();
  const body = {
    idempotencyKey: crypto.randomUUID(),
    verificationToken,
    customer: { fullName: 'Price Tester', emirate: 'Sharjah', area: 'Al Nahda', streetAddress: 's', buildingVilla: 'b', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 2, unitPrice: 1, totalPrice: 2 }],
    paymentMethod: 'cod',
    total: 2,
  };
  const first = await (await post('/api/orders', body)).json();
  assert.equal(first.order.total, (p.price + p.profiles[0].priceDelta) * 2, 'price from the catalogue');
  const retry = await post('/api/orders', body);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).order.id, first.order.id, 'same order back');
  const after = (await (await fetch(`${BASE}/api/products`)).json()).products.find((x: { id: string }) => x.id === p.id);
  assert.equal(after.stockCount, stockBefore - 2, 'stock taken once');

  // No phone proof, or someone else's: refused.
  assert.equal((await post('/api/orders', { ...body, idempotencyKey: crypto.randomUUID(), verificationToken: 'forged.token' })).status, 401);
  // More than in stock: refused with how many are left.
  const tooMany = await post('/api/orders', { ...body, idempotencyKey: crypto.randomUUID(), items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 20 }] });
  assert.ok([400, 409].includes(tooMany.status));
});

test('settings: keys are write-only and never reach the public page', { skip: !hasBuild }, async () => {
  const cookie = await adminCookie();
  const put = (key: string, settings: unknown) =>
    fetch(`${BASE}/api/admin/settings/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ settings }) });
  const saved = await (await put('courier', { jeebly: { apiKey: 'JB-SECRET-XYZ' }, echo: {} })).json();
  assert.equal(saved.value.jeebly.apiKey, '');
  assert.equal(saved.secretsSet['jeebly.apiKey'], true);
  const all = await (await fetch(`${BASE}/api/admin/settings`, { headers: { cookie } })).text();
  assert.ok(!all.includes('JB-SECRET-XYZ'));
  assert.ok(!(await (await fetch(`${BASE}/api/settings/public`)).text()).includes('JB-SECRET'));
  assert.equal((await put('bank', { iban: 'not an iban' })).status, 400);
  assert.equal((await put('nope', {})).status, 404);
  assert.equal((await fetch(`${BASE}/api/admin/settings/courier`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: BASE }, body: '{}' })).status, 401);
});

test('backups: "Back up now" works for the admin only', { skip: !hasBuild }, async () => {
  const cookie = await adminCookie();
  assert.equal((await post('/api/admin/backup', {})).status, 401);
  const res = await post('/api/admin/backup', {}, { cookie });
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.ok(health.lastSuccessAt);
  assert.match(health.lastSummary, /orders/);
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
