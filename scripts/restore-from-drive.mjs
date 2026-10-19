// Fetch a backup copy from Google Drive, for scripts/restore-backup.mjs --from-drive (the shop's
// "Copy each backup to Google Drive", src/lib/server/driveBackup.ts, put it there).
//
// The connection and the folder come from, in this order:
//   Connect my Google Drive: BUH_DRIVE_CLIENT_ID, BUH_DRIVE_CLIENT_SECRET and BUH_DRIVE_REFRESH_TOKEN
//   (Admin Hub → Copy restore details), BUH_DRIVE_FOLDER optional (else the shop's own folder,
//   found by name); a service account: BUH_DRIVE_KEY (the JSON key's text) or BUH_DRIVE_KEY_FILE
//   (a path to it), and BUH_DRIVE_FOLDER (the folder's id or link); otherwise the shop's own saved
//   settings in DATA_DIR/shop.db and its secrets in DATA_DIR/drive-secrets.json (when run inside the
//   running shop: podman exec beautifuluaehome …).
// Only the shop's own copies count: files it marked (appProperties buhBackup=1) with a backup's
// name, not stamped more than a day ahead. Copies in Drive are always encrypted: the backup password
// opens them, and restore-backup.mjs refuses one from Drive that is not.
// Only Google's fixed addresses are called (oauth2.googleapis.com, www.googleapis.com). The download
// is streamed to disk and checked against Drive's size and MD5 before the restore reads it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const APP_FOLDER = 'Beautiful UAE Home backups';
const COPY_NAME = /^buh-backup-\d{8}-\d{4}\.tar\.gz\.enc$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

const SECRETS_FILE = 'drive-secrets.json';
/** Most pages of one listing (200 files each). */
const MAX_PAGES = 50;

/**
 * Tests only: BUH_TEST_GOOGLE_API=http://127.0.0.1:<port>/ (plain-http loopback, nothing else; in
 * production only with the test server's flag, as src/lib/server/testStandIn.ts).
 */
function testApi() {
  const v = process.env.BUH_TEST_GOOGLE_API;
  if (!v) return null;
  if (process.env.NODE_ENV === 'production' && process.env.BUH_TEST_SERVER !== '1') return null;
  try {
    const u = new URL(v);
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port && u.pathname === '/' && !u.search) return u;
  } catch {
    // ignored
  }
  return null;
}

/** One request to Google's fixed hosts. Resolves { status, headers, res } with the reply unread. */
function open(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const real = new URL(url);
  if (real.protocol !== 'https:' || !['oauth2.googleapis.com', 'www.googleapis.com'].includes(real.hostname) || real.port) throw new Error('Not a Google API address.');
  const test = testApi();
  const target = test ? new URL(`${real.pathname}${real.search}`, test) : real;
  const lib = test ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method, headers: { ...headers, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) }, timeout: timeoutMs }, (res) =>
      resolve({ status: res.statusCode ?? 0, headers: res.headers, res })
    );
    req.on('timeout', () => req.destroy(new Error('Google did not answer in time.')));
    req.on('error', reject);
    req.end(body);
  });
}

async function readJson(reply, max = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of reply.res) {
    size += c.length;
    if (size > max) throw new Error('Google’s answer was too large.');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200);

function folderIdOf(input) {
  const s = String(input ?? '').trim();
  if (DRIVE_ID.test(s)) return s;
  try {
    const u = new URL(s);
    const id = u.hostname === 'drive.google.com' ? (u.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? u.searchParams.get('id') ?? '') : '';
    if (DRIVE_ID.test(id)) return id;
  } catch {
    // below
  }
  throw new Error('BUH_DRIVE_FOLDER: give the Drive folder’s id or its link (drive.google.com/drive/folders/…).');
}

/** The service account and folder: from the environment, else the shop's saved settings. */
function credentials(dataDir) {
  let saved = null;
  const db = dataDir ? path.join(dataDir, 'shop.db') : '';
  if (db && fs.existsSync(db)) return import('better-sqlite3').then(({ default: Database }) => {
    try {
      const conn = new Database(db, { readonly: true, fileMustExist: true });
      try {
        const row = conn.prepare("SELECT data FROM kv WHERE key = 'backup:drive'").get();
        saved = row ? JSON.parse(row.data) : null;
      } finally {
        conn.close();
      }
    } catch {
      saved = null;
    }
    // The secrets are in their own file (the first version kept them in the database: either works).
    try {
      const secrets = JSON.parse(fs.readFileSync(path.join(dataDir, SECRETS_FILE), 'utf8'));
      if (saved && secrets && typeof secrets === 'object') {
        for (const k of ['privateKey', 'keyId', 'oauthClientSecret', 'refreshToken']) if (typeof secrets[k] === 'string' && secrets[k]) saved[k] = secrets[k];
      }
    } catch {
      // no secrets file
    }
    return pick(saved);
  });
  return Promise.resolve(pick(saved));
}

function pick(saved) {
  // Connect my Google Drive: the OAuth client and refresh token (env first: a brand-new server).
  const envRefresh = process.env.BUH_DRIVE_REFRESH_TOKEN || '';
  if (envRefresh || (!process.env.BUH_DRIVE_KEY && !process.env.BUH_DRIVE_KEY_FILE && saved?.mode === 'oauth')) {
    const clientId = envRefresh ? process.env.BUH_DRIVE_CLIENT_ID || '' : String(saved?.oauthClientId ?? '');
    const clientSecret = envRefresh ? process.env.BUH_DRIVE_CLIENT_SECRET || '' : String(saved?.oauthClientSecret ?? '');
    const refreshToken = envRefresh || String(saved?.refreshToken ?? '');
    if (!clientId || !clientSecret || !refreshToken) throw new Error('No Google Drive connection: set BUH_DRIVE_CLIENT_ID, BUH_DRIVE_CLIENT_SECRET and BUH_DRIVE_REFRESH_TOKEN (Admin Hub → Settings → System & backups → Copy restore details), or run this inside the shop that is connected.');
    // A saved folder id goes into a Drive query: an id, or nothing (then the folder is found by name).
    const savedFolder = String(saved?.oauthFolderId ?? '');
    const folderId = process.env.BUH_DRIVE_FOLDER ? folderIdOf(process.env.BUH_DRIVE_FOLDER) : envRefresh || !DRIVE_ID.test(savedFolder) ? '' : savedFolder;
    return { mode: 'oauth', clientId, clientSecret, refreshToken, folderId, who: 'your Google account' };
  }
  let keyText = process.env.BUH_DRIVE_KEY || '';
  if (!keyText && process.env.BUH_DRIVE_KEY_FILE) keyText = fs.readFileSync(process.env.BUH_DRIVE_KEY_FILE, 'utf8');
  let clientEmail = '';
  let privateKey = '';
  let keyId = '';
  if (keyText) {
    let key;
    try {
      key = JSON.parse(keyText);
    } catch {
      throw new Error('BUH_DRIVE_KEY: not the JSON key file of a service account.');
    }
    clientEmail = String(key.client_email ?? '');
    privateKey = String(key.private_key ?? '');
    keyId = typeof key.private_key_id === 'string' ? key.private_key_id : '';
  } else if (saved?.privateKey) {
    clientEmail = String(saved.clientEmail ?? '');
    privateKey = String(saved.privateKey);
    keyId = String(saved.keyId ?? '');
  }
  if (!clientEmail || !privateKey) throw new Error('No Google Drive connection: set BUH_DRIVE_CLIENT_ID, BUH_DRIVE_CLIENT_SECRET and BUH_DRIVE_REFRESH_TOKEN (Connect my Google Drive), or BUH_DRIVE_KEY / BUH_DRIVE_KEY_FILE (a service account), or run this inside the shop that has it saved.');
  const folderId = process.env.BUH_DRIVE_FOLDER ? folderIdOf(process.env.BUH_DRIVE_FOLDER) : String(saved?.folderId ?? '');
  if (!DRIVE_ID.test(folderId)) throw new Error('No Google Drive folder: set BUH_DRIVE_FOLDER (the folder’s id or link).');
  return { mode: 'service_account', clientEmail, privateKey, keyId, folderId, who: clientEmail };
}

async function token(cred) {
  if (cred.mode === 'oauth') {
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: cred.clientId, client_secret: cred.clientSecret, refresh_token: cred.refreshToken }).toString();
    const reply = await open(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await readJson(reply);
    if (data.error === 'invalid_grant') throw new Error('Google no longer accepts this Google Drive connection (removed, or expired). Reconnect Google Drive in the Admin Hub of the shop that has it, then Copy restore details again.');
    if (reply.status !== 200 || typeof data.access_token !== 'string') throw new Error(`Google did not accept the Google Drive connection (${clean(data.error_description || data.error || reply.status)}).`);
    return data.access_token;
  }
  const { clientEmail, privateKey, keyId } = cred;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'RS256', typ: 'JWT', ...(keyId ? { kid: keyId } : {}) })}.${b64({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const assertion = `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
  const reply = await open(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
  const data = await readJson(reply);
  if (reply.status !== 200 || typeof data.access_token !== 'string') throw new Error(`Google did not accept the service account key (${clean(data.error_description || data.error || reply.status)}).`);
  return data.access_token;
}

/** Every page of a files.list query (at most MAX_PAGES; an empty page that names itself again ends it). */
async function listAll(access, q, fields) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ q, pageSize: '200', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', fields: `nextPageToken,files(${fields})`, ...(pageToken ? { pageToken } : {}) });
    const reply = await open(`${FILES_URL}?${params}`, { headers: { Authorization: `Bearer ${access}` } });
    const data = await readJson(reply, 8 * 1024 * 1024);
    if (reply.status !== 200) throw new Error(`Google Drive could not list the files (HTTP ${reply.status}: ${clean(data.error?.message)}).`);
    const files = Array.isArray(data.files) ? data.files : [];
    out.push(...files);
    const next = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!next || (!files.length && next === pageToken) || out.length >= 5000) break;
    pageToken = next;
  }
  return out;
}

/** The time in a copy's name (buh-backup-YYYYMMDD-HHMM…, UTC), in ms. */
function stampOf(name) {
  const m = /^buh-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : NaN;
}

/** The backup copies in the folder, newest first (by the time in their name). */
export async function listDriveCopies(dataDir) {
  const cred = await credentials(dataDir);
  const access = await token(cred);
  // Connect my Google Drive on a new server without BUH_DRIVE_FOLDER: the shop's own folder(s), found
  // by name (drive.file sees only what this OAuth client made, so another app's folder never matches).
  let folders = cred.folderId ? [cred.folderId] : [];
  if (!folders.length) {
    const found = await listAll(access, `name = '${APP_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, 'id');
    folders = found.map((f) => String(f.id)).filter((id) => DRIVE_ID.test(id)).slice(0, 20);
    if (!folders.length) throw new Error(`No “${APP_FOLDER}” folder made by this Google Drive connection was found.`);
  }
  const out = [];
  let files;
  try {
    // Only files the shop marked as its own copies (anyone with access to the folder could put a
    // file with a backup's name there).
    files = await listAll(access, `(${folders.map((f) => `'${f}' in parents`).join(' or ')}) and trashed = false and name contains 'buh-backup-' and appProperties has { key='buhBackup' and value='1' }`, 'id,name,size,md5Checksum,createdTime,appProperties');
  } catch (err) {
    throw new Error(`${err.message}${cred.mode === 'service_account' ? ` Is the folder shared with ${cred.who}?` : ''}`);
  }
  // A name stamped more than a day ahead would be "latest" for good: not a copy the shop made.
  const notAfter = Date.now() + 24 * 3600_000;
  for (const f of files) {
    if (!COPY_NAME.test(f.name) || !DRIVE_ID.test(String(f.id)) || f.appProperties?.buhBackup !== '1' || !(stampOf(f.name) <= notAfter)) continue;
    out.push({ id: String(f.id), name: f.name, size: Number(f.size), md5: String(f.md5Checksum ?? ''), created: String(f.createdTime ?? '') });
  }
  // Newest first: by the time in the name, then (two backups in the same minute) by when Drive got it.
  const cmp = (x, y) => (x < y ? 1 : x > y ? -1 : 0);
  out.sort((a, b) => cmp(a.name, b.name) || cmp(a.created, b.created));
  return { copies: out, access, cred };
}

/**
 * Download one copy ("latest", its file name, or its Drive id) into `dest` (a new file), checked
 * against Drive's size and MD5. Leaves `minFree` bytes of disk on top of the backup, or refuses.
 * @param {string} spec
 * @param {string} dest
 * @param {{ dataDir?: string, minFree?: number }} [opts]
 */
export async function downloadFromDrive(spec, dest, { dataDir = '', minFree = 256 * 1024 * 1024 } = {}) {
  const { copies, access } = await listDriveCopies(dataDir);
  if (!copies.length) throw new Error('There are no backup copies in that Google Drive folder.');
  const pickCopy = spec === 'latest' ? copies[0] : copies.find((c) => c.name === spec || c.id === spec);
  if (!pickCopy) throw new Error(`No copy called ${clean(spec)} in the Google Drive folder. The newest is ${copies[0].name}.`);
  try {
    const st = fs.statfsSync(path.dirname(dest));
    if (Number(st.bavail) * Number(st.bsize) < pickCopy.size * 2 + minFree) throw new Error('Not enough free disk space to download and restore this backup: free some space and try again.');
  } catch (err) {
    if (/free disk/.test(String(err?.message))) throw err;
  }
  const reply = await open(`${FILES_URL}/${pickCopy.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${access}` }, timeoutMs: 120_000 });
  if (reply.status !== 200) {
    const data = await readJson(reply).catch(() => ({}));
    throw new Error(`Google Drive could not send ${pickCopy.name} (HTTP ${reply.status}: ${clean(data.error?.message)}).`);
  }
  const hash = crypto.createHash('md5');
  let size = 0;
  const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 });
  // A write that fails (the file already there, a full disk) ends the download with that error.
  let writeError = null;
  out.on('error', (err) => {
    writeError = err;
    reply.res.destroy(err);
  });
  const drained = () =>
    new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      out.once('error', onError);
      out.once('drain', () => {
        out.off('error', onError);
        resolve();
      });
    });
  try {
    for await (const c of reply.res) {
      if (writeError) throw writeError;
      size += c.length;
      if (size > pickCopy.size) throw new Error(`${pickCopy.name} from Google Drive is larger than Drive says.`);
      hash.update(c);
      if (!out.write(c)) await drained();
    }
    if (writeError) throw writeError;
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : writeError ? reject(writeError) : resolve())));
  } catch (err) {
    reply.res.destroy();
    out.destroy();
    // Only a file this download made (never one that was there already).
    if (writeError?.code !== 'EEXIST') fs.rmSync(dest, { force: true });
    throw err;
  }
  if (size !== pickCopy.size || (pickCopy.md5 && hash.digest('hex') !== pickCopy.md5)) {
    fs.rmSync(dest, { force: true });
    throw new Error(`${pickCopy.name} from Google Drive does not match its size or checksum: download it again.`);
  }
  return pickCopy;
}
