/**
 * Big backups (review of BUH-02.10): the backup is streamed (each file read a piece at a time,
 * compressed and encrypted as it goes) and so is the restore (decrypted, uncompressed and unpacked
 * one file at a time), so a shop with hundreds of MB of photos and bills needs disk, not memory, for
 * both. The data may be at most BACKUP_LIMITS.totalBytes: the monitor warns from 80%, and beyond it
 * the backup is refused with a failure the owner is told about, never an unrestorable file.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const backup = await import('@/lib/server/backup');
const { currentProblems } = await import('@/lib/server/monitor');
const { getDb } = await import('@/lib/server/db');

const MB = 1024 * 1024;
const BIG = 80 * MB;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-big-'));
const hook = path.join(scratch, 'maxrss.mjs');
fs.writeFileSync(hook, "process.on('exit', () => process.stderr.write(`MAXRSS=${process.resourceUsage().maxRSS}\\n`));\n");

getDb();
fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
// Three 80 MB photos (sparse files: zeros on disk cost nothing until restored), and one with bytes.
for (const n of [1, 2, 3]) {
  fs.writeFileSync(path.join(dir, 'images', `big-${n}.jpg`), '');
  fs.truncateSync(path.join(dir, 'images', `big-${n}.jpg`), BIG);
}
const noise = crypto.randomBytes(3 * MB);
fs.writeFileSync(path.join(dir, 'images', 'noise.jpg'), noise);

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a backup of 240 MB of photos is made without holding them in memory, and the restore streams it back', async () => {
  const before = process.resourceUsage().maxRSS;
  const result = await backup.createBackup();
  const grew = (process.resourceUsage().maxRSS - before) / 1024;
  assert.ok(grew < 150, `the backup took ${grew.toFixed(0)} MB more memory`);
  assert.ok(fs.statSync(result.file).size < 10 * MB, 'zeros compress');

  const target = path.join(scratch, 'restored');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, 'scripts/restore-backup.mjs', result.file, target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Integrity check: ok/);
  const rss = Number(/MAXRSS=(\d+)/.exec(r.stderr)?.[1]) / 1024;
  assert.ok(rss > 0 && rss < 200, `the restore used ${rss.toFixed(0)} MB of memory for 243 MB of files`);
  for (const n of [1, 2, 3]) assert.equal(fs.statSync(path.join(target, 'images', `big-${n}.jpg`)).size, BIG);
  assert.equal(sha(path.join(target, 'images', 'noise.jpg')), crypto.createHash('sha256').update(noise).digest('hex'));
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(result.file);
});

test('encrypted: streamed both ways; a wrong passphrase or a damaged file restores nothing', async () => {
  // Without the big photos (the passphrase's scrypt alone takes 128 MB).
  for (const n of [1, 2, 3]) fs.renameSync(path.join(dir, 'images', `big-${n}.jpg`), path.join(scratch, `big-${n}.jpg`));
  process.env.BACKUP_PASSPHRASE = 'correct horse battery staple';
  try {
    const result = await backup.createBackup();
    assert.match(result.file, /\.enc$/);
    // The in-memory reader agrees with the streamed writer (tag, header and all).
    assert.ok(backup.openBackup(fs.readFileSync(result.file), process.env.BACKUP_PASSPHRASE).some((e) => e.name === 'images/noise.jpg'));
    const ok = path.join(scratch, 'enc-ok');
    const r = spawnSync(process.execPath, ['scripts/restore-backup.mjs', result.file, ok], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sha(path.join(ok, 'images', 'noise.jpg')), crypto.createHash('sha256').update(noise).digest('hex'));
    fs.rmSync(ok, { recursive: true, force: true });
    const wrong = path.join(scratch, 'enc-wrong');
    const w = spawnSync(process.execPath, ['scripts/restore-backup.mjs', result.file, wrong], { encoding: 'utf8', env: { ...process.env, BACKUP_PASSPHRASE: 'wrong passphrase!' } });
    assert.notEqual(w.status, 0);
    assert.match(w.stderr, /Wrong password: this backup was made with another backup password \(fingerprint [a-f0-9]{12}\), not with BACKUP_PASSPHRASE/);
    assert.ok(!fs.existsSync(wrong) || fs.readdirSync(wrong).length === 0, 'nothing left behind');
    // One byte changed in the middle: refused, nothing left behind.
    const bad = path.join(scratch, 'damaged.tar.gz.enc');
    const bytes = fs.readFileSync(result.file);
    bytes[Math.floor(bytes.length / 2)] ^= 0x40;
    fs.writeFileSync(bad, bytes);
    const d = spawnSync(process.execPath, ['scripts/restore-backup.mjs', bad, path.join(scratch, 'enc-bad')], { encoding: 'utf8', env: { ...process.env } });
    assert.notEqual(d.status, 0);
    assert.match(d.stderr, /damaged/);
    assert.ok(!fs.existsSync(path.join(scratch, 'enc-bad')) || fs.readdirSync(path.join(scratch, 'enc-bad')).length === 0);
    fs.rmSync(result.file);
  } finally {
    delete process.env.BACKUP_PASSPHRASE;
    for (const n of [1, 2, 3]) fs.renameSync(path.join(scratch, `big-${n}.jpg`), path.join(dir, 'images', `big-${n}.jpg`));
  }
});

test('the data nears the most one backup holds: the monitor warns from 80%; beyond it the backup is refused and the owner told', async () => {
  const size = backup.backupDataSize();
  assert.ok(size.bytes > 3 * BIG);
  const limit = backup.BACKUP_LIMITS.totalBytes;
  try {
    backup.BACKUP_LIMITS.totalBytes = Math.ceil(size.bytes / 0.85);
    const warn = currentProblems().find((p) => p.id === 'backup_size');
    assert.equal(warn?.level, 'warning');
    assert.match(warn!.text, /8[45]% of the most one backup can hold/);
    backup.BACKUP_LIMITS.totalBytes = Math.floor(size.bytes * 0.9);
    const over = currentProblems().find((p) => p.id === 'backup_size');
    assert.equal(over?.level, 'failing');
    const before = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('buh-backup-')).length;
    const state = await backup.runBackup('manual');
    assert.match(state.lastError ?? '', /more than one backup can hold/);
    assert.equal(fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('buh-backup-')).length, before, 'no file made');
    const month = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).sort().pop()!;
    const last = fs.readFileSync(path.join(dir, month), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'backup.failed').pop();
    assert.match(last.details.error, /more than one backup can hold/);
    assert.equal(backup.backupHealth().level, 'failing', 'the hub (and the monitor\'s email) say so');
  } finally {
    backup.BACKUP_LIMITS.totalBytes = limit;
  }
  assert.equal(currentProblems().find((p) => p.id === 'backup_size'), undefined, 'well under: nothing to say');
  fs.rmSync(scratch, { recursive: true, force: true });
});
