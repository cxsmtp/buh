#!/usr/bin/env node
// Snapshot the shop's database before an update (run inside the running container):
//   docker exec <container> node scripts/backup-now.mjs
// Writes DATA_DIR/backups/pre-update-<stamp>.db with SQLite's online backup API,
// which is safe while the shop is serving: the live database is opened read-only
// and nothing in it is changed. The snapshot is integrity-checked; the newest
// KEEP_PRE_UPDATE (default 5) snapshots are kept. Prints the snapshot's path.
//
// Unlike the automatic backups, this copy keeps the courier and SMS keys (it never
// leaves the server's data volume, exactly like shop.db itself), so a rollback
// restores a working shop.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const dataDir = path.resolve(process.env.DATA_DIR || '.data');
const live = path.join(dataDir, 'shop.db');
const keep = Math.max(1, Number.parseInt(process.env.KEEP_PRE_UPDATE || '5', 10) || 5);

if (!fs.existsSync(live)) {
  console.log(`No database at ${live} yet: nothing to back up.`);
  process.exit(0);
}

const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const target = path.join(dir, `pre-update-${stamp}.db`);
const partial = `${target}.partial`;

const db = new Database(live, { readonly: true, fileMustExist: true });
try {
  db.pragma('busy_timeout = 5000');
  await db.backup(partial);
} finally {
  db.close();
}

// The copy (never the live database): fold its WAL in, so the snapshot is one self-contained file.
const copy = new Database(partial);
copy.pragma('journal_mode = DELETE');
const ok = copy.pragma('integrity_check', { simple: true });
copy.close();
for (const extra of ['-wal', '-shm', '-journal']) fs.rmSync(`${partial}${extra}`, { force: true });
if (ok !== 'ok') {
  fs.rmSync(partial, { force: true });
  console.error(`The snapshot failed its integrity check: ${ok}`);
  process.exit(1);
}
fs.chmodSync(partial, 0o600);
fs.renameSync(partial, target);

const snapshots = fs.readdirSync(dir).filter((f) => /^pre-update-\d{8}-\d{6}\.db$/.test(f)).sort();
for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) fs.rmSync(path.join(dir, old), { force: true });

console.log(target);
