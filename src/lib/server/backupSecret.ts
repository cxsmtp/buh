import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { dataFile, writePrivateFile } from './dataDir';
import { HttpError } from './http';
import { addRedactedValue } from './log';
import { WORDS } from './wordlist';

/**
 * The backup password (Settings → System & backups → "Protect backups with a password"): what every
 * backup is encrypted with (backup.ts), and so every copy in Google Drive (driveBackup.ts).
 *
 * - Chosen in the Admin Hub, made by the shop ("Make one for me": six words from the EFF wordlist
 *   and two digits, about 84 bits, shown once) or typed by the owner (at least 12 characters).
 * - Kept in its own file, DATA_DIR/backup-secret.json (owner-only, written atomically): never in the
 *   database and never in a backup (createBackup takes only shop.db and the shop's folders, the same
 *   as drive-secrets.json), never in a reply but the one "Make one for me" answer, never logged
 *   (log.ts masks it wherever it appears).
 * - BACKUP_PASSPHRASE, when set on the server, still wins: the hub then shows "Set on the server".
 * - Every password has a fingerprint: a short SHA-256 prefix of a slow scrypt of it (so it is no
 *   quicker to guess from than the backup itself). Each encrypted backup carries the fingerprint and
 *   the day its password was set in its header, and the file keeps the earlier ones with their days,
 *   so the restore tool and the hub can say which password a backup needs. Never the password.
 */

export const BACKUP_SECRET_FILE = 'backup-secret.json';
/** Shorter passphrases are refused in the hub (and flagged when set on the server). */
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 256;
/** "Make one for me": this many words, then two digits. */
export const GENERATED_WORDS = 6;
/** A password made but not yet confirmed ("I saved it") is forgotten after this long. */
const PENDING_MS = 30 * 60_000;
const EARLIER_KEEP = 20;

// The fingerprint: scrypt at the same cost as the backup's key (2^17, 128 MB), fixed salt, SHA-256, 12 hex.
const FP_SALT = Buffer.from('buh-backup-password-fingerprint-v1');
const FP_OPTS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const scrypt = promisify(crypto.scrypt) as (pass: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

export interface EarlierPassword {
  fingerprint: string;
  setAt: string;
  replacedAt: string;
}

interface SecretFile {
  passphrase: string;
  fingerprint: string;
  setAt: string;
  setBy: string;
  how: 'generated' | 'typed' | '';
  earlier: EarlierPassword[];
  pending: { passphrase: string; fingerprint: string; expiresAt: number; by: string } | null;
}

const FP = /^[a-f0-9]{12}$/;

function readFile(): SecretFile {
  let v: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile(BACKUP_SECRET_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed;
  } catch {
    // none yet (or unreadable): no password
  }
  const s = (x: unknown) => (typeof x === 'string' ? x : '');
  const earlier = Array.isArray(v.earlier)
    ? (v.earlier as EarlierPassword[]).filter((e) => e && FP.test(s(e.fingerprint))).map((e) => ({ fingerprint: e.fingerprint, setAt: s(e.setAt), replacedAt: s(e.replacedAt) }))
    : [];
  const p = v.pending as SecretFile['pending'];
  const pending = p && typeof p === 'object' && typeof p.passphrase === 'string' && p.passphrase && FP.test(s(p.fingerprint)) && Number(p.expiresAt) > 0 ? { passphrase: p.passphrase, fingerprint: p.fingerprint, expiresAt: Number(p.expiresAt), by: s(p.by) } : null;
  const out: SecretFile = { passphrase: s(v.passphrase), fingerprint: FP.test(s(v.fingerprint)) ? s(v.fingerprint) : '', setAt: s(v.setAt), setBy: s(v.setBy), how: v.how === 'generated' || v.how === 'typed' ? v.how : '', earlier, pending };
  // Whatever happens next, the password is never written to a log or the audit log.
  if (out.passphrase) addRedactedValue(out.passphrase);
  if (out.pending) addRedactedValue(out.pending.passphrase);
  return out;
}

function writeFile(next: SecretFile) {
  writePrivateFile(dataFile(BACKUP_SECRET_FILE), JSON.stringify(next));
}

function env(): string {
  const v = process.env.BACKUP_PASSPHRASE || '';
  if (v) addRedactedValue(v);
  return v;
}

/** The password backups are encrypted with: BACKUP_PASSPHRASE when set, else the one chosen in the hub, else ''. */
export function backupPassphrase(): string {
  return env() || readFile().passphrase;
}

export type PassphraseSource = 'env' | 'hub' | 'none';

export function passphraseSource(): PassphraseSource {
  return env() ? 'env' : readFile().passphrase ? 'hub' : 'none';
}

/** A password's fingerprint (slow on purpose: about half a second). */
export async function passphraseFingerprint(passphrase: string): Promise<string> {
  const key = await scrypt(passphrase, FP_SALT, 32, FP_OPTS);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function passphraseFingerprintSync(passphrase: string): string {
  const key = crypto.scryptSync(passphrase, FP_SALT, 32, FP_OPTS);
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

let envFingerprint: { hash: string; fingerprint: string } | null = null;

/**
 * What the next backup is encrypted with: the password, its fingerprint and the day it was set (''
 * for one set on the server). null: no password (the backup is not encrypted).
 */
export async function currentBackupKey(): Promise<{ passphrase: string; fingerprint: string; setOn: string } | null> {
  const fromEnv = env();
  if (fromEnv) {
    const hash = crypto.createHash('sha256').update(fromEnv).digest('hex');
    if (envFingerprint?.hash !== hash) envFingerprint = { hash, fingerprint: await passphraseFingerprint(fromEnv) };
    return { passphrase: fromEnv, fingerprint: envFingerprint.fingerprint, setOn: '' };
  }
  const f = readFile();
  if (!f.passphrase) return null;
  const fingerprint = f.fingerprint || (await passphraseFingerprint(f.passphrase));
  return { passphrase: f.passphrase, fingerprint, setOn: f.setAt.slice(0, 10) };
}

/** The day the password with this fingerprint was set, and whether it is the one in use now (as far as this server knows). */
export function describeFingerprint(fingerprint: string): { setAt: string; current: boolean } | null {
  if (!FP.test(fingerprint)) return null;
  const f = readFile();
  if (f.fingerprint === fingerprint) return { setAt: f.setAt, current: !env() };
  const e = f.earlier.find((x) => x.fingerprint === fingerprint);
  return e ? { setAt: e.setAt, current: false } : null;
}

// ── Making and checking one ─────────────────────────────────────────────────

/** A uniformly random whole number below n (no modulo bias). */
function randomBelow(n: number): number {
  return crypto.randomInt(n);
}

/** Six random words from the built-in list joined with "-", then two digits: e.g. spoon-hazel-unwrap-canine-gravy-oxford-47. */
export function generatePassphrase(): string {
  const words = Array.from({ length: GENERATED_WORDS }, () => WORDS[randomBelow(WORDS.length)]);
  return `${words.join('-')}-${String(randomBelow(100)).padStart(2, '0')}`;
}

/** The strength of a generated password, in bits. */
export function generatedBits(): number {
  return GENERATED_WORDS * Math.log2(WORDS.length) + Math.log2(100);
}

/** The owner's own password: long enough, not one character over and over. Throws a message to show. */
export function checkTypedPassphrase(passphrase: unknown, repeat: unknown): string {
  if (typeof passphrase !== 'string' || !passphrase) throw new HttpError(400, 'Type the password for your backups.');
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) throw new HttpError(400, `The password can be at most ${MAX_PASSPHRASE_LENGTH} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(passphrase)) throw new HttpError(400, 'The password can’t contain line breaks or tabs.');
  if (passphrase.trim() !== passphrase) throw new HttpError(400, 'The password can’t start or end with a space (it is too easy to lose).');
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) throw new HttpError(400, `Use at least ${MIN_PASSPHRASE_LENGTH} characters (a few words with dashes are easiest).`);
  if (new Set(passphrase.toLowerCase()).size < 5) throw new HttpError(400, 'That password is too easy to guess: use more different characters, or press Make one for me.');
  if (typeof repeat !== 'string' || repeat !== passphrase) throw new HttpError(400, 'The two passwords are not the same: type it again in both boxes.');
  return passphrase;
}

// ── Saving ──────────────────────────────────────────────────────────────────

function notOnServer() {
  if (env()) throw new HttpError(409, 'The backup password is set on the server, so it can’t be changed here.', {}, { code: 'passphrase_on_server' });
}

/** "Make one for me": a new password, kept (unconfirmed) for 30 minutes, returned this once. */
export async function startGeneratedPassphrase(by: string, now = Date.now()): Promise<{ passphrase: string; expiresAt: string }> {
  notOnServer();
  const passphrase = generatePassphrase();
  addRedactedValue(passphrase);
  const fingerprint = await passphraseFingerprint(passphrase);
  writeFile({ ...readFile(), pending: { passphrase, fingerprint, expiresAt: now + PENDING_MS, by } });
  return { passphrase, expiresAt: new Date(now + PENDING_MS).toISOString() };
}

export interface SavedPassphrase {
  changed: boolean;
  fingerprint: string;
  how: 'generated' | 'typed';
}

function save(cur: SecretFile, passphrase: string, fingerprint: string, how: 'generated' | 'typed', by: string, now: number): SavedPassphrase {
  const at = new Date(now).toISOString();
  const changed = Boolean(cur.passphrase);
  const earlier = changed && cur.fingerprint && cur.fingerprint !== fingerprint
    ? [{ fingerprint: cur.fingerprint, setAt: cur.setAt, replacedAt: at }, ...cur.earlier.filter((e) => e.fingerprint !== cur.fingerprint && e.fingerprint !== fingerprint)].slice(0, EARLIER_KEEP)
    : cur.earlier.filter((e) => e.fingerprint !== fingerprint);
  addRedactedValue(passphrase);
  writeFile({ passphrase, fingerprint, setAt: at, setBy: by, how, earlier, pending: null });
  return { changed, fingerprint, how };
}

/** "I saved it": the password made by "Make one for me" becomes the backup password. */
export function confirmGeneratedPassphrase(by: string, now = Date.now()): SavedPassphrase {
  notOnServer();
  const cur = readFile();
  if (!cur.pending || cur.pending.expiresAt <= now) {
    if (cur.pending) writeFile({ ...cur, pending: null });
    throw new HttpError(409, 'That password ran out before it was saved (30 minutes). Press Make one for me again.', {}, { code: 'pending_expired' });
  }
  return save(cur, cur.pending.passphrase, cur.pending.fingerprint, 'generated', by, now);
}

/** The owner's own password (checked with checkTypedPassphrase first). */
export async function setTypedPassphrase(passphrase: string, by: string, now = Date.now()): Promise<SavedPassphrase> {
  notOnServer();
  addRedactedValue(passphrase);
  const fingerprint = await passphraseFingerprint(passphrase);
  return save(readFile(), passphrase, fingerprint, 'typed', by, now);
}

/** Whether a password is set in the hub (a change then needs the hub password again). */
export function hubPassphraseSet(): boolean {
  return Boolean(readFile().passphrase);
}

export interface PassphraseStatus {
  source: PassphraseSource;
  encrypted: boolean;
  /** Set on the server and shorter than the minimum. */
  short: boolean;
  setAt?: string;
  setBy?: string;
  how?: 'generated' | 'typed' | '';
  fingerprint?: string;
  earlier: EarlierPassword[];
  minLength: number;
}

/** What the hub may see: never the password (its fingerprint, the day it was set, the earlier ones). */
export function passphraseStatus(): PassphraseStatus {
  const fromEnv = env();
  const f = readFile();
  if (fromEnv) {
    return { source: 'env', encrypted: true, short: fromEnv.length < MIN_PASSPHRASE_LENGTH, fingerprint: envFingerprint?.hash === crypto.createHash('sha256').update(fromEnv).digest('hex') ? envFingerprint.fingerprint : undefined, earlier: f.earlier, minLength: MIN_PASSPHRASE_LENGTH };
  }
  if (!f.passphrase) return { source: 'none', encrypted: false, short: false, earlier: f.earlier, minLength: MIN_PASSPHRASE_LENGTH };
  return { source: 'hub', encrypted: true, short: false, setAt: f.setAt, setBy: f.setBy, how: f.how, fingerprint: f.fingerprint, earlier: f.earlier, minLength: MIN_PASSPHRASE_LENGTH };
}

/** Tests: forget the fingerprint of BACKUP_PASSPHRASE worked out so far. */
export function _resetBackupSecretCache() {
  envFingerprint = null;
}
