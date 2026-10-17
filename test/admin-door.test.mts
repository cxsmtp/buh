/**
 * BUH-02.08: the Admin Hub is only at a private link. The link (≥ 128 bits, here 192) is kept
 * only as a hash and checked in constant time; changing it ends the old link and every door
 * cookie at once; every admin route checks the door; the reset email opens the hub through a
 * one-time grant; logs never carry the link; backups keep the hash (not the one-time copy);
 * the server command makes a new link from the published image's own files; and the scanner
 * slow-down counts only what a scanner does. (Over HTTP and in a browser: admin-door-e2e.)
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD_HASH;
const link = await import('@/lib/server/adminLink');
const gate = await import('@/lib/server/frontGate');
const scan = await import('@/lib/server/scannerGuard');
const { getDb } = await import('@/lib/server/db');
const { kvGet } = await import('@/lib/server/kv');

test('a link is 24 random bytes (192 bits) in base64url: 32 characters, never repeated', () => {
  assert.ok(link.LINK_BYTES * 8 >= 128);
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const s = link.generateLinkSegment();
    assert.match(s, /^[A-Za-z0-9_-]{32}$/);
    seen.add(s);
  }
  assert.equal(seen.size, 2000);
  // Every position takes many values (not a fixed prefix or a counter).
  const segs = [...seen];
  for (let pos = 0; pos < 32; pos++) assert.ok(new Set(segs.map((s) => s[pos])).size > 40, `position ${pos}`);
});

test('only the hash is stored: neither the database nor its write-ahead log holds the link', () => {
  const segment = link.createLinkIfAbsent('test')!;
  assert.ok(segment, 'made');
  assert.equal(link.createLinkIfAbsent('test'), null, 'only once (a second copy of the shop starting keeps the first)');
  const rec = kvGet<Record<string, string>>('admin:link')!.data;
  assert.equal(rec.hash, link.hashSegment(segment));
  assert.ok(!JSON.stringify(rec).includes(segment));
  getDb().pragma('wal_checkpoint(FULL)');
  // Searched by another process: opening the live database file here would drop this process's SQLite locks.
  const found = spawnSync('grep', ['-rlF', segment, dir], { encoding: 'utf8' });
  assert.equal(found.status, 1, `no file in the data folder holds the link: ${found.stdout}`);
  assert.equal(link.matchesLink(segment), true);
  // One character off, the wrong length, or a stored hash typed in: refused.
  const off = (segment[0] === 'A' ? 'B' : 'A') + segment.slice(1);
  assert.equal(link.matchesLink(off), false);
  assert.equal(link.matchesLink(segment.slice(1)), false);
  assert.equal(link.matchesLink(rec.hash.slice(0, 32)), false);
  assert.equal(link.matchesLink(''), false);
});

test('the check is constant-time: digests compared with timingSafeEqual, never the strings', () => {
  const source = fs.readFileSync('src/lib/server/adminLink.ts', 'utf8');
  assert.match(source, /timingSafeEqual/);
  const fn = source.slice(source.indexOf('export function matchesLink'), source.indexOf('export function createLinkIfAbsent'));
  assert.match(fn, /sameDigest\(hashSegment\(segment\), rec\.hash\)/);
  assert.doesNotMatch(fn, /===\s*rec\.hash|rec\.hash\s*===/);
});

test('the door cookie: signed, bound to the link, 30 days, renewed after a day; forged or expired ones are refused', () => {
  const now = Date.now();
  const token = link.issueDoorToken(now)!;
  assert.deepEqual(link.verifyDoorToken(token, now), { ok: true, renew: false });
  assert.deepEqual(link.verifyDoorToken(token, now + 2 * 86_400_000), { ok: true, renew: true });
  assert.equal(link.verifyDoorToken(token, now + link.DOOR_TTL_MS + 1).ok, false, 'expired');
  const [body, sig] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  const longer = Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 1e12 })).toString('base64url');
  assert.equal(link.verifyDoorToken(`${longer}.${sig}`, now).ok, false, 'a changed body');
  assert.equal(link.verifyDoorToken(`${body}.${sig.slice(0, -2)}xx`, now).ok, false, 'a changed signature');
  assert.equal(link.verifyDoorToken(undefined, now).ok, false);
  assert.equal(link.verifyDoorToken('x'.repeat(600), now).ok, false);
  const c = link.doorCookie(token);
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, 'strict');
  assert.equal(c.maxAge, 30 * 86_400);
  assert.equal(link.doorTokenFromCookieHeader(`a=1; ${link.DOOR_COOKIE}=${token}; b=2`), token);
});

test('changing the link: the old link and every door cookie stop working at once; the new one works', () => {
  const before = link.currentLink()!;
  const oldDoor = link.issueDoorToken()!;
  const oldHub = link.hubHeaderValue();
  const segment = link.rotateLink('hub');
  const after = link.currentLink()!;
  assert.notEqual(after.version, before.version);
  assert.notEqual(after.hash, before.hash);
  assert.equal(link.verifyDoorToken(oldDoor).ok, false, 'old door cookies');
  assert.equal(link.hubHeaderMatches(oldHub), false);
  assert.equal(link.matchesLink(segment), true);
  assert.equal(link.verifyDoorToken(link.issueDoorToken()).ok, true);
});

test('every admin route checks the door (requireAdmin or requireDoor), found by listing the route files', () => {
  const root = 'src/app/api/admin';
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name === 'route.ts') files.push(path.join(d, e.name));
    }
  };
  walk(root);
  assert.ok(files.length >= 40, `${files.length} routes`);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // A file's own helper that calls requireAdmin (e.g. owner(req)) counts too.
    const helpers = [...src.matchAll(/(?:async )?function (\w+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)].filter(([, , b]) => /requireAdmin\(req|requireDoor\(req/.test(b)).map(([, name]) => name);
    const checks = new RegExp(`(?:requireAdmin|requireDoor${helpers.map((h) => `|${h}`).join('')})\\(req`);
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(([^)]*)\)\s*\{([\s\S]*?)\n\}/g)];
    assert.ok(handlers.length, `${f} has handlers`);
    for (const [, method, params, body] of handlers) {
      assert.match(params, /req/, `${f} ${method} takes the request`);
      assert.match(body, checks, `${f} ${method} checks the door`);
    }
  }
  const guard = fs.readFileSync('src/lib/server/guard.ts', 'utf8');
  const requireAdmin = guard.slice(guard.indexOf('export async function requireAdmin'));
  assert.match(requireAdmin.split('\n').slice(0, 3).join('\n'), /requireDoor\(req\)/, 'requireAdmin checks the door first');
});

test('the front gate: admin addresses without a door become an unknown address; the link opens the hub', () => {
  const segment = link.rotateLink('test');
  const door = `${link.DOOR_COOKIE}=${link.issueDoorToken()}`;
  const unknownApi = { kind: 'unknown', url: gate.NOWHERE_API };
  const unknownPage = { kind: 'unknown', url: gate.NOWHERE_PAGE };
  for (const p of ['/api/admin/login', '/api/admin', '/api/admin/orders/x/receipt', '/api/courier/dispatch', '/api/courier/test', '/api/ai-transform', '/api//admin/session', '/api/%61dmin/session', '/x/../api/admin/session', '/api/admin/%2e%2e/admin/session']) {
    assert.deepEqual(gate.decide(p, ''), unknownApi, p);
    assert.deepEqual(gate.decide(p, 'buh_door=forged.x'), unknownApi, `${p} forged`);
    assert.equal(gate.decide(p, door).kind, 'pass', `${p} with the door`);
  }
  assert.deepEqual(gate.decide('/api/admin/login?x=1', ''), { kind: 'unknown', url: `${gate.NOWHERE_API}?x=1` });
  for (const p of ['/hub', '/hub/x', '/_buh/nowhere', '/api/_buh/nowhere']) assert.equal(gate.decide(p, door).kind, 'unknown', p);
  assert.deepEqual(gate.decide('/hub', door), unknownPage);
  // The shop's own addresses are never touched.
  for (const p of ['/', '/p/abc', '/api/products', '/api/orders', '/api/courier/serviceability', '/api/images/a.jpg', '/_next/static/x.js', '/admin', '/wp-admin', '/.env']) assert.deepEqual(gate.decide(p, ''), { kind: 'pass' }, p);
  const hub = gate.decide(`/${segment}?a=1`, '');
  assert.equal(hub.kind, 'hub');
  if (hub.kind === 'hub') {
    assert.equal(hub.url, '/hub?a=1');
    assert.match(hub.cookie, /^buh_door=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict/);
    assert.equal(link.hubHeaderMatches(hub.hubHeader), true);
  }
  assert.equal(gate.decide(`/${segment.slice(0, 31)}x`, '').kind, 'pass', 'a near miss is just an unknown address');
  // A trailing slash: Next.js redirects to the address without it, which comes back through the gate.
  assert.equal(gate.decide('/api/admin/login/', '').kind, 'pass');
});

test('the password-reset email opens the hub through its own one-time grant', async () => {
  const auth = await import('@/lib/server/adminAuth');
  await auth.ensureAdminAccount();
  const reset = (await auth.startPasswordReset('admin@beautifuluaehome.com'))!;
  assert.equal(gate.decide(`/${reset.grant}`, '').kind, 'hub');
  assert.equal(gate.decide(`/${reset.grant.slice(0, 42)}A`, '').kind, 'pass');
  await auth.completePasswordReset(reset.token, 'A-New-Long-Passphrase-1');
  assert.equal(gate.decide(`/${reset.grant}`, '').kind, 'pass', 'used: the grant is gone');
});

test('logs never carry the link: logEvent masks it (and reset paths) to 4 characters', async () => {
  const { logEvent, maskSecretPaths } = await import('@/lib/server/log');
  const segment = link.generateLinkSegment();
  const lines: string[] = [];
  const original = console.log;
  console.log = (m: string) => lines.push(String(m));
  try {
    logEvent('info', 'test', { path: `/${segment}`, url: `https://shop.ae/${segment}?x=1`, note: `opened /${'g'.repeat(43)}` });
  } finally {
    console.log = original;
  }
  assert.ok(!lines.join('').includes(segment));
  assert.ok(!lines.join('').includes('g'.repeat(43)));
  assert.match(lines[0], new RegExp(`/${segment.slice(0, 4).replace(/[-]/g, '\\-')}…`));
  assert.equal(maskSecretPaths('/api/products'), '/api/products');
});

test('the link made by an update is shown once to a signed-in owner, then gone; never after the link changed', () => {
  const segment = link.rotateLink('test');
  link.storeReveal(segment);
  assert.equal(link.hasPendingReveal(), true);
  const raw = JSON.stringify(kvGet('admin:link-reveal')!.data);
  assert.ok(!raw.includes(segment), 'kept encrypted');
  assert.equal(link.takeReveal(), segment);
  assert.equal(link.takeReveal(), null, 'once');
  link.storeReveal(segment);
  link.rotateLink('test');
  assert.equal(link.takeReveal(), null, 'not after the link changed');
  link.storeReveal(link.rotateLink('test'));
  assert.equal(link.takeReveal(Date.now() + link.REVEAL_TTL_MS + 1), null, 'not after 8 hours');
});

test('backups keep the link’s hash (the restored shop keeps the bookmark), never the one-time copy; the restore says so', async () => {
  const backup = await import('@/lib/server/backup');
  const segment = link.rotateLink('test');
  link.storeReveal(segment);
  const result = await backup.createBackup();
  const entries = backup.openBackup(fs.readFileSync(result.file));
  const dbEntry = entries.find((e) => e.name === 'shop.db')!;
  assert.ok(!dbEntry.data.includes(segment));
  const target = fs.mkdtempSync(path.join(path.dirname(dir), 'buh-door-restore-'));
  fs.rmSync(target, { recursive: true });
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /private admin link from this backup works again/);
  const Database = (await import('better-sqlite3')).default;
  const restored = new Database(path.join(target, 'shop.db'), { readonly: true });
  const row = restored.prepare("SELECT data FROM kv WHERE key = 'admin:link'").get() as { data: string };
  const reveal = restored.prepare("SELECT data FROM kv WHERE key = 'admin:link-reveal'").get();
  restored.close();
  assert.equal(JSON.parse(row.data).hash, link.hashSegment(segment), 'the same link opens the restored shop');
  assert.equal(reveal, undefined);
  link.takeReveal();
});

test('the server command: says plainly that the link cannot be shown again; --new makes one that works at once and is audited', async () => {
  link.createLinkIfAbsent('test');
  const before = link.currentLink()!;
  const oldDoor = link.issueDoorToken()!;
  const run = (args: string[], env: Record<string, string> = {}) => execFileSync(process.execPath, ['scripts/admin-link.mjs', ...args], { env: { ...process.env, DATA_DIR: dir, ...env } }).toString();
  const info = run([]);
  assert.match(info, /cannot be shown again/);
  assert.match(info, /podman exec beautifuluaehome node scripts\/admin-link\.mjs --new/);
  assert.equal(link.currentLink()!.version, before.version, 'looking changes nothing');
  const out = run(['--new'], { NEXT_PUBLIC_APP_URL: 'https://shop.example' });
  const made = out.match(/Admin link: https:\/\/shop\.example\/([A-Za-z0-9_-]{32})\n/)![1];
  assert.equal(link.matchesLink(made), true, 'the new link works');
  assert.equal(link.verifyDoorToken(oldDoor).ok, false, 'the old door cookies stop working');
  assert.equal(link.currentLink()!.via, 'script');
  assert.equal(link.linkNotice(), 'new');
  const { verifyAuditLog } = await import('@/lib/server/audit');
  const files = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f));
  const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.match(text, /"action":"admin\.link_changed".*"via":"script"/);
  assert.ok(!text.includes(made), 'never the link itself');
  for (const f of files) assert.equal(verifyAuditLog(path.join(dir, f)).ok, true, 'the audit chain still checks');
  assert.throws(() => run(['--bogus']));
  // The published image carries it.
  assert.match(fs.readFileSync('Dockerfile', 'utf8'), /COPY --from=builder \/app\/scripts\/admin-link\.mjs \.\/scripts\/admin-link\.mjs/);
});

test('scanner slow-down: 10 misses in a minute slow an address, 30 shut it out for 10 minutes; the shop’s own files never count', () => {
  const ip = '203.0.113.7';
  const t0 = 1_800_000_000_000;
  for (let i = 0; i < scan.SLOW_AFTER - 1; i++) scan.recordMiss(ip, t0 + i);
  assert.equal(scan.verdictFor(ip, t0 + 100).action, 'pass');
  scan.recordMiss(ip, t0 + 100);
  assert.equal(scan.verdictFor(ip, t0 + 101).action, 'slow');
  let blocked = false;
  for (let i = scan.SLOW_AFTER; i < scan.BLOCK_AFTER; i++) blocked = scan.recordMiss(ip, t0 + 200 + i) || blocked;
  assert.equal(blocked, true);
  assert.equal(scan.verdictFor(ip, t0 + 1000).action, 'block');
  assert.equal(scan.verdictFor('203.0.113.8', t0 + 1000).action, 'pass', 'another address is not affected');
  assert.equal(scan.verdictFor(ip, t0 + 1000 + scan.BLOCK_MS).action, 'pass', 'over after 10 minutes');
  // Misses spread out (a shopper's odd dead link) never add up.
  const calm = '203.0.113.9';
  for (let i = 0; i < 100; i++) scan.recordMiss(calm, t0 + i * 61_000);
  assert.equal(scan.verdictFor(calm, t0 + 100 * 61_000).action, 'pass');
  for (const p of ['/_next/static/chunks/old.js', '/api/images/gone.jpg', '/icons/x.png', '/api/orders/lookup', '/api/products']) assert.equal(scan.countsAsProbe(p), false, p);
  for (const p of ['/wp-admin', '/.env', '/admin', '/api/admin/login', '/p/gone']) assert.equal(scan.countsAsProbe(p), true, p);
  // Only behind the shop's proxy: without TRUST_PROXY=1 there is no address to count.
  const saved = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  assert.equal(scan.addressOf({ 'x-real-ip': ip }), null);
  process.env.TRUST_PROXY = '1';
  assert.equal(scan.addressOf({ 'x-real-ip': ip }), ip);
  if (saved === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = saved;
});
