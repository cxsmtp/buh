#!/usr/bin/env node
// Restore a Beautiful UAE Home backup.
//
//   Into an empty folder (then point DATA_DIR at it):
//     node scripts/restore-backup.mjs buh-backup-20261014-1200.tar.gz /var/lib/buhome-restored
//   In place, over the current data (STOP THE SHOP FIRST); the current data is moved
//   aside to replaced-<time>/ (never deleted) and the backups/ folder is kept:
//     node scripts/restore-backup.mjs buh-backup-….tar.gz /data --replace
//   Encrypted backups need their backup password: BACKUP_PASSPHRASE when set, else (inside the
//   running shop: podman exec beautifuluaehome …) the one chosen in the Admin Hub, read from
//   DATA_DIR/backup-secret.json. Another one (an older backup, a new server) is typed:
//     BACKUP_PASSPHRASE='…' node scripts/restore-backup.mjs buh-backup-….tar.gz.enc …
//   A backup made with an earlier password is refused with the day that password was set.
//   From the shop's copies in Google Drive (always encrypted; the service account from
//   BUH_DRIVE_KEY / BUH_DRIVE_KEY_FILE and BUH_DRIVE_FOLDER, or the shop's saved settings):
//     node scripts/restore-backup.mjs --from-drive latest [empty folder, default DATA_DIR]
//     node scripts/restore-backup.mjs --from-drive list
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
// off until the owner confirms them in the Admin Hub (see below). Accountant accounts come back
// revoked, for the same reason: the owner re-invites their accountant. Expenses come back with every
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
const SECRET_FILE = 'backup-secret.json';

/** The shop's backup password file (DATA_DIR/backup-secret.json), or {} when there is none. */
function readSecretFile() {
  const dir = process.env.DATA_DIR;
  if (!dir) return {};
  try {
    const v = JSON.parse(fs.readFileSync(path.join(path.resolve(dir), SECRET_FILE), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
const secretFile = readSecretFile();
/** BACKUP_PASSPHRASE wins; else the password chosen in the Admin Hub (when run inside the shop). */
const passphrase = process.env.BACKUP_PASSPHRASE || (typeof secretFile.passphrase === 'string' ? secretFile.passphrase : '');
const passphraseFrom = process.env.BACKUP_PASSPHRASE ? 'BACKUP_PASSPHRASE' : passphrase ? `the shop’s backup password${typeof secretFile.setAt === 'string' && secretFile.setAt ? ` (set on ${secretFile.setAt.slice(0, 10)})` : ''}` : '';

/** As src/lib/server/backupSecret.ts: SHA-256 of a slow scrypt of the password, 12 hex characters. */
function fingerprintOf(pass) {
  const key = crypto.scryptSync(pass, Buffer.from('buh-backup-password-fingerprint-v1'), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/** Which password a backup needs, from its head (and what this server remembers of earlier ones). */
function neededPassword(meta) {
  const fp = typeof meta.fp === 'string' && /^[a-f0-9]{12}$/.test(meta.fp) ? meta.fp : '';
  if (!fp) return '';
  let day = typeof meta.fpSet === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.fpSet) ? meta.fpSet : '';
  if (!day) {
    const known = [{ fingerprint: secretFile.fingerprint, setAt: secretFile.setAt }, ...(Array.isArray(secretFile.earlier) ? secretFile.earlier : [])].find((e) => e && e.fingerprint === fp);
    if (known && typeof known.setAt === 'string') day = known.setAt.slice(0, 10);
  }
  return day ? `the backup password set on ${day}` : `another backup password (fingerprint ${fp})`;
}
const replace = args.includes('--replace');
// --from-drive latest | <copy's file name> | <Drive file id> | list: a copy from Google Drive
// (scripts/restore-from-drive.mjs), downloaded next to the restore, checked, then restored as any
// other backup. Without a folder, into DATA_DIR (it must be empty unless --replace).
const driveAt = args.indexOf('--from-drive');
const fromDrive = driveAt >= 0 ? args[driveAt + 1] || '' : null;
const positional = args.filter((a, i) => a !== '--replace' && (driveAt < 0 || (i !== driveAt && i !== driveAt + 1)));
let file = fromDrive === null ? positional[0] : '';
const finalTarget = fromDrive === null ? positional[1] : positional[0] || process.env.DATA_DIR || '';
if (fromDrive === 'list') {
  const { listDriveCopies } = await import('./restore-from-drive.mjs');
  try {
    const { copies } = await listDriveCopies(process.env.DATA_DIR || '');
    if (!copies.length) console.log('There are no backup copies in the Google Drive folder.');
    for (const c of copies) console.log(`${c.name}  ${(c.size / 1024 / 1024).toFixed(1)} MB  ${c.id}`);
    process.exit(0);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}
if (fromDrive === '' || (fromDrive === null && !file) || !finalTarget || (fromDrive !== null && positional.length > 1)) {
  console.error('Usage: node scripts/restore-backup.mjs <backup file> <empty folder | data folder with --replace>');
  console.error('   or: node scripts/restore-backup.mjs --from-drive <latest | copy name | list> [empty folder, default DATA_DIR] [--replace]');
  process.exit(2);
}
if (fromDrive !== null && !passphrase) {
  console.error('Copies in Google Drive are encrypted: give the backup password to restore one (BACKUP_PASSPHRASE=\'…\', or run it inside the shop, which knows its own).');
  process.exit(2);
}
if (!replace && fs.existsSync(finalTarget) && fs.readdirSync(finalTarget).length) {
  console.error(`Refusing to restore into ${finalTarget}: it is not empty. Use --replace to restore over the shop's data (stop the shop first).`);
  process.exit(2);
}
// With --replace, restore next to the data first, and swap only once everything checked out.
const target = replace ? path.join(finalTarget, `.restore-${Date.now()}`) : finalTarget;
const targetExisted = fs.existsSync(target);
// A copy fetched from Drive (removed at the end, and on any failure).
let downloaded = '';

/** Stop: remove everything this restore wrote (the target was empty, or is our own staging folder). */
function fail(message, code = 1) {
  try {
    if (downloaded) fs.rmSync(downloaded, { force: true });
  } catch {
    // best effort
  }
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

/** Copy the backup password file (owner-only, without a password still waiting to be confirmed); never over one already there. */
function keepSecret(from, to) {
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    const v = JSON.parse(fs.readFileSync(from, 'utf8'));
    if (!v || typeof v !== 'object' || typeof v.passphrase !== 'string' || !v.passphrase) return false;
    delete v.pending;
    fs.writeFileSync(to, JSON.stringify(v), { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// ── From Google Drive: fetched (and checked) into the folder being restored to ──
let driveCopy = '';
if (fromDrive !== null) {
  const { downloadFromDrive } = await import('./restore-from-drive.mjs');
  fs.mkdirSync(replace ? finalTarget : target, { recursive: true, mode: 0o700 });
  // A name nobody can guess or have made already; Ctrl-C (or a stop) removes it and what was restored.
  downloaded = path.join(replace ? finalTarget : target, `.drive-download-${crypto.randomBytes(12).toString('hex')}.tar.gz.enc`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => fail('Stopped.'));
  try {
    const copy = await downloadFromDrive(fromDrive, downloaded, { dataDir: process.env.DATA_DIR || '', minFree: MIN_FREE });
    console.log(`Downloaded ${copy.name} (${(copy.size / 1024 / 1024).toFixed(1)} MB) from Google Drive; size and checksum match.`);
    file = downloaded;
    driveCopy = copy.name;
  } catch (err) {
    fail(String(err?.message ?? err));
  }
}
const backupName = driveCopy ? `${driveCopy} (Google Drive)` : path.basename(file);

// ── The stream: the file, decrypted if sealed, uncompressed ──────────────────
let source;
let sealed = false;
// The backup named its password's fingerprint and the password given matches it: a failure is damage.
let passwordMatches = false;
{
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  if (head.subarray(0, MAGIC.length).toString() === MAGIC) {
    sealed = true;
    if (!passphrase) fail('This backup is encrypted: give its backup password (BACKUP_PASSPHRASE=\'…\'), or run this inside the shop, which knows its own.', 2);
    const nl = head.subarray(MAGIC.length, n).indexOf(0x0a);
    if (nl < 0) fail('Unknown backup encryption settings.');
    let meta;
    try {
      meta = JSON.parse(head.subarray(MAGIC.length, MAGIC.length + nl).toString());
    } catch {
      fail('Unknown backup encryption settings.');
    }
    if (![16384, 131072].includes(meta.N) || meta.r !== 8 || meta.p !== 1) fail('Unknown backup encryption settings.');
    // The backup names its password's fingerprint (backups from BUH-02.18 on): a different one is
    // refused now, saying which password it needs, rather than after reading the whole file.
    const needed = neededPassword(meta);
    if (needed) {
      if (fingerprintOf(passphrase) !== meta.fp) fail(`Wrong password: this backup was made with ${needed}, not with ${passphraseFrom}. Backups made before a password change still need the old password: run again with BACKUP_PASSPHRASE='the old password'.`, 2);
      passwordMatches = true;
    }
    const key = crypto.scryptSync(passphrase, Buffer.from(meta.salt, 'base64'), 32, { N: meta.N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(meta.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(meta.tag, 'base64'));
    // Until the end the data is not proven (the tag is checked last): nothing is used before then.
    source = fs.createReadStream(file, { start: MAGIC.length + nl + 1 }).pipe(decipher);
  } else {
    // The shop only ever puts encrypted copies in Drive: a plain one there was not made by it.
    if (driveCopy && !sealed) fail('Copies from Google Drive are always encrypted: this one is not, so it was not restored.');
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
  fail(passwordMatches ? 'The backup is damaged (the password is right, but the data does not check out).' : sealed || /auth|decrypt/i.test(text) ? 'Wrong passphrase, or the backup is damaged.' : `The backup could not be read: ${text}`);
}
// The stream is fully read: the encryption tag (if any) is now checked.
await new Promise((resolve) => (source.readableEnded || source.destroyed ? resolve() : source.once('close', resolve)));
if (source.errored) fail(passwordMatches ? 'The backup is damaged (the password is right, but the data does not check out).' : 'Wrong passphrase, or the backup is damaged.');

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
// Accountant access (backups from before BUH-02.17 have none): the backup may predate a revoke,
// and nothing in it can tell. So every restored accountant (active, or invited with a setup link)
// is revoked; the first start writes it to the audit log and the hub says "Re-invite your accountant".
const staffRevoked = tableExists('staff_accounts')
  ? db.prepare("SELECT id, email, status FROM staff_accounts WHERE status IN ('active', 'invited') ORDER BY id").all()
  : [];
if (staffRevoked.length) {
  db.prepare("UPDATE staff_accounts SET status = 'revoked', password_hash = NULL, setup_hash = NULL, setup_grant_hash = NULL, setup_expires_at = NULL, session_gen = session_gen + 1, revoked_at = ?, revoked_by = 'restore' WHERE status IN ('active', 'invited')").run(new Date().toISOString());
}
if (tableExists('kv')) {
  const put = db.prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
  const now = new Date().toISOString();
  if (passkeyIds.length) put.run('admin:passkeys-suspended', JSON.stringify(passkeyIds), now);
  if (staffRevoked.length) put.run('staff:revoked-by-restore', JSON.stringify({ at: now, accounts: staffRevoked.map((s) => ({ id: s.id, was: s.status })) }), now);
  put.run('admin:restored', JSON.stringify({ at: now, backup: backupName }), now);
  db.prepare("DELETE FROM kv WHERE key = 'admin:link-reveal'").run();
}
// The Admin Hub's private link comes back with the backup (only its fingerprint is stored), so the
// owner's bookmark keeps working. A backup without one (from before BUH-02.08) gets a new link,
// printed on the first start.
const hasAdminLink = tableExists('kv') && Boolean(db.prepare("SELECT 1 FROM kv WHERE key = 'admin:link' AND data != 'null'").get());
db.close();
const passkeys = passkeyIds.length;
if (downloaded) {
  fs.rmSync(downloaded, { force: true });
  downloaded = '';
}
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
  // And its backup password (never in a backup): the restored shop keeps encrypting its backups.
  if (keepSecret(path.join(aside, SECRET_FILE), path.join(finalTarget, SECRET_FILE))) console.log('The backup password chosen in the Admin Hub stays: the next backups are encrypted with it.');
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
  // The running shop's backup password (never in a backup), so the restored shop keeps encrypting.
  if (live && live !== path.resolve(target) && keepSecret(path.join(live, SECRET_FILE), path.join(target, SECRET_FILE))) {
    console.log(`The backup password chosen in the Admin Hub was copied from ${live}: the restored shop encrypts its backups with it.`);
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
if (staffRevoked.length) {
  console.log('');
  console.log(`Accountant access: ${staffRevoked.length} accountant account${staffRevoked.length === 1 ? ' was' : 's were'} revoked (the backup may be older than a revoke). Re-invite your accountant in Settings → Security → Accountant access.`);
}
if (passkeys || voidedCodes) {
  console.log('');
  console.log('!!! IMPORTANT: Admin Hub passkeys and recovery codes from this backup are switched off !!!');
  console.log('This backup may be older than a passkey you removed (a lost phone) or a new set of recovery codes, so:');
  console.log(`  - ${voidedCodes} unused recovery code${voidedCodes === 1 ? ' was' : 's were'} voided: create a new set in Settings → Passkeys & recovery codes.`);
  console.log(`  - ${passkeys} passkey${passkeys === 1 ? ' is' : 's are'} switched off until you confirm ${passkeys === 1 ? 'it' : 'each'} there ("Keep") or remove ${passkeys === 1 ? 'it' : 'them'}.`);
  console.log('Sign in with the password first; the Admin Hub shows a reminder until you have reviewed them.');
}
