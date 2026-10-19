/**
 * Google Drive copies, after the review of the first version (src/lib/server/driveBackup.ts and
 * scripts/restore-from-drive.mjs), against the stand-in for Google on 127.0.0.1:
 * - the secrets (key, client secret, refresh token, device sign-in) in a private file outside the
 *   database, moved there from the database of the first version;
 * - a restore from Drive takes only the shop's own encrypted copies (never a plain one, one the
 *   shop did not mark, or one stamped in the future);
 * - "Back up now" does not wait for the upload; a backup taken meanwhile is copied next;
 * - an upload of a file cut short stops; retries count only while nothing moves; a 308 that keeps
 *   saying "all received" is not a loop; a page token that repeats is not a loop;
 * - retention drops a copy Google refuses to delete for good; a copy finished after the setting
 *   changed is not recorded under the new one;
 * - the device flow: a poll that finishes after a cancel or a new start saves nothing; a folder
 *   that could not be made keeps the connection (the folder is made later); Disconnect revokes;
 * - the restore script: a write error, Ctrl-C (the partial download removed), a random temp name;
 * - BUH_TEST_*_API only in tests (NODE_ENV production needs the test server's flag).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { addForeignFile, makeServiceAccount, OAUTH_CLIENT, startGoogleMock, type GoogleMock } from './google-drive-mock.mjs';

const dir = tempDataDir();
const PASS = 'correct horse battery staple';
process.env.BACKUP_PASSPHRASE = PASS;
process.env.MONITOR_DISABLED = 'true';

const sa = makeServiceAccount();
let google: GoogleMock;

const drive = await import('@/lib/server/driveBackup');
const backup = await import('@/lib/server/backup');
const { kvGet, kvSet } = await import('@/lib/server/kv');
const { getDb } = await import('@/lib/server/db');
const { testStandIn } = await import('@/lib/server/testStandIn');
const fromDrive = await import('../scripts/restore-from-drive.mjs');

const FOLDER = '1HardeningFolder_abcdefghijk';
const OTHER = '1AnotherFolder_abcdefghijklm';
const SECRETS = path.join(dir, 'drive-secrets.json');

before(async () => {
  google = await startGoogleMock(sa);
  process.env.BUH_TEST_GOOGLE_API = google.url;
});
afterEach(() => {
  google.before = null;
  google.pageLoop = false;
  google.slowMedia = null;
  drive.DRIVE_LIMITS.chunkBytes = 8 * 1024 * 1024;
  drive.DRIVE_LIMITS.retryMs = 1000;
});
after(async () => {
  await google.close();
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}
async function within<T>(p: Promise<T>, ms = 5000): Promise<T | 'timeout'> {
  let t: NodeJS.Timeout | undefined;
  const r = await Promise.race([p, new Promise<'timeout'>((res) => (t = setTimeout(() => res('timeout'), ms)))]);
  clearTimeout(t);
  return r;
}
async function until(check: () => boolean, ms = 5000) {
  for (let i = 0; i < ms / 20; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waited too long');
}
const isDataPut = (r: { method: string; path: string; bodySize: number }) => r.method === 'PUT' && r.path.startsWith('/upload/') && r.bodySize > 0;
const ours = () => [...google.files.values()].filter((f) => f.appProperties?.buhBackup === '1' && f.name.endsWith('.tar.gz.enc'));
const auditText = () => fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

function enableSa(keep = 30, folder = FOLDER) {
  return drive.saveDriveSettings({ enabled: true, mode: 'service_account', folderId: folder, keep, serviceAccountKey: sa.json }, 'owner@shop.ae');
}

function restore(args: string[], env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ['scripts/restore-backup.mjs', ...args], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise<{ status: number | null; signal: string | null; out: string }>((resolve) => child.on('close', (status, signal) => resolve({ status, signal, out })));
  return { child, done };
}
const saEnv = { BUH_TEST_GOOGLE_API: '', BACKUP_PASSPHRASE: PASS, BUH_DRIVE_KEY: sa.json, BUH_DRIVE_FOLDER: FOLDER };

test('the key, client secret, refresh token and device sign-in live in a private file: never in the database, never in a backup', async () => {
  enableSa();
  assert.ok(fs.existsSync(SECRETS), 'the secrets file is there');
  assert.equal(fs.statSync(SECRETS).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(SECRETS, 'utf8')).privateKey, sa.pem);
  const row = kvGet<Record<string, unknown>>('backup:drive')!.data;
  assert.ok(!row.privateKey && !JSON.stringify(row).includes('PRIVATE KEY'), 'not in the database');
  assert.equal(row.folderId, FOLDER, 'the folder and the switch stay in the database');
  assert.equal(drive.driveStatus().keySaved, true);
  // The live database itself (as an older image would back it up), byte for byte.
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  assert.ok(!fs.readFileSync(path.join(dir, 'shop.db')).includes(Buffer.from('BEGIN PRIVATE KEY')), 'nowhere in shop.db');
  const result = await backup.createBackup(new Date(Date.UTC(2026, 5, 1, 9)));
  const entries = backup.openBackup(fs.readFileSync(result.file), PASS);
  assert.ok(!entries.some((e) => e.name.includes('drive-secrets')), 'the file is not in the backup');
  assert.ok(!entries.some((e) => e.data.includes(Buffer.from('BEGIN PRIVATE KEY'))), 'nor the key, anywhere');
  fs.rmSync(result.file);
});

test('secrets the first version kept in the database move to the private file, and the restore script reads them there', async () => {
  fs.rmSync(SECRETS, { force: true });
  const legacy = { enabled: true, mode: 'oauth', keep: 30, folderId: FOLDER, clientEmail: sa.email, privateKey: sa.pem, keyId: sa.keyId, oauthClientId: OAUTH_CLIENT.id, oauthClientSecret: OAUTH_CLIENT.secret, refreshToken: google.refreshToken, oauthFolderId: '1LegacyFolder_abcdefgh' };
  kvSet('backup:drive', legacy);
  kvSet('backup:drive-device', { clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret, deviceCode: '4/legacy-device-code', userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', expiresAt: Date.now() + 600_000, interval: 5, nextPollAt: Date.now(), by: 'o' });
  drive.migrateDriveSecrets();
  const row = JSON.stringify(kvGet('backup:drive')!.data);
  for (const secret of [sa.pem, OAUTH_CLIENT.secret, google.refreshToken]) assert.ok(!row.includes(secret), 'out of the database');
  assert.ok(!kvGet('backup:drive-device')?.data, 'the device sign-in is out of the database');
  const file = fs.readFileSync(SECRETS, 'utf8');
  for (const secret of [OAUTH_CLIENT.secret, google.refreshToken, '4/legacy-device-code']) assert.ok(file.includes(secret));
  assert.equal(JSON.parse(file).privateKey, sa.pem);
  const st = drive.driveStatus();
  assert.deepEqual({ connected: st.connected, secret: st.oauthSecretSaved, key: st.keySaved, code: st.connecting?.userCode, folder: st.oauthFolderId }, { connected: true, secret: true, key: true, code: 'ABCD-EFGH', folder: '1LegacyFolder_abcdefgh' });
  drive.cancelDriveConnect('o');

  // podman exec … restore-backup.mjs --from-drive list: the saved connection, from the file.
  const before = google.requests.length;
  const r = await restore(['--from-drive', 'list'], { BUH_TEST_GOOGLE_API: google.url, BACKUP_PASSPHRASE: PASS, DATA_DIR: dir }).done;
  assert.equal(r.status, 0, r.out);
  assert.ok(google.requests.slice(before).some((q) => q.form?.grant_type === 'refresh_token' && q.form.refresh_token === google.refreshToken));
});

test('a saved folder id that is not one never reaches the Drive query', async () => {
  const cfg = kvGet<Record<string, unknown>>('backup:drive')!.data;
  kvSet('backup:drive', { ...cfg, mode: 'oauth', oauthFolderId: "1abcdefghij' in parents or name contains '" });
  const before = google.requests.length;
  const r = await restore(['--from-drive', 'list'], { BUH_TEST_GOOGLE_API: google.url, BACKUP_PASSPHRASE: PASS, DATA_DIR: dir }).done;
  const queries = google.requests.slice(before).filter((q) => q.method === 'GET' && q.path.startsWith('/drive/v3/files?')).map((q) => new URL(q.path, 'http://x').searchParams.get('q') || '');
  assert.ok(queries.length, r.out);
  assert.ok(!queries.some((q) => q.includes("1abcdefghij'")), queries.join(' | '));
  kvSet('backup:drive', cfg);
});

test('restore from Drive: only the shop’s own encrypted copies, never a plain one, an unmarked one or one stamped in the future', async () => {
  enableSa();
  const real = await backup.createBackup(new Date(Date.UTC(2026, 5, 1, 10)));
  assert.equal((await drive.copyBackupToDrive(real.file))?.lastError, undefined);
  delete process.env.BACKUP_PASSPHRASE;
  const plain = await backup.createBackup(new Date(Date.UTC(2026, 5, 2, 10)));
  process.env.BACKUP_PASSPHRASE = PASS;
  assert.match(plain.file, /\.tar\.gz$/);
  const env = { ...saEnv, BUH_TEST_GOOGLE_API: google.url, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'buh-hard-')) };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-hard-restore-'));

  // A plain backup with the shop's mark, named as the newest copy: refused, nothing left behind.
  const plainId = addForeignFile(google, FOLDER, 'buh-backup-20260602-1000.tar.gz.enc', fs.readFileSync(plain.file), undefined, { appProperties: { buhBackup: '1' }, by: 'sa' });
  const a = path.join(scratch, 'a');
  const r1 = await restore(['--from-drive', 'latest', a], env).done;
  assert.notEqual(r1.status, 0);
  assert.match(r1.out, /Copies from Google Drive are always encrypted: this one is not, so it was not restored\./);
  assert.ok(!fs.existsSync(a), 'nothing left behind');
  google.files.delete(plainId);

  // Not marked by the shop (an encrypted file someone else put there), or stamped in the future: not listed.
  const sealed = fs.readFileSync(real.file);
  addForeignFile(google, FOLDER, 'buh-backup-20260603-1000.tar.gz.enc', sealed);
  addForeignFile(google, FOLDER, 'buh-backup-20990101-0000.tar.gz.enc', sealed, undefined, { appProperties: { buhBackup: '1' }, by: 'sa' });
  const list = await restore(['--from-drive', 'list'], env).done;
  assert.equal(list.status, 0, list.out);
  assert.match(list.out, /buh-backup-20260601-1000\.tar\.gz\.enc/);
  assert.ok(!/20260603|20990101/.test(list.out), list.out);
  const b = path.join(scratch, 'b');
  const r2 = await restore(['--from-drive', 'latest', b], env).done;
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /Downloaded buh-backup-20260601-1000\.tar\.gz\.enc/);
  for (const f of [...google.files.values()].filter((x) => /20260603|20990101/.test(x.name))) google.files.delete(f.id);
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(plain.file);
});

test('Back up now does not wait for the copy to Drive: the copy is shown in progress, and a backup taken meanwhile is copied next', async () => {
  enableSa();
  const g = gate();
  let held = 0;
  google.before = async (r) => {
    if (isDataPut(r)) {
      held++;
      await g.promise;
    }
  };
  const first = await within(backup.runBackup('manual'));
  if (first === 'timeout') g.open();
  assert.notEqual(first, 'timeout', 'the backup returned while the copy is still going');
  if (first === 'timeout') return;
  assert.ok(first.lastSuccessAt && !first.lastError);
  await until(() => held > 0);
  const copying = drive.driveStatus().copying;
  assert.equal(copying?.file, first.lastFile);
  assert.ok(copying && copying.size > 0);
  // The backup lock is free: another backup runs now (its copy waits for the one in progress).
  const second = await within(backup.runBackup('manual'));
  assert.notEqual(second, 'timeout');
  g.open();
  await drive.waitForDriveCopy();
  const st = drive.driveStatus();
  assert.equal(st.copying, null);
  assert.equal(st.level, 'ok', st.lastError);
  assert.equal(st.lastFile, (second as { lastFile: string }).lastFile);
  const local = path.join(dir, 'backups', st.lastFile!);
  const inDrive = ours().filter((f) => f.name === st.lastFile);
  assert.equal(inDrive.length, 1, 'one copy of that name');
  assert.ok(inDrive[0].data.equals(fs.readFileSync(local)), 'Drive holds the newest backup');
});

test('a backup file cut short during the upload stops the upload with an error', async () => {
  drive.DRIVE_LIMITS.chunkBytes = 256 * 1024;
  const file = path.join(dir, 'cut-short.bin');
  fs.writeFileSync(file, crypto.randomBytes(1024 * 1024));
  const token = await drive.accessToken(drive.parseServiceAccountKey(sa.json));
  let puts = 0;
  google.before = (r) => {
    if (isDataPut(r) && ++puts === 2) fs.truncateSync(file, 300 * 1024);
  };
  const r = await within(drive.uploadToDrive(token, FOLDER, file, 'cut-short.bin', sa.email).then(() => 'uploaded', (err: Error) => err.message));
  assert.match(String(r), /changed while it was being copied/);
  fs.rmSync(file);
});

test('upload retries: counted only while nothing moves forward; a 308 that keeps saying “all received” is not a loop', async () => {
  drive.DRIVE_LIMITS.chunkBytes = 256 * 1024;
  drive.DRIVE_LIMITS.retryMs = 1;
  const token = await drive.accessToken(drive.parseServiceAccountKey(sa.json));
  // Seven pieces, every other attempt refused with a 503: seven failures in all, never six in a row.
  const file = path.join(dir, 'flaky.bin');
  fs.writeFileSync(file, crypto.randomBytes(7 * 256 * 1024));
  let n = 0;
  google.before = (r) => (isDataPut(r) && ++n % 2 === 1 ? { status: 503, json: { error: { code: 503, message: 'Backend Error' } } } : undefined);
  const up = await within(drive.uploadToDrive(token, FOLDER, file, 'flaky.bin', sa.email).then((x) => x.id, (err: Error) => err.message));
  assert.ok(google.files.has(String(up)), String(up));
  google.files.delete(String(up));

  // Every piece after the first: "308, I have it all" without finishing.
  const small = path.join(dir, 'stuck.bin');
  fs.writeFileSync(small, crypto.randomBytes(300 * 1024));
  let puts = 0;
  google.before = (r) => (r.method === 'PUT' && ++puts >= 2 ? { status: 308, headers: { range: `bytes=0-${300 * 1024 - 1}` } } : undefined);
  const stuck = await within(drive.uploadToDrive(token, FOLDER, small, 'stuck.bin', sa.email).then(() => 'uploaded', (err: Error) => err.message));
  assert.match(String(stuck), /not moving forward/);
  google.before = null;
  fs.rmSync(file);
  fs.rmSync(small);
});

test('retention: a copy Google refuses to delete for good is dropped from the list (audited) and the others still go', async () => {
  enableSa(30);
  const made: string[] = [];
  for (const day of [10, 11]) {
    const r = await backup.createBackup(new Date(Date.UTC(2026, 6, day, 8)));
    assert.equal((await drive.copyBackupToDrive(r.file))?.lastError, undefined);
    made.push(path.basename(r.file));
  }
  const tracked = kvGet<Array<{ id: string; name: string }>>('backup:drive-files')!.data;
  const stuck = tracked.find((c) => c.name === made[0])!;
  const older = tracked.filter((c) => c.name !== made[0] && !made.includes(c.name));
  google.before = (r) => (r.method === 'DELETE' && r.path.includes(stuck.id) ? { status: 403, json: { error: { code: 403, message: 'The user does not have sufficient permissions for this file.', errors: [{ reason: 'insufficientFilePermissions' }] } } } : undefined);
  enableSa(1);
  const r = await backup.createBackup(new Date(Date.UTC(2026, 6, 12, 8)));
  assert.equal((await drive.copyBackupToDrive(r.file))?.lastError, undefined);
  const now = kvGet<Array<{ id: string; name: string }>>('backup:drive-files')!.data;
  assert.deepEqual(now.map((c) => c.name), [path.basename(r.file)], 'only the newest is tracked');
  assert.ok(google.files.has(stuck.id), 'Google kept the one it refused');
  assert.ok(!google.files.has(tracked.find((c) => c.name === made[1])!.id), 'the next one was still deleted');
  for (const c of older) assert.ok(!google.files.has(c.id));
  assert.match(auditText(), new RegExp(`"action":"backup\\.drive_remove_failed".*"fileId":"${stuck.id}"`));
  google.files.delete(stuck.id);
});

test('a copy that finishes after the folder changed is not recorded under the new folder', async () => {
  enableSa(30);
  const r = await backup.createBackup(new Date(Date.UTC(2026, 6, 20, 8)));
  const g = gate();
  let held = 0;
  google.before = async (q) => {
    if (isDataPut(q)) {
      held++;
      await g.promise;
    }
  };
  const p = drive.copyBackupToDrive(r.file);
  await until(() => held > 0);
  enableSa(30, OTHER);
  assert.equal(drive.driveStatus().copies, 0);
  g.open();
  await p;
  assert.equal(drive.driveStatus().copies, 0, 'not this setting’s copy');
  enableSa(30, FOLDER);
});

async function pollUntilHeld(steps: Array<'ok'>, act: () => Promise<unknown> | unknown) {
  google.deviceScript = [...steps];
  await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret }, 'o');
  const g = gate();
  let held = 0;
  google.before = async (r) => {
    if (r.path === '/token' && r.form?.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      held++;
      await g.promise;
    }
  };
  const p = drive.pollDriveConnect('o', Date.now() + 60_000);
  await until(() => held > 0);
  google.before = null;
  await act();
  g.open();
  return p;
}

test('the device flow: a poll that finishes after Cancel, or after a new Connect, saves nothing and keeps the new sign-in', async () => {
  drive.saveDriveSettings({ mode: 'oauth', enabled: false, disconnect: true }, 'o');
  const cancelled = await pollUntilHeld(['ok'], () => drive.cancelDriveConnect('o'));
  assert.equal(cancelled.outcome, 'none');
  assert.equal(drive.driveStatus().connected, false, 'not connected after Cancel');
  const restarted = await pollUntilHeld(['ok'], () => drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret }, 'o'));
  assert.equal(restarted.outcome, 'none');
  assert.equal(drive.driveStatus().connected, false);
  assert.ok(drive.driveStatus().connecting, 'the new sign-in is still waiting');
  drive.cancelDriveConnect('o');
});

test('the folder could not be made after Google approved: the connection is kept and the folder is made by the next backup', async () => {
  // A first connection: no folder of the shop's yet.
  kvSet('backup:drive', { ...kvGet<Record<string, unknown>>('backup:drive')!.data, oauthFolderId: '' });
  google.deviceScript = ['ok'];
  await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret }, 'o');
  google.before = (r) => (r.method === 'POST' && r.path.startsWith('/drive/v3/files') ? { status: 500, json: { error: { code: 500, message: 'Backend Error' } } } : undefined);
  const r = await drive.pollDriveConnect('o', Date.now() + 60_000);
  google.before = null;
  assert.equal(r.outcome, 'connected');
  assert.equal(r.status.connected, true);
  assert.equal(r.status.enabled, true);
  assert.equal(r.status.oauthFolderId, '');
  assert.equal(r.status.level, 'ok', 'not failing: the folder comes with the next copy');
  const b = await backup.createBackup(new Date(Date.UTC(2026, 7, 1, 8)));
  const st = await drive.copyBackupToDrive(b.file);
  assert.equal(st?.lastError, undefined, st?.lastError);
  const folder = drive.driveStatus().oauthFolderId;
  assert.equal(google.files.get(folder)?.name, 'Beautiful UAE Home backups');
  assert.ok(ours().some((f) => f.name === path.basename(b.file) && f.parents.includes(folder)));
});

test('Disconnect revokes the refresh token at Google (best effort, audited), then forgets it', async () => {
  const token = google.refreshToken;
  const st = await drive.updateDriveSettings({ disconnect: true }, 'o');
  assert.equal(st.connected, false);
  assert.ok(google.revoked.has(token), 'revoked at Google');
  const call = google.requests.filter((r) => r.path === '/revoke').at(-1)!;
  assert.equal(call.method, 'POST');
  assert.equal(call.form?.token, token);
  assert.match(auditText(), /"action":"backup\.drive_revoked".*"ok":true/);
  assert.ok(!auditText().includes(token));

  // Google unreachable: still disconnected here.
  google.revoked.clear();
  google.deviceScript = ['ok'];
  await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret }, 'o');
  assert.equal((await drive.pollDriveConnect('o', Date.now() + 60_000)).outcome, 'connected');
  google.before = (r) => (r.path === '/revoke' ? { status: 503, json: {} } : undefined);
  assert.equal((await drive.updateDriveSettings({ disconnect: true }, 'o')).connected, false);
  assert.match(auditText(), /"action":"backup\.drive_revoked".*"ok":false/);
  assert.ok(!JSON.parse(fs.readFileSync(SECRETS, 'utf8')).refreshToken, 'forgotten');
});

test('the restore script: a download that cannot be written fails cleanly; a page token that repeats is not a loop', async () => {
  enableSa();
  const saved = { key: process.env.BUH_DRIVE_KEY, folder: process.env.BUH_DRIVE_FOLDER };
  process.env.BUH_DRIVE_KEY = sa.json;
  process.env.BUH_DRIVE_FOLDER = FOLDER;
  try {
    const dest = path.join(dir, 'already-here.enc');
    fs.writeFileSync(dest, 'x');
    await assert.rejects(fromDrive.downloadFromDrive('latest', dest, { dataDir: '', minFree: 0 }), /EEXIST|exists/);
    fs.rmSync(dest);
    google.pageLoop = true;
    const before = google.requests.length;
    const r = await within(fromDrive.listDriveCopies('').then((x: { copies: unknown[] }) => x.copies.length, (err: Error) => err.message));
    assert.notEqual(r, 'timeout');
    assert.ok(google.requests.length - before < 60, 'a bounded number of pages');
  } finally {
    google.pageLoop = false;
    if (saved.key === undefined) delete process.env.BUH_DRIVE_KEY;
    else process.env.BUH_DRIVE_KEY = saved.key;
    if (saved.folder === undefined) delete process.env.BUH_DRIVE_FOLDER;
    else process.env.BUH_DRIVE_FOLDER = saved.folder;
  }
});

test('the restore script: Ctrl-C or a stop during the download removes the partial download (a random temp name)', async () => {
  enableSa();
  const big = await backup.createBackup(new Date(Date.UTC(2026, 8, 1, 8)));
  assert.equal((await drive.copyBackupToDrive(big.file))?.lastError, undefined);
  const g = gate();
  google.slowMedia = g.promise;
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buh-hard-stop-')), 'restore');
  const run = restore(['--from-drive', 'latest', target], { ...saEnv, BUH_TEST_GOOGLE_API: google.url, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'buh-hard-')) });
  let partial = '';
  await until(() => {
    partial = fs.existsSync(target) ? (fs.readdirSync(target).find((f) => f.startsWith('.drive-download-')) ?? '') : '';
    return Boolean(partial) && fs.statSync(path.join(target, partial)).size > 0;
  }, 10_000);
  assert.match(partial, /^\.drive-download-[a-f0-9]{16,}\.tar\.gz\.enc$/);
  assert.ok(!partial.includes(String(run.child.pid)), 'not named by the process id');
  run.child.kill('SIGTERM');
  const r = await run.done;
  g.open();
  assert.match(r.out, /Stopped\./);
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(target), 'the partial download and the folder are removed');
  fs.rmSync(big.file);
});

test('BUH_TEST_*_API stand-ins: in production only with the test server’s flag', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, flag: process.env.BUH_TEST_SERVER };
  const env = process.env as Record<string, string | undefined>;
  try {
    env.BUH_TEST_X_API = 'http://127.0.0.1:4321/';
    delete env.BUH_TEST_SERVER;
    env.NODE_ENV = 'development';
    assert.equal(testStandIn('BUH_TEST_X_API')?.port, '4321');
    env.NODE_ENV = 'production';
    assert.equal(testStandIn('BUH_TEST_X_API'), null, 'ignored in production');
    env.BUH_TEST_SERVER = '1';
    assert.equal(testStandIn('BUH_TEST_X_API')?.port, '4321', 'the test server');
    env.BUH_TEST_X_API = 'https://evil.example/';
    assert.equal(testStandIn('BUH_TEST_X_API'), null, 'loopback only');
  } finally {
    delete env.BUH_TEST_X_API;
    env.NODE_ENV = saved.NODE_ENV;
    if (saved.flag === undefined) delete env.BUH_TEST_SERVER;
    else env.BUH_TEST_SERVER = saved.flag;
  }
  // The restore script follows the same rule.
  const script = fs.readFileSync('scripts/restore-from-drive.mjs', 'utf8');
  assert.match(script, /NODE_ENV === 'production' && process\.env\.BUH_TEST_SERVER !== '1'/);
});
