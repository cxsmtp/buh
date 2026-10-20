/**
 * Copies of each backup in Google Drive (src/lib/server/driveBackup.ts) and the rebuild from them
 * (scripts/restore-backup.mjs --from-drive), against a stand-in for Google on 127.0.0.1
 * (BUH_TEST_GOOGLE_API, loopback only): the JWT, the token exchange, the resumable upload in pieces
 * checked against Drive's size and MD5, retention that deletes only this feature's copies, the
 * refusal without a passphrase, the key never shown, backed up or logged, the owner alert, and a
 * restore into an empty folder that brings back products, orders, settings and photos.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';
import { addForeignFile, makeServiceAccount, startGoogleMock, type GoogleMock } from './google-drive-mock.mjs';

const dir = tempDataDir();
const PASS = 'correct horse battery staple';
delete process.env.BACKUP_PASSPHRASE;
process.env.MONITOR_DISABLED = 'true';

const sa = makeServiceAccount();
let google: GoogleMock;

// Everything the server logs, to check no key or token is ever in it.
const logged: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error'] as const) {
  console[k] = (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  };
}

const drive = await import('@/lib/server/driveBackup');
const backup = await import('@/lib/server/backup');
const { kvGet, kvSet } = await import('@/lib/server/kv');
const { localBackupTime } = await import('@/lib/server/backupPolicy');
const { logEvent, redact } = await import('@/lib/server/log');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { placeOrder } = await import('@/lib/server/orders');
const { listProducts } = await import('@/lib/server/products');
const settings = await import('@/lib/server/settings');
const monitor = await import('@/lib/server/monitor');

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz_folder';

before(async () => {
  google = await startGoogleMock(sa);
  process.env.BUH_TEST_GOOGLE_API = google.url;
});
after(async () => {
  Object.assign(console, original);
  await google.close();
});

function order(name: string) {
  const p = listProducts()[0];
  return placeOrder({
    idempotencyKey: `drive-${crypto.randomUUID()}`,
    verificationToken: issuePhoneToken('+971501234567'),
    customer: { fullName: name, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
}

const ours = () => [...google.files.values()].filter((f) => f.appProperties?.buhBackup === '1');

function enable(keep = 30) {
  process.env.BACKUP_PASSPHRASE = PASS;
  return drive.saveDriveSettings({ enabled: true, folderId: `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`, keep, serviceAccountKey: sa.json }, 'owner@shop.ae');
}

test('the folder id is taken from a link or as it is; anything else is refused', () => {
  assert.equal(drive.parseFolderId(FOLDER), FOLDER);
  assert.equal(drive.parseFolderId(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`), FOLDER);
  assert.equal(drive.parseFolderId(`https://drive.google.com/drive/u/0/folders/${FOLDER}`), FOLDER);
  assert.equal(drive.parseFolderId(`https://drive.google.com/open?id=${FOLDER}`), FOLDER);
  assert.throws(() => drive.parseFolderId('https://evil.example/drive/folders/1AbCdEfGhIjKlMnOp'), /drive\.google\.com/);
  assert.throws(() => drive.parseFolderId('not a folder'), /link/);
});

test('the service account key: only a real service account JSON with an RSA private key', () => {
  const k = drive.parseServiceAccountKey(sa.json);
  assert.equal(k.clientEmail, sa.email);
  assert.equal(k.keyId, sa.keyId);
  assert.throws(() => drive.parseServiceAccountKey('{'), /whole JSON/);
  assert.throws(() => drive.parseServiceAccountKey(JSON.stringify({ ...JSON.parse(sa.json), type: 'authorized_user' })), /not a service account/);
  assert.throws(() => drive.parseServiceAccountKey(JSON.stringify({ ...JSON.parse(sa.json), client_email: 'me@gmail.com' })), /client_email/);
  assert.throws(() => drive.parseServiceAccountKey(JSON.stringify({ ...JSON.parse(sa.json), private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' })), /could not be read/);
});

test('the JWT: RS256 with the key id, issued by the service account for the Drive scope, one hour, signed by its key', () => {
  const now = 1_800_000_000;
  const jwt = drive.serviceAccountJwt(sa.email, sa.pem, sa.keyId, now);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT', kid: sa.keyId });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: sa.email, scope: 'https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), sa.publicKey, Buffer.from(s, 'base64url')));
  assert.ok(!/[+/=]/.test(jwt), 'base64url');
});

test('the token exchange: the JWT bearer grant at Google’s token address; kept until it runs out; a wrong key is refused readably', async () => {
  drive._resetDriveToken();
  const cfg = drive.parseServiceAccountKey(sa.json);
  const before = google.requests.length;
  assert.equal(await drive.accessToken(cfg), google.token);
  assert.equal(await drive.accessToken(cfg), google.token);
  const calls = google.requests.slice(before).filter((r) => r.path === '/token');
  assert.equal(calls.length, 1, 'the token is reused');
  assert.equal(calls[0].method, 'POST');
  assert.match(String(calls[0].headers['content-type']), /application\/x-www-form-urlencoded/);
  assert.equal(google.jwts.at(-1)!.claims.iss, sa.email);

  drive._resetDriveToken();
  const other = makeServiceAccount(sa.email);
  await assert.rejects(drive.accessToken(drive.parseServiceAccountKey(other.json)), (err: Error) => /did not accept the service account key \(Invalid JWT Signature\.\)/.test(err.message) && !err.message.includes('PRIVATE'));
  drive._resetDriveToken();
});

test('switching copies on is refused without a backup password; a copy is never made while it is missing', async () => {
  delete process.env.BACKUP_PASSPHRASE;
  assert.throws(() => drive.saveDriveSettings({ enabled: true, folderId: FOLDER, serviceAccountKey: sa.json }), (err: Error & { status?: number; details?: { code?: string } }) => err.status === 400 && err.details?.code === 'passphrase_required' && /No backup password is set/.test(err.message) && !/BACKUP_PASSPHRASE/.test(err.message));
  assert.equal(drive.driveStatus().enabled, false);
  // Saving without switching on is fine (the key and folder are kept).
  drive.saveDriveSettings({ enabled: false, folderId: FOLDER, serviceAccountKey: sa.json });
  assert.equal(drive.driveStatus().keySaved, true);

  // Switched on, then the passphrase removed: an (unencrypted) backup is not copied, and says why.
  enable();
  delete process.env.BACKUP_PASSPHRASE;
  const plain = await backup.createBackup();
  assert.match(plain.file, /\.tar\.gz$/);
  const uploads = google.requests.filter((r) => r.path.startsWith('/upload/')).length;
  const st = await drive.copyBackupToDrive(plain.file);
  assert.match(String(st?.lastError), /No backup password is set/);
  assert.equal(google.requests.filter((r) => r.path.startsWith('/upload/')).length, uploads, 'nothing sent to Google');
  // An unencrypted file is refused even with a passphrase set.
  process.env.BACKUP_PASSPHRASE = PASS;
  assert.match(String((await drive.copyBackupToDrive(plain.file))?.lastError), /not encrypted/);
  fs.rmSync(plain.file);
});

test('a backup goes up in resumable pieces read from disk, matches Drive’s size and MD5, and is recorded', async () => {
  enable();
  // About 1 MB of photo that does not compress: at 256 KB a piece, at least 4 pieces.
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'noise.jpg'), crypto.randomBytes(1024 * 1024));
  drive.DRIVE_LIMITS.chunkBytes = 256 * 1024;
  try {
    const result = await backup.createBackup();
    const pieces = google.chunks.length;
    const st = await drive.copyBackupToDrive(result.file);
    assert.equal(st?.lastError, undefined, st?.lastError);
    const sent = google.chunks.slice(pieces);
    assert.ok(sent.length >= 4, `${sent.length} pieces`);
    assert.ok(sent.slice(0, -1).every((n) => n === 256 * 1024), 'every piece but the last is a full one');
    const up = ours().find((f) => f.name === path.basename(result.file))!;
    assert.ok(up.parents.includes(FOLDER));
    assert.ok(up.data.equals(fs.readFileSync(result.file)), 'Drive holds exactly the backup');
    assert.ok(up.data.subarray(0, 7).toString() === 'BUHBK1\n', 'encrypted');
    const start = google.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/upload/drive/v3/files')).at(-1)!;
    assert.match(start.path, /uploadType=resumable/);
    assert.match(start.path, /supportsAllDrives=true/);
    assert.equal(start.headers['x-upload-content-length'], String(fs.statSync(result.file).size));
    const status = drive.driveStatus();
    assert.equal(status.level, 'ok');
    assert.equal(status.lastFile, path.basename(result.file));
    assert.equal(status.lastSize, fs.statSync(result.file).size);
    assert.equal(status.copies, 1);
  } finally {
    drive.DRIVE_LIMITS.chunkBytes = 8 * 1024 * 1024;
  }
});

test('a copy whose size or MD5 does not match is refused and removed from Drive', async () => {
  enable();
  for (const kind of ['md5', 'size'] as const) {
    const result = await backup.createBackup(new Date(Date.UTC(2026, 0, 2, kind === 'md5' ? 1 : 2)));
    const copiesBefore = drive.driveStatus().copies;
    const filesBefore = google.files.size;
    google.tamper = { [kind]: true };
    try {
      const st = await drive.copyBackupToDrive(result.file);
      assert.match(String(st?.lastError), /does not match the backup/);
    } finally {
      google.tamper = {};
    }
    assert.equal(google.files.size, filesBefore, 'the mismatched upload was deleted');
    assert.equal(drive.driveStatus().copies, copiesBefore);
    assert.equal(drive.driveStatus().level, 'failing');
    fs.rmSync(result.file);
  }
});

test('retention keeps the newest N copies and deletes only copies this feature made', async () => {
  enable(2);
  const foreign = [addForeignFile(google, FOLDER, 'Owner notes.docx'), addForeignFile(google, FOLDER, 'buh-backup-20250101-0000.tar.gz.enc', Buffer.from('owner’s own copy'))];
  const elsewhere = addForeignFile(google, 'some-other-folder-id', 'buh-backup-20240101-0000.tar.gz.enc');
  const names: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await backup.createBackup(new Date(Date.UTC(2026, 1, 1 + i, 12)));
    names.push(path.basename(r.file));
    const st = await drive.copyBackupToDrive(r.file);
    assert.equal(st?.lastError, undefined, st?.lastError);
  }
  assert.deepEqual(ours().map((f) => f.name).sort(), names.slice(-2).sort(), 'the two newest');
  for (const id of [...foreign, elsewhere]) assert.ok(google.files.has(id), 'the owner’s files are untouched');
  assert.equal(drive.driveStatus().copies, 2);
  // A copy the owner deleted by hand already counts as gone (Drive's 404).
  const tracked = kvGet<Array<{ id: string }>>('backup:drive-files')!.data;
  google.files.delete(tracked[0].id);
  enable(1);
  const r = await backup.createBackup(new Date(Date.UTC(2026, 1, 9, 12)));
  assert.equal((await drive.copyBackupToDrive(r.file))?.lastError, undefined);
  assert.deepEqual(ours().map((f) => f.name), [path.basename(r.file)]);
  for (const id of [...foreign, elsewhere]) assert.ok(google.files.has(id));
});

const H = 3600_000;
const DAY = 24 * H;
const localNames = () => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('buh-backup-')) : []);

/** Undo a test's backups and copies (named in the future: "latest" for the restore test otherwise). */
function snapshotCopies() {
  const files = new Set(google.files.keys());
  const tracked = kvGet('backup:drive-files')?.data ?? [];
  const local = new Set(localNames());
  return () => {
    for (const id of [...google.files.keys()]) if (!files.has(id)) google.files.delete(id);
    kvSet('backup:drive-files', tracked);
    kvSet('backup:clock', {});
    for (const n of localNames()) if (!local.has(n)) fs.rmSync(path.join(dir, 'backups', n));
  };
}

test('the server’s clock a year ahead for 5 backups: no copy is removed in Drive or on the server, the hub warns; put right, all is as before', async () => {
  enable(60);
  const undo = snapshotCopies();
  // One backup a day for 10 days with the server's clock and Google's agreeing, then 5 with the
  // server's a year ahead (Google's: the real time), then the clock put right.
  const start = Date.now() + DAY;
  const step = async (server: number, googleTime: number) => {
    mock.timers.setTime(server);
    google.clock = () => googleTime;
    const r = await backup.createBackup(new Date(server));
    const st = await drive.copyBackupToDrive(r.file);
    assert.equal(st?.lastError, undefined, st?.lastError);
  };
  mock.timers.enable({ apis: ['Date'], now: start });
  try {
    for (let i = 0; i < 10; i++) await step(start + i * DAY, start + i * DAY);
    const uploadStart = google.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/upload/drive/v3/files')).at(-1)!;
    assert.match(uploadStart.path, /fields=[^&]*createdTime/, 'Google is asked when it made the copy');
    const tracked = kvGet<Array<{ id: string; createdTime?: string }>>('backup:drive-files')!.data;
    assert.ok(tracked.every((c) => c.createdTime), 'each copy keeps Google’s createdTime');
    const history = ours().map((f) => f.id);
    assert.ok(history.length >= 10, String(history.length));
    const last = start + 9 * DAY;
    const localHistory = localNames().filter((n) => last - localBackupTime(n)! <= 14 * DAY);
    assert.ok(localHistory.length >= 10);
    for (let j = 1; j <= 5; j++) await step(last + 365 * DAY + j * DAY, last + j * DAY);
    for (const id of history) assert.ok(google.files.has(id), 'every copy from before is still in Drive');
    assert.equal(ours().length, history.length + 5);
    for (const n of localHistory) assert.ok(localNames().includes(n), `${n} is still on the server`);
    assert.ok(logged.some((l) => l.includes('backup_clock_skew')), 'logged');
    assert.equal(drive.serverClockSuspect(), true);
    const health = backup.backupHealth();
    assert.equal(health.clockWarning, drive.CLOCK_WRONG);
    assert.notEqual(health.level, 'ok');
    assert.ok(monitor.currentProblems().some((p) => p.id === 'clock' && p.level === 'warning' && p.text === drive.CLOCK_WRONG));
    // The clock put right: the warning goes, and Drive's retention runs as before (by Google's times).
    const fixed = last + 6 * DAY;
    await step(fixed, fixed);
    assert.equal(drive.serverClockSuspect(), false);
    assert.equal(backup.backupHealth().clockWarning, undefined);
    for (const id of history) assert.ok(google.files.has(id), 'within the rules (4 a day, 60 copies): all kept');
  } finally {
    mock.timers.reset();
    google.clock = () => new Date().getTime();
    undo();
  }
});

test('copies recorded before createdTime was kept: dated from Drive’s list, and never removed until they are', async (t) => {
  enable(60);
  const undo = snapshotCopies();
  t.after(undo);
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const r = await backup.createBackup(new Date(now + (i + 30) * 60_000));
    assert.equal((await drive.copyBackupToDrive(r.file))?.lastError, undefined);
  }
  const tracked = kvGet<Array<{ id: string; name: string; size: number; at: string; createdTime?: string }>>('backup:drive-files')!.data;
  const [oldId, recentId] = tracked.slice(-3).map((c) => c.id);
  // Google made one 400 days ago and one yesterday; an older version recorded neither's createdTime.
  google.files.get(oldId)!.createdTime = new Date(now - 400 * DAY).toISOString();
  google.files.get(recentId)!.createdTime = new Date(now - DAY).toISOString();
  kvSet('backup:drive-files', tracked.map((c) => (c.id === oldId || c.id === recentId ? { id: c.id, name: c.name, size: c.size, at: new Date(now - 400 * DAY).toISOString() } : c)));
  // Drive's list fails: neither can be dated, so neither is removed (even the old-looking one).
  google.before = (req) => (req.method === 'GET' && req.path.startsWith('/drive/v3/files?') ? { status: 500, json: { error: { code: 500, message: 'Backend Error' } } } : undefined);
  try {
    const r = await backup.createBackup(new Date(now + 40 * 60_000));
    assert.equal((await drive.copyBackupToDrive(r.file))?.lastError, undefined, 'a failed list never fails the copy');
  } finally {
    google.before = null;
  }
  assert.ok(google.files.has(oldId) && google.files.has(recentId), 'nothing undated was removed');
  const undated = kvGet<Array<{ id: string; createdTime?: string }>>('backup:drive-files')!.data.filter((c) => !c.createdTime).map((c) => c.id);
  assert.deepEqual(undated.sort(), [oldId, recentId].sort());
  // The list works: both are dated with Google's times; the one Google made 400 days ago goes, yesterday's stays.
  const r = await backup.createBackup(new Date(now + 41 * 60_000));
  assert.equal((await drive.copyBackupToDrive(r.file))?.lastError, undefined);
  const list = google.requests.filter((q) => q.method === 'GET' && q.path.startsWith('/drive/v3/files?')).at(-1)!;
  assert.match(decodeURIComponent(list.path), /fields=nextPageToken,files\(id,createdTime\)/);
  assert.ok(!google.files.has(oldId), 'Google says it is 400 days old: removed');
  assert.ok(google.files.has(recentId));
  const after = kvGet<Array<{ id: string; createdTime?: string }>>('backup:drive-files')!.data;
  assert.equal(after.find((c) => c.id === recentId)?.createdTime, new Date(now - DAY).toISOString());
  assert.ok(after.every((c) => c.createdTime));
});

test('the key is never shown, never in a backup or settings history, never logged; log.ts removes keys and tokens', async () => {
  enable(30);
  const status = drive.driveStatus();
  assert.equal(status.clientEmail, sa.email);
  assert.equal(status.keySaved, true);
  assert.ok(!JSON.stringify(status).includes('PRIVATE KEY'));
  assert.ok(!('privateKey' in status));

  // The backup's copy of the database keeps the folder and the switch, not the key.
  const result = await backup.createBackup(new Date(Date.UTC(2026, 2, 1)));
  const entries = backup.openBackup(fs.readFileSync(result.file), PASS);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buh-drive-db-')), 'shop.db');
  fs.writeFileSync(tmp, entries.find((e) => e.name === 'shop.db')!.data);
  const copy = new Database(tmp, { readonly: true });
  const saved = JSON.parse((copy.prepare("SELECT data FROM kv WHERE key = 'backup:drive'").get() as { data: string }).data);
  copy.close();
  assert.equal(saved.privateKey, '');
  assert.equal(saved.folderId, FOLDER);
  assert.equal(saved.enabled, true);
  assert.ok(!entries.some((e) => e.data.includes(Buffer.from('BEGIN PRIVATE KEY'))), 'nowhere in the backup');
  // Not in settings history either (it is not a settings group at all).
  assert.equal(settings.settingsHistory(200).filter((v) => String(v.key).includes('drive')).length, 0);

  // A failed test with the key typed: the reply and the log name no key.
  google.failStart = { status: 403, reason: 'insufficientFilePermissions', message: `no access ${sa.pem}` };
  await assert.rejects(drive.testDriveConnection({ serviceAccountKey: sa.json, folderId: FOLDER }), (err: Error) => /Share the folder with/.test(err.message) && !err.message.includes('PRIVATE') && !err.message.includes('MII'));

  // logEvent: by name and by shape.
  logEvent('warn', 'drive_key_check', { private_key: sa.pem, privateKey: sa.pem, note: `key ${sa.pem} token ${google.token}`, json: sa.json });
  assert.equal((redact({ private_key: 'x' }) as Record<string, string>).private_key, '[redacted]');
  assert.match(String(redact(`a ${sa.pem} b`)), /\[private key redacted\]/);
  assert.match(String(redact(`Bearer ${google.token}`)), /ya29\.\[redacted\]/);
  // A key cut in the middle by the 500-character limit is still removed.
  assert.ok(!String(redact(`${'x'.repeat(300)} ${sa.pem}`)).includes('MII'));

  const all = logged.join('\n');
  assert.ok(!all.includes('PRIVATE KEY-----\nMII') && !all.includes('MII'), 'no private key in the log');
  assert.ok(!all.includes(google.token), 'no access token in the log');
  const auditText = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!auditText.includes('MII') && !auditText.includes(google.token), 'nor in the audit log');
  assert.match(auditText, /backup\.drive_copied/);
  fs.rmSync(result.file);
});

test('a failed copy raises the owner alert without failing the local backup; a good copy clears it', async () => {
  enable(30);
  google.failStart = { status: 403, reason: 'storageQuotaExceeded', message: 'Service Accounts do not have storage quota.' };
  const local = await backup.runBackup('manual');
  await drive.waitForDriveCopy(); // the copy runs on after the backup
  assert.ok(local.lastSuccessAt && !local.lastError, 'the local backup succeeded');
  assert.equal(backup.backupHealth().level === 'failing', false);
  const status = drive.driveStatus();
  assert.equal(status.level, 'failing');
  assert.match(String(status.lastError), /shared drive/);
  const problems = monitor.currentProblems();
  const p = problems.find((x) => x.id === 'drive_backup');
  assert.ok(p && p.level === 'failing' && /Google Drive failed: Google does not let a service account/.test(p.text), JSON.stringify(problems));
  assert.ok(!problems.some((x) => x.id === 'backup' && x.level === 'failing'), 'the local backup is not reported as failing');
  await monitor.checkAndAlert();
  const auditText = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(auditText, /"action":"monitor\.problem".*"id":"drive_backup"/);
  assert.match(auditText, /backup\.drive_failed/);

  // Paused without the passphrase: also an alert.
  delete process.env.BACKUP_PASSPHRASE;
  assert.match(String(monitor.currentProblems().find((x) => x.id === 'drive_backup')?.text), /paused: No backup password is set/);
  process.env.BACKUP_PASSPHRASE = PASS;

  await backup.runBackup('manual');
  await drive.waitForDriveCopy(); // the copy runs on after the backup
  assert.equal(drive.driveStatus().level, 'ok');
  assert.equal(monitor.currentProblems().find((x) => x.id === 'drive_backup'), undefined);
});

test('Test connection uploads a tiny file and deletes it again', async () => {
  enable(30);
  const files = google.files.size;
  const res = await drive.testDriveConnection({});
  assert.equal(res.clientEmail, sa.email);
  assert.equal(google.files.size, files, 'the test file is gone again');
  const start = google.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/upload/')).at(-1)!;
  assert.ok(start.bodySize > 0);
  assert.ok(google.requests.some((r) => r.method === 'DELETE'));
});

/** The restore script, run as the owner would (async: the stand-in for Google answers from this process). */
function restore(args: string[], env: Record<string, string | undefined>): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/restore-backup.mjs', ...args], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

function check(target: string, expect: { orders: number; storeName: string }) {
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n, expect.orders);
    assert.ok((db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n > 0);
    const brand = JSON.parse((db.prepare("SELECT data FROM settings WHERE key = 'brand'").get() as { data: string }).data);
    assert.equal(brand.storeName, expect.storeName);
  } finally {
    db.close();
  }
  assert.ok(fs.readFileSync(path.join(target, 'images', 'photo-1.jpg')).equals(PHOTO), 'the photo is back');
}

const PHOTO = crypto.randomBytes(4096);

test('one-command rebuild: --from-drive latest into an empty folder brings back products, orders, settings and photos', async () => {
  enable(30);
  order('Fatima Al Mansoori');
  order('Aisha Khan');
  const brand = settings.adminView('brand').value;
  await settings.updateSettings('brand', { ...brand, storeName: 'Round Trip Linens' });
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'images', 'photo-1.jpg'), PHOTO);
  const live = new Database(path.join(dir, 'shop.db'), { readonly: true });
  const count = (live.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  live.close();
  const state = await backup.runBackup('manual');
  await drive.waitForDriveCopy(); // the copy runs on after the backup
  assert.equal(drive.driveStatus().lastFile, state.lastFile);
  // Two backups in the same minute replace each other on the server: in Drive too (no duplicates of ours).
  const names = ours().map((f) => f.name);
  assert.equal(new Set(names).size, names.length, names.join(', '));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-drive-restore-'));

  // Inside the running shop (podman exec): the saved key and folder, into a new empty folder.
  const a = path.join(scratch, 'from-settings');
  const r1 = await restore(['--from-drive', 'latest', a], { BUH_TEST_GOOGLE_API: google.url, BACKUP_PASSPHRASE: PASS, DATA_DIR: dir });
  assert.equal(r1.status, 0, r1.out);
  assert.match(r1.out, new RegExp(`Downloaded ${state.lastFile!.replace(/\./g, '\\.')} .*size and checksum match`));
  assert.match(r1.out, /Integrity check: ok/);
  check(a, { orders: count, storeName: 'Round Trip Linens' });
  assert.deepEqual(fs.readdirSync(a).filter((f) => f.startsWith('.drive-download')), [], 'the download is removed');

  // A brand-new server: nothing but the image, the key and folder in the environment, DATA_DIR empty.
  const b = path.join(scratch, 'fresh-data');
  fs.mkdirSync(b);
  const env = { BUH_TEST_GOOGLE_API: google.url, BACKUP_PASSPHRASE: PASS, DATA_DIR: b, BUH_DRIVE_KEY: sa.json, BUH_DRIVE_FOLDER: `https://drive.google.com/drive/folders/${FOLDER}` };
  const list = await restore(['--from-drive', 'list'], env);
  assert.equal(list.status, 0, list.out);
  assert.match(list.out, new RegExp(state.lastFile!.replace(/\./g, '\\.')));
  assert.ok(!/Owner notes/.test(list.out), 'only backup copies are listed');
  const r2 = await restore(['--from-drive', 'latest'], env);
  assert.equal(r2.status, 0, r2.out);
  check(b, { orders: count, storeName: 'Round Trip Linens' });
  // The restored shop has the folder but not the key (paste it again).
  const db = new Database(path.join(b, 'shop.db'), { readonly: true });
  const saved = JSON.parse((db.prepare("SELECT data FROM kv WHERE key = 'backup:drive'").get() as { data: string }).data);
  const restored = JSON.parse((db.prepare("SELECT data FROM kv WHERE key = 'admin:restored'").get() as { data: string }).data);
  db.close();
  assert.equal(saved.privateKey, '');
  assert.equal(restored.backup, `${state.lastFile} (Google Drive)`, 'the audit names the copy restored');

  // Refusals: no passphrase, a folder that is not empty, a copy that is not there, a wrong passphrase (nothing left behind).
  const c = path.join(scratch, 'refusals');
  assert.match((await restore(['--from-drive', 'latest', c], { ...env, BACKUP_PASSPHRASE: '' })).out, /give the backup password/);
  assert.match((await restore(['--from-drive', 'latest', a], env)).out, /not empty/);
  const missing = await restore(['--from-drive', 'buh-backup-19990101-0000.tar.gz.enc', c], env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.out, /No copy called/);
  const wrong = await restore(['--from-drive', 'latest', c], { ...env, BACKUP_PASSPHRASE: 'not the passphrase' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.out, /Wrong password: this backup was made with another backup password/);
  assert.ok(!fs.existsSync(c) || fs.readdirSync(c).length === 0, 'nothing left behind');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('nothing new: no backup and no Drive copy; a "Back up now" with nothing new is not copied again; a change is', async () => {
  enable(30);
  google.failStart = null;
  await settings.updateSettings('store', { supportEmail: 'before@shop.test' });
  await backup.runBackup('manual');
  await drive.waitForDriveCopy();
  const copies = ours().length;
  const tried = drive.driveStatus().lastAttemptAt;
  assert.equal(drive.driveStatus().lastFile, backup.readBackupState().lastFile, 'the backup is in Drive');
  // Nothing changes: the schedule takes no backup, so nothing goes to Drive.
  assert.equal(backup.backupTick(Date.now() + 3 * 3600_000), null);
  await drive.waitForDriveCopy();
  assert.equal(ours().length, copies);
  assert.equal(drive.driveStatus().lastAttemptAt, tried, 'no copy tried');
  // "Back up now" with nothing new: a backup on the server, but Drive already holds the same data.
  const again = await backup.runBackup('manual');
  await drive.waitForDriveCopy();
  assert.equal(again.lastError, undefined);
  assert.equal(ours().length, copies, 'not copied again');
  assert.equal(drive.driveStatus().lastAttemptAt, tried, 'no copy tried');
  assert.equal(monitor.currentProblems().find((x) => x.id === 'drive_backup'), undefined, 'and no alert for it');
  // A change: the next backup is copied.
  await settings.updateSettings('store', { supportEmail: 'after@shop.test' });
  await backup.runBackup('changes');
  await drive.waitForDriveCopy();
  assert.notEqual(drive.driveStatus().lastAttemptAt, tried, 'copied');
  assert.equal(drive.driveStatus().lastFile, backup.readBackupState().lastFile);
  assert.equal(drive.driveStatus().level, 'ok');
});

test('the image ships the Drive restore next to the restore script', () => {
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  assert.match(dockerfile, /COPY --from=builder \/app\/scripts\/restore-backup\.mjs \.\/scripts\/restore-backup\.mjs/);
  assert.match(dockerfile, /COPY --from=builder \/app\/scripts\/restore-from-drive\.mjs \.\/scripts\/restore-from-drive\.mjs/);
  assert.match(fs.readFileSync('scripts/restore-backup.mjs', 'utf8'), /import\('\.\/restore-from-drive\.mjs'\)/);
});
