#!/usr/bin/env node
// Restore a Beautiful UAE Home backup.
//
//   Into an empty folder (then point DATA_DIR at it):
//     node scripts/restore-backup.mjs buh-backup-20261014-1200.tar.gz /var/lib/buhome-restored
//   In place, over the current data (STOP THE SHOP FIRST); the current data is moved
//   aside to replaced-<time>/ (never deleted) and the backups/ folder is kept:
//     node scripts/restore-backup.mjs buh-backup-….tar.gz /data --replace
//   Encrypted backups need the passphrase:
//     BACKUP_PASSPHRASE='…' node scripts/restore-backup.mjs buh-backup-….tar.gz.enc …
//
// Every file is checked against the backup's manifest, and the database is
// integrity-checked, before anything is written. Then stop the shop, point
// DATA_DIR at the new folder (or swap folders), and start it again. Admin
// sign-in: the first start prints a new one-time password. The admin account
// is not in backups, and courier / SMS keys are blanked in them, on purpose:
// re-enter the keys in the Admin Hub after a restore. The owner's passkeys and
// recovery codes are in the database, so they still open the Admin Hub (a
// recovery code with the sign-in email the restored shop uses).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = 'BUHBK1\n';
const args = process.argv.slice(2);
const replace = args.includes('--replace');
const [file, finalTarget] = args.filter((a) => a !== '--replace');
if (!file || !finalTarget) {
  console.error('Usage: node scripts/restore-backup.mjs <backup file> <empty folder | data folder with --replace>');
  process.exit(2);
}
if (!replace && fs.existsSync(finalTarget) && fs.readdirSync(finalTarget).length) {
  console.error(`Refusing to restore into ${finalTarget}: it is not empty. Use --replace to restore over the shop's data (stop the shop first).`);
  process.exit(2);
}
// With --replace, restore next to the data first, and swap only once everything checked out.
const target = replace ? path.join(finalTarget, `.restore-${Date.now()}`) : finalTarget;

let payload = fs.readFileSync(file);
if (payload.subarray(0, MAGIC.length).toString() === MAGIC) {
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase) {
    console.error('This backup is encrypted: set BACKUP_PASSPHRASE.');
    process.exit(2);
  }
  const rest = payload.subarray(MAGIC.length);
  const nl = rest.indexOf(0x0a);
  const head = JSON.parse(rest.subarray(0, nl).toString());
  if (![16384, 131072].includes(head.N) || head.r !== 8 || head.p !== 1) {
    console.error('Unknown backup encryption settings.');
    process.exit(1);
  }
  const key = crypto.scryptSync(passphrase, Buffer.from(head.salt, 'base64'), 32, { N: head.N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(head.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(head.tag, 'base64'));
  try {
    payload = Buffer.concat([decipher.update(rest.subarray(nl + 1)), decipher.final()]);
  } catch {
    console.error('Wrong passphrase, or the backup is damaged.');
    process.exit(1);
  }
}

// Read the tar.
const tar = zlib.gunzipSync(payload, { maxOutputLength: 2 * 1024 * 1024 * 1024 });
const entries = new Map();
for (let off = 0; off + 512 <= tar.length; ) {
  const h = tar.subarray(off, off + 512);
  if (h.every((b) => b === 0)) break;
  const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
  const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
  entries.set(name, tar.subarray(off + 512, off + 512 + size));
  off += 512 + Math.ceil(size / 512) * 512;
}

// Check everything against the manifest; refuse anything else or any path tricks.
const manifest = entries.get('MANIFEST.sha256');
if (!manifest) {
  console.error('The backup has no manifest.');
  process.exit(1);
}
const listed = new Set(['MANIFEST.sha256']);
for (const line of manifest.toString().trim().split('\n')) {
  const [hash, size, name] = line.split(/ {2}/);
  const data = entries.get(name);
  if (!data || data.length !== Number(size) || crypto.createHash('sha256').update(data).digest('hex') !== hash) {
    console.error(`Damaged backup: ${name} does not match its checksum.`);
    process.exit(1);
  }
  // Only these names: never the shop's keys or admin account, never . or ..
  if (!/^(shop\.db|[a-z_]+\.csv|(receipts|images)\/[A-Za-z0-9_-][A-Za-z0-9._-]*|audit\/audit-\d{4}-\d{2}\.jsonl)$/.test(name) || /\.\./.test(name)) {
    console.error(`Unexpected file in backup: ${name}`);
    process.exit(1);
  }
  listed.add(name);
}

fs.mkdirSync(target, { recursive: true, mode: 0o700 });
for (const [name, data] of entries) {
  if (!listed.has(name) || name === 'MANIFEST.sha256' || name.endsWith('.csv')) continue;
  const dest = path.join(target, name.startsWith('audit/') ? name.slice('audit/'.length) : name);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, data, { mode: 0o600 });
}

// Integrity check of the restored database.
const { default: Database } = await import('better-sqlite3');
const db = new Database(path.join(target, 'shop.db'));
const ok = db.pragma('integrity_check', { simple: true });
const orders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
const products = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
// Ways back into the Admin Hub (backups from before BUH-02.04 have neither table).
const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const passkeys = hasTable('admin_passkeys') ? db.prepare('SELECT COUNT(*) AS n FROM admin_passkeys').get().n : 0;
const recoveryCodes = hasTable('admin_recovery_codes') ? db.prepare('SELECT COUNT(*) AS n FROM admin_recovery_codes WHERE used_at IS NULL').get().n : 0;
db.close();
const signInWays = `${passkeys} passkey${passkeys === 1 ? '' : 's'}, ${recoveryCodes} unused recovery code${recoveryCodes === 1 ? '' : 's'}`;
if (ok !== 'ok') {
  console.error(`The restored database failed its integrity check: ${ok}`);
  process.exit(1);
}
if (replace) {
  // Move the current data aside (kept), then the restored files into place.
  const aside = path.join(finalTarget, `replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(aside, { mode: 0o700 });
  for (const name of fs.readdirSync(finalTarget)) {
    if (name === path.basename(target) || name === 'backups' || name.startsWith('replaced-')) continue;
    fs.renameSync(path.join(finalTarget, name), path.join(aside, name));
  }
  for (const name of fs.readdirSync(target)) fs.renameSync(path.join(target, name), path.join(finalTarget, name));
  fs.rmdirSync(target);
  console.log(`Restored into ${finalTarget}: ${orders} orders, ${products} products. Integrity check: ok.`);
  console.log(`The previous data was moved to ${aside} (delete it once you are happy).`);
  console.log('Start the shop again. Admin sign-in: a new one-time password is printed in the log.');
} else {
  console.log(`Restored to ${target}: ${orders} orders, ${products} products. Integrity check: ok.`);
  console.log('Next: stop the shop, set DATA_DIR to this folder (or swap folders), start it, and sign in with the new one-time password from the log.');
}
console.log(`Admin Hub sign-in also works with the restored ${signInWays}.`);
