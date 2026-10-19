import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { audit } from './audit';
import { dataDir } from './dataDir';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { safeRequest, type SafeResponse } from './outbound';

/**
 * Off-server copies of every backup, in a Google Drive folder (Settings → System & backups →
 * "Copy each backup to Google Drive").
 *
 * The owner makes a Google Cloud service account, shares one Drive folder with its email (as
 * Editor) and pastes the service account's JSON key and the folder's link here. No consent screen
 * and no refresh token: each copy signs a short JWT with the key (RS256, node:crypto) and trades it
 * at Google's fixed token address for an access token, then sends the backup with a resumable
 * upload, 8 MB at a time read from disk (never the whole file in memory), and checks Google's size
 * and MD5 of the result against the file's own.
 *
 * - Only encrypted backups (BACKUP_PASSPHRASE) ever go to Drive: without the passphrase, copies
 *   can't be switched on and stop (an alert) if it is later removed.
 * - The newest `keep` copies (default 30) are kept; older ones that this feature uploaded (their
 *   Drive file ids are recorded) are deleted. Nothing else in the folder is ever touched.
 * - The key is a secret: stored on the server only (kv `backup:drive`), never in a reply (the hub
 *   sees the service account's email), blanked in every backup, never logged (log.ts removes PEM
 *   keys and Google access tokens wherever they appear).
 * - A failed copy never undoes the local backup: it is recorded, audited and raised as an owner
 *   alert (monitor.ts).
 * - Fixed hosts only (oauth2.googleapis.com, www.googleapis.com), through safeRequest; the
 *   resumable session address Google hands back must be on www.googleapis.com too.
 *
 * Restore from Drive: node scripts/restore-backup.mjs --from-drive latest <empty folder>.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
export const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
/** Full Drive scope: the service account only sees what is shared with it (the one folder). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
/** Resumable upload pieces: a multiple of 256 KiB, as Google asks. (Changeable by tests only.) */
export const DRIVE_LIMITS = { chunkBytes: 8 * 1024 * 1024 };
export const DRIVE_KEEP_DEFAULT = 30;
export const DRIVE_KEEP_MAX = 365;
const BACKUP_MAGIC = 'BUHBK1\n'; // as in backup.ts: an encrypted backup's first bytes

const CONFIG_KEY = 'backup:drive';
const STATE_KEY = 'backup:drive-state';
const FILES_KEY = 'backup:drive-files';

interface DriveConfig {
  enabled: boolean;
  folderId: string;
  keep: number;
  clientEmail: string;
  privateKey: string;
  keyId: string;
  savedAt?: string;
  savedBy?: string;
}

export interface DriveState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastError?: string;
}

/** A copy this feature put in Drive (only these are ever deleted). */
interface DriveCopy {
  id: string;
  name: string;
  size: number;
  at: string;
}

const EMPTY: DriveConfig = { enabled: false, folderId: '', keep: DRIVE_KEEP_DEFAULT, clientEmail: '', privateKey: '', keyId: '' };

function config(): DriveConfig {
  return { ...EMPTY, ...(kvGet<Partial<DriveConfig>>(CONFIG_KEY)?.data ?? {}) };
}

function state(): DriveState {
  return kvGet<DriveState>(STATE_KEY)?.data ?? {};
}

function setState(patch: DriveState) {
  kvSet(STATE_KEY, { ...state(), ...patch });
}

function copies(): DriveCopy[] {
  const list = kvGet<DriveCopy[]>(FILES_KEY)?.data;
  return Array.isArray(list) ? list.filter((c) => c && typeof c.id === 'string' && DRIVE_ID.test(c.id)) : [];
}

/** Backups: the copy of the database keeps the folder and the switch, never the key. */
export function blankDriveKeyIn(db: import('better-sqlite3').Database): void {
  db.prepare("UPDATE kv SET data = json_set(data, '$.privateKey', '', '$.keyId', '') WHERE key = ? AND json_valid(data)").run(CONFIG_KEY);
}

// ── The key and the folder ──────────────────────────────────────────────────

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
const SA_EMAIL = /^[a-z0-9][a-z0-9._-]{0,99}@[a-z0-9.-]+\.gserviceaccount\.com$/;

/** The folder's id from what the owner pasted: the id itself, or the folder's address in Drive. */
export function parseFolderId(input: string): string {
  const s = input.trim();
  if (DRIVE_ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new HttpError(400, 'Google Drive folder: paste the folder’s link (drive.google.com/drive/folders/…) or its id.');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') throw new HttpError(400, 'Google Drive folder: the link must start with https://drive.google.com/.');
  const id = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? url.searchParams.get('id') ?? '';
  if (!DRIVE_ID.test(id)) throw new HttpError(400, 'Google Drive folder: that link has no folder id. Open the folder in Drive and copy the address from the address bar.');
  return id;
}

/** The parts of a service account's JSON key the shop needs (and keeps): its email and private key. */
export function parseServiceAccountKey(text: string): { clientEmail: string; privateKey: string; keyId: string } {
  let key: Record<string, unknown>;
  try {
    key = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Service account key: paste the whole JSON file Google gave you (it starts with { and ends with }).');
  }
  if (!key || typeof key !== 'object' || Array.isArray(key)) throw new HttpError(400, 'Service account key: paste the whole JSON file Google gave you.');
  if (key.type !== 'service_account') throw new HttpError(400, 'Service account key: this is not a service account key ("type" must be "service_account"). Make one in Google Cloud → IAM → Service accounts → Keys → Add key → JSON.');
  const clientEmail = typeof key.client_email === 'string' ? key.client_email.trim().toLowerCase() : '';
  if (!SA_EMAIL.test(clientEmail)) throw new HttpError(400, 'Service account key: its client_email is not a service account address (…@….iam.gserviceaccount.com).');
  const privateKey = typeof key.private_key === 'string' ? key.private_key : '';
  if (!/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/.test(privateKey) || privateKey.length > 8000) throw new HttpError(400, 'Service account key: its private_key is missing or not a private key.');
  try {
    const k = crypto.createPrivateKey(privateKey);
    if (k.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch {
    throw new HttpError(400, 'Service account key: its private_key could not be read. Make a new JSON key in Google Cloud and paste it again.');
  }
  const keyId = typeof key.private_key_id === 'string' && /^[a-f0-9]{20,64}$/.test(key.private_key_id) ? key.private_key_id : '';
  return { clientEmail, privateKey, keyId };
}

// ── Talking to Google ───────────────────────────────────────────────────────

/**
 * Tests only: BUH_TEST_GOOGLE_API=http://127.0.0.1:<port>/ sends every Google call to a stand-in
 * on the same machine (the token to /token, Drive to its own path). Anything but a plain-http
 * loopback address is ignored.
 */
function testApi(): URL | null {
  const v = process.env.BUH_TEST_GOOGLE_API;
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port && u.pathname === '/' && !u.search) return u;
  } catch {
    // ignored below
  }
  logEvent('warn', 'google_test_api_ignored', {});
  return null;
}

interface GoogleInit {
  method: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
}

function loopback(base: URL, real: URL, init: GoogleInit): Promise<SafeResponse> {
  const target = new URL(`${real.hostname === 'oauth2.googleapis.com' ? '/token' : real.pathname}${real.search}`, base);
  const maxBytes = init.maxBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    const headers = { ...init.headers, ...(init.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(init.body)) } : {}) };
    const r = http.request(target, { method: init.method, headers, timeout: init.timeoutMs ?? 10_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= maxBytes) chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const head: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) head[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        resolve({ status, ok: status >= 200 && status < 300, headers: head, body: Buffer.concat(chunks), truncated: size > maxBytes });
      });
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' })));
    r.on('error', reject);
    r.end(init.body);
  });
}

const GOOGLE_HOSTS = new Set(['oauth2.googleapis.com', 'www.googleapis.com']);

/** One call to Google's fixed addresses (or the test stand-in). */
function google(url: string, init: GoogleInit): Promise<SafeResponse> {
  const real = new URL(url);
  if (real.protocol !== 'https:' || !GOOGLE_HOSTS.has(real.hostname) || real.port) return Promise.reject(new Error('Not a Google API address.'));
  const test = testApi();
  if (test) return loopback(test, real, init);
  return safeRequest(real, init);
}

function jsonOf(res: SafeResponse): Record<string, unknown> {
  try {
    const v = JSON.parse(res.body.toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Google's message, with anything that looks like a key or token removed, one short line. */
function said(text: unknown): string {
  return String(text ?? '')
    .replace(/-----BEGIN[\s\S]*?(-----END [A-Z ]*-----|$)/g, '[key]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[token]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+/g, '[jwt]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** A short-lived JWT for the token exchange (RFC 7523), signed RS256 with the service account's key. */
export function serviceAccountJwt(clientEmail: string, privateKey: string, keyId = '', nowSec = Math.floor(Date.now() / 1000)): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT', ...(keyId ? { kid: keyId } : {}) });
  const claims = b64({ iss: clientEmail, scope: DRIVE_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey).toString('base64url');
  return `${head}.${claims}.${signature}`;
}

let cachedToken: { email: string; keyId: string; token: string; until: number } | null = null;

/** Tests: forget the access token in hand. */
export function _resetDriveToken() {
  cachedToken = null;
}

/** An access token for the service account (kept until a minute before it runs out). */
export async function accessToken(cfg: Pick<DriveConfig, 'clientEmail' | 'privateKey' | 'keyId'>): Promise<string> {
  if (cachedToken && cachedToken.email === cfg.clientEmail && cachedToken.keyId === cfg.keyId && cachedToken.until > Date.now()) return cachedToken.token;
  const assertion = serviceAccountJwt(cfg.clientEmail, cfg.privateKey, cfg.keyId);
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString();
  let res: SafeResponse;
  try {
    res = await google(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 20_000, maxBytes: 64 * 1024 });
  } catch {
    throw new Error('Could not reach Google (oauth2.googleapis.com). Check the server’s internet connection.');
  }
  const data = jsonOf(res);
  if (!res.ok || typeof data.access_token !== 'string' || !data.access_token) {
    const why = said(data.error_description || data.error);
    throw new Error(`Google did not accept the service account key${why ? ` (${why})` : ''}. Check that the key is current (Google Cloud → IAM → Service accounts → Keys) and paste it again.`);
  }
  const seconds = Number(data.expires_in);
  cachedToken = { email: cfg.clientEmail, keyId: cfg.keyId, token: data.access_token, until: Date.now() + (Number.isFinite(seconds) && seconds > 120 ? seconds - 60 : 60) * 1000 };
  return data.access_token;
}

/** A readable reason from a Drive error reply (never the token). */
function driveError(res: SafeResponse, what: string, clientEmail: string): Error {
  const e = (jsonOf(res).error ?? {}) as { message?: string; errors?: Array<{ reason?: string }> };
  const reasons = (e.errors ?? []).map((x) => String(x?.reason ?? '')).join(' ');
  const message = said(e.message);
  if (/storageQuotaExceeded/i.test(reasons) || /service accounts do not have storage quota/i.test(message)) {
    return new Error('Google does not let a service account store files in a personal Drive folder (it has no storage of its own). Use a folder in a shared drive (Google Workspace) and add the service account to that shared drive as Content manager.');
  }
  if (res.status === 404) return new Error(`Google Drive could not find the folder. Share the folder with ${clientEmail} as Editor, and check the folder link.`);
  if (res.status === 401) return new Error('Google did not accept the access token. Press Test connection again; if it keeps failing, paste a new key.');
  if (res.status === 403) return new Error(`Google Drive refused to ${what}${message ? `: ${message}` : ''}. Share the folder with ${clientEmail} as Editor.`);
  return new Error(`Google Drive could not ${what} (HTTP ${res.status}${message ? `: ${message}` : ''}).`);
}

/** The resumable session's address: on Google's upload address only. */
function sessionUrl(location: string | undefined): string {
  let u: URL;
  try {
    u = new URL(String(location ?? ''));
  } catch {
    throw new Error('Google Drive did not start the upload (no upload address).');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'www.googleapis.com' || u.port || u.pathname !== '/upload/drive/v3/files' || !u.searchParams.get('upload_id')) {
    throw new Error('Google Drive answered with an unexpected upload address: not used.');
  }
  return u.href;
}

async function md5Of(file: string): Promise<string> {
  const hash = crypto.createHash('md5');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deleteDriveFile(token: string, id: string, clientEmail: string): Promise<void> {
  if (!DRIVE_ID.test(id)) throw new Error('Not a Drive file id.');
  const res = await google(`${DRIVE_FILES_URL}/${id}?supportsAllDrives=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20_000, maxBytes: 64 * 1024 });
  if (res.ok || res.status === 404) return; // gone already (the owner removed it)
  throw driveError(res, 'delete an old copy', clientEmail);
}

/**
 * Upload one file into the folder (resumable, DRIVE_LIMITS.chunkBytes at a time, read from disk),
 * then check Google's size and MD5 against the file's. A mismatch removes the upload and fails.
 */
export async function uploadToDrive(token: string, folderId: string, file: string, name: string, clientEmail: string): Promise<{ id: string; size: number }> {
  const size = fs.statSync(file).size;
  const md5 = await md5Of(file);
  const start = await google(`${DRIVE_UPLOAD_URL}?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,md5Checksum`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType: 'application/octet-stream', appProperties: { buhBackup: '1' } }),
    timeoutMs: 30_000,
    maxBytes: 64 * 1024,
  });
  if (!start.ok) throw driveError(start, 'start the upload', clientEmail);
  const session = sessionUrl(start.headers.location);

  const chunk = Math.max(256 * 1024, DRIVE_LIMITS.chunkBytes - (DRIVE_LIMITS.chunkBytes % (256 * 1024)));
  const buf = Buffer.alloc(Math.min(chunk, Math.max(size, 1)));
  const fd = fs.openSync(file, 'r');
  let done: SafeResponse | null = null;
  try {
    let offset = 0;
    let retries = 0;
    while (!done) {
      const n = Math.min(chunk, size - offset);
      let got = 0;
      while (got < n) got += fs.readSync(fd, buf, got, n - got, offset + got);
      const range = size === 0 ? 'bytes */0' : `bytes ${offset}-${offset + n - 1}/${size}`;
      let res: SafeResponse;
      try {
        res = await google(session, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': range }, body: buf.subarray(0, n), timeoutMs: 300_000, maxBytes: 64 * 1024 });
      } catch (err) {
        if (++retries > 5) throw new Error(`The upload to Google Drive was cut off (${(err as { code?: string }).code || 'network'}).`);
        await wait(1000 * retries);
        // Ask Google how much it has, and carry on from there.
        res = await google(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, body: Buffer.alloc(0), timeoutMs: 30_000, maxBytes: 64 * 1024 }).catch(() => ({ status: 0 }) as SafeResponse);
        if (res.status !== 308 && !res.ok) continue;
      }
      if (res.status === 308) {
        const m = /bytes=0-(\d+)/.exec(res.headers.range ?? '');
        const next = m ? Number(m[1]) + 1 : 0;
        if (next > size) throw new Error('Google Drive reported an impossible upload position.');
        // No progress (Google kept less than was sent, again and again): give up rather than loop.
        if (next <= offset && n > 0 && ++retries > 5) throw new Error('The upload to Google Drive is not moving forward.');
        offset = next;
        continue;
      }
      if (res.ok) {
        done = res;
        break;
      }
      if ((res.status >= 500 || res.status === 429) && ++retries <= 5) {
        await wait(1000 * retries);
        continue;
      }
      throw driveError(res, 'upload the backup', clientEmail);
    }
  } finally {
    fs.closeSync(fd);
  }
  const meta = jsonOf(done);
  const id = String(meta.id ?? '');
  if (!DRIVE_ID.test(id)) throw new Error('Google Drive did not say which file it made.');
  if (String(meta.size ?? '') !== String(size) || String(meta.md5Checksum ?? '') !== md5) {
    await deleteDriveFile(token, id, clientEmail).catch(() => {});
    throw new Error(`Google Drive’s copy does not match the backup (size ${String(meta.size ?? '?').slice(0, 20)} of ${size} bytes, or its checksum): it was removed. The next backup tries again.`);
  }
  return { id, size };
}

// ── Copying each backup ─────────────────────────────────────────────────────

function passphraseSet(): boolean {
  return Boolean(process.env.BACKUP_PASSPHRASE);
}

const NO_PASSPHRASE = 'BACKUP_PASSPHRASE is not set: copies to Google Drive are always encrypted, so none can be made. Set BACKUP_PASSPHRASE (see the deployment guide), then try again.';

function isSealed(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(BACKUP_MAGIC.length);
    fs.readSync(fd, head, 0, head.length, 0);
    return head.toString() === BACKUP_MAGIC;
  } finally {
    fs.closeSync(fd);
  }
}

let running: Promise<DriveState> | null = null;

/**
 * Copy a backup just taken to Drive (when switched on), keep the newest `keep`, record the outcome.
 * Never throws: a failure is in the state (and the owner alert), the local backup stays as it is.
 */
export function copyBackupToDrive(file: string, reason = 'backup'): Promise<DriveState | null> {
  const cfg = config();
  if (!cfg.enabled) return Promise.resolve(null);
  if (running) return running;
  running = (async () => {
    const attemptAt = new Date().toISOString();
    try {
      if (!passphraseSet()) throw new Error(NO_PASSPHRASE);
      if (!file.endsWith('.tar.gz.enc') || !isSealed(file)) throw new Error('This backup is not encrypted, so it was not copied to Google Drive.');
      if (!cfg.privateKey || !cfg.clientEmail) throw new Error('The service account key is missing (a restored shop has none): paste it again in Settings → System & backups.');
      if (!cfg.folderId) throw new Error('No Google Drive folder is set.');
      const token = await accessToken(cfg);
      const name = path.basename(file);
      const up = await uploadToDrive(token, cfg.folderId, file, name, cfg.clientEmail);
      const before = copies();
      kvSet(FILES_KEY, [...before.filter((c) => c.id !== up.id), { id: up.id, name, size: up.size, at: new Date().toISOString() }]);
      audit('backup.drive_copied', { reason, file: name, size: up.size, fileId: up.id });
      setState({ lastAttemptAt: attemptAt, lastSuccessAt: new Date().toISOString(), lastFile: name, lastSize: up.size, lastError: undefined });
      logEvent('info', 'backup_drive_copied', { file: name, size: up.size });
      // An earlier copy with the same name (two backups in one minute: the local file was replaced) goes.
      for (const same of before.filter((c) => c.name === name && c.id !== up.id)) {
        try {
          await deleteDriveFile(token, same.id, cfg.clientEmail);
          kvSet(FILES_KEY, copies().filter((c) => c.id !== same.id));
        } catch (err) {
          logEvent('warn', 'backup_drive_prune_failed', { file: same.name, error: err instanceof Error ? err.message : String(err) });
        }
      }
      // Retention: only copies this feature made, oldest first; a delete that fails is tried next time.
      const keep = Math.max(1, cfg.keep || DRIVE_KEEP_DEFAULT);
      let kept = copies();
      while (kept.length > keep) {
        const old = kept[0];
        try {
          await deleteDriveFile(token, old.id, cfg.clientEmail);
        } catch (err) {
          logEvent('warn', 'backup_drive_prune_failed', { file: old.name, error: err instanceof Error ? err.message : String(err) });
          break;
        }
        kept = kept.slice(1);
        kvSet(FILES_KEY, kept);
        audit('backup.drive_removed', { file: old.name, fileId: old.id, keep });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ lastAttemptAt: attemptAt, lastError: message });
      audit('backup.drive_failed', { reason, error: message });
      logEvent('error', 'backup_drive_failed', { error: message });
    }
    return state();
  })().finally(() => {
    running = null;
  });
  return running;
}

// ── Settings → System & backups ─────────────────────────────────────────────

export interface DriveStatus {
  enabled: boolean;
  folderId: string;
  keep: number;
  clientEmail: string;
  keySaved: boolean;
  passphraseSet: boolean;
  copies: number;
  level: 'off' | 'ok' | 'failing';
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastError?: string;
}

/** What the hub may see: never the key (its service account's email says which key is saved). */
export function driveStatus(): DriveStatus {
  const cfg = config();
  const s = state();
  const failing = cfg.enabled && (!passphraseSet() || !cfg.privateKey || Boolean(s.lastError && (!s.lastSuccessAt || Date.parse(s.lastAttemptAt || '') > Date.parse(s.lastSuccessAt))));
  return {
    enabled: cfg.enabled,
    folderId: cfg.folderId,
    keep: cfg.keep,
    clientEmail: cfg.clientEmail,
    keySaved: Boolean(cfg.privateKey),
    passphraseSet: passphraseSet(),
    copies: copies().length,
    level: !cfg.enabled ? 'off' : failing ? 'failing' : 'ok',
    lastAttemptAt: s.lastAttemptAt,
    lastSuccessAt: s.lastSuccessAt,
    lastFile: s.lastFile,
    lastSize: s.lastSize,
    lastError: s.lastError,
  };
}

/**
 * The owner alert (monitor.ts): copies switched on but failing, paused (no passphrase or no key),
 * or none since local backups kept succeeding for two intervals.
 */
export function driveProblem(localLastSuccessAt: string | undefined, intervalHours: number, now = Date.now()): { id: string; level: 'failing'; text: string } | null {
  const st = driveStatus();
  if (!st.enabled) return null;
  const id = 'drive_backup';
  if (!st.passphraseSet) return { id, level: 'failing', text: `Copies to Google Drive are paused: ${NO_PASSPHRASE}` };
  if (!st.keySaved) return { id, level: 'failing', text: 'Copies to Google Drive are paused: the service account key is missing. Paste it again in Settings → System & backups.' };
  if (st.level === 'failing') return { id, level: 'failing', text: `The copy to Google Drive failed: ${st.lastError}` };
  const local = localLastSuccessAt ? Date.parse(localLastSuccessAt) : 0;
  const last = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : 0;
  if (local && local - last > 2 * intervalHours * 3600_000 && now - (last || 0) > 2 * intervalHours * 3600_000) {
    return { id, level: 'failing', text: last ? `No copy of the backups in Google Drive since ${new Date(last).toUTCString()}.` : 'No backup has been copied to Google Drive yet: press Back up now.' };
  }
  return null;
}

const FIELDS = ['enabled', 'folderId', 'keep', 'serviceAccountKey'];

/**
 * Save Settings → Google Drive: { enabled?, folderId?, keep?, serviceAccountKey? } (a JSON key
 * replaces the saved one; null removes it; missing or empty keeps it). Switching on needs
 * BACKUP_PASSPHRASE, a key and a folder.
 */
export function saveDriveSettings(input: Record<string, unknown>, by = ''): DriveStatus {
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 40)}.`);
  const cur = config();
  const next: DriveConfig = { ...cur };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.');
    next.enabled = input.enabled;
  }
  if (input.folderId !== undefined) {
    if (typeof input.folderId !== 'string' || input.folderId.length > 500) throw new HttpError(400, 'Google Drive folder: paste the folder’s link or its id.');
    next.folderId = input.folderId.trim() ? parseFolderId(input.folderId) : '';
  }
  if (input.keep !== undefined) {
    const n = Number(input.keep);
    if (!Number.isInteger(n) || n < 1 || n > DRIVE_KEEP_MAX) throw new HttpError(400, `Copies to keep: a whole number from 1 to ${DRIVE_KEEP_MAX}.`);
    next.keep = n;
  }
  let keyChanged = false;
  if (input.serviceAccountKey === null) {
    next.privateKey = '';
    next.keyId = '';
    next.clientEmail = '';
    next.enabled = false;
    keyChanged = true;
  } else if (typeof input.serviceAccountKey === 'string' && input.serviceAccountKey.trim()) {
    if (input.serviceAccountKey.length > 12_000) throw new HttpError(400, 'Service account key: that is too long for a key file.');
    Object.assign(next, parseServiceAccountKey(input.serviceAccountKey));
    keyChanged = true;
  } else if (input.serviceAccountKey !== undefined && typeof input.serviceAccountKey !== 'string') {
    throw new HttpError(400, 'Service account key: paste the JSON file as text.');
  }
  if (next.enabled) {
    if (!passphraseSet()) throw new HttpError(400, `Not switched on. ${NO_PASSPHRASE.replace(', then try again', ', restart the shop, then switch this on')}`, {}, { code: 'passphrase_required' });
    if (!next.privateKey) throw new HttpError(400, 'Paste the service account’s JSON key before switching this on.');
    if (!next.folderId) throw new HttpError(400, 'Paste the Google Drive folder’s link before switching this on.');
  }
  // Another account's key, or another folder: the copies recorded so far stay in Drive, but are no
  // longer this setting's to delete (they may not even be reachable with the new key).
  if ((keyChanged && next.clientEmail !== cur.clientEmail) || next.folderId !== cur.folderId) kvSet(FILES_KEY, []);
  next.savedAt = new Date().toISOString();
  next.savedBy = by;
  kvSet(CONFIG_KEY, next);
  if (keyChanged) _resetDriveToken();
  audit('backup.drive_saved', { by, enabled: next.enabled, folderId: next.folderId, keep: next.keep, serviceAccount: next.clientEmail, keyChanged });
  return driveStatus();
}

/**
 * "Test connection": with the typed key and folder (blank ones from the saved settings), take a
 * token, upload a tiny text file, check it, and delete it again.
 */
export async function testDriveConnection(input: Record<string, unknown>, by = ''): Promise<{ clientEmail: string; folderId: string }> {
  for (const k of Object.keys(input)) if (!['folderId', 'serviceAccountKey'].includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 40)}.`);
  const cur = config();
  const typedKey = typeof input.serviceAccountKey === 'string' && input.serviceAccountKey.trim() ? input.serviceAccountKey : '';
  if (typedKey.length > 12_000) throw new HttpError(400, 'Service account key: that is too long for a key file.');
  const key = typedKey ? parseServiceAccountKey(typedKey) : { clientEmail: cur.clientEmail, privateKey: cur.privateKey, keyId: cur.keyId };
  const folderId = typeof input.folderId === 'string' && input.folderId.trim() ? parseFolderId(input.folderId) : cur.folderId;
  if (!key.privateKey) throw new HttpError(400, 'Paste the service account’s JSON key first.');
  if (!folderId) throw new HttpError(400, 'Paste the Google Drive folder’s link first.');
  const scratch = path.join(fs.mkdtempSync(path.join(dataDir(), '.drive-test-')), 'test.txt');
  try {
    fs.writeFileSync(scratch, `Beautiful UAE Home: Google Drive connection test, ${new Date().toISOString()}. Safe to delete.\n`, { mode: 0o600 });
    const token = await accessToken(key);
    const up = await uploadToDrive(token, folderId, scratch, `buh-connection-test-${Date.now()}.txt`, key.clientEmail);
    await deleteDriveFile(token, up.id, key.clientEmail);
    audit('backup.drive_tested', { by, ok: true, serviceAccount: key.clientEmail, folderId });
    return { clientEmail: key.clientEmail, folderId };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    audit('backup.drive_tested', { by, ok: false, serviceAccount: key.clientEmail, folderId, error: message });
    logEvent('warn', 'backup_drive_test_failed', { error: message });
    throw new HttpError(502, message, {}, { code: 'drive_test_failed' });
  } finally {
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
  }
}
