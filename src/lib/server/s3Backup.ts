import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { audit } from './audit';
import { backupPassphrase } from './backupSecret';
import { dataFile, writePrivateFile } from './dataDir';
import { HttpError } from './http';
import { kvGet, kvSet } from './kv';
import { logEvent } from './log';
import { assertPublicHttpsUrl, safeRequest } from './outbound';
import { testStandIn } from './testStandIn';

/**
 * A second place for the backups (asked by the owner: Google Drive drops its connection while
 * its app is in "Testing"): an S3-compatible bucket, Amazon S3, Backblaze B2 or Cloudflare R2.
 *
 * - Only encrypted backups go (a backup password is required, like Drive), each as
 *   <prefix>/<backup file name>; the newest `keep` (30 by default) are kept, older ones removed.
 * - The access key's secret stays on the server in its own file (DATA_DIR/s3-secrets.json, never in
 *   a backup or a log, never sent to the browser: only whether it is saved and its last 4
 *   characters); the endpoint, bucket and switch are settings, backed up as usual.
 * - Requests are signed with AWS Signature Version 4 (every provider here takes it), go only to
 *   the public https endpoint the owner typed, and never follow redirects. Big backups go up in
 *   16 MB parts (multipart upload), a part at a time, so memory stays small.
 * - Never throws into the backup: a failure is recorded (the hub shows it) and the local backup
 *   stays as it is. One copy at a time.
 * - To restore: download the newest file from the bucket and run scripts/restore-backup.mjs on it.
 */

const CONFIG_KEY = 'backup:s3';
const STATE_KEY = 'backup:s3-state';
export const S3_SECRETS_FILE = 's3-secrets.json';
export const S3_KEEP_DEFAULT = 30;
export const S3_KEEP_MAX = 365;
export const S3_PART_BYTES = 16 * 1024 * 1024;
const BACKUP_NAME = /^buh-backup-[A-Za-z0-9._-]+\.tar\.gz\.enc$/;

export interface S3Config {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  keep: number;
  accessKeyId: string;
}
interface S3Secrets {
  secretAccessKey?: string;
}
export interface S3State {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastError?: string;
  removed?: number;
}

const DEFAULTS: S3Config = { enabled: false, endpoint: '', region: 'auto', bucket: '', prefix: 'beautifuluaehome', keep: S3_KEEP_DEFAULT, accessKeyId: '' };

function config(): S3Config {
  return { ...DEFAULTS, ...(kvGet<Partial<S3Config>>(CONFIG_KEY)?.data ?? {}) };
}
function readSecrets(): S3Secrets {
  try {
    return JSON.parse(fs.readFileSync(dataFile(S3_SECRETS_FILE), 'utf8')) as S3Secrets;
  } catch {
    return {};
  }
}
const state = (): S3State => kvGet<S3State>(STATE_KEY)?.data ?? {};
const setState = (patch: S3State) => kvSet(STATE_KEY, { ...state(), ...patch });

function passphraseSet(): boolean {
  try {
    return Boolean(backupPassphrase());
  } catch {
    return false;
  }
}

const hint = (s: string | undefined) => (s && s.length >= 16 ? `••••${s.slice(-4)}` : undefined);

/** The hub's view: the settings, whether the secret is saved (and its last 4), the last copy. */
export function s3Status() {
  const c = config();
  const secret = readSecrets().secretAccessKey;
  return {
    ...c,
    secretSet: Boolean(secret),
    ...(hint(secret) ? { secretHint: hint(secret) } : {}),
    ...(hint(c.accessKeyId) ? { accessKeyHint: hint(c.accessKeyId) } : {}),
    accessKeyId: c.accessKeyId ? `${c.accessKeyId.slice(0, 4)}…` : '',
    passwordSet: passphraseSet(),
    state: state(),
    running: Boolean(running),
  };
}

type Obj = Record<string, unknown>;
const FIELDS = ['enabled', 'endpoint', 'region', 'bucket', 'prefix', 'keep', 'accessKeyId', 'secretAccessKey', 'forget'];

/** Save the owner's settings (allow-listed, checked); a blank secret keeps the saved one; "forget" removes the keys. */
export async function updateS3Settings(input: unknown, actor: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Settings must be an object.');
  const o = input as Obj;
  const unknown = Object.keys(o).filter((k) => !FIELDS.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown field: ${unknown[0].slice(0, 40)}.`);
  const cur = config();
  if (o.forget === true) {
    kvSet(CONFIG_KEY, { ...cur, enabled: false, accessKeyId: '' });
    writePrivateFile(dataFile(S3_SECRETS_FILE), JSON.stringify({}));
    audit('backup.s3_forgotten', { by: actor });
    return s3Status();
  }
  const str = (v: unknown, field: string, max: number, fallback: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
    const s = v.trim();
    if (s.length > max) throw new HttpError(400, `${field}: at most ${max} characters.`);
    return s;
  };
  let endpoint = str(o.endpoint, 'Endpoint', 300, cur.endpoint).replace(/\/+$/, '');
  if (endpoint) {
    if (!/^https:\/\//i.test(endpoint)) endpoint = `https://${endpoint}`;
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw new HttpError(400, 'Endpoint is not a valid address.');
    }
    if (u.pathname !== '/' || u.search || u.username || u.password || (u.port && u.port !== '443')) throw new HttpError(400, 'Endpoint: the address only, e.g. https://s3.eu-central-1.amazonaws.com.');
    // Its name is looked up when it is used (Test, and each copy: assertPublicHttpsUrl and safeRequest
    // refuse a non-public address); here only what can be told from the text.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) || host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || !host.includes('.')) throw new HttpError(400, 'Endpoint must be the provider’s public address.');
    endpoint = `https://${u.host}`;
  }
  const region = str(o.region, 'Region', 40, cur.region) || 'auto';
  if (!/^[a-z0-9-]{2,40}$/.test(region)) throw new HttpError(400, 'Region: e.g. me-central-1, us-west-004 or auto.');
  const bucket = str(o.bucket, 'Bucket', 63, cur.bucket);
  if (bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new HttpError(400, 'Bucket: its name as in the provider (lower case, 3–63 characters).');
  const prefix = str(o.prefix, 'Folder', 100, cur.prefix).replace(/^\/+|\/+$/g, '');
  if (prefix && !/^[A-Za-z0-9._/-]+$/.test(prefix)) throw new HttpError(400, 'Folder: letters, digits, - _ . and / only.');
  const keepRaw = o.keep === undefined ? cur.keep : o.keep;
  if (typeof keepRaw !== 'number' || !Number.isInteger(keepRaw) || keepRaw < 1 || keepRaw > S3_KEEP_MAX) throw new HttpError(400, `Keep: 1 to ${S3_KEEP_MAX} copies.`);
  const accessKeyId = o.accessKeyId === undefined || o.accessKeyId === '' ? cur.accessKeyId : str(o.accessKeyId, 'Access key ID', 128, cur.accessKeyId);
  if (accessKeyId && !/^[A-Za-z0-9+/=_-]{8,128}$/.test(accessKeyId)) throw new HttpError(400, 'Access key ID: as the provider shows it.');
  const secret = o.secretAccessKey === undefined || o.secretAccessKey === '' ? undefined : str(o.secretAccessKey, 'Secret access key', 256, '');
  if (secret !== undefined && !/^[A-Za-z0-9+/=_-]{16,256}$/.test(secret)) throw new HttpError(400, 'Secret access key: as the provider shows it.');
  const enabled = o.enabled === undefined ? cur.enabled : o.enabled === true;
  if (enabled && !(endpoint && bucket && accessKeyId && (secret || readSecrets().secretAccessKey))) throw new HttpError(400, 'To switch it on, enter the endpoint, bucket, access key ID and secret access key.');
  if (enabled && !passphraseSet()) throw new HttpError(409, 'Set a backup password first (Settings → System & backups): copies outside the server are always encrypted.', {}, { code: 'no_passphrase' });
  const next: S3Config = { enabled, endpoint, region, bucket, prefix, keep: keepRaw, accessKeyId };
  kvSet(CONFIG_KEY, next);
  if (secret !== undefined) writePrivateFile(dataFile(S3_SECRETS_FILE), JSON.stringify({ secretAccessKey: secret } satisfies S3Secrets));
  audit('backup.s3_settings', { by: actor, enabled, endpoint, bucket, prefix, keep: keepRaw, keyChanged: secret !== undefined });
  return s3Status();
}

// ── Signed requests (AWS Signature Version 4) ───────────────────────────────

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key: Buffer | string, s: string) => crypto.createHmac('sha256', key).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

interface Target {
  url: URL;
  host: string;
  canonicalUri: string;
}

/** Virtual-hosted address for Amazon (bucket.s3.region.amazonaws.com), path style for the rest (endpoint/bucket/key). */
function target(c: S3Config, key: string, query: Record<string, string> = {}): Target {
  const base = new URL(c.endpoint);
  const amazon = /(^|\.)amazonaws\.com$/.test(base.hostname) && !c.bucket.includes('.');
  const host = amazon ? `${c.bucket}.${base.host}` : base.host;
  const keyPath = key.split('/').map(enc).join('/');
  const canonicalUri = amazon ? `/${keyPath}` : `/${enc(c.bucket)}${key ? `/${keyPath}` : ''}`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join('&');
  return { url: new URL(`https://${host}${canonicalUri}${qs ? `?${qs}` : ''}`), host, canonicalUri };
}

/**
 * The AWS Signature Version 4 Authorization header for one request (pure: tested against Amazon's
 * own published example). Header names are signed lower-case and sorted.
 */
export function signV4(r: { method: string; canonicalUri: string; canonicalQuery: string; headers: Record<string, string>; payloadHash: string; region: string; accessKeyId: string; secret: string; amzDate: string }): string {
  const lower = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [r.method, r.canonicalUri, r.canonicalQuery, canonicalHeaders, signedHeaders, r.payloadHash].join('\n');
  const day = r.amzDate.slice(0, 8);
  const scope = `${day}/${r.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', r.amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${r.secret}`, day), r.region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

async function signed(c: S3Config, method: string, key: string, query: Record<string, string>, body: Buffer = Buffer.alloc(0), extra: Record<string, string> = {}) {
  const secret = readSecrets().secretAccessKey;
  // The endpoint must still be a public https address (its name looked up now; the connection checks again).
  if (!testStandIn('S3_TEST_API')) await assertPublicHttpsUrl(c.endpoint, 'Endpoint');
  if (!secret || !c.accessKeyId) throw new Error('The access key is not saved.');
  const t = target(c, key, query);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const payloadHash = sha256(body);
  const headers: Record<string, string> = { host: t.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
  const auth = signV4({ method, canonicalUri: t.canonicalUri, canonicalQuery: t.url.search.slice(1), headers, payloadHash, region: c.region, accessKeyId: c.accessKeyId, secret, amzDate });
  const sendHeaders: Record<string, string> = { ...headers, authorization: auth, 'content-length': String(body.length) };
  delete sendHeaders.host;
  // Tests: a stand-in on this machine (never in a shop: testStandIn).
  const stand = testStandIn('S3_TEST_API');
  if (stand) {
    const res = await fetch(new URL(`${t.url.pathname}${t.url.search}`, stand), { method, headers: { ...sendHeaders, 'x-test-host': t.host }, body: body.length ? new Uint8Array(body) : undefined });
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) };
  }
  const res = await safeRequest(t.url, { method, headers: sendHeaders, body: body.length ? body : undefined, timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024 });
  return { status: res.status, headers: res.headers, body: res.body };
}

/** The provider's own error text (<Code> and <Message>), short, never the request. */
function s3Error(what: string, res: { status: number; body: Buffer }): Error {
  const xml = res.body.toString('utf8');
  const code = /<Code>([^<]{1,80})<\/Code>/.exec(xml)?.[1];
  const msg = /<Message>([^<]{1,200})<\/Message>/.exec(xml)?.[1];
  const plain = code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId' ? 'the access key ID or secret is wrong' : code === 'NoSuchBucket' ? 'there is no bucket with that name at this endpoint' : code === 'AccessDenied' ? 'the key may not write to this bucket' : msg || code || `HTTP ${res.status}`;
  return new Error(`${what}: ${plain}${code && !plain.includes(code) ? ` (${code})` : ''}.`);
}

const keyOf = (c: S3Config, name: string) => (c.prefix ? `${c.prefix}/${name}` : name);

async function putFile(c: S3Config, file: string, name: string): Promise<number> {
  const size = fs.statSync(file).size;
  const key = keyOf(c, name);
  const fd = fs.openSync(file, 'r');
  try {
    if (size <= S3_PART_BYTES) {
      const body = Buffer.alloc(size);
      fs.readSync(fd, body, 0, size, 0);
      const res = await signed(c, 'PUT', key, {}, body, { 'content-type': 'application/octet-stream' });
      if (res.status !== 200) throw s3Error('Upload refused', res);
      return size;
    }
    const start = await signed(c, 'POST', key, { uploads: '' });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(start.body.toString('utf8'))?.[1];
    if (start.status !== 200 || !uploadId) throw s3Error('Upload refused', start);
    const parts: string[] = [];
    try {
      for (let n = 1, at = 0; at < size; n++, at += S3_PART_BYTES) {
        const len = Math.min(S3_PART_BYTES, size - at);
        const body = Buffer.alloc(len);
        fs.readSync(fd, body, 0, len, at);
        const res = await signed(c, 'PUT', key, { partNumber: String(n), uploadId }, body);
        const etag = res.headers.etag ?? res.headers.ETag;
        if (res.status !== 200 || !etag) throw s3Error(`Part ${n} refused`, res);
        parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${etag.replace(/[<>&]/g, '')}</ETag></Part>`);
      }
      const done = await signed(c, 'POST', key, { uploadId }, Buffer.from(`<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`), { 'content-type': 'application/xml' });
      if (done.status !== 200 || /<Error>/.test(done.body.toString('utf8'))) throw s3Error('Upload not completed', done);
    } catch (err) {
      await signed(c, 'DELETE', key, { uploadId }).catch(() => undefined);
      throw err;
    }
    return size;
  } finally {
    fs.closeSync(fd);
  }
}

/** The shop's backup copies in the bucket (newest last), by name: names hold the time, so they sort by it. */
async function listCopies(c: S3Config): Promise<string[]> {
  const out: string[] = [];
  let token = '';
  for (let page = 0; page < 20; page++) {
    const res = await signed(c, 'GET', '', { 'list-type': '2', prefix: c.prefix ? `${c.prefix}/` : '', ...(token ? { 'continuation-token': token } : {}) });
    if (res.status !== 200) throw s3Error('Listing refused', res);
    const xml = res.body.toString('utf8');
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const name = m[1].replace(/&amp;/g, '&').split('/').pop()!;
      if (BACKUP_NAME.test(name)) out.push(name);
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : '';
    if (!token) break;
  }
  return out.sort();
}

// ── Copying each backup ─────────────────────────────────────────────────────

let running: Promise<S3State | null> | null = null;
let queued: { file: string; reason: string } | null = null;

export const s3Enabled = () => config().enabled;

/** Copy a backup just taken to the bucket (when switched on), keep the newest `keep`. Never throws. */
export function copyBackupToS3(file: string, reason = 'backup'): Promise<S3State | null> {
  if (!config().enabled) return Promise.resolve(null);
  if (running) {
    queued = { file, reason };
    return running;
  }
  running = copyOnce(file, reason).finally(() => {
    running = null;
    const next = queued;
    queued = null;
    if (next) void copyBackupToS3(next.file, next.reason);
  });
  return running;
}

/** Wait until no copy is in progress or waiting (tests). */
export async function waitForS3Copy(): Promise<void> {
  while (running) await running;
}

async function copyOnce(file: string, reason: string): Promise<S3State | null> {
  const c = config();
  if (!c.enabled) return null;
  const attemptAt = new Date().toISOString();
  const name = path.basename(file);
  try {
    if (!passphraseSet()) throw new Error('No backup password is set: copies outside the server are always encrypted, so none was made.');
    if (!BACKUP_NAME.test(name) || !isSealed(file)) throw new Error('This backup is not encrypted, so it was not copied.');
    const size = await putFile(c, file, name);
    let removed = 0;
    try {
      const all = await listCopies(c);
      const old = all.filter((n) => n !== name).slice(0, Math.max(0, all.length - Math.max(1, c.keep)));
      for (const n of old.slice(0, 10)) {
        const res = await signed(c, 'DELETE', keyOf(c, n), {});
        if (res.status === 204 || res.status === 200) removed++;
      }
    } catch (err) {
      logEvent('warn', 'backup_s3_prune_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    const done: S3State = { lastAttemptAt: attemptAt, lastSuccessAt: new Date().toISOString(), lastFile: name, lastSize: size, lastError: undefined, removed };
    setState(done);
    audit('backup.s3_copied', { reason, file: name, size, removed, bucket: c.bucket });
    logEvent('info', 'backup_s3_copied', { file: name, size, removed });
    return state();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState({ lastAttemptAt: attemptAt, lastError: message });
    audit('backup.s3_failed', { reason, file: name, error: message });
    logEvent('warn', 'backup_s3_failed', { file: name, error: message });
    return state();
  }
}

function isSealed(file: string): boolean {
  const magic = 'BUHBK1\n';
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(magic.length);
    fs.readSync(fd, head, 0, head.length, 0);
    return head.toString() === magic;
  } finally {
    fs.closeSync(fd);
  }
}

/** "Test": write a small file in the folder and remove it again; says plainly what went wrong. */
export async function testS3(): Promise<{ ok: boolean; message: string }> {
  const c = config();
  if (!c.endpoint || !c.bucket || !c.accessKeyId || !readSecrets().secretAccessKey) return { ok: false, message: 'Enter and save the endpoint, bucket, access key ID and secret access key first.' };
  const key = keyOf(c, `.buh-test-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const put = await signed(c, 'PUT', key, {}, Buffer.from('Beautiful UAE Home backup test\n'), { 'content-type': 'text/plain' });
    if (put.status !== 200) throw s3Error('Writing refused', put);
    await listCopies(c);
    const del = await signed(c, 'DELETE', key, {});
    if (del.status !== 204 && del.status !== 200) throw s3Error('Removing the test file refused', del);
    return { ok: true, message: `Connected: the shop can write to ${c.bucket}${c.prefix ? `/${c.prefix}` : ''}, list and remove its copies.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
