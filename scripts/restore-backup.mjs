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
// The backup is read as a stream (decrypted, uncompressed and unpacked a piece at a time, one file
// after another), so a big one needs disk, not memory; it stops if the disk would be left with
// less than 256 MB. Every file is checked against the backup's manifest, and the database is
// integrity-checked, before anything is used; on any problem everything it wrote is removed.
// Then stop the shop, point DATA_DIR at the new folder (or swap folders), and start it again.
// Admin sign-in: the first start prints a new one-time password. The admin account is not in
// backups, and courier / SMS keys are blanked in them, on purpose: re-enter the keys in the Admin
// Hub after a restore. The owner's passkeys and recovery codes are in the database, but the backup
// may predate a revocation: restored recovery codes are voided and restored passkeys are switched
// off until the owner confirms them in the Admin Hub (see below). Expenses come back with every
// earlier version and every bill (expenses/). The server's audit key stays (with --replace), or is
// copied from the running shop's DATA_DIR into the new folder, so the restored audit log still
// checks out on this server; on a new server the hub says the log was signed by another server's
// key (restored from a backup), and new entries start a fresh chain.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = 'BUHBK1\n';
const MIN_FREE = 256 * 1024 * 1024;
const BILL_EXTS = ['jpg', 'png', 'webp', 'heic', 'pdf'];
const BILL_FILE = new RegExp(`^expenses/[a-f0-9]{24}\\.(${BILL_EXTS.join('|')})$`);
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
const targetExisted = fs.existsSync(target);

/** Stop: remove everything this restore wrote (the target was empty, or is our own staging folder). */
function fail(message, code = 1) {
  try {
    if (fs.existsSync(target)) {
      if (targetExisted) for (const name of fs.readdirSync(target)) fs.rmSync(path.join(target, name), { recursive: true, force: true });
      else fs.rmSync(target, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
  console.error(message);
  process.exit(code);
}

// ── The stream: the file, decrypted if sealed, uncompressed ──────────────────
let source;
let sealed = false;
{
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  if (head.subarray(0, MAGIC.length).toString() === MAGIC) {
    sealed = true;
    const passphrase = process.env.BACKUP_PASSPHRASE;
    if (!passphrase) fail('This backup is encrypted: set BACKUP_PASSPHRASE.', 2);
    const nl = head.subarray(MAGIC.length, n).indexOf(0x0a);
    if (nl < 0) fail('Unknown backup encryption settings.');
    let meta;
    try {
      meta = JSON.parse(head.subarray(MAGIC.length, MAGIC.length + nl).toString());
    } catch {
      fail('Unknown backup encryption settings.');
    }
    if (![16384, 131072].includes(meta.N) || meta.r !== 8 || meta.p !== 1) fail('Unknown backup encryption settings.');
    const key = crypto.scryptSync(passphrase, Buffer.from(meta.salt, 'base64'), 32, { N: meta.N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(meta.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(meta.tag, 'base64'));
    // Until the end the data is not proven (the tag is checked last): nothing is used before then.
    source = fs.createReadStream(file, { start: MAGIC.length + nl + 1 }).pipe(decipher);
  } else {
    source = fs.createReadStream(file);
  }
}
const gunzip = zlib.createGunzip();
source.on('error', (err) => gunzip.destroy(err));
const tarStream = source.pipe(gunzip);

// ── Unpacking, one file at a time ───────────────────────────────────────────
// Only these names: never the shop's keys or admin account, never . or ..
const ALLOWED = /^(shop\.db|[a-z_]+\.csv|(receipts|images)\/[A-Za-z0-9_-][A-Za-z0-9._-]*|expenses\/[A-Za-z0-9_-][A-Za-z0-9._-]*|audit\/audit-\d{4}-\d{2}\.jsonl)$/;
const seen = new Map(); // name → { size, hash }
let manifestText = '';
let budget = Infinity;
fs.mkdirSync(target, { recursive: true, mode: 0o700 });
try {
  const st = fs.statfsSync(target);
  budget = Number(st.bavail) * Number(st.bsize) - MIN_FREE;
} catch {
  // statfs unavailable: no disk bound
}
let written = 0;

function destOf(name) {
  return path.join(target, name.startsWith('audit/') ? name.slice('audit/'.length) : name);
}

async function unpack() {
  let header = Buffer.alloc(0);
  let entry = null; // { name, remaining, pad, fd, hash, size, keep, manifest: [] }
  let pad = 0;
  let ended = false;
  for await (let chunk of tarStream) {
    while (chunk.length) {
      if (ended) {
        chunk = chunk.subarray(chunk.length);
        break;
      }
      if (pad) {
        const skip = Math.min(pad, chunk.length);
        pad -= skip;
        chunk = chunk.subarray(skip);
        continue;
      }
      if (entry) {
        const take = Math.min(entry.remaining, chunk.length);
        const piece = chunk.subarray(0, take);
        chunk = chunk.subarray(take);
        entry.hash.update(piece);
        entry.remaining -= take;
        if (entry.fd !== null) {
          written += take;
          if (written > budget) fail('Not enough free disk space to restore this backup: free some space and try again.');
          let done = 0;
          while (done < piece.length) done += fs.writeSync(entry.fd, piece, done, piece.length - done);
        } else if (entry.manifest) {
          entry.manifest.push(Buffer.from(piece));
          if (entry.manifest.reduce((n, b) => n + b.length, 0) > 16 * 1024 * 1024) fail('The backup is damaged (manifest too large).');
        }
        if (!entry.remaining) {
          if (entry.fd !== null) fs.closeSync(entry.fd);
          if (entry.manifest) manifestText = Buffer.concat(entry.manifest).toString();
          seen.set(entry.name, { size: entry.size, hash: entry.hash.digest('hex') });
          pad = (512 - (entry.size % 512)) % 512;
          entry = null;
        }
        continue;
      }
      // A header (512 bytes, perhaps split across pieces).
      const need = 512 - header.length;
      header = Buffer.concat([header, chunk.subarray(0, need)]);
      chunk = chunk.subarray(need);
      if (header.length < 512) continue;
      const h = header;
      header = Buffer.alloc(0);
      if (h.every((b) => b === 0)) {
        ended = true;
        continue;
      }
      const name = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
      const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0[\s\S]*$/, '').trim() || '0', 8);
      const stored = parseInt(h.subarray(148, 156).toString('ascii').replace(/\0[\s\S]*$/, '').trim(), 8);
      const check = Buffer.from(h);
      check.write('        ', 148, 8, 'ascii');
      let sum = 0;
      for (const b of check) sum += b;
      if (sum !== stored || !Number.isFinite(size) || size < 0) fail(`Damaged backup (archive header) at ${name || 'an entry'}.`);
      if (seen.has(name)) fail(`Damaged backup: ${name} appears twice.`);
      if (name !== 'MANIFEST.sha256' && (!ALLOWED.test(name) || /\.\./.test(name))) fail(`Unexpected file in backup: ${name}`);
      if (name.startsWith('expenses/') && !BILL_FILE.test(name)) fail(`Unexpected file in backup: ${name} (a bill is a photo or PDF named by its id).`);
      let fd = null;
      if (name !== 'MANIFEST.sha256' && !name.endsWith('.csv')) {
        const dest = destOf(name);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fd = fs.openSync(dest, 'wx', 0o600);
      }
      entry = { name, size, remaining: size, fd, hash: crypto.createHash('sha256'), manifest: name === 'MANIFEST.sha256' ? [] : null };
      if (!size) {
        if (fd !== null) fs.closeSync(fd);
        seen.set(name, { size: 0, hash: entry.hash.digest('hex') });
        entry = null;
      }
    }
  }
  if (entry || header.length) fail('The backup is damaged (it ends in the middle of a file).');
}

try {
  await unpack();
} catch (err) {
  const text = String(err?.message ?? err);
  // Encrypted: anything unreadable is a wrong passphrase or damage (garbage in, before the tag says so).
  fail(sealed || /auth|decrypt/i.test(text) ? 'Wrong passphrase, or the backup is damaged.' : `The backup could not be read: ${text}`);
}
// The stream is fully read: the encryption tag (if any) is now checked.
await new Promise((resolve) => (source.readableEnded || source.destroyed ? resolve() : source.once('close', resolve)));
if (source.errored) fail('Wrong passphrase, or the backup is damaged.');

// Check everything against the manifest; refuse anything else.
if (!manifestText) fail('The backup has no manifest.');
const listed = new Set(['MANIFEST.sha256']);
for (const line of manifestText.trim().split('\n')) {
  const [hash, size, name] = line.split(/ {2}/);
  const got = seen.get(name);
  if (!got || got.size !== Number(size) || got.hash !== hash) fail(`Damaged backup: ${name} does not match its checksum.`);
  listed.add(name);
}
for (const name of seen.keys()) if (!listed.has(name)) fail(`Unexpected file in backup: ${name} (not in its manifest).`);
if (!seen.has('shop.db')) fail('The backup has no database.');

// Integrity check of the restored database.
const { default: Database } = await import('better-sqlite3');
const db = new Database(path.join(target, 'shop.db'));
const ok = db.pragma('integrity_check', { simple: true });
if (ok !== 'ok') {
  db.close();
  fail(`The restored database failed its integrity check: ${ok}`);
}
const orders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
const products = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
// The stock ledger and product drafts (backups from before BUH-02.05 have neither table).
const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const stockMoves = tableExists('stock_moves') ? db.prepare('SELECT COUNT(*) AS n FROM stock_moves').get().n : 0;
const drafts = tableExists('product_drafts') ? db.prepare('SELECT COUNT(*) AS n FROM product_drafts').get().n : 0;
// Shared selections, /c/<slug> (backups from before BUH-02.17 have none).
const collections = tableExists('collections') ? db.prepare('SELECT COUNT(*) AS n FROM collections').get().n : 0;
// Expenses and their bills (backups from before BUH-02.10 have none). A bill is one of five kinds
// of file named by its id: a row naming anything else is refused (it would be served from disk).
const expenses = tableExists('expenses') ? db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n : 0;
const billRows = tableExists('expense_bills') ? db.prepare('SELECT id, ext FROM expense_bills').all() : [];
const strange = billRows.filter((b) => typeof b.id !== 'string' || !/^[a-f0-9]{24}$/.test(b.id) || !BILL_EXTS.includes(b.ext));
if (strange.length) {
  db.close();
  fail(`The backup is damaged: ${strange.length} bill${strange.length === 1 ? ' is' : 's are'} not a photo or PDF named by its id.`);
}
const bills = billRows.length;
const missingBills = billRows.filter((b) => !fs.existsSync(path.join(target, 'expenses', `${b.id}.${b.ext}`))).length;
// The refunds ledger (backups from before BUH-02.10 have none: the shop fills it in on its first start).
const refunds = tableExists('card_refunds') ? db.prepare('SELECT COUNT(*) AS n FROM card_refunds').get().n : 0;
// Ways back into the Admin Hub (backups from before BUH-02.04 have neither table). The backup
// may be older than the owner's last "Remove" of a lost phone's passkey or last new set of
// recovery codes, and nothing in it can tell. So: every restored recovery code is voided, and
// every restored passkey is switched off until the owner confirms it in the Admin Hub (signed
// in with the password: a restore always gives a fresh one-time password in the log, or the
// ADMIN_PASSWORD_HASH one, so this can't lock the owner out).
const passkeyIds = tableExists('admin_passkeys') ? db.prepare('SELECT id FROM admin_passkeys').all().map((r) => r.id) : [];
const voidedCodes = tableExists('admin_recovery_codes') ? db.prepare('DELETE FROM admin_recovery_codes WHERE used_at IS NULL').run().changes : 0;
if (tableExists('admin_recovery_codes')) db.prepare('DELETE FROM admin_recovery_codes').run();
if (tableExists('kv')) {
  const put = db.prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
  const now = new Date().toISOString();
  if (passkeyIds.length) put.run('admin:passkeys-suspended', JSON.stringify(passkeyIds), now);
  put.run('admin:restored', JSON.stringify({ at: now, backup: path.basename(file) }), now);
  db.prepare("DELETE FROM kv WHERE key = 'admin:link-reveal'").run();
}
// The Admin Hub's private link comes back with the backup (only its fingerprint is stored), so the
// owner's bookmark keeps working. A backup without one (from before BUH-02.08) gets a new link,
// printed on the first start.
const hasAdminLink = tableExists('kv') && Boolean(db.prepare("SELECT 1 FROM kv WHERE key = 'admin:link' AND data != 'null'").get());
db.close();
const passkeys = passkeyIds.length;
const counts = `${orders} orders, ${refunds} card refunds, ${products} products, ${stockMoves} stock moves, ${drafts} product drafts, ${collections} shared selections, ${expenses} expenses, ${bills} bills`;
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
  console.log(`Restored into ${finalTarget}: ${counts}. Integrity check: ok.`);
  console.log(`The previous data was moved to ${aside} (delete it once you are happy).`);
  console.log('Start the shop again. Admin sign-in: a new one-time password is printed in the log.');
} else {
  // This server's audit key (from the running shop's DATA_DIR), so the restored log still checks
  // out when the shop is pointed at this folder. Never over a key already there.
  const live = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : '';
  const liveKey = live ? path.join(live, 'audit.key') : '';
  if (liveKey && live !== path.resolve(target) && fs.existsSync(liveKey) && !fs.existsSync(path.join(target, 'audit.key'))) {
    fs.copyFileSync(liveKey, path.join(target, 'audit.key'));
    fs.chmodSync(path.join(target, 'audit.key'), 0o600);
    console.log(`This server's audit key was copied from ${live}, so the restored audit log checks out here.`);
  }
  console.log(`Restored to ${target}: ${counts}. Integrity check: ok.`);
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
