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
// recovery codes are in the database, but the backup may predate a revocation:
// restored recovery codes are voided and restored passkeys are switched off
// until the owner confirms them in the Admin Hub (see below). Expenses come back with every
// earlier version and every bill (expenses/). With --replace the server's audit key stays, so
// the restored audit log still checks out on this server (a new server can't check its
// signatures: the key never leaves the server; the hub says so).
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
  if (!/^(shop\.db|[a-z_]+\.csv|(receipts|images|expenses)\/[A-Za-z0-9_-][A-Za-z0-9._-]*|audit\/audit-\d{4}-\d{2}\.jsonl)$/.test(name) || /\.\./.test(name)) {
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
// The stock ledger and product drafts (backups from before BUH-02.05 have neither table).
const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const stockMoves = tableExists('stock_moves') ? db.prepare('SELECT COUNT(*) AS n FROM stock_moves').get().n : 0;
const drafts = tableExists('product_drafts') ? db.prepare('SELECT COUNT(*) AS n FROM product_drafts').get().n : 0;
// Expenses and their bills (backups from before BUH-02.10 have none).
const expenses = tableExists('expenses') ? db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n : 0;
const bills = tableExists('expense_bills') ? db.prepare('SELECT COUNT(*) AS n FROM expense_bills').get().n : 0;
const missingBills = tableExists('expense_bills')
  ? db.prepare('SELECT id, ext FROM expense_bills').all().filter((b) => !fs.existsSync(path.join(target, 'expenses', `${b.id}.${b.ext}`))).length
  : 0;
if (ok !== 'ok') {
  db.close();
  console.error(`The restored database failed its integrity check: ${ok}`);
  process.exit(1);
}
// Ways back into the Admin Hub (backups from before BUH-02.04 have neither table). The backup
// may be older than the owner's last "Remove" of a lost phone's passkey or last new set of
// recovery codes, and nothing in it can tell. So: every restored recovery code is voided, and
// every restored passkey is switched off until the owner confirms it in the Admin Hub (signed
// in with the password: a restore always gives a fresh one-time password in the log, or the
// ADMIN_PASSWORD_HASH one, so this can't lock the owner out).
const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const passkeyIds = hasTable('admin_passkeys') ? db.prepare('SELECT id FROM admin_passkeys').all().map((r) => r.id) : [];
const voidedCodes = hasTable('admin_recovery_codes') ? db.prepare('DELETE FROM admin_recovery_codes WHERE used_at IS NULL').run().changes : 0;
if (hasTable('admin_recovery_codes')) db.prepare('DELETE FROM admin_recovery_codes').run();
if (hasTable('kv')) {
  const put = db.prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
  const now = new Date().toISOString();
  if (passkeyIds.length) put.run('admin:passkeys-suspended', JSON.stringify(passkeyIds), now);
  put.run('admin:restored', JSON.stringify({ at: now, backup: path.basename(file) }), now);
  db.prepare("DELETE FROM kv WHERE key = 'admin:link-reveal'").run();
}
// The Admin Hub's private link comes back with the backup (only its fingerprint is stored), so the
// owner's bookmark keeps working. A backup without one (from before BUH-02.08) gets a new link,
// printed on the first start.
const hasAdminLink = hasTable('kv') && Boolean(db.prepare("SELECT 1 FROM kv WHERE key = 'admin:link' AND data != 'null'").get());
db.close();
const passkeys = passkeyIds.length;
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
  // The same server: its audit key stays, so the restored audit log is still checked against it.
  if (fs.existsSync(path.join(aside, 'audit.key'))) fs.copyFileSync(path.join(aside, 'audit.key'), path.join(finalTarget, 'audit.key'));
  console.log(`Restored into ${finalTarget}: ${orders} orders, ${products} products, ${stockMoves} stock moves, ${drafts} product drafts, ${expenses} expenses, ${bills} bills. Integrity check: ok.`);
  console.log(`The previous data was moved to ${aside} (delete it once you are happy).`);
  console.log('Start the shop again. Admin sign-in: a new one-time password is printed in the log.');
} else {
  console.log(`Restored to ${target}: ${orders} orders, ${products} products, ${stockMoves} stock moves, ${drafts} product drafts, ${expenses} expenses, ${bills} bills. Integrity check: ok.`);
  console.log('Next: stop the shop, set DATA_DIR to this folder (or swap folders), start it, and sign in with the new one-time password from the log.');
}
if (missingBills) console.log(`Warning: ${missingBills} bill file${missingBills === 1 ? ' is' : 's are'} missing from this backup (the expense rows are there).`);
console.log('');
console.log(
  hasAdminLink
    ? 'Admin Hub: the private admin link from this backup works again. If you changed it after this backup was taken, make a new one: node scripts/admin-link.mjs --new'
    : 'Admin Hub: this backup has no private admin link; the first start prints a new one in the log.'
);
if (passkeys || voidedCodes) {
  console.log('');
  console.log('!!! IMPORTANT: Admin Hub passkeys and recovery codes from this backup are switched off !!!');
  console.log('This backup may be older than a passkey you removed (a lost phone) or a new set of recovery codes, so:');
  console.log(`  - ${voidedCodes} unused recovery code${voidedCodes === 1 ? ' was' : 's were'} voided: create a new set in Settings → Passkeys & recovery codes.`);
  console.log(`  - ${passkeys} passkey${passkeys === 1 ? ' is' : 's are'} switched off until you confirm ${passkeys === 1 ? 'it' : 'each'} there ("Keep") or remove ${passkeys === 1 ? 'it' : 'them'}.`);
  console.log('Sign in with the password first; the Admin Hub shows a reminder until you have reviewed them.');
}
