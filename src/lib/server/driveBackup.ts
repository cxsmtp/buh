import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { audit } from './audit';
import { driveRetention } from './backupPolicy';
import { dataDir, dataFile, writePrivateFile } from './dataDir';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { testStandIn } from './testStandIn';
import { logEvent } from './log';
import { safeRequest, type SafeResponse } from './outbound';
import { backupPassphrase } from './backupSecret';

/**
 * Off-server copies of every backup, in a Google Drive folder (Settings → System & backups →
 * "Copy each backup to Google Drive"), connected one of two ways:
 *
 * - "Connect my Google Drive" (recommended; any Google account, a personal Gmail too): the owner
 *   makes an OAuth client of type "TVs and Limited Input devices", pastes its id and secret, and
 *   enters the code the hub shows at google.com/device (the OAuth 2.0 device flow; the server asks
 *   Google, the hub asks the server). Scope drive.file: the shop sees only the files it made, so it
 *   makes its own folder "Beautiful UAE Home backups". The refresh token is a secret like the key
 *   below; access tokens come from it (grant_type refresh_token); a refused one (invalid_grant)
 *   raises the alert "Reconnect Google Drive".
 * - A service account (shared drives in Google Workspace: Google gives a service account no storage
 *   of its own, so a personal Drive folder refuses its uploads), as follows.
 *
 * The owner makes a Google Cloud service account, shares one Drive folder with its email (as
 * Editor) and pastes the service account's JSON key and the folder's link here. No consent screen
 * and no refresh token: each copy signs a short JWT with the key (RS256, node:crypto) and trades it
 * at Google's fixed token address for an access token, then sends the backup with a resumable
 * upload, 8 MB at a time read from disk (never the whole file in memory), and checks Google's size
 * and MD5 of the result against the file's own.
 *
 * - Only encrypted backups (a backup password: backupSecret.ts) ever go to Drive: without one, copies
 *   can't be switched on and stop (an alert) if it is later removed. Connecting before there is a
 *   password marks the setting "switch on once protected": setting the password switches copies on.
 * - Setting it up (the hub's "Set up Google Drive" wizard): the steps the owner has ticked and the
 *   Google Cloud project id (for the console links) are kept in kv `backup:drive-wizard` (nothing
 *   secret). The connected Google account's email comes from Drive's about.get (drive.file allows
 *   it: no extra permission), shown as "Connected to …".
 * - Copies kept: up to 4 a day for the last 7 days, then the newest of each day to 30 days and of
 *   each week (Monday to Sunday, UAE) to 6 months, at most `keep` (default 60, the newest days
 *   thinned first), never the newest (backupPolicy.ts); older ones
 *   that this feature uploaded (their Drive file ids are recorded) are deleted. Nothing else in the
 *   folder is ever touched.
 * - The key, the OAuth client secret, the refresh token and a device sign-in in progress are
 *   secrets: kept in their own file, DATA_DIR/drive-secrets.json (owner-only, written atomically),
 *   never in the database (kv `backup:drive` holds only the rest), so no backup, made by this
 *   version or an older one, can hold them (the backup also blanks any found in the database, and
 *   a first start moves those of the first version to the file). Never in a reply (the hub sees the
 *   service account's email), never logged (log.ts removes PEM keys and Google tokens).
 * - Copies run after the backup, not as part of it: "Back up now" and the backup lock never wait for
 *   Google; the hub shows a copy in progress (driveStatus().copying). A backup taken while one is
 *   being copied is copied next.
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
export const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** Full Drive scope: the service account only sees what is shared with it (the one folder). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
/** "Connect my Google Drive": the shop sees only the files it made itself (non-sensitive, allowed in the device flow). */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** The folder the shop makes in the owner's Drive on first connect. */
export const APP_FOLDER_NAME = 'Beautiful UAE Home backups';
/** Resumable upload pieces: a multiple of 256 KiB, as Google asks; the wait before a retry grows by retryMs each time. (Changeable by tests only.) */
export const DRIVE_LIMITS = { chunkBytes: 8 * 1024 * 1024, retryMs: 1000 };
export const DRIVE_KEEP_DEFAULT = 60;
export const DRIVE_KEEP_MAX = 365;
const BACKUP_MAGIC = 'BUHBK1\n'; // as in backup.ts: an encrypted backup's first bytes

const CONFIG_KEY = 'backup:drive';
const STATE_KEY = 'backup:drive-state';
const FILES_KEY = 'backup:drive-files';
/** The first version kept a device sign-in here (now in the secrets file; moved, then removed). */
const DEVICE_KEY = 'backup:drive-device';
/** The secrets, outside the database: never in a backup (createBackup takes only shop.db and the shop's folders). */
export const DRIVE_SECRETS_FILE = 'drive-secrets.json';
/** The setup wizard's ticks and the Google Cloud project id (not secret). */
const WIZARD_KEY = 'backup:drive-wizard';

/** service_account: a key and a folder shared with it (shared drives). oauth: the owner's own Drive, connected with a code. */
export type DriveMode = 'oauth' | 'service_account';

interface DriveConfig {
  enabled: boolean;
  mode: DriveMode;
  keep: number;
  /** Service account: the folder shared with it, its email and key. */
  folderId: string;
  clientEmail: string;
  privateKey: string;
  keyId: string;
  /** Connect my Google Drive: the OAuth client ("TVs and Limited Input devices"), the refresh token, the shop's own folder. */
  oauthClientId: string;
  oauthClientSecret: string;
  refreshToken: string;
  oauthFolderId: string;
  connectedAt?: string;
  /** The Google account connected (Drive's about.get), when Google said; shown as "Connected to …". */
  accountEmail?: string;
  /** Connected before there was a backup password: copies switch on when one is set. */
  enableWhenProtected?: boolean;
  /** Google refused the refresh token (revoked, or expired): "Reconnect Google Drive". */
  needsReconnect?: boolean;
  savedAt?: string;
  savedBy?: string;
}

/** A device sign-in in progress (the device code is a secret: never shown, never backed up). */
interface DevicePending {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
  by: string;
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

const EMPTY: DriveConfig = { enabled: false, mode: 'oauth', keep: DRIVE_KEEP_DEFAULT, folderId: '', clientEmail: '', privateKey: '', keyId: '', oauthClientId: '', oauthClientSecret: '', refreshToken: '', oauthFolderId: '' };

// ── The secrets file ────────────────────────────────────────────────────────

const SECRET_FIELDS = ['privateKey', 'keyId', 'oauthClientSecret', 'refreshToken'] as const;
type SecretField = (typeof SECRET_FIELDS)[number];
type DriveSecrets = Record<SecretField, string> & { device: DevicePending | null };
const NO_SECRETS: DriveSecrets = { privateKey: '', keyId: '', oauthClientSecret: '', refreshToken: '', device: null };

function readSecrets(): DriveSecrets {
  let saved: Record<string, unknown> = {};
  try {
    const v = JSON.parse(fs.readFileSync(dataFile(DRIVE_SECRETS_FILE), 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) saved = v;
  } catch {
    // none yet (or unreadable): no secrets
  }
  const out: DriveSecrets = { ...NO_SECRETS };
  for (const k of SECRET_FIELDS) if (typeof saved[k] === 'string') out[k] = saved[k] as string;
  const d = saved.device as DevicePending | null | undefined;
  out.device = d && typeof d === 'object' && typeof d.deviceCode === 'string' && d.deviceCode ? d : null;
  return out;
}

/** The secrets file is written first (owner-only, atomically), then the database. */
function writeSecrets(patch: Partial<DriveSecrets>) {
  writePrivateFile(dataFile(DRIVE_SECRETS_FILE), JSON.stringify({ ...readSecrets(), ...patch }));
}

function withoutSecrets(cfg: Partial<DriveConfig>): Partial<DriveConfig> {
  const out: Partial<DriveConfig> = { ...cfg };
  for (const k of SECRET_FIELDS) delete out[k];
  return out;
}

/**
 * The first version kept the secrets in the database (kv `backup:drive`, `backup:drive-device`):
 * move them to the secrets file, then remove them from the database. Runs on start and before
 * every read (cheap when there is nothing to move), so an older version's writes during an update
 * or after a rollback are moved too.
 */
export function migrateDriveSecrets(): void {
  const saved = kvGet<Partial<DriveConfig>>(CONFIG_KEY)?.data;
  const device = kvGet<DevicePending>(DEVICE_KEY)?.data;
  const inDb = Boolean(saved && SECRET_FIELDS.some((k) => k in saved));
  if (!inDb && !device) return;
  const patch: Partial<DriveSecrets> = {};
  if (saved) for (const k of SECRET_FIELDS) if (typeof saved[k] === 'string' && saved[k]) patch[k] = saved[k] as string;
  if (device && typeof device.deviceCode === 'string' && device.deviceCode) patch.device = device;
  if (Object.keys(patch).length) writeSecrets(patch);
  if (saved && inDb) kvSet(CONFIG_KEY, withoutSecrets(saved));
  if (device) kvSet(DEVICE_KEY, null);
  logEvent('info', 'backup_drive_secrets_moved', { fields: Object.keys(patch) });
}

function config(): DriveConfig {
  migrateDriveSecrets();
  const saved = withoutSecrets(kvGet<Partial<DriveConfig>>(CONFIG_KEY)?.data ?? {});
  const s = readSecrets();
  // Saved before there were two ways: a service account.
  const mode: DriveMode = saved.mode === 'oauth' || saved.mode === 'service_account' ? saved.mode : saved.clientEmail ? 'service_account' : 'oauth';
  return { ...EMPTY, ...saved, privateKey: s.privateKey, keyId: s.keyId, oauthClientSecret: s.oauthClientSecret, refreshToken: s.refreshToken, mode };
}

/** Save the setting: the secrets to their file, the rest to the database. */
function saveConfig(cfg: DriveConfig) {
  writeSecrets({ privateKey: cfg.privateKey, keyId: cfg.keyId, oauthClientSecret: cfg.oauthClientSecret, refreshToken: cfg.refreshToken });
  kvSet(CONFIG_KEY, withoutSecrets(cfg));
}

function setPending(p: DevicePending | null) {
  writeSecrets({ device: p });
}

/** The same Google account, folder and mode (a copy made for one is not the other's to keep or delete). */
function sameTarget(a: DriveConfig, b: DriveConfig): boolean {
  return a.mode === b.mode && activeFolder(a) === activeFolder(b) && (a.mode === 'oauth' ? a.oauthClientId === b.oauthClientId : a.clientEmail === b.clientEmail);
}

/** The folder copies go to, and who Google sees, in the mode in use. */
function activeFolder(cfg: DriveConfig): string {
  return cfg.mode === 'oauth' ? cfg.oauthFolderId : cfg.folderId;
}
function who(cfg: DriveConfig): Who {
  return cfg.mode === 'oauth' ? { mode: 'oauth', email: '' } : { mode: 'service_account', email: cfg.clientEmail };
}
interface Who {
  mode: DriveMode;
  email: string;
}

function pendingDevice(): DevicePending | null {
  migrateDriveSecrets();
  return readSecrets().device;
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

/**
 * Backups: the copy of the database keeps the folder, the mode and the switch. The secrets are not
 * in the database (the secrets file is never backed up); any an older version left there are
 * blanked in the copy all the same, and a device sign-in in progress is left out.
 */
export function blankDriveKeyIn(db: import('better-sqlite3').Database): void {
  db.prepare("UPDATE kv SET data = json_set(data, '$.privateKey', '', '$.keyId', '', '$.oauthClientSecret', '', '$.refreshToken', '') WHERE key = ? AND json_valid(data)").run(CONFIG_KEY);
  db.prepare('DELETE FROM kv WHERE key = ?').run(DEVICE_KEY);
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
 * on the same machine (each address by its path: /token, /device/code, /drive/v3/…). Anything but a plain-http
 * loopback address is ignored, and so is any in production without the test server's flag (testStandIn.ts).
 */
function testApi(): URL | null {
  const v = process.env.BUH_TEST_GOOGLE_API;
  if (!v) return null;
  const u = testStandIn('BUH_TEST_GOOGLE_API');
  if (u) return u;
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
  const target = new URL(`${real.pathname}${real.search}`, base);
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

// ── Connect my Google Drive (OAuth 2.0 device flow, drive.file) ─────────────

const CLIENT_ID = /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET = /^[A-Za-z0-9_-]{10,100}$/;
const REFRESH_TOKEN = /^[\x21-\x7e]{20,1024}$/;

/** Google refused the refresh token: revoked by the owner, or expired (7 days while the app is in Testing). */
export class DriveReconnectError extends Error {}
const RECONNECT = 'Google no longer accepts the shop’s access to your Drive (it was removed, or it ran out: a Google app left in “Testing” is cut off after 7 days). Reconnect Google Drive in Settings → System & backups.';

let cachedUserToken: { client: string; refresh: string; token: string; until: number } | null = null;

/** An access token from the refresh token (grant_type refresh_token), kept until a minute before it runs out. */
export async function oauthAccessToken(c: { clientId: string; clientSecret: string; refreshToken: string }): Promise<string> {
  const refresh = crypto.createHash('sha256').update(c.refreshToken).digest('hex');
  if (cachedUserToken && cachedUserToken.client === c.clientId && cachedUserToken.refresh === refresh && cachedUserToken.until > Date.now()) return cachedUserToken.token;
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }).toString();
  let res: SafeResponse;
  try {
    res = await google(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 20_000, maxBytes: 64 * 1024 });
  } catch {
    throw new Error('Could not reach Google (oauth2.googleapis.com). Check the server’s internet connection.');
  }
  const data = jsonOf(res);
  if (data.error === 'invalid_grant') throw new DriveReconnectError(RECONNECT);
  if (data.error === 'invalid_client' || data.error === 'unauthorized_client') throw new DriveReconnectError('Google no longer accepts the shop’s OAuth client (deleted, or its secret changed). Reconnect Google Drive with the current client ID and secret.');
  if (!res.ok || typeof data.access_token !== 'string' || !data.access_token) throw new Error(`Google did not give an access token (${said(data.error_description || data.error || res.status)}).`);
  const seconds = Number(data.expires_in);
  cachedUserToken = { client: c.clientId, refresh, token: data.access_token, until: Date.now() + (Number.isFinite(seconds) && seconds > 120 ? seconds - 60 : 60) * 1000 };
  return data.access_token;
}

/** The token for the mode in use. A refused refresh token marks the setting "Reconnect Google Drive". */
async function tokenFor(cfg: DriveConfig): Promise<string> {
  if (cfg.mode === 'service_account') return accessToken(cfg);
  try {
    return await oauthAccessToken({ clientId: cfg.oauthClientId, clientSecret: cfg.oauthClientSecret, refreshToken: cfg.refreshToken });
  } catch (err) {
    if (err instanceof DriveReconnectError) saveConfig({ ...config(), needsReconnect: true });
    throw err;
  }
}

/**
 * The shop's own folder in the owner's Drive: the saved one while it is there (drive.file sees it:
 * the shop made it), otherwise a new "Beautiful UAE Home backups".
 */
export async function ensureAppFolder(token: string, existing: string): Promise<string> {
  if (existing && DRIVE_ID.test(existing)) {
    const res = await google(`${DRIVE_FILES_URL}/${existing}?supportsAllDrives=true&fields=id,trashed,mimeType`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20_000, maxBytes: 64 * 1024 });
    const meta = jsonOf(res);
    if (res.ok && meta.trashed !== true && meta.mimeType === 'application/vnd.google-apps.folder') return existing;
    if (res.status !== 404 && !res.ok) throw driveError(res, 'check the backup folder', '');
  }
  const res = await google(`${DRIVE_FILES_URL}?supportsAllDrives=true&fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ name: APP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { buhBackupFolder: '1' } }),
    timeoutMs: 20_000,
    maxBytes: 64 * 1024,
  });
  const id = String(jsonOf(res).id ?? '');
  if (!res.ok || !DRIVE_ID.test(id)) throw driveError(res, 'make the backup folder', '');
  return id;
}

function deviceError(data: Record<string, unknown>, status: number): HttpError {
  const e = String(data.error ?? data.error_code ?? '');
  if (e === 'invalid_client' || e === 'unauthorized_client') return new HttpError(400, 'Google did not accept that client ID and secret. Make an OAuth client of type “TVs and Limited Input devices” and copy both from it.', {}, { code: 'drive_client_refused' });
  if (e === 'invalid_scope') return new HttpError(400, 'Google refused the Drive permission for this client: use a “TVs and Limited Input devices” client and switch on the Google Drive API.', {}, { code: 'drive_scope_refused' });
  if (e === 'rate_limit_exceeded') return new HttpError(429, 'Google asks to wait before trying again. Try again in a few minutes.');
  return new HttpError(502, `Google could not start the connection (${said(data.error_description || e || status)}).`);
}

/**
 * "Connect Google Drive", step 1: ask Google for a device code with the owner's OAuth client.
 * The owner then enters the user code at the verification address on any phone or computer.
 */
export async function startDriveConnect(input: Record<string, unknown>, by = ''): Promise<DriveStatus> {
  for (const k of Object.keys(input)) if (!['clientId', 'clientSecret'].includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 40)}.`);
  const cur = config();
  const clientId = typeof input.clientId === 'string' && input.clientId.trim() ? input.clientId.trim() : cur.oauthClientId;
  if (!CLIENT_ID.test(clientId)) throw new HttpError(400, 'Client ID: copy it from your OAuth client in Google Cloud (it ends with .apps.googleusercontent.com).');
  const typedSecret = typeof input.clientSecret === 'string' ? input.clientSecret.trim() : '';
  // A saved secret only goes with the client it was saved for.
  const clientSecret = typedSecret || (clientId === cur.oauthClientId ? cur.oauthClientSecret : '');
  if (!CLIENT_SECRET.test(clientSecret)) throw new HttpError(400, 'Client secret: copy it from the same OAuth client (it usually starts with GOCSPX-).');
  let res: SafeResponse;
  try {
    res = await google(GOOGLE_DEVICE_CODE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId, scope: DRIVE_FILE_SCOPE }).toString(), timeoutMs: 20_000, maxBytes: 64 * 1024 });
  } catch {
    throw new HttpError(502, 'Could not reach Google (oauth2.googleapis.com). Check the server’s internet connection.');
  }
  const data = jsonOf(res);
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : '';
  const userCode = typeof data.user_code === 'string' ? data.user_code : '';
  if (!res.ok || !deviceCode || !/^[\x21-\x7e]{4,40}$/.test(userCode)) throw deviceError(data, res.status);
  // Shown to the owner as a link: Google's own address only.
  let verificationUrl = 'https://www.google.com/device';
  try {
    const u = new URL(String(data.verification_url ?? data.verification_uri ?? ''));
    if (u.protocol === 'https:' && !u.port && (u.hostname === 'google.com' || u.hostname.endsWith('.google.com'))) verificationUrl = u.href;
  } catch {
    // Google's usual address
  }
  const expiresIn = Math.min(3600, Math.max(60, Number(data.expires_in) || 1800));
  const interval = Math.min(60, Math.max(1, Number(data.interval) || 5));
  const now = Date.now();
  const pending: DevicePending = { clientId, clientSecret, deviceCode, userCode, verificationUrl, expiresAt: now + expiresIn * 1000, interval, nextPollAt: now + interval * 1000, by };
  setPending(pending);
  audit('backup.drive_connect_started', { by, clientId });
  return driveStatus();
}

/** Stop a connection in progress. */
export function cancelDriveConnect(by = ''): DriveStatus {
  if (pendingDevice()) {
    setPending(null);
    audit('backup.drive_connect_cancelled', { by });
  }
  return driveStatus();
}

export type ConnectOutcome = 'none' | 'pending' | 'connected' | 'denied' | 'expired';

/**
 * Step 2, asked by the hub every few seconds: the server asks Google whether the owner has
 * approved, but never sooner than Google's interval (raised by 5 seconds on every slow_down), and
 * stops when the device code expires. Approved: the refresh token is saved, the shop's folder is
 * made (or the saved one kept), and copies are switched on when there is a backup password (or as
 * soon as one is set).
 */
export async function pollDriveConnect(by = '', now = Date.now()): Promise<{ outcome: ConnectOutcome; status: DriveStatus }> {
  const p = pendingDevice();
  if (!p) return { outcome: 'none', status: driveStatus() };
  // Still this sign-in (not cancelled, nor replaced by a new Connect, while Google was answering)?
  const mine = () => pendingDevice()?.deviceCode === p.deviceCode;
  const end = (outcome: ConnectOutcome) => {
    if (mine()) setPending(null);
    return { outcome, status: driveStatus() };
  };
  if (now >= p.expiresAt) {
    audit('backup.drive_connect_expired', { by });
    return end('expired');
  }
  if (now < p.nextPollAt) return { outcome: 'pending', status: driveStatus() };
  // Claim this poll before asking (two hub tabs, two copies of the shop: one request per interval).
  setPending({ ...p, nextPollAt: now + p.interval * 1000 });
  let res: SafeResponse;
  try {
    res = await google(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString(),
      timeoutMs: 20_000,
      maxBytes: 64 * 1024,
    });
  } catch {
    return { outcome: 'pending', status: driveStatus() };
  }
  // Cancelled, or a new Connect started, while Google answered: this answer is not used.
  if (!mine()) return { outcome: 'none', status: driveStatus() };
  const data = jsonOf(res);
  const error = String(data.error ?? '');
  if (error === 'authorization_pending') return { outcome: 'pending', status: driveStatus() };
  if (error === 'slow_down') {
    const interval = Math.min(60, p.interval + 5);
    setPending({ ...p, interval, nextPollAt: now + interval * 1000 });
    return { outcome: 'pending', status: driveStatus() };
  }
  if (error === 'access_denied') {
    audit('backup.drive_connect_denied', { by });
    return end('denied');
  }
  if (error === 'expired_token') {
    audit('backup.drive_connect_expired', { by });
    return end('expired');
  }
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  const access = typeof data.access_token === 'string' ? data.access_token : '';
  if (!res.ok || !REFRESH_TOKEN.test(refreshToken) || !access) {
    setPending(null);
    throw new HttpError(502, `Google did not finish the connection (${said(data.error_description || error || res.status)}). Press Connect Google Drive to try again.`);
  }
  const scopes = String(data.scope ?? DRIVE_FILE_SCOPE).split(/\s+/);
  if (!scopes.includes(DRIVE_FILE_SCOPE)) {
    setPending(null);
    throw new HttpError(400, 'Google connected without the Drive permission (the box was unticked?). Press Connect Google Drive and allow access to the files the shop makes.');
  }
  const cur = config();
  // The same client keeps its folder (it can still see it); another client can't, and gets a new one.
  const keepFolder = p.clientId === cur.oauthClientId ? cur.oauthFolderId : '';
  const at = new Date(now).toISOString();
  const next: DriveConfig = {
    ...cur,
    mode: 'oauth',
    oauthClientId: p.clientId,
    oauthClientSecret: p.clientSecret,
    refreshToken,
    oauthFolderId: keepFolder,
    connectedAt: at,
    needsReconnect: false,
    // Connecting is the owner asking for copies: on, when they can be encrypted (else once they can).
    enabled: passphraseSet(),
    enableWhenProtected: !passphraseSet(),
    accountEmail: p.clientId === cur.oauthClientId ? cur.accountEmail : undefined,
    savedAt: at,
    savedBy: by,
  };
  // The connection is saved first: Google issued the refresh token once, it is never thrown away.
  if (activeFolder(cur) !== keepFolder || cur.mode !== 'oauth') kvSet(FILES_KEY, []);
  saveConfig(next);
  setPending(null);
  cachedUserToken = { client: p.clientId, refresh: crypto.createHash('sha256').update(refreshToken).digest('hex'), token: access, until: now + Math.max(60, (Number(data.expires_in) || 3600) - 60) * 1000 };
  // Then the shop's folder: checked (or made) now; if Google fails here, the next copy or Test connection makes it.
  let folder = keepFolder;
  try {
    folder = await ensureAppFolder(access, keepFolder);
  } catch (err) {
    logEvent('warn', 'backup_drive_folder_later', { error: err instanceof Error ? err.message : String(err) });
  }
  // Who is connected (Drive's about.get: allowed with drive.file), best effort.
  const email = await driveAccountEmail(access);
  const latest = config();
  // Unless the setting changed meanwhile (disconnected, another client).
  if (sameTarget(latest, next) && (folder !== keepFolder || (email && email !== latest.accountEmail))) {
    saveConfig({ ...latest, oauthFolderId: folder, ...(email ? { accountEmail: email } : {}) });
    if (folder !== keepFolder) kvSet(FILES_KEY, []);
  }
  audit('backup.drive_connected', { by, clientId: p.clientId, folderId: folder, enabled: next.enabled });
  return { outcome: 'connected', status: driveStatus() };
}

export const DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about';
const ACCOUNT_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;

/** The connected Google account's email (Drive's about.get; drive.file allows it), or '' when Google does not say. */
export async function driveAccountEmail(token: string): Promise<string> {
  try {
    const res = await google(`${DRIVE_ABOUT_URL}?fields=user(emailAddress)`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 10_000, maxBytes: 16 * 1024 });
    const user = (jsonOf(res).user ?? {}) as { emailAddress?: unknown };
    const email = typeof user.emailAddress === 'string' ? user.emailAddress.trim().toLowerCase() : '';
    return res.ok && ACCOUNT_EMAIL.test(email) ? email : '';
  } catch {
    return '';
  }
}

/** Tests: forget the OAuth access token in hand. */
export function _resetDriveUserToken() {
  cachedUserToken = null;
}

/**
 * "Copy restore details" (the route asks for the password first, and audits it): what a brand-new
 * server needs to find and open the copies, as lines for an env file.
 */
export function driveRestoreDetails(): string {
  const cfg = config();
  if (cfg.mode !== 'oauth' || !cfg.refreshToken) throw new HttpError(409, 'Connect Google Drive first.');
  return [`BUH_DRIVE_CLIENT_ID=${cfg.oauthClientId}`, `BUH_DRIVE_CLIENT_SECRET=${cfg.oauthClientSecret}`, `BUH_DRIVE_REFRESH_TOKEN=${cfg.refreshToken}`, `BUH_DRIVE_FOLDER=${cfg.oauthFolderId}`].join('\n') + '\n';
}

/** A readable reason from a Drive error reply (never the token). */
function driveError(res: SafeResponse, what: string, clientEmail: string): Error {
  const e = (jsonOf(res).error ?? {}) as { message?: string; errors?: Array<{ reason?: string }> };
  const reasons = (e.errors ?? []).map((x) => String(x?.reason ?? '')).join(' ');
  const message = said(e.message);
  if (/storageQuotaExceeded/i.test(reasons) || /service accounts do not have storage quota/i.test(message)) {
    return new Error('Google does not let a service account store files in a personal Drive folder (it has no storage of its own). Use a folder in a shared drive (Google Workspace) and add the service account to that shared drive as Content manager.');
  }
  // Connect my Google Drive (no service account email): the shop's own folder, made by the shop.
  if (!clientEmail) {
    if (res.status === 404) return new Error(`Google Drive could not find the shop’s folder “${APP_FOLDER_NAME}” (deleted, or emptied from the bin?). Press Reconnect Google Drive to make a new one.`);
    if (res.status === 401 || res.status === 403) return new Error(`Google Drive refused to ${what}${message ? `: ${message}` : ''}. Press Reconnect Google Drive in Settings → System & backups.`);
    return new Error(`Google Drive could not ${what} (HTTP ${res.status}${message ? `: ${message}` : ''}).`);
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

const CHANGED = 'The backup file changed while it was being copied (it is shorter than it was): not copied. The next backup tries again.';

/** Read exactly `length` bytes at `position`, or fail (the file was cut short): never a loop on 0 bytes. */
async function readExactly(fh: fs.promises.FileHandle, buf: Buffer, length: number, position: number): Promise<void> {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) throw new Error(CHANGED);
    got += bytesRead;
  }
}

/** The MD5 of the file open in `fh` (its first `size` bytes). */
async function md5Of(fh: fs.promises.FileHandle, size: number): Promise<string> {
  const hash = crypto.createHash('md5');
  const buf = Buffer.alloc(Math.min(1024 * 1024, Math.max(size, 1)));
  for (let at = 0; at < size; at += buf.length) {
    const n = Math.min(buf.length, size - at);
    await readExactly(fh, buf, n, at);
    hash.update(buf.subarray(0, n));
  }
  return hash.digest('hex');
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A failed delete; `status` is Google's answer (0: no answer). */
export class DriveDeleteError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function deleteDriveFile(token: string, id: string, clientEmail: string): Promise<void> {
  if (!DRIVE_ID.test(id)) throw new Error('Not a Drive file id.');
  let res: SafeResponse;
  try {
    res = await google(`${DRIVE_FILES_URL}/${id}?supportsAllDrives=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20_000, maxBytes: 64 * 1024 });
  } catch (err) {
    throw new DriveDeleteError(`Could not reach Google Drive (${(err as { code?: string }).code || 'network'}).`, 0);
  }
  if (res.ok || res.status === 404) return; // gone already (the owner removed it)
  throw new DriveDeleteError(driveError(res, 'delete an old copy', clientEmail).message, res.status);
}

/**
 * Upload one file into the folder (resumable, DRIVE_LIMITS.chunkBytes at a time, read from disk),
 * then check Google's size and MD5 against the file's. A mismatch removes the upload and fails.
 * The file is opened once: its size, MD5 and every piece come from that same open file (a backup
 * replaced at the same path meanwhile is not mixed in; one cut short fails).
 */
export async function uploadToDrive(token: string, folderId: string, file: string, name: string, clientEmail: string, onProgress?: (sent: number, size: number) => void): Promise<{ id: string; size: number }> {
  const fh = await fs.promises.open(file, 'r');
  let done: SafeResponse | null = null;
  let size = 0;
  let md5 = '';
  try {
    size = (await fh.stat()).size;
    md5 = await md5Of(fh, size);
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
    let offset = 0;
    // Failed attempts since the upload last moved forward (it starts again from 0 on progress).
    let retries = 0;
    onProgress?.(0, size);
    while (!done) {
      const n = Math.min(chunk, size - offset);
      await readExactly(fh, buf, n, offset);
      // Nothing left to send (an empty file, or Google has every byte but has not finished): ask where it stands.
      const range = n === 0 ? `bytes */${size}` : `bytes ${offset}-${offset + n - 1}/${size}`;
      let res: SafeResponse;
      let asked = false;
      try {
        res = await google(session, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': range }, body: buf.subarray(0, n), timeoutMs: 300_000, maxBytes: 64 * 1024 });
      } catch (err) {
        if (++retries > 5) throw new Error(`The upload to Google Drive was cut off (${(err as { code?: string }).code || 'network'}).`);
        await wait(DRIVE_LIMITS.retryMs * retries);
        // Ask Google how much it has, and carry on from there.
        asked = true;
        res = await google(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${size}` }, body: Buffer.alloc(0), timeoutMs: 30_000, maxBytes: 64 * 1024 }).catch(() => ({ status: 0 }) as SafeResponse);
        if (res.status !== 308 && !res.ok) continue;
      }
      if (res.status === 308) {
        const m = /bytes=0-(\d+)/.exec(res.headers.range ?? '');
        const next = m ? Number(m[1]) + 1 : 0;
        if (next > size) throw new Error('Google Drive reported an impossible upload position.');
        if (next > offset) retries = 0;
        // No progress (Google kept less than was sent, or keeps saying it has it all without finishing): give up rather than loop.
        else if (!asked && ++retries > 5) throw new Error('The upload to Google Drive is not moving forward.');
        offset = next;
        onProgress?.(offset, size);
        continue;
      }
      if (res.ok) {
        done = res;
        break;
      }
      if ((res.status >= 500 || res.status === 429) && ++retries <= 5) {
        await wait(DRIVE_LIMITS.retryMs * retries);
        continue;
      }
      throw driveError(res, 'upload the backup', clientEmail);
    }
  } finally {
    await fh.close();
  }
  onProgress?.(size, size);
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
  try {
    return Boolean(backupPassphrase());
  } catch {
    return false; // the password file can't be read: no copy (backup health says why)
  }
}

const NO_PASSPHRASE = 'No backup password is set: copies to Google Drive are always encrypted, so none can be made. Make one in Settings → System & backups → Protect backups with a password.';

/**
 * A backup password was just set: a Google Drive connected while there was none (copies waiting to
 * be protected) is switched on now. Returns whether copies were switched on.
 */
export function enableDriveIfWaiting(by = ''): boolean {
  const cfg = config();
  if (!cfg.enableWhenProtected || !passphraseSet()) return false;
  const ready = cfg.mode === 'oauth' && Boolean(cfg.refreshToken) && !cfg.needsReconnect;
  saveConfig({ ...cfg, enabled: cfg.enabled || ready, enableWhenProtected: false });
  if (ready && !cfg.enabled) {
    audit('backup.drive_saved', { by, enabled: true, mode: cfg.mode, folderId: activeFolder(cfg), keep: cfg.keep, reason: 'backup password set' });
    return true;
  }
  return false;
}

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

/** The copy in progress (one at a time), the next one waiting (only the newest backup), and how far it is. */
let running: Promise<DriveState | null> | null = null;
let queued: { file: string; reason: string; promise: Promise<DriveState | null>; resolve: (s: DriveState | null) => void } | null = null;
let progress: { file: string; size: number; sent: number; startedAt: string } | null = null;

/** What is missing for the mode in use, or '' when copies can be made. */
function missingFor(cfg: DriveConfig): string {
  if (cfg.mode === 'oauth') {
    if (!cfg.refreshToken || !cfg.oauthClientId || !cfg.oauthClientSecret) return 'Google Drive is not connected (a restored shop has no connection): press Connect Google Drive in Settings → System & backups.';
    if (cfg.needsReconnect) return RECONNECT;
    // No folder yet (Google failed to make it while connecting): the copy makes it.
    return '';
  }
  if (!cfg.privateKey || !cfg.clientEmail) return 'The service account key is missing (a restored shop has none): paste it again in Settings → System & backups.';
  if (!cfg.folderId) return 'No Google Drive folder is set.';
  return '';
}

/** Google's answer to a delete that will not change by trying again (403: no longer ours to delete; 400). */
function refusedForGood(err: unknown): boolean {
  const status = err instanceof DriveDeleteError ? err.status : 0;
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

/**
 * Copy a backup just taken to Drive (when switched on), keep the newest `keep`, record the outcome.
 * Never throws: a failure is in the state (and the owner alert), the local backup stays as it is.
 * The backup does not wait for it (backup.ts starts it and moves on). One copy at a time: a backup
 * taken while one is being copied waits for it, and only the newest of those waiting is copied.
 */
export function copyBackupToDrive(file: string, reason = 'backup'): Promise<DriveState | null> {
  if (!config().enabled) return Promise.resolve(null);
  if (running) {
    if (queued) {
      queued.file = file;
      queued.reason = reason;
    } else {
      let resolve!: (s: DriveState | null) => void;
      const promise = new Promise<DriveState | null>((r) => (resolve = r));
      queued = { file, reason, promise, resolve };
    }
    return queued.promise;
  }
  running = copyOnce(file, reason).finally(() => {
    running = null;
    progress = null;
    const next = queued;
    queued = null;
    if (next) void copyBackupToDrive(next.file, next.reason).then(next.resolve);
  });
  return running;
}

/** Wait until no copy is in progress or waiting (tests, and a clean stop). */
export async function waitForDriveCopy(): Promise<void> {
  while (running || queued) await (running ?? queued?.promise);
}

async function copyOnce(file: string, reason: string): Promise<DriveState | null> {
  let cfg = config();
  if (!cfg.enabled) return null;
  const attemptAt = new Date().toISOString();
  progress = { file: path.basename(file), size: 0, sent: 0, startedAt: attemptAt };
  try {
    if (!passphraseSet()) throw new Error(NO_PASSPHRASE);
    if (!file.endsWith('.tar.gz.enc') || !isSealed(file)) throw new Error('This backup is not encrypted, so it was not copied to Google Drive.');
    const missing = missingFor(cfg);
    if (missing) throw new Error(missing);
    const token = await tokenFor(cfg);
    const account = who(cfg).email;
    if (cfg.mode === 'oauth' && !cfg.oauthFolderId) {
      // Connected, but Google did not make the shop's folder then: make it now.
      const folder = await ensureAppFolder(token, '');
      const latest = config();
      if (sameTarget(latest, cfg)) saveConfig({ ...latest, oauthFolderId: folder });
      cfg = { ...cfg, oauthFolderId: folder };
    }
    const folder = activeFolder(cfg);
    const name = path.basename(file);
    const up = await uploadToDrive(token, folder, file, name, account, (sent, size) => {
      progress = { file: name, size, sent, startedAt: attemptAt };
    });
    setState({ lastAttemptAt: attemptAt, lastSuccessAt: new Date().toISOString(), lastFile: name, lastSize: up.size, lastError: undefined });
    logEvent('info', 'backup_drive_copied', { file: name, size: up.size });
    // The setting changed while this copy was going (another account, folder or mode): the copy is
    // in Drive, but not the new setting's to keep or delete.
    if (!sameTarget(config(), cfg)) {
      audit('backup.drive_copied', { reason, mode: cfg.mode, file: name, size: up.size, fileId: up.id, tracked: false });
      return state();
    }
    const before = copies();
    kvSet(FILES_KEY, [...before.filter((c) => c.id !== up.id), { id: up.id, name, size: up.size, at: new Date().toISOString() }]);
    audit('backup.drive_copied', { reason, mode: cfg.mode, file: name, size: up.size, fileId: up.id });
    // An earlier copy with the same name (two backups in one minute: the local file was replaced) goes.
    for (const same of before.filter((c) => c.name === name && c.id !== up.id)) {
      try {
        await deleteDriveFile(token, same.id, account);
        kvSet(FILES_KEY, copies().filter((c) => c.id !== same.id));
      } catch (err) {
        logEvent('warn', 'backup_drive_prune_failed', { file: same.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Retention: only copies this feature made (backupPolicy.ts: up to 4 a day for 7 days, then one
    // a day to 30 days, one a week to 6 months, at most `keep`; never the newest, never the one just
    // made; at most 10 a run; nothing when the clock is ahead of the copies), oldest first. A delete that fails for now (no answer, Google busy) is tried next
    // time; one Google refuses for good (403: the file is no longer ours to delete) is no longer
    // tracked (audited), so retention never stalls on it.
    const keep = Math.max(1, cfg.keep || DRIVE_KEEP_DEFAULT);
    const plan = driveRetention(copies(), keep, Date.now(), up.id);
    if (plan.clockAhead) logEvent('warn', 'backup_drive_clock_ahead', { note: 'the clock is more than 2 days ahead of the newest copy: no copy removed' });
    for (const old of plan.remove) {
      try {
        await deleteDriveFile(token, old.id, account);
        audit('backup.drive_removed', { file: old.name, fileId: old.id, keep });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent('warn', 'backup_drive_prune_failed', { file: old.name, error: message });
        if (!refusedForGood(err)) break;
        audit('backup.drive_remove_failed', { file: old.name, fileId: old.id, status: (err as DriveDeleteError).status, error: message, tracked: false });
      }
      kvSet(FILES_KEY, copies().filter((c) => c.id !== old.id));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastAttemptAt: attemptAt, lastError: message });
    audit('backup.drive_failed', { reason, mode: cfg.mode, error: message });
    logEvent('error', 'backup_drive_failed', { error: message });
  }
  return state();
}

// ── The setup wizard ────────────────────────────────────────────────────────

/** The wizard's steps, in order (the owner ticks each one done in Google Cloud). */
export const WIZARD_STEPS = ['project', 'api', 'consent', 'client'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export interface DriveWizard {
  done: WizardStep[];
  projectId: string;
}
/** A Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function driveWizard(): DriveWizard {
  const v = kvGet<Partial<DriveWizard>>(WIZARD_KEY)?.data ?? {};
  const done = Array.isArray(v.done) ? WIZARD_STEPS.filter((x) => (v.done as unknown[]).includes(x)) : [];
  const projectId = typeof v.projectId === 'string' && PROJECT_ID.test(v.projectId) ? v.projectId : '';
  return { done, projectId };
}

/** Save the wizard's ticks ({ done?: steps[], projectId?: string }); nothing secret. */
export function saveDriveWizard(input: Record<string, unknown>): DriveWizard {
  for (const k of Object.keys(input)) if (!['done', 'projectId'].includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 40)}.`);
  const cur = driveWizard();
  const next: DriveWizard = { ...cur };
  if (input.done !== undefined) {
    if (!Array.isArray(input.done) || input.done.length > WIZARD_STEPS.length || input.done.some((x) => !WIZARD_STEPS.includes(x as WizardStep))) throw new HttpError(400, `done: a list of ${WIZARD_STEPS.join(', ')}.`);
    next.done = WIZARD_STEPS.filter((x) => (input.done as unknown[]).includes(x));
  }
  if (input.projectId !== undefined) {
    const id = typeof input.projectId === 'string' ? input.projectId.trim().toLowerCase() : null;
    if (id === null || (id && !PROJECT_ID.test(id))) throw new HttpError(400, 'Project ID: 6 to 30 lowercase letters, digits and dashes, as Google shows it (for example beautiful-uae-home-123456).');
    next.projectId = id;
  }
  kvSet(WIZARD_KEY, next);
  return next;
}

// ── Settings → System & backups ─────────────────────────────────────────────

export interface DriveStatus {
  enabled: boolean;
  mode: DriveMode;
  keep: number;
  passphraseSet: boolean;
  copies: number;
  level: 'off' | 'ok' | 'failing';
  /** Service account. */
  folderId: string;
  clientEmail: string;
  keySaved: boolean;
  /** Connect my Google Drive (never the secret or the tokens). */
  oauthClientId: string;
  oauthSecretSaved: boolean;
  connected: boolean;
  connectedAt?: string;
  needsReconnect: boolean;
  oauthFolderId: string;
  folderName: string;
  /** The Google account connected, when Google said (else ''). */
  accountEmail: string;
  /** Connected before there was a backup password: copies switch on when one is set. */
  waitingForPassword: boolean;
  /** The setup wizard: steps ticked, the Google Cloud project id. */
  wizard: DriveWizard;
  /** A connection in progress: the code to enter and where (never the device code). */
  connecting: { userCode: string; verificationUrl: string; expiresAt: string; interval: number } | null;
  /** A copy going up now (the backup is already done): its file, bytes sent of its size. */
  copying: { file: string; size: number; sent: number; startedAt: string } | null;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastError?: string;
}

/** What the hub may see: never a key, secret or token (the service account's email, the OAuth client id). */
export function driveStatus(): DriveStatus {
  const cfg = config();
  const s = state();
  const p = pendingDevice();
  const lastFailed = Boolean(s.lastError && (!s.lastSuccessAt || Date.parse(s.lastAttemptAt || '') > Date.parse(s.lastSuccessAt)));
  const failing = cfg.enabled && (!passphraseSet() || Boolean(missingFor(cfg)) || lastFailed);
  return {
    enabled: cfg.enabled,
    mode: cfg.mode,
    keep: cfg.keep,
    passphraseSet: passphraseSet(),
    copies: copies().length,
    level: !cfg.enabled ? 'off' : failing ? 'failing' : 'ok',
    folderId: cfg.folderId,
    clientEmail: cfg.clientEmail,
    keySaved: Boolean(cfg.privateKey),
    oauthClientId: cfg.oauthClientId,
    oauthSecretSaved: Boolean(cfg.oauthClientSecret),
    connected: Boolean(cfg.refreshToken),
    connectedAt: cfg.connectedAt,
    needsReconnect: Boolean(cfg.needsReconnect),
    oauthFolderId: cfg.oauthFolderId,
    folderName: APP_FOLDER_NAME,
    accountEmail: cfg.mode === 'oauth' && cfg.refreshToken ? cfg.accountEmail ?? '' : '',
    waitingForPassword: Boolean(cfg.enableWhenProtected && !cfg.enabled && cfg.refreshToken),
    wizard: driveWizard(),
    connecting: p && p.expiresAt > Date.now() ? { userCode: p.userCode, verificationUrl: p.verificationUrl, expiresAt: new Date(p.expiresAt).toISOString(), interval: p.interval } : null,
    copying: running && progress ? { ...progress } : null,
    lastAttemptAt: s.lastAttemptAt,
    lastSuccessAt: s.lastSuccessAt,
    lastFile: s.lastFile,
    lastSize: s.lastSize,
    lastError: s.lastError,
  };
}

/**
 * The owner alert (monitor.ts): copies switched on but failing, paused (no passphrase, no key, not
 * connected, or Google refused the connection: "Reconnect Google Drive"), or none since local
 * backups kept succeeding for two intervals.
 */
export function driveProblem(localLastSuccessAt: string | undefined, intervalHours: number, now = Date.now()): { id: string; level: 'failing'; text: string } | null {
  const cfg = config();
  const st = driveStatus();
  if (!st.enabled) return null;
  const id = 'drive_backup';
  if (!st.passphraseSet) return { id, level: 'failing', text: `Copies to Google Drive are paused: ${NO_PASSPHRASE}` };
  if (cfg.mode === 'oauth' && cfg.needsReconnect) return { id, level: 'failing', text: `Copies to Google Drive have stopped. ${RECONNECT}` };
  const missing = missingFor(cfg);
  if (missing) return { id, level: 'failing', text: `Copies to Google Drive are paused: ${missing}` };
  if (st.level === 'failing') return { id, level: 'failing', text: `The copy to Google Drive failed: ${st.lastError}` };
  const local = localLastSuccessAt ? Date.parse(localLastSuccessAt) : 0;
  const last = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : 0;
  if (local && local - last > 2 * intervalHours * 3600_000 && now - (last || 0) > 2 * intervalHours * 3600_000) {
    return { id, level: 'failing', text: last ? `No copy of the backups in Google Drive since ${new Date(last).toUTCString()}.` : 'No backup has been copied to Google Drive yet: press Back up now.' };
  }
  return null;
}

const FIELDS = ['enabled', 'mode', 'folderId', 'keep', 'serviceAccountKey', 'disconnect'];

/**
 * Disconnect, first part: ask Google to revoke the refresh token (best effort, fixed host, through
 * safeRequest; audited either way, never the token), so the access ends at Google too, not only
 * here. The token is forgotten here whatever Google answers.
 */
async function revokeDriveAccess(by: string): Promise<void> {
  const token = config().refreshToken;
  if (!token) return;
  let status = 0;
  try {
    const res = await google(GOOGLE_REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), timeoutMs: 10_000, maxBytes: 16 * 1024 });
    status = res.status;
  } catch {
    // no answer: forgotten here all the same
  }
  const ok = status === 200;
  audit('backup.drive_revoked', { by, ok, status });
  if (!ok) logEvent('warn', 'backup_drive_revoke_failed', { status });
}

/** The Settings route: saveDriveSettings, revoking the connection at Google first on Disconnect. */
export async function updateDriveSettings(input: Record<string, unknown>, by = ''): Promise<DriveStatus> {
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 40)}.`);
  if (input.disconnect === true) await revokeDriveAccess(by);
  return saveDriveSettings(input, by);
}

/**
 * Save Settings → Google Drive: { enabled?, mode?, folderId?, keep?, serviceAccountKey?, disconnect? }.
 * A JSON key replaces the saved one; null removes it; missing or empty keeps it. `disconnect: true`
 * forgets the Google Drive connection (the refresh token). Switching on needs a backup password and,
 * for the mode chosen, a connection (oauth) or a key and a folder (service account).
 */
export function saveDriveSettings(input: Record<string, unknown>, by = ''): DriveStatus {
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 40)}.`);
  const cur = config();
  const next: DriveConfig = { ...cur };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false.');
    next.enabled = input.enabled;
    // The owner said: no longer "switch on once protected".
    next.enableWhenProtected = false;
  }
  if (input.mode !== undefined) {
    if (input.mode !== 'oauth' && input.mode !== 'service_account') throw new HttpError(400, 'mode: oauth or service_account.');
    next.mode = input.mode;
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
    if (next.mode === 'service_account') next.enabled = false;
    keyChanged = true;
  } else if (typeof input.serviceAccountKey === 'string' && input.serviceAccountKey.trim()) {
    if (input.serviceAccountKey.length > 12_000) throw new HttpError(400, 'Service account key: that is too long for a key file.');
    Object.assign(next, parseServiceAccountKey(input.serviceAccountKey));
    keyChanged = true;
    // A key pasted without saying which way: the service account way.
    if (input.mode === undefined) next.mode = 'service_account';
  } else if (input.serviceAccountKey !== undefined && typeof input.serviceAccountKey !== 'string') {
    throw new HttpError(400, 'Service account key: paste the JSON file as text.');
  }
  if (input.disconnect !== undefined) {
    if (input.disconnect !== true) throw new HttpError(400, 'disconnect must be true.');
    next.refreshToken = '';
    next.needsReconnect = false;
    next.accountEmail = undefined;
    if (next.mode === 'oauth') next.enabled = false;
    setPending(null);
    _resetDriveUserToken();
  }
  if (next.enabled) {
    if (!passphraseSet()) throw new HttpError(400, `Not switched on. ${NO_PASSPHRASE}`, {}, { code: 'passphrase_required' });
    if (next.mode === 'oauth' && !next.refreshToken) throw new HttpError(400, 'Press Connect Google Drive before switching this on.');
    if (next.mode === 'service_account' && !next.privateKey) throw new HttpError(400, 'Paste the service account’s JSON key before switching this on.');
    if (next.mode === 'service_account' && !next.folderId) throw new HttpError(400, 'Paste the Google Drive folder’s link before switching this on.');
  }
  // Another account, folder or mode: the copies recorded so far stay in Drive, but are no longer
  // this setting's to delete (they may not even be reachable now).
  const sameAccount = next.mode === cur.mode && (next.mode === 'oauth' ? next.oauthClientId === cur.oauthClientId : !(keyChanged && next.clientEmail !== cur.clientEmail));
  if (!sameAccount || activeFolder(next) !== activeFolder(cur)) kvSet(FILES_KEY, []);
  next.savedAt = new Date().toISOString();
  next.savedBy = by;
  saveConfig(next);
  if (keyChanged) _resetDriveToken();
  audit('backup.drive_saved', { by, enabled: next.enabled, mode: next.mode, folderId: activeFolder(next), keep: next.keep, serviceAccount: next.clientEmail, keyChanged, disconnected: input.disconnect === true });
  return driveStatus();
}

/**
 * "Test connection": take a token, upload a tiny text file to the folder, check it, delete it.
 * Service account: the typed key and folder (blank ones from the saved settings). Connect my
 * Google Drive: the saved connection and the shop's own folder.
 */
export async function testDriveConnection(input: Record<string, unknown>, by = ''): Promise<{ mode: DriveMode; clientEmail: string; folderId: string }> {
  for (const k of Object.keys(input)) if (!['mode', 'folderId', 'serviceAccountKey'].includes(k)) throw new HttpError(400, `Unexpected field: ${k.slice(0, 40)}.`);
  const cur = config();
  // A key typed without saying which way: the service account way.
  const typedSa = typeof input.serviceAccountKey === 'string' && input.serviceAccountKey.trim() !== '';
  const mode: DriveMode = input.mode === 'oauth' || input.mode === 'service_account' ? input.mode : typedSa ? 'service_account' : cur.mode;
  let token = '';
  let account = '';
  let folderId = '';
  let getToken: () => Promise<string>;
  if (mode === 'oauth') {
    if (!cur.refreshToken) throw new HttpError(400, 'Press Connect Google Drive first.');
    folderId = cur.oauthFolderId;
    getToken = () => tokenFor({ ...cur, mode: 'oauth' });
  } else {
    const typedKey = typeof input.serviceAccountKey === 'string' && input.serviceAccountKey.trim() ? input.serviceAccountKey : '';
    if (typedKey.length > 12_000) throw new HttpError(400, 'Service account key: that is too long for a key file.');
    const key = typedKey ? parseServiceAccountKey(typedKey) : { clientEmail: cur.clientEmail, privateKey: cur.privateKey, keyId: cur.keyId };
    folderId = typeof input.folderId === 'string' && input.folderId.trim() ? parseFolderId(input.folderId) : cur.folderId;
    if (!key.privateKey) throw new HttpError(400, 'Paste the service account’s JSON key first.');
    if (!folderId) throw new HttpError(400, 'Paste the Google Drive folder’s link first.');
    account = key.clientEmail;
    getToken = () => accessToken(key);
  }
  const scratch = path.join(fs.mkdtempSync(path.join(dataDir(), '.drive-test-')), 'test.txt');
  try {
    fs.writeFileSync(scratch, `Beautiful UAE Home: Google Drive connection test, ${new Date().toISOString()}. Safe to delete.\n`, { mode: 0o600 });
    token = await getToken();
    if (mode === 'oauth') {
      // The shop's folder gone (deleted by hand)? Make it again, as a backup would need.
      const folder = await ensureAppFolder(token, folderId);
      if (folder !== folderId) {
        saveConfig({ ...config(), oauthFolderId: folder });
        kvSet(FILES_KEY, []);
        folderId = folder;
      }
    }
    const up = await uploadToDrive(token, folderId, scratch, `buh-connection-test-${Date.now()}.txt`, account);
    await deleteDriveFile(token, up.id, account);
    if (mode === 'oauth' && cur.needsReconnect) saveConfig({ ...config(), needsReconnect: false });
    audit('backup.drive_tested', { by, ok: true, mode, serviceAccount: account, folderId });
    return { mode, clientEmail: account, folderId };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    audit('backup.drive_tested', { by, ok: false, mode, serviceAccount: account, folderId, error: message });
    logEvent('warn', 'backup_drive_test_failed', { error: message });
    throw new HttpError(502, message, {}, { code: 'drive_test_failed' });
  } finally {
    fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
  }
}
