/**
 * BUH-02.45.00: the operations faults found by the production-readiness review. Each failed before its fix:
 *  - a database that could not be opened once is opened again on the next request (never a
 *    half-ready handle), and /api/health answers 503 while the shop can't read it, so the updater
 *    never switches to such a copy;
 *  - the owner is emailed what the updater raises (rolled back, the shop did not start) and when
 *    it goes silent; a failed copy to S3 is a problem like Drive's, and does not count as a copy
 *    off the server; phone codes left in test mode on a real shop are a problem;
 *  - a problem whose email could not be sent is sent again within the hour, not a day later.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-upd-status-'));
process.env.UPDATER_STATUS_DIR = statusDir;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'BUH_TEST_SERVER', 'OTP_DEV_MODE']) delete process.env[k];
const db = await import('@/lib/server/db');
const health = await import('@/app/api/health/route');
const monitor = await import('@/lib/server/monitor');
const { kvGet, kvSet } = await import('@/lib/server/kv');
const s3 = await import('@/lib/server/s3Backup');

const status = (over: Record<string, unknown>) =>
  fs.writeFileSync(path.join(statusDir, 'status.json'), JSON.stringify({ updatedAt: new Date().toISOString(), mode: 'single', running: '2.45.0', lastGood: '2.45.0', previous: '', onServer: [], autoUpdateMinutes: 15, lastRequest: {}, registryProblem: '', auto: true, lastCheck: {}, history: [], digests: [], integrityProblem: '', ...over }));
const ids = (now = Date.now()) => monitor.currentProblems(now).map((p) => p.id);

async function withMailServer(fn: (mails: Array<{ subject: string; text: string }>) => Promise<void>) {
  const { SMTPServer } = await import('smtp-server');
  const { simpleParser } = await import('mailparser');
  const mails: Array<{ subject: string; text: string }> = [];
  const pending: Array<Promise<void>> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        pending.push(simpleParser(raw).then((m) => void mails.push({ subject: m.subject ?? '', text: m.text ?? '' })));
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test' });
  try {
    await fn(
      new Proxy(mails, {
        get: (t, k) => (k === 'settle' ? () => Promise.all(pending) : Reflect.get(t, k)),
      })
    );
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL']) delete process.env[k];
  }
}
const settle = (m: unknown) => (m as { settle: () => Promise<unknown> }).settle();

test('a database that could not be opened is opened again the next time; meanwhile /api/health says 503', async () => {
  assert.equal(db.dbReady(), true);
  assert.equal(health.GET(new Request('http://shop.test/api/health')).status, 200);
  // The data folder points at a file that is not a database: opening fails, and keeps failing cleanly.
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-broken-'));
  fs.writeFileSync(path.join(broken, 'shop.db'), 'this is not a database, it is a text file that is long enough to be read as a header by SQLite '.repeat(4));
  process.env.DATA_DIR = broken;
  assert.throws(() => db.getDb());
  assert.throws(() => db.getDb(), 'again: no half-ready handle is handed out');
  assert.equal(db.dbReady(), false);
  const res = health.GET(new Request('http://shop.test/api/health'));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false }, 'no detail given away');
  // The file is put right: the very next call works, with every table (migrated).
  process.env.DATA_DIR = dir;
  assert.equal(db.dbReady(), true);
  assert.equal(typeof db.getDb().prepare('SELECT COUNT(*) FROM orders').pluck().get(), 'number');
  assert.equal(health.GET(new Request('http://shop.test/api/health')).status, 200);
});

test('the updater: silent for 45 minutes is a problem; what it reports (a version that came back changed, a registry login) too', () => {
  assert.ok(!ids().some((i) => i.startsWith('updater')), 'no updater here: nothing said');
  status({});
  assert.ok(!ids().some((i) => i.startsWith('updater')));
  status({ updatedAt: new Date(Date.now() - 50 * 60_000).toISOString() });
  const silent = monitor.currentProblems().find((p) => p.id === 'updater')!;
  assert.equal(silent.level, 'failing');
  assert.match(silent.text, /has not reported since/);
  status({ registryProblem: 'The registry refused the download: sign in again.', integrityProblem: 'Version 2.45.0 came back with other contents.' });
  assert.deepEqual(ids().filter((i) => i.startsWith('updater')).sort(), ['updater_integrity', 'updater_registry']);
  status({});
});

test('what the updater raises (error, critical) is emailed to the owner, once; a failed email is tried again', async () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  status({ lastAlert: { at, level: 'critical', message: 'the shop is down: beautifuluaehome does not start from buh:last-good.' } });
  // The mail server is down: nothing is marked as told.
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', BACKUP_EMAIL: 'owner@shop.test' });
  await monitor.checkAndAlert();
  assert.equal(kvGet<number>('monitor:updater-alert')?.data ?? 0, 0);
  await withMailServer(async (mails) => {
    await monitor.checkAndAlert();
    await settle(mails);
    const mine = mails.filter((m) => /Updater CRITICAL/.test(m.subject));
    assert.equal(mine.length, 1);
    assert.match(mine[0].text, /the shop is down/);
    mails.length = 0;
    await monitor.checkAndAlert();
    await settle(mails);
    assert.equal(mails.filter((m) => /Updater/.test(m.subject)).length, 0, 'the same alert is not emailed twice');
    // An info or warning line is the log's business, not an email.
    status({ lastAlert: { at: new Date().toISOString(), level: 'info', message: 'recovered' } });
    await monitor.checkAndAlert();
    await settle(mails);
    assert.equal(mails.filter((m) => /Updater/.test(m.subject)).length, 0);
  });
  status({});
});

test('a problem whose email could not be sent is sent again within the hour', async () => {
  kvSet('monitor:alerted', {});
  status({ updatedAt: new Date(Date.now() - 50 * 60_000).toISOString() });
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', BACKUP_EMAIL: 'owner@shop.test' });
  const now = Date.now();
  await monitor.checkAndAlert(now);
  const marked = kvGet<Record<string, number>>('monitor:alerted')!.data.updater;
  assert.ok(now - marked > 22 * 3600_000, 'not marked as told today');
  await withMailServer(async (mails) => {
    await monitor.checkAndAlert(now + 30 * 60_000);
    await settle(mails);
    assert.equal(mails.filter((m) => /updater/.test(m.subject)).length, 0, 'not every 15 minutes');
    await monitor.checkAndAlert(now + 61 * 60_000);
    await settle(mails);
    assert.equal(mails.filter((m) => /Needs attention: updater/.test(m.subject)).length, 1);
    assert.ok(now + 61 * 60_000 - kvGet<Record<string, number>>('monitor:alerted')!.data.updater < 1000, 'told now: again in a day');
  });
  status({});
});

test('phone codes left in test mode on a real shop are a problem', () => {
  const env = { ...process.env };
  try {
    Object.assign(process.env, { NODE_ENV: 'production', OTP_DEV_MODE: 'true' });
    assert.ok(ids().includes('otp_test_mode'));
    process.env.OTP_DEV_MODE = 'false';
    assert.ok(!ids().includes('otp_test_mode'));
  } finally {
    Object.assign(process.env, { NODE_ENV: env.NODE_ENV });
    delete process.env.OTP_DEV_MODE;
  }
});

test('a copy to S3 that fails is a problem, and does not count as a copy off the server', () => {
  assert.equal(s3.s3Problem(), null, 'off: nothing said');
  assert.equal(s3.s3Protects(), false);
  kvSet('backup:s3', { enabled: true, endpoint: 'https://s3.example.com', bucket: 'shop', accessKeyId: 'AKIA1234567890ABCDEF' });
  kvSet('backup:s3-state', { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() });
  assert.equal(s3.s3Problem(), null);
  assert.equal(s3.s3Protects(), true, 'a copy arrived today');
  kvSet('backup:s3-state', { lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), lastError: 'HTTP 403 AccessDenied' });
  assert.match(s3.s3Problem()!.text, /HTTP 403 AccessDenied/);
  assert.equal(s3.s3Protects(), false);
  assert.ok(ids().includes('s3_backup'));
  kvSet('backup:s3-state', { lastSuccessAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString() });
  assert.equal(s3.s3Protects(), false, 'the last copy is three days old');
  kvSet('backup:s3', { enabled: false });
});

test('the proxy log never holds a working customer link: tracking, receipt, photo deal and bank pages are masked, and the chat header is dropped', () => {
  const mac = 'Zk3_abcDEF-ghiJKLmnoPQRstuVWXyz0123456789AB';
  for (const file of ['deploy/shop-snippets.caddy', 'deploy/proxy/Caddyfile', 'deploy/Caddyfile', 'deploy/ci/Caddyfile']) {
    const text = fs.readFileSync(file, 'utf8');
    const m = /request>uri regexp "([^"]+)" "([^"]+)"/.exec(text)!;
    const mask = (uri: string) => uri.replace(new RegExp(m[1]), m[2].replace(/\$\{(\d)\}/g, '$$$1')).replace(/undefined/g, '');
    for (const uri of [`/track/BUH-261114-ABC234.${mac}`, `/invoice/BUH-261114-ABC234.${mac}`, `/invoice/BUH-261114-ABC234.${mac}/pdf`, `/deal/${mac}`, `/api/deal/${mac}/photos/2`, `/pay/${mac}`, `/api/pay/${mac}`, `/${mac.slice(0, 32)}`, `/${mac}`]) {
      const masked = mask(uri);
      assert.ok(!masked.includes(mac.slice(8)) && masked.includes('...'), `${file}: ${uri} -> ${masked}`);
    }
    for (const uri of ['/', '/p/prod-01?s=king', '/track', '/api/products', '/_next/static/chunks/0123456789abcdef0123456789abcdef.js', '/gifts/diwali']) assert.equal(mask(uri), uri, `${file}: ${uri}`);
    assert.match(text, /request>headers>X-Chat-Token delete/, file);
  }
});

test('the admin door: an address that only ends in a slash after decoding is judged without it, like any other', async () => {
  const gate = await import('@/lib/server/frontGate');
  const kind = (u: string) => gate.decide(u, undefined).kind;
  assert.equal(kind('/api/admin/orders/x%2F'), kind('/api/admin/orders/x'));
  assert.equal(kind('/api/admin/orders/x%2F'), 'unknown');
  assert.equal(kind('/api/admin/staff/x%2f%2F'), 'unknown');
  assert.equal(kind('/api/admin/orders/x/'), 'pass', 'a real trailing slash is only redirected by Next.js');
  assert.equal(kind('/terms/'), 'pass');
});

test('shoppers get the product as shown: no stock code, camera original or AI prompt', async () => {
  const { GET } = await import('@/app/api/products/route');
  const { listProducts, updateProduct } = (await import('@/lib/server/products')) as unknown as { listProducts: () => Array<{ id: string }>; updateProduct?: unknown };
  void updateProduct;
  db.getDb().prepare("UPDATE products SET data = json_set(data, '$.sku', 'BUH-SECRET-001', '$.aiStagingPrompt', 'a secret prompt', '$.rawOriginalImage', '/api/images/raw.jpg') WHERE id = ?").run(listProducts()[0].id);
  const body = JSON.stringify(await (await GET()).json());
  for (const leak of ['BUH-SECRET-001', 'a secret prompt', 'raw.jpg', 'aiStagingPrompt', 'rawOriginalImage', '"sku"']) assert.ok(!body.includes(leak), leak);
  assert.ok(body.includes('"price"') && body.includes('"stockBySize"'));
});

test('a copy that is being stopped or replaced ends its open live streams at once (the browsers reconnect to the new copy)', async () => {
  const live = await import('@/lib/server/live');
  const a = live.eventStream(new Request('http://shop.test/api/events'), ['catalog'], '10.1.1.1');
  const b = live.eventStream(new Request('http://shop.test/api/events'), ['orders'], '10.1.1.2');
  assert.equal(live._openStreams(), 2);
  assert.equal(live.closeAllStreams(), 2);
  assert.equal(live._openStreams(), 0);
  for (const res of [a, b]) {
    const reader = res.body!.getReader();
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done;
    assert.equal(done, true, 'the stream ended');
  }
  assert.match(fs.readFileSync('deploy/shop-snippets.caddy', 'utf8'), /^\tlb_try_duration 60s$/m);
});
