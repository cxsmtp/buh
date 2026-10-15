import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';

// scripts/backup-now.mjs: the snapshot the updater takes before switching versions.

function liveDb(dir: string) {
  const db = new Database(path.join(dir, 'shop.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, total_fils INTEGER)');
  return db;
}

function run(dir: string, extra: Record<string, string> = {}) {
  return execFileSync(process.execPath, ['scripts/backup-now.mjs'], { env: { ...process.env, DATA_DIR: dir, ...extra } }).toString().trim();
}

test('takes a consistent snapshot while the shop holds the database open, and leaves the live database untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-backup-now-'));
  const db = liveDb(dir);
  db.prepare('INSERT INTO orders VALUES (?, ?)').run('BUH-1', 12345);
  // Still in the WAL (no checkpoint): the snapshot must include it.
  const before = fs.statSync(path.join(dir, 'shop.db')).mtimeMs;

  const file = run(dir);
  assert.match(path.basename(file), /^pre-update-\d{8}-\d{6}\.db$/);
  assert.equal(path.dirname(file), path.join(dir, 'backups'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const copy = new Database(file, { readonly: true });
  assert.deepEqual(copy.prepare('SELECT * FROM orders').all(), [{ id: 'BUH-1', total_fils: 12345 }]);
  copy.close();

  // The shop keeps writing as before.
  db.prepare('INSERT INTO orders VALUES (?, ?)').run('BUH-2', 500);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n, 2);
  assert.equal(fs.statSync(path.join(dir, 'shop.db')).mtimeMs, before);
  db.close();
  // One self-contained file: no leftover -wal, -shm or .partial.
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')), [path.basename(file)]);
});

test('works when the shop is stopped, and keeps only the newest snapshots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-backup-now-'));
  liveDb(dir).close();
  const backups = path.join(dir, 'backups');
  fs.mkdirSync(backups);
  for (const s of ['20200101-000000', '20200101-000001', '20200101-000002']) fs.writeFileSync(path.join(backups, `pre-update-${s}.db`), 'old');
  fs.writeFileSync(path.join(backups, 'buh-backup-20200101-0000.tar.gz'), 'not ours');

  const file = run(dir, { KEEP_PRE_UPDATE: '2' });
  const left = fs.readdirSync(backups).sort();
  assert.deepEqual(left, ['buh-backup-20200101-0000.tar.gz', 'pre-update-20200101-000002.db', path.basename(file)]);
});

test('a shop with no database yet has nothing to back up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-backup-now-'));
  assert.match(run(dir), /nothing to back up/);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false);
});
