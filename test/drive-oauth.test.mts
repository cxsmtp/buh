/**
 * "Connect my Google Drive" (src/lib/server/driveBackup.ts, OAuth 2.0 device flow, scope drive.file)
 * against a stand-in for Google on 127.0.0.1 (BUH_TEST_GOOGLE_API, loopback only): the device flow
 * (pending, slow_down, success, denied, expired, Google's interval respected), the refresh, a revoked
 * token raising "Reconnect Google Drive", the shop's own folder, upload/retention, the restore from
 * Drive (saved connection, and a fresh server from env), and the secrets never shown, logged or
 * backed up.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';
import { addForeignFile, makeServiceAccount, OAUTH_CLIENT, startGoogleMock, type GoogleMock } from './google-drive-mock.mjs';

const dir = tempDataDir();
const PASS = 'correct horse battery staple';
process.env.BACKUP_PASSPHRASE = PASS;
process.env.MONITOR_DISABLED = 'true';

let google: GoogleMock;
const logged: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error'] as const) {
  console[k] = (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  };
}

const drive = await import('@/lib/server/driveBackup');
const backup = await import('@/lib/server/backup');
const { redact } = await import('@/lib/server/log');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { placeOrder } = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const settings = await import('@/lib/server/settings');
const monitor = await import('@/lib/server/monitor');

before(async () => {
  google = await startGoogleMock(makeServiceAccount());
  process.env.BUH_TEST_GOOGLE_API = google.url;
});
after(async () => {
  Object.assign(console, original);
  await google.close();
});

const tokenPolls = () => google.requests.filter((r) => r.path === '/token' && r.form?.grant_type === 'urn:ietf:params:oauth:grant-type:device_code');
const refreshes = () => google.requests.filter((r) => r.path === '/token' && r.form?.grant_type === 'refresh_token');
const appFiles = () => [...google.files.values()].filter((f) => f.by === 'user');
const copiesInDrive = () => appFiles().filter((f) => f.name.endsWith('.tar.gz.enc'));

/** Walk the device flow to the end with the given answers from Google, polling as the hub would. */
async function connect(steps: Array<'pending' | 'slow_down' | 'denied' | 'expired' | 'ok'>) {
  google.deviceScript = [...steps];
  await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret }, 'owner@shop.ae');
  let now = Date.now();
  for (let i = 0; i < 20; i++) {
    const p = (JSON.parse(fs.readFileSync(path.join(dir, 'drive-secrets.json'), 'utf8')) as { device: { nextPollAt: number } | null }).device;
    if (!p) break;
    now = Math.max(now, p.nextPollAt);
    const r = await drive.pollDriveConnect('owner@shop.ae', now);
    if (r.outcome !== 'pending') return r.outcome;
  }
  return 'pending';
}

test('the device flow: Google’s code shown, its interval respected, slow_down adds 5 seconds, then connected with the shop’s own folder', async () => {
  google.deviceScript = ['pending', 'slow_down', 'ok'];
  const started = await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret }, 'owner@shop.ae');
  const code = google.requests.find((r) => r.path === '/device/code')!;
  assert.equal(code.form?.client_id, OAUTH_CLIENT.id);
  assert.equal(code.form?.scope, 'https://www.googleapis.com/auth/drive.file');
  assert.deepEqual({ userCode: started.connecting?.userCode, url: started.connecting?.verificationUrl, interval: started.connecting?.interval }, { userCode: 'GQVQ-JKEC', url: 'https://www.google.com/device', interval: 5 });
  const json = JSON.stringify(started);
  assert.ok(!json.includes('mock-device') && !json.includes(OAUTH_CLIENT.secret), 'neither the device code nor the secret in the status');

  const t0 = Date.now();
  // Too early: Google is not asked.
  assert.equal((await drive.pollDriveConnect('o', t0)).outcome, 'pending');
  assert.equal(tokenPolls().length, 0);
  // After the interval: asked, pending.
  assert.equal((await drive.pollDriveConnect('o', t0 + 5_000)).outcome, 'pending');
  assert.equal(tokenPolls().length, 1);
  const poll = tokenPolls()[0].form!;
  assert.equal(poll.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(poll.client_secret, OAUTH_CLIENT.secret);
  assert.match(poll.device_code, /^4\/mock-device-/);
  // Asked again too soon (a second tab): not sent.
  assert.equal((await drive.pollDriveConnect('o', t0 + 6_000)).outcome, 'pending');
  assert.equal(tokenPolls().length, 1);
  // slow_down: the interval becomes 10 seconds.
  assert.equal((await drive.pollDriveConnect('o', t0 + 10_000)).outcome, 'pending');
  assert.equal(tokenPolls().length, 2);
  assert.equal(drive.driveStatus().connecting?.interval, 10);
  assert.equal((await drive.pollDriveConnect('o', t0 + 15_000)).outcome, 'pending');
  assert.equal(tokenPolls().length, 2, 'not before 10 seconds');
  const done = await drive.pollDriveConnect('o', t0 + 20_000);
  assert.equal(done.outcome, 'connected');
  assert.equal(tokenPolls().length, 3);

  const st = done.status;
  assert.equal(st.mode, 'oauth');
  assert.equal(st.connected, true);
  assert.equal(st.enabled, true, 'switched on: the passphrase is set');
  assert.equal(st.connecting, null);
  const folder = google.files.get(st.oauthFolderId)!;
  assert.equal(folder.name, 'Beautiful UAE Home backups');
  assert.equal(folder.mimeType, 'application/vnd.google-apps.folder');
  assert.equal(folder.by, 'user');
  assert.ok(!JSON.stringify(st).includes(google.refreshToken), 'no refresh token in the status');
});

test('denied and expired end the connection attempt; a code past its time is not polled', async () => {
  const keep = drive.driveStatus().oauthFolderId;
  assert.equal(await connect(['denied']), 'denied');
  assert.equal(await connect(['pending', 'expired']), 'expired');
  // Past expires_in: stopped without asking Google.
  google.deviceExpiresIn = 60;
  google.deviceScript = [];
  await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id }, 'o');
  const before = tokenPolls().length;
  assert.equal((await drive.pollDriveConnect('o', Date.now() + 61_000)).outcome, 'expired');
  assert.equal(tokenPolls().length, before);
  google.deviceExpiresIn = 1800;
  assert.equal(drive.driveStatus().connecting, null);
  // The earlier connection is untouched by attempts that did not finish.
  assert.equal(drive.driveStatus().connected, true);
  assert.equal(drive.driveStatus().oauthFolderId, keep);
  // A bad client is refused readably; a client id that isn't one, before calling Google.
  await assert.rejects(drive.startDriveConnect({ clientId: '999999999-zzzzzzzzzzzzzzzz.apps.googleusercontent.com', clientSecret: 'GOCSPX-wrongwrongwrong' }), /did not accept that client ID/);
  await assert.rejects(drive.startDriveConnect({ clientId: 'not-a-client' }), /Client ID/);
  await assert.rejects(drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, sneaky: 1 } as Record<string, unknown>), /Unexpected field/);
});

function order(name: string) {
  const p = listProducts()[0];
  return placeOrder({
    idempotencyKey: `oauth-${crypto.randomUUID()}`,
    verificationToken: issuePhoneToken('+971501234567'),
    customer: { fullName: name, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
}

test('copies go to the shop’s folder with a refreshed token (kept until it runs out); retention keeps the newest; a pasted folder is out of sight', async () => {
  drive._resetDriveUserToken();
  const r0 = refreshes().length;
  drive.saveDriveSettings({ keep: 2 }, 'o');
  const folder = drive.driveStatus().oauthFolderId;
  const owners = addForeignFile(google, folder, 'buh-backup-20240101-0000.tar.gz.enc');
  for (let i = 0; i < 3; i++) {
    const r = await backup.createBackup(new Date(Date.UTC(2026, 3, 1 + i, 8)));
    const st = await drive.copyBackupToDrive(r.file);
    assert.equal(st?.lastError, undefined, st?.lastError);
  }
  assert.equal(refreshes().length - r0, 1, 'one refresh for three copies');
  const refresh = refreshes().at(-1)!.form!;
  assert.deepEqual({ id: refresh.client_id, secret: refresh.client_secret, token: refresh.refresh_token }, { id: OAUTH_CLIENT.id, secret: OAUTH_CLIENT.secret, token: google.refreshToken });
  assert.deepEqual(copiesInDrive().map((f) => f.name).sort(), ['buh-backup-20260402-0800.tar.gz.enc', 'buh-backup-20260403-0800.tar.gz.enc']);
  assert.ok(copiesInDrive().every((f) => f.parents.includes(folder)));
  assert.ok(google.files.has(owners), 'the owner’s own file stays');
  assert.equal(drive.driveStatus().copies, 2);

  // drive.file: a folder the owner made (not the shop) can't be written to.
  const pasted = addForeignFile(google, 'root', 'My backups', Buffer.alloc(0), 'application/vnd.google-apps.folder');
  const token = await drive.oauthAccessToken({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret, refreshToken: google.refreshToken });
  const tiny = path.join(dir, 'tiny.txt');
  fs.writeFileSync(tiny, 'x');
  await assert.rejects(drive.uploadToDrive(token, pasted, tiny, 'x.txt', ''), /could not find the shop’s folder/);

  // Test connection: a tiny file up and gone again.
  const files = google.files.size;
  assert.equal((await drive.testDriveConnection({ mode: 'oauth' })).mode, 'oauth');
  assert.equal(google.files.size, files);
  // The shop's folder deleted by hand: Test connection makes a new one.
  google.files.delete(folder);
  await drive.testDriveConnection({});
  const again = drive.driveStatus().oauthFolderId;
  assert.notEqual(again, folder);
  assert.equal(google.files.get(again)?.name, 'Beautiful UAE Home backups');
});

test('a revoked refresh token (invalid_grant): the copy fails, the alert says Reconnect Google Drive; reconnecting clears it and keeps the folder', async () => {
  drive._resetDriveUserToken();
  google.revoked.add(google.refreshToken);
  const local = await backup.runBackup('manual');
  await drive.waitForDriveCopy(); // the copy runs on after the backup
  assert.ok(local.lastSuccessAt && !local.lastError, 'the local backup is fine');
  const st = drive.driveStatus();
  assert.equal(st.needsReconnect, true);
  assert.equal(st.level, 'failing');
  assert.match(String(st.lastError), /Reconnect Google Drive/);
  const p = monitor.currentProblems().find((x) => x.id === 'drive_backup');
  assert.ok(p && p.level === 'failing' && /Reconnect Google Drive/.test(p.text), JSON.stringify(p));
  await monitor.checkAndAlert();
  const auditText = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(auditText, /"action":"monitor\.problem".*"id":"drive_backup"/);

  // Reconnect: Google gives a new refresh token; the same client keeps its folder.
  const folder = st.oauthFolderId;
  google.revoked.clear();
  google.refreshToken = `1//0gMockRefreshAgain${crypto.randomBytes(12).toString('base64url')}`;
  assert.equal(await connect(['ok']), 'connected');
  const after = drive.driveStatus();
  assert.equal(after.needsReconnect, false);
  assert.equal(after.oauthFolderId, folder);
  await backup.runBackup('manual');
  await drive.waitForDriveCopy(); // the copy runs on after the backup
  assert.equal(drive.driveStatus().level, 'ok');
  assert.equal(monitor.currentProblems().find((x) => x.id === 'drive_backup'), undefined);
});

test('the client secret, refresh token and device code: never in the status, a backup, settings history, the log or the audit', async () => {
  // A connection in progress too (its device code must not be backed up either).
  google.deviceScript = [];
  await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id }, 'o');
  const status = JSON.stringify(drive.driveStatus());
  for (const secret of [OAUTH_CLIENT.secret, google.refreshToken, 'mock-device']) assert.ok(!status.includes(secret), secret);

  const result = await backup.createBackup(new Date(Date.UTC(2026, 4, 1)));
  const entries = backup.openBackup(fs.readFileSync(result.file), PASS);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buh-oauth-db-')), 'shop.db');
  fs.writeFileSync(tmp, entries.find((e) => e.name === 'shop.db')!.data);
  const copy = new Database(tmp, { readonly: true });
  const saved = JSON.parse((copy.prepare("SELECT data FROM kv WHERE key = 'backup:drive'").get() as { data: string }).data);
  const device = copy.prepare("SELECT data FROM kv WHERE key = 'backup:drive-device'").get();
  copy.close();
  assert.equal(saved.refreshToken, '');
  assert.equal(saved.oauthClientSecret, '');
  assert.equal(saved.oauthClientId, OAUTH_CLIENT.id, 'the client id (not a secret) stays');
  assert.equal(saved.mode, 'oauth');
  assert.equal(device, undefined, 'no device sign-in in the backup');
  for (const secret of [OAUTH_CLIENT.secret, google.refreshToken, 'mock-device']) assert.ok(!entries.some((e) => e.data.includes(Buffer.from(secret))), secret);
  assert.equal(settings.settingsHistory(200).filter((v) => String(v.key).includes('drive')).length, 0);
  drive.cancelDriveConnect('o');

  // log.ts: refresh tokens and client secrets by shape, and by field name.
  assert.equal(String(redact(`r=${google.refreshToken} s=${OAUTH_CLIENT.secret}`)), 'r=1//[redacted] s=GOCSPX-[redacted]');
  assert.equal((redact({ refresh_token: 'x', client_secret: 'y', device_code: 'z' }) as Record<string, string>).refresh_token, '[redacted]');
  const all = logged.join('\n');
  for (const secret of [OAUTH_CLIENT.secret, google.refreshToken, google.userToken, 'mock-device']) assert.ok(!all.includes(secret), `log: ${secret.slice(0, 8)}`);
  const auditText = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  for (const secret of [OAUTH_CLIENT.secret, google.refreshToken, google.userToken]) assert.ok(!auditText.includes(secret), `audit: ${secret.slice(0, 8)}`);
  assert.match(auditText, /backup\.drive_connected/);
  fs.rmSync(result.file);
});

function restore(args: string[], env: Record<string, string | undefined>): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/restore-backup.mjs', ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

test('restore details, and the rebuild from Drive in this mode: from the saved connection, and on a fresh server from env alone', async () => {
  order('Fatima Al Mansoori');
  order('Mariam Al Suwaidi');
  await settings.updateSettings('brand', { ...settings.adminView('brand').value, storeName: 'OAuth Round Trip' });
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const photo = crypto.randomBytes(2048);
  fs.writeFileSync(path.join(dir, 'images', 'oauth-photo.jpg'), photo);
  const live = new Database(path.join(dir, 'shop.db'), { readonly: true });
  const orders = (live.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  live.close();
  const state = await backup.runBackup('manual');
  await drive.waitForDriveCopy(); // the copy runs on after the backup
  assert.equal(drive.driveStatus().lastFile, state.lastFile);

  const text = drive.driveRestoreDetails();
  const env = Object.fromEntries(text.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.deepEqual(Object.keys(env), ['BUH_DRIVE_CLIENT_ID', 'BUH_DRIVE_CLIENT_SECRET', 'BUH_DRIVE_REFRESH_TOKEN', 'BUH_DRIVE_FOLDER']);
  assert.equal(env.BUH_DRIVE_REFRESH_TOKEN, google.refreshToken);

  const check = (target: string) => {
    const db = new Database(path.join(target, 'shop.db'), { readonly: true });
    try {
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n, orders);
      assert.ok((db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n > 0);
      assert.equal(JSON.parse((db.prepare("SELECT data FROM settings WHERE key = 'brand'").get() as { data: string }).data).storeName, 'OAuth Round Trip');
    } finally {
      db.close();
    }
    assert.ok(fs.readFileSync(path.join(target, 'images', 'oauth-photo.jpg')).equals(photo));
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-oauth-restore-'));
  const base = { BUH_TEST_GOOGLE_API: google.url, BACKUP_PASSPHRASE: PASS };

  // Inside the running shop: the saved connection.
  const a = path.join(scratch, 'saved');
  const r1 = await restore(['--from-drive', 'latest', a], { ...base, DATA_DIR: dir });
  assert.equal(r1.status, 0, r1.out);
  assert.match(r1.out, /size and checksum match/);
  check(a);

  // A brand-new server: the three values, no folder (found by its name), empty DATA_DIR as the target.
  const b = path.join(scratch, 'fresh');
  fs.mkdirSync(b);
  const fresh = { ...base, DATA_DIR: b, BUH_DRIVE_CLIENT_ID: env.BUH_DRIVE_CLIENT_ID, BUH_DRIVE_CLIENT_SECRET: env.BUH_DRIVE_CLIENT_SECRET, BUH_DRIVE_REFRESH_TOKEN: env.BUH_DRIVE_REFRESH_TOKEN };
  const list = await restore(['--from-drive', 'list'], fresh);
  assert.equal(list.status, 0, list.out);
  assert.match(list.out, new RegExp(state.lastFile!.replace(/\./g, '\\.')));
  assert.ok(!/buh-backup-20240101/.test(list.out), 'the owner’s own file is not the app’s: not listed');
  const r2 = await restore(['--from-drive', 'latest'], fresh);
  assert.equal(r2.status, 0, r2.out);
  check(b);
  const db = new Database(path.join(b, 'shop.db'), { readonly: true });
  const saved = JSON.parse((db.prepare("SELECT data FROM kv WHERE key = 'backup:drive'").get() as { data: string }).data);
  db.close();
  assert.equal(saved.refreshToken, '', 'the restored shop must be connected again');

  // A revoked token: a clear message, nothing restored.
  google.revoked.add(google.refreshToken);
  const c = path.join(scratch, 'revoked');
  const r3 = await restore(['--from-drive', 'latest', c], fresh);
  assert.notEqual(r3.status, 0);
  assert.match(r3.out, /no longer accepts this Google Drive connection/);
  assert.ok(!r3.out.includes(google.refreshToken), 'the token is not printed');
  google.revoked.clear();
  fs.rmSync(scratch, { recursive: true, force: true });

  // Not connected: no details to give.
  drive.saveDriveSettings({ disconnect: true });
  assert.throws(() => drive.driveRestoreDetails(), /Connect Google Drive first/);
  assert.equal(drive.driveStatus().enabled, false);
});
