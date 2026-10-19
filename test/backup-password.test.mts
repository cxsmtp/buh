/**
 * The backup password chosen in the Admin Hub (src/lib/server/backupSecret.ts): made by the shop
 * ("Make one for me", shown once, then confirmed) or typed; changed; kept in DATA_DIR/backup-secret.json
 * (owner-only, never in a backup); BACKUP_PASSPHRASE still wins; backups encrypted with it and
 * restorable by the restore script inside the shop (reading the file); a backup made with an earlier
 * password refused with the day that password was set; never in the log or the audit log; the
 * health alert pointing to the hub; Google Drive copies switched on as soon as a password exists;
 * Google's client file read in the browser; the setup wizard's ticks kept.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';
import { makeServiceAccount, OAUTH_CLIENT, startGoogleMock, type GoogleMock } from './google-drive-mock.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
process.env.MONITOR_DISABLED = 'true';

const logged: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const k of ['log', 'warn', 'error'] as const) {
  console[k] = (...a: unknown[]) => {
    logged.push(a.map(String).join(' '));
  };
}

const secret = await import('@/lib/server/backupSecret');
const backup = await import('@/lib/server/backup');
const drive = await import('@/lib/server/driveBackup');
const { logEvent } = await import('@/lib/server/log');
const { audit } = await import('@/lib/server/audit');
const { WORDS } = await import('@/lib/server/wordlist');
const { parseClientJson, clientIdLooksRight } = await import('@/lib/driveClientJson');
const { passphraseStrength } = await import('@/lib/passphraseStrength');

let google: GoogleMock;
before(async () => {
  google = await startGoogleMock(makeServiceAccount());
  process.env.BUH_TEST_GOOGLE_API = google.url;
});
after(async () => {
  Object.assign(console, original);
  await google.close();
});

const secretFile = () => path.join(dir, 'backup-secret.json');
const auditText = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
const restore = (args: string[], env: Record<string, string | undefined>) => {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
  return spawnSync(process.execPath, ['scripts/restore-backup.mjs', ...args], { encoding: 'utf8', env: e as NodeJS.ProcessEnv });
};
const tmp = (name: string) => path.join(os.tmpdir(), `buh-pw-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

const made: string[] = [];

test('the wordlist and "Make one for me": six words and two digits, over 80 bits, never the same twice', () => {
  assert.ok(WORDS.length >= 7700 && new Set(WORDS).size === WORDS.length, 'a big list without repeats');
  assert.ok(WORDS.every((w) => /^[a-z]+$/.test(w)));
  assert.ok(secret.generatedBits() >= 80, `${secret.generatedBits()} bits`);
  const a = secret.generatePassphrase();
  const b = secret.generatePassphrase();
  assert.match(a, /^([a-z]+-){6}\d{2}$/);
  assert.notEqual(a, b);
  for (const w of a.split('-').slice(0, 6)) assert.ok(WORDS.includes(w));
});

test('typed passwords: at least 12 characters, typed twice the same, not one character over and over', () => {
  const bad = (p: unknown, r: unknown, re: RegExp) => assert.throws(() => secret.checkTypedPassphrase(p, r), (e: Error & { status?: number }) => e.status === 400 && re.test(e.message));
  bad('short one', 'short one', /at least 12/);
  bad('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaa', /too easy/);
  bad('a perfectly fine one', 'a perfectly fine 0ne', /not the same/);
  bad(' leading space ok?', ' leading space ok?', /space/);
  bad('x'.repeat(257), 'x'.repeat(257), /at most 256/);
  bad(123, 123, /Type the password/);
  assert.equal(secret.checkTypedPassphrase('mango-harbour-velvet', 'mango-harbour-velvet'), 'mango-harbour-velvet');
  // The hint in the browser.
  assert.equal(passphraseStrength('short').level, 'too-short');
  assert.equal(passphraseStrength('password1234').level, 'weak');
  assert.equal(passphraseStrength('mango-harbour-velvet-quiet-74').level, 'fair');
  assert.equal(passphraseStrength('mango-harbour-velvet-quiet-ribbon-lantern-74').level, 'strong');
});

test('no password yet: backups are not encrypted and the health alert points to the card in the hub', async () => {
  assert.equal(secret.passphraseSource(), 'none');
  assert.equal(secret.backupPassphrase(), '');
  assert.equal(secret.passphraseStatus().encrypted, false);
  const r = await backup.createBackup();
  assert.equal(r.encrypted, false);
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.BACKUP_EMAIL = 'owner@test';
  try {
    const notice = backup.backupHealth().notice ?? '';
    assert.equal(notice, 'Backups are emailed unencrypted: anyone with a backup email can read customers’ details. Protect them with a password in Settings → System & backups.');
    assert.doesNotMatch(notice, /BACKUP_PASSPHRASE|\.env|env var/i);
  } finally {
    delete process.env.SMTP_HOST;
    delete process.env.BACKUP_EMAIL;
  }
});

test('generate, then confirm: the password is saved (owner-only file), audited without its value, backups encrypted', async () => {
  const g = await secret.startGeneratedPassphrase('owner@shop.ae');
  made.push(g.passphrase);
  // Made, not yet used.
  assert.equal(secret.passphraseSource(), 'none');
  assert.equal(fs.statSync(secretFile()).mode & 0o777, 0o600);
  const saved = secret.confirmGeneratedPassphrase('owner@shop.ae');
  assert.equal(saved.changed, false);
  assert.equal(saved.how, 'generated');
  assert.ok(audit('backup.passphrase_set', { by: 'owner@shop.ae', how: saved.how, fingerprint: saved.fingerprint, passphrase: g.passphrase, note: `typed ${g.passphrase} by mistake` }));
  assert.equal(secret.passphraseSource(), 'hub');
  assert.equal(secret.backupPassphrase(), g.passphrase);
  const st = secret.passphraseStatus();
  assert.equal(st.encrypted, true);
  assert.equal(st.how, 'generated');
  assert.match(st.fingerprint ?? '', /^[a-f0-9]{12}$/);
  assert.ok(!JSON.stringify(st).includes(g.passphrase), 'the status never holds the password');
  assert.equal(fs.statSync(secretFile()).mode & 0o777, 0o600);
  // A second confirm has nothing to confirm.
  assert.throws(() => secret.confirmGeneratedPassphrase('owner@shop.ae'), (e: Error & { status?: number }) => e.status === 409);
  assert.equal(backup.backupHealth().notice, undefined);
  assert.equal(backup.backupHealth().encrypted, true);
});

test('the password file is never in a backup (raw bytes and every file inside), and backups are encrypted with it', async () => {
  const pass = made[0];
  const r = await backup.createBackup();
  assert.equal(r.encrypted, true);
  const raw = fs.readFileSync(r.file);
  assert.ok(!raw.includes(Buffer.from(pass)), 'not in the raw bytes');
  assert.throws(() => backup.openBackup(raw), /encrypted/);
  const entries = backup.openBackup(raw, pass);
  assert.ok(entries.some((e) => e.name === 'shop.db'));
  assert.ok(!entries.some((e) => /backup-secret/.test(e.name)), 'the file is not packed');
  for (const e of entries) assert.ok(!e.data.includes(Buffer.from(pass)), `not inside ${e.name}`);
  // The head names the password's fingerprint and day, never the password.
  const head = JSON.parse(raw.subarray(7, raw.indexOf(0x0a, 7)).toString());
  assert.equal(head.fp, secret.passphraseStatus().fingerprint);
  assert.equal(head.fpSet, new Date().toISOString().slice(0, 10));
});

test('the restore script inside the shop reads the password file: no BACKUP_PASSPHRASE needed', () => {
  const file = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.enc')).sort().at(-1)!;
  const target = tmp('inside');
  const r = restore([path.join(dir, 'backups', file), target], { BACKUP_PASSPHRASE: undefined, DATA_DIR: dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Integrity check: ok/);
  // The restored shop keeps the password (copied from the running shop, owner-only, nothing waiting).
  const copied = JSON.parse(fs.readFileSync(path.join(target, 'backup-secret.json'), 'utf8'));
  assert.equal(copied.passphrase, made[0]);
  assert.equal(copied.pending, undefined);
  assert.equal(fs.statSync(path.join(target, 'backup-secret.json')).mode & 0o777, 0o600);
  // Outside the shop (no DATA_DIR, no BACKUP_PASSPHRASE): asked for.
  const outside = restore([path.join(dir, 'backups', file), tmp('outside')], { BACKUP_PASSPHRASE: undefined, DATA_DIR: undefined });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /give its backup password/);
  fs.rmSync(target, { recursive: true, force: true });
});

test('change: a new typed password; earlier backups need the old one, refused with the day it was set', async () => {
  const before = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.enc')).sort().at(-1)!;
  const oldFp = secret.passphraseStatus().fingerprint!;
  const oldSetAt = secret.passphraseStatus().setAt!;
  // Set it a day later, so the old one's day is not today.
  const later = Date.now() + 26 * 3600_000;
  const typed = 'quiet-lantern-orchard-ribbon-31';
  made.push(typed);
  const saved = await secret.setTypedPassphrase(secret.checkTypedPassphrase(typed, typed), 'owner@shop.ae', later);
  assert.equal(saved.changed, true);
  assert.equal(saved.how, 'typed');
  const st = secret.passphraseStatus();
  assert.deepEqual(st.earlier.map((e) => e.fingerprint), [oldFp]);
  assert.equal(st.earlier[0].setAt, oldSetAt);
  assert.ok(!fs.readFileSync(secretFile(), 'utf8').includes(made[0]), 'the old password is not kept');

  const oldBackup = fs.readFileSync(path.join(dir, 'backups', before));
  const day = oldSetAt.slice(0, 10);
  assert.throws(() => backup.openBackup(oldBackup, typed), new RegExp(`Wrong password: this backup was made with the backup password set on ${day}\\. Backups made before a password change still need the old password\\.`));
  assert.ok(backup.openBackup(oldBackup, made[0]).length > 0, 'the old password still opens it');
  // The restore script inside the shop (the new password from the file): refused at once, naming the day.
  const r = restore([path.join(dir, 'backups', before), tmp('old')], { BACKUP_PASSPHRASE: undefined, DATA_DIR: dir });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`Wrong password: this backup was made with the backup password set on ${day}, not with the shop’s backup password \\(set on ${new Date(later).toISOString().slice(0, 10)}\\)`));
  assert.match(r.stderr, /BACKUP_PASSPHRASE='the old password'/);
  // With the old one typed: restored.
  const ok = restore([path.join(dir, 'backups', before), tmp('oldok')], { BACKUP_PASSPHRASE: made[0], DATA_DIR: dir });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // A new backup uses the new password.
  const n = await backup.createBackup(new Date(later));
  assert.ok(backup.openBackup(fs.readFileSync(n.file), typed).length > 0);
});

test('BACKUP_PASSPHRASE wins: used for backups, the hub shows "on the server" and can’t change it', async () => {
  process.env.BACKUP_PASSPHRASE = 'the server one, long enough';
  try {
    assert.equal(secret.passphraseSource(), 'env');
    assert.equal(secret.backupPassphrase(), 'the server one, long enough');
    await assert.rejects(secret.startGeneratedPassphrase('owner@shop.ae'), (e: Error & { status?: number }) => e.status === 409);
    await assert.rejects(secret.setTypedPassphrase('another long password', 'owner@shop.ae'), (e: Error & { status?: number }) => e.status === 409);
    const r = await backup.createBackup(new Date(Date.now() + 27 * 3600_000));
    assert.ok(backup.openBackup(fs.readFileSync(r.file), 'the server one, long enough').length > 0);
    assert.throws(() => backup.openBackup(fs.readFileSync(r.file), made[1]), /another backup password \(fingerprint/);
    const st = secret.passphraseStatus();
    assert.equal(st.source, 'env');
    assert.equal(st.short, false);
    process.env.BACKUP_PASSPHRASE = 'short';
    assert.equal(secret.passphraseStatus().short, true);
    assert.match(backup.backupHealth().notice ?? '', /set on the server is short/);
  } finally {
    delete process.env.BACKUP_PASSPHRASE;
  }
  assert.equal(secret.passphraseSource(), 'hub');
});

test('a password made but not confirmed in 30 minutes is not used', async () => {
  const g = await secret.startGeneratedPassphrase('owner@shop.ae', Date.now() - 31 * 60_000);
  made.push(g.passphrase);
  assert.throws(() => secret.confirmGeneratedPassphrase('owner@shop.ae'), (e: Error & { status?: number; details?: { code?: string } }) => e.status === 409 && e.details?.code === 'pending_expired');
  assert.equal(secret.backupPassphrase(), made[1]);
});

test('never in the log or the audit log, wherever it appears', () => {
  for (const p of made) {
    logEvent('error', 'oops', { error: `failed with ${p} in the message`, passphrase: p, nested: { why: p } });
  }
  const text = logged.join('\n');
  for (const p of made) assert.ok(!text.includes(p), `log: ${p.slice(0, 6)}…`);
  const a = auditText();
  assert.match(a, /backup\.passphrase_set/);
  for (const p of made) assert.ok(!a.includes(p), `audit: ${p.slice(0, 6)}…`);
});

test('Google Drive connected before there was a password: copies switch on as soon as one is set', async () => {
  // A fresh shop with no password (the file moved aside for this test).
  fs.renameSync(secretFile(), `${secretFile()}.aside`);
  try {
    assert.equal(secret.passphraseSource(), 'none');
    google.deviceScript = ['ok'];
    await drive.startDriveConnect({ clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret }, 'owner@shop.ae');
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'drive-secrets.json'), 'utf8')).device;
    const r = await drive.pollDriveConnect('owner@shop.ae', p.nextPollAt);
    assert.equal(r.outcome, 'connected');
    assert.equal(r.status.enabled, false, 'not on without a password');
    assert.equal(r.status.waitingForPassword, true);
    assert.equal(r.status.accountEmail, 'shop.owner@gmail.com', 'who is connected, from about.get');
    assert.equal(drive.enableDriveIfWaiting('owner@shop.ae'), false, 'still no password');
    await secret.setTypedPassphrase('mango-harbour-velvet-quiet-74', 'owner@shop.ae');
    assert.equal(drive.enableDriveIfWaiting('owner@shop.ae'), true);
    const st = drive.driveStatus();
    assert.equal(st.enabled, true);
    assert.equal(st.waitingForPassword, false);
    assert.equal(drive.enableDriveIfWaiting('owner@shop.ae'), false, 'once');
    // The owner switching copies off is respected (no longer waiting).
    drive.saveDriveSettings({ enabled: false });
    assert.equal(drive.enableDriveIfWaiting('owner@shop.ae'), false);
    assert.equal(drive.driveStatus().enabled, false);
    assert.match(auditText(), /"reason":"backup password set"/);
  } finally {
    fs.rmSync(secretFile(), { force: true });
    fs.renameSync(`${secretFile()}.aside`, secretFile());
  }
});

test('Google’s client file: read in the browser; the wrong kinds refused with what to do', () => {
  const good = JSON.stringify({ installed: { client_id: OAUTH_CLIENT.id, project_id: 'beautiful-uae-home-4711', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', client_secret: OAUTH_CLIENT.secret } });
  assert.deepEqual(parseClientJson(good), { ok: true, clientId: OAUTH_CLIENT.id, clientSecret: OAUTH_CLIENT.secret, projectId: 'beautiful-uae-home-4711' });
  const bad = (text: string, re: RegExp) => {
    const r = parseClientJson(text);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, re);
  };
  bad('not json', /not Google’s client file/);
  bad('[]', /not Google’s client file/);
  bad(makeServiceAccount().json, /service account key, not an OAuth client/);
  bad(JSON.stringify({ web: { client_id: OAUTH_CLIENT.id, client_secret: OAUTH_CLIENT.secret } }), /Web application/);
  bad(JSON.stringify({ installed: { client_id: 'nope', client_secret: OAUTH_CLIENT.secret } }), /no client ID/);
  bad(JSON.stringify({ installed: { client_id: OAUTH_CLIENT.id } }), /no client secret/);
  bad('x'.repeat(20_001), /too big/);
  assert.equal(clientIdLooksRight(OAUTH_CLIENT.id), true);
  assert.equal(clientIdLooksRight('123-abc.apps.google.com'), false);
});

test('the setup wizard: ticks and the project id kept (in order, checked), shown in the status', () => {
  assert.deepEqual(drive.driveWizard(), { done: [], projectId: '' });
  drive.saveDriveWizard({ done: ['api', 'project'], projectId: 'Beautiful-UAE-Home-4711' });
  assert.deepEqual(drive.driveWizard(), { done: ['project', 'api'], projectId: 'beautiful-uae-home-4711' });
  assert.deepEqual(drive.driveStatus().wizard, { done: ['project', 'api'], projectId: 'beautiful-uae-home-4711' });
  for (const bad of [{ done: ['nope'] }, { done: 'project' }, { projectId: 'x' }, { projectId: 'has spaces in it' }, { other: 1 }]) {
    assert.throws(() => drive.saveDriveWizard(bad), (e: Error & { status?: number }) => e.status === 400);
  }
  drive.saveDriveWizard({ done: [] });
  assert.deepEqual(drive.driveWizard(), { done: [], projectId: 'beautiful-uae-home-4711' });
});
