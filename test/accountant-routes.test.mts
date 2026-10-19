/**
 * The accountant's role against the real build, route by route. Every handler of every route file
 * under src/app/api/admin (and the courier admin routes) is called with an accountant's session:
 * every one is refused (403, nothing done) except the read-only allow-list below; the door-only
 * routes (sign-in and the like) are checked to need no session. The list here is written out on its
 * own, so a new route is owner-only until someone adds it here and to the handler. Also: the setup
 * link opens the hub, sign-ins and exports are audited, the accountant's actions leave nothing but
 * those entries, revoking signs them out at once, and the tax invoice's headers. Skipped without a build.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { hasBuild, rawFetch, startServer, type RunningServer } from './server.mjs';

const skip = !hasBuild;
const EMAIL = 'admin@beautifuluaehome.com';
const CA = 'ca@firm.test';
const CA_PASSWORD = 'Ledger-Reader-2026!';

/** The read-only routes an accountant may use (path under /api/admin → methods). Everything else: owner only. */
const ACCOUNTANT_ALLOWED: Record<string, string[]> = {
  reports: ['GET'],
  'reports/export': ['GET'],
  audit: ['GET'],
  'audit/export': ['GET'],
  expenses: ['GET'],
  'expenses/[id]': ['GET'],
  'expenses/[id]/bills/[bill]': ['GET'],
  'expenses/categories': ['GET'],
  'orders/[id]/receipt': ['GET'],
  'orders/[id]/invoice': ['GET'],
  vat: ['GET'],
  'vat/return': ['GET'],
};
/** Routes that need no session at all (only the door): signing in, out, the setup link and the like. */
const DOOR_ONLY = new Set(['login', 'login/passkey', 'login/passkey/options', 'login/recovery', 'logout', 'session', 'password/forgot', 'password/reset', 'client-error', 'staff/setup']);
const COURIER_ADMIN = ['dispatch', 'test', 'live', 'sandbox-check'];

let server: RunningServer;
let owner = '';
let accountant = '';
let invoiceOrder: { id: string; documentPath: string } | null = null;
/** The doors the accountant's browser got: the setup link's, and the one the setup gave. */
let grantDoor = '';
let setupDoor = '';

const h = () => ({ 'content-type': 'application/json', origin: server.base });
const as = (cookie: string, method: string, p: string, body?: unknown) =>
  fetch(`${server.base}${p}`, { method, headers: { ...h(), cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(server.dataDir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(server.dataDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

/** Every route file: its path under /api/admin (or /api/courier) and its handlers. */
function routeTable(root: string): Array<{ route: string; file: string; methods: string[] }> {
  const out: Array<{ route: string; file: string; methods: string[] }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'route.ts') {
        const src = fs.readFileSync(full, 'utf8');
        const methods = [...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)].map((m) => m[1]);
        out.push({ route: path.relative(root, path.dirname(full)).split(path.sep).join('/'), file: full, methods });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}
const urlOf = (route: string) => route.replace(/\[key\]/g, 'store').replace(/\[[^\]]+\]/g, 'x1');

before(async () => {
  if (skip) return;
  server = await startServer();
  await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: 'x@y.z', password: 'x' }) });
  let once: string | undefined;
  for (let i = 0; i < 100 && !(once = server.log().match(/Password: (\S+)/)?.[1]); i++) await new Promise((r) => setTimeout(r, 100));
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: EMAIL, password: once }) });
  const first = (login.headers.get('set-cookie') || '').split(';')[0];
  const changed = await fetch(`${server.base}/api/admin/password`, { method: 'POST', headers: { ...h(), cookie: first }, body: JSON.stringify({ currentPassword: once, newPassword: 'Finance-Owner-Pass-1' }) });
  owner = (changed.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(owner);
});
after(() => server?.stop());

test('the owner invites; the setup link opens the hub (its own path) and signs the accountant in, audited', { skip }, async () => {
  const res = await as(owner, 'POST', '/api/admin/staff', { email: CA, name: 'Our CA' });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { emailed: boolean; link: string; account: { id: string; status: string } };
  assert.equal(body.emailed, false, 'no email set up here: the link comes back to the owner once');
  const m = /\/([A-Za-z0-9_-]{43})#setup=([^&]+)$/.exec(body.link)!;
  assert.ok(m, body.link);
  // The setup path is the hub (with a door that lasts as long as the invite), and nothing else is.
  const hub = await rawFetch(`${server.base}/${m[1]}`, { redirect: 'manual' });
  assert.equal(hub.status, 200);
  const door = (hub.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('buh_door='));
  assert.ok(door, 'a door');
  // Not for someone without that path: an admin API without a door is the unknown address.
  assert.equal((await rawFetch(`${server.base}/api/admin/staff/setup`, { method: 'POST', headers: h(), body: '{}' })).status, 404);
  const setup = await rawFetch(`${server.base}/api/admin/staff/setup`, { method: 'POST', headers: { ...h(), cookie: door! }, body: JSON.stringify({ token: decodeURIComponent(m[2]), password: CA_PASSWORD }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const cookies = (setup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]);
  accountant = cookies.find((c) => c.startsWith('buh_admin='))!;
  assert.ok(accountant);
  assert.ok(cookies.some((c) => c.startsWith('buh_door=')), 'the hub’s ordinary door for this browser');
  grantDoor = door!;
  setupDoor = cookies.find((c) => c.startsWith('buh_door='))!;
  const again = await rawFetch(`${server.base}/api/admin/staff/setup`, { method: 'POST', headers: { ...h(), cookie: door! }, body: JSON.stringify({ token: decodeURIComponent(m[2]), password: CA_PASSWORD }) });
  assert.notEqual(again.status, 200, 'the link works once');
  // Signing in with the ordinary form: audited as the accountant's sign-in.
  const login = await fetch(`${server.base}/api/admin/login`, { method: 'POST', headers: h(), body: JSON.stringify({ email: CA, password: CA_PASSWORD }) });
  assert.equal(login.status, 200);
  assert.equal(((await login.json()) as { role: string }).role, 'accountant');
  accountant = (login.headers.get('set-cookie') || '').split(';')[0];
  const session = (await (await as(accountant, 'GET', '/api/admin/session')).json()) as { role: string; email: string };
  assert.equal(session.role, 'accountant');
  assert.equal(session.email, CA);
  assert.ok(auditEntries().filter((e) => e.action === 'accountant.sign_in' && e.details.by === CA).length >= 2, 'setup and sign-in audited');
});

test('the route table: every admin route refuses an accountant (403, before anything runs) except the read-only allow-list', { skip }, async () => {
  assert.ok(accountant, 'signed in');
  // Something real for the allowed routes to read: an expense with a bill, an order.
  const exp = (await (await as(owner, 'POST', '/api/admin/expenses', { key: crypto.randomUUID(), date: new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10), amount: '10', categoryId: 'other', method: 'cash' })).json()) as { expense: { id: string } };
  const table = [
    ...routeTable('src/app/api/admin').map((r) => ({ ...r, url: `/api/admin/${urlOf(r.route)}`, key: r.route })),
    ...routeTable('src/app/api/courier')
      .filter((r) => COURIER_ADMIN.includes(r.route))
      .map((r) => ({ ...r, url: `/api/courier/${r.route}`, key: `courier/${r.route}` })),
  ];
  assert.ok(table.length >= 60, `${table.length} route files`);
  for (const k of Object.keys(ACCOUNTANT_ALLOWED)) assert.ok(table.some((r) => r.key === k), `allow-listed route exists: ${k}`);
  const seen: string[] = [];
  for (const r of table) {
    assert.ok(r.methods.length, `${r.key} has handlers`);
    const src = fs.readFileSync(r.file, 'utf8');
    if (DOOR_ONLY.has(r.key)) {
      // Door-only: no session asked, and so nothing an accountant could do there that a stranger with the door couldn't.
      assert.doesNotMatch(src, /requireAdmin|requireReader/, `${r.key} is door-only`);
      assert.match(src, /requireDoor\(req\)/, `${r.key} checks the door`);
      continue;
    }
    for (const method of r.methods) {
      const allowed = (ACCOUNTANT_ALLOWED[r.key] ?? []).includes(method);
      let url = r.url;
      if (r.key === 'expenses/[id]') url = `/api/admin/expenses/${exp.expense.id}`;
      const res = await as(accountant, method, url, method === 'GET' || method === 'HEAD' ? undefined : {});
      const text = await res.text();
      if (allowed) {
        assert.ok(![401, 403].includes(res.status), `${method} ${r.key}: allowed for the accountant, got ${res.status} ${text.slice(0, 200)}`);
      } else {
        assert.equal(res.status, 403, `${method} ${r.key}: must refuse the accountant, got ${res.status} ${text.slice(0, 200)}`);
        assert.match(text, /role_refused/, `${method} ${r.key}: refused for the role (not for something else)`);
      }
      seen.push(`${method} ${r.key}`);
    }
  }
  assert.ok(seen.length >= 80, `${seen.length} handlers checked`);
  // The allowed ones are all reads.
  for (const methods of Object.values(ACCOUNTANT_ALLOWED)) assert.deepEqual(methods, ['GET']);
  // In the code: each allowed handler asks for the accountant explicitly; no other does.
  for (const r of routeTable('src/app/api/admin')) {
    const src = fs.readFileSync(r.file, 'utf8');
    const readers = [...src.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b[\s\S]*?(?=export (?:async )?function|$)/g)].filter((m) => /requireReader\(|OWNER_OR_ACCOUNTANT/.test(m[0])).map((m) => m[1]);
    assert.deepEqual(readers, ACCOUNTANT_ALLOWED[r.route] ?? [], `${r.route}: handlers open to the accountant`);
  }
  // The accountant changed nothing: the only audit entries in their name are sign-ins and exports.
  const theirs = auditEntries().filter((e) => e.details.by === CA).map((e) => e.action);
  for (const a of theirs) assert.ok(['accountant.sign_in', 'accountant.setup_done', 'report.exported', 'report.export_failed', 'audit.exported', 'vat.return_exported'].includes(a), a);
});

test('exports by the accountant are audited in their name; reading the Money area works', { skip }, async () => {
  const d = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
  const zip = await as(accountant, 'GET', `/api/admin/reports/export?from=${d}&to=${d}`);
  assert.equal(zip.status, 200);
  await zip.arrayBuffer();
  // One export at a time: the ZIP's lock goes when its file is closed, a moment after the download ends.
  let audit = await as(accountant, 'GET', '/api/admin/audit/export?format=csv');
  for (let i = 0; i < 50 && audit.status === 429; i++) {
    await new Promise((r) => setTimeout(r, 100));
    audit = await as(accountant, 'GET', '/api/admin/audit/export?format=csv');
  }
  assert.equal(audit.status, 200);
  await audit.text();
  const vatCsv = await as(accountant, 'GET', `/api/admin/vat/return?from=${d}&to=${d}&format=csv`);
  assert.equal(vatCsv.status, 200);
  const csvBytes = Buffer.from(await vatCsv.arrayBuffer());
  assert.equal(csvBytes.subarray(0, 3).toString('hex'), 'efbbbf', 'UTF-8 with a BOM, for Excel');
  assert.match(csvBytes.subarray(3).toString(), /^section,document/);
  const entries = auditEntries();
  for (const action of ['report.exported', 'audit.exported', 'vat.return_exported']) assert.ok(entries.some((e) => e.action === action && e.details.by === CA), action);
  const report = await as(accountant, 'GET', `/api/admin/reports?from=${d}&to=${d}`);
  assert.equal(report.status, 200);
  // No keys or secrets in what an accountant can read: settings are refused outright.
  assert.equal((await as(accountant, 'GET', '/api/admin/settings')).status, 403);
  assert.equal((await as(accountant, 'GET', '/api/admin/chats')).status, 403);
  assert.equal((await as(accountant, 'GET', '/api/admin/orders')).status, 403);
});

test('VAT switched on over HTTP needs the typed confirmation; the tax invoice: the hub’s and the customer’s, no scripts, never cached', { skip }, async () => {
  const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
  const bad = await as(owner, 'PUT', '/api/admin/vat', { enabled: true, trn: '100123456700003', effectiveFrom: today, address: 'Dubai' });
  assert.equal(bad.status, 400);
  assert.equal((await as(accountant, 'PUT', '/api/admin/vat', { enabled: false })).status, 403);
  const on = await as(owner, 'PUT', '/api/admin/vat', { enabled: true, trn: '100123456700003', effectiveFrom: today, address: 'Shop 4, Marina Walk, Dubai', legalName: 'BUH Trading LLC', confirm: 'TURN ON VAT' });
  assert.equal(on.status, 200, await on.clone().text());
  const products = (await (await rawFetch(`${server.base}/api/products`)).json()).products as Array<{ id: string; profiles: Array<{ id: string }> }>;
  const placed = await rawFetch(`${server.base}/api/orders`, {
    method: 'POST',
    headers: h(),
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      customer: { fullName: 'Invoice Customer', phone: '+971507771234', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
      items: [{ productId: products[0].id, profileId: products[0].profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
    }),
  });
  assert.equal(placed.status, 201, await placed.clone().text());
  invoiceOrder = ((await placed.json()) as { order: { id: string; documentPath: string; documentLabel: string } }).order;
  assert.match(invoiceOrder.documentPath, /^\/invoice\//);
  const confirmed = await as(owner, 'PATCH', `/api/admin/orders/${invoiceOrder.id}`, { status: 'confirmed', shipUnconfirmed: true });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  for (const [who, url] of [
    ['customer', invoiceOrder.documentPath],
    ['accountant', `/api/admin/orders/${invoiceOrder.id}/invoice`],
  ] as const) {
    const res = who === 'customer' ? await rawFetch(`${server.base}${url}`) : await as(accountant, 'GET', url);
    assert.equal(res.status, 200, who);
    const html = await res.text();
    assert.match(html, /<h1>Tax Invoice<\/h1>/, who);
    assert.match(html, /INV-\d{6}/);
    assert.match(html, /TRN: <strong>100123456700003<\/strong>/);
    assert.doesNotMatch(html, /<script/i);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.doesNotMatch(res.headers.get('content-security-policy') ?? '', /script-src/);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  // A changed mac, or another order's number with this mac: the ordinary 404.
  const wrong = invoiceOrder.documentPath.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await rawFetch(`${server.base}${wrong}`)).status, 404);
  fs.writeFileSync(path.join(server.dataDir, 'finance-invoice.json'), JSON.stringify(invoiceOrder));
});

test('revoking ends the accountant’s session at once; the owner’s carries on', { skip }, async () => {
  const list = (await (await as(owner, 'GET', '/api/admin/staff')).json()) as { accounts: Array<{ id: string; email: string }> };
  const acc = list.accounts.find((a) => a.email === CA)!;
  assert.equal((await as(accountant, 'DELETE', `/api/admin/staff/${acc.id}`)).status, 403, 'an accountant can’t revoke (or invite)');
  assert.equal((await as(accountant, 'POST', '/api/admin/staff', { email: 'friend@firm.test' })).status, 403);
  const res = await as(owner, 'DELETE', `/api/admin/staff/${acc.id}`);
  assert.equal(res.status, 200);
  assert.equal((await as(accountant, 'GET', '/api/admin/reports')).status, 401, 'signed out at once');
  assert.equal((await as(owner, 'GET', '/api/admin/reports')).status, 200);
  assert.ok(auditEntries().some((e) => e.action === 'accountant.revoked'));
  // The doors the accountant's browser was given end too: an admin address is the unknown address again.
  for (const d of [setupDoor, grantDoor]) {
    assert.ok(d);
    assert.equal((await rawFetch(`${server.base}/api/admin/session`, { headers: { cookie: d } })).status, 404, 'no door after a revoke');
  }
});

test('the owner’s "sign out everywhere" signs every accountant out too', { skip }, async () => {
  const res = await as(owner, 'POST', '/api/admin/staff', { email: 'second@firm.test' });
  const m = /\/([A-Za-z0-9_-]{43})#setup=([^&]+)$/.exec(((await res.json()) as { link: string }).link)!;
  const hub = await rawFetch(`${server.base}/${m[1]}`, { redirect: 'manual' });
  const door = (hub.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('buh_door='))!;
  const setup = await rawFetch(`${server.base}/api/admin/staff/setup`, { method: 'POST', headers: { ...h(), cookie: door }, body: JSON.stringify({ token: decodeURIComponent(m[2]), password: CA_PASSWORD }) });
  assert.equal(setup.status, 200, await setup.clone().text());
  const second = (setup.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('buh_admin='))!;
  assert.equal((await as(second, 'GET', '/api/admin/reports')).status, 200);
  assert.equal((await as(owner, 'POST', '/api/admin/logout')).status, 200);
  assert.equal((await as(second, 'GET', '/api/admin/reports')).status, 401, 'the accountant is signed out too');
  assert.equal((await as(owner, 'GET', '/api/admin/reports')).status, 401, 'and the owner');
  assert.ok(auditEntries().some((e) => e.action === 'admin.sign_out' && Number(e.details.accountantsSignedOut) >= 1));
});
