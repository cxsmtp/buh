import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Google's token and device-code endpoints and the Drive v3 API on 127.0.0.1 (the
 * shop and the restore script are pointed at it with BUH_TEST_GOOGLE_API, loopback only).
 *
 * - Service account: checks the JWT the shop signs against the service account's public key; sees
 *   every file (as if each folder were shared with it).
 * - Connect my Google Drive: the device flow (each poll answers with the next entry of
 *   `deviceScript`: pending, slow_down, denied, expired or ok) and refresh tokens (a revoked one
 *   gets invalid_grant). Like drive.file, this account sees only the files it made itself.
 * - Files kept in memory; a resumable upload answered like Drive (308 with a Range until the last
 *   piece; Location on www.googleapis.com). `tamper` misreports a finished upload's size or MD5.
 */

export function makeServiceAccount(email = 'buh-backups@buh-test-123.iam.gserviceaccount.com') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = crypto.randomBytes(20).toString('hex');
  const json = JSON.stringify({
    type: 'service_account',
    project_id: 'buh-test-123',
    private_key_id: keyId,
    private_key: pem,
    client_email: email,
    client_id: '1234567890',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
  return { json, pem, publicKey, email, keyId };
}

/** The OAuth client the owner makes ("TVs and Limited Input devices"). */
export const OAUTH_CLIENT = { id: '123456789012-abcdefghijklmnopqrstuvwxyz012345.apps.googleusercontent.com', secret: 'GOCSPX-mockClientSecret_0123456789' };

export interface DriveFile {
  id: string;
  name: string;
  parents: string[];
  data: Buffer;
  createdTime: string;
  mimeType?: string;
  appProperties?: Record<string, string>;
  /** Who made it: 'sa', 'user' (the OAuth app) or 'owner' (the owner's own files). */
  by: string;
}

/** An answer a test gives instead of the stand-in. */
export type MockAnswer = { status: number; headers?: Record<string, string>; json?: unknown } | undefined;

export type DeviceStep ='pending' | 'slow_down' | 'denied' | 'expired' | 'ok';

export interface GoogleMock {
  url: string;
  files: Map<string, DriveFile>;
  requests: Array<{ at: number; method: string; path: string; headers: http.IncomingHttpHeaders; bodySize: number; form?: Record<string, string> }>;
  /** Byte counts of each upload PUT carrying data. */
  chunks: number[];
  /** Every JWT claims set seen at /token. */
  jwts: Array<{ header: Record<string, unknown>; claims: Record<string, unknown> }>;
  tamper: { size?: boolean; md5?: boolean };
  /** Answer the next upload start with this error (status, reason). */
  failStart: { status: number; reason: string; message: string } | null;
  /** The service account's access token. */
  token: string;
  /** Connect my Google Drive: what the next device-code polls answer, the interval Google asks for, the tokens. */
  deviceScript: DeviceStep[];
  deviceInterval: number;
  deviceExpiresIn: number;
  userCode: string;
  refreshToken: string;
  userToken: string;
  /** The Google account the device flow connects (Drive's about.get answers with it; '' answers 403). */
  userEmail: string;
  revoked: Set<string>;
  /**
   * Called before each request is answered (after its body is read): may wait (to hold a request
   * while a test acts), or answer instead of the stand-in ({ status, headers?, json? }).
   */
  before: ((req: { method: string; path: string; headers: http.IncomingHttpHeaders; bodySize: number; form?: Record<string, string> }) => void | MockAnswer | Promise<void | MockAnswer>) | null;
  /** files.list answers with an empty page and the same nextPageToken, again and again. */
  pageLoop: boolean;
  /** A download sends its first piece, then waits for this before the rest. */
  slowMedia: Promise<void> | null;
  /** Google's clock (each file's createdTime): the real time unless a test sets it. */
  clock: () => number;
  close: () => Promise<void>;
}

export async function startGoogleMock(sa: { publicKey: crypto.KeyObject; email: string }): Promise<GoogleMock> {
  const files = new Map<string, DriveFile>();
  const sessions = new Map<string, { name: string; parents: string[]; total: number; got: Buffer[]; size: number; appProperties?: Record<string, string>; by: string; fields: string }>();
  const devices = new Set<string>();
  const mock = {
    files,
    requests: [],
    chunks: [],
    jwts: [],
    tamper: {},
    failStart: null,
    token: `ya29.mock-${crypto.randomBytes(12).toString('hex')}`,
    deviceScript: [],
    deviceInterval: 5,
    deviceExpiresIn: 1800,
    userCode: 'GQVQ-JKEC',
    refreshToken: `1//0gMockRefresh${crypto.randomBytes(16).toString('base64url')}`,
    userToken: `ya29.mock-user-${crypto.randomBytes(12).toString('hex')}`,
    userEmail: 'shop.owner@gmail.com',
    revoked: new Set<string>(),
    before: null,
    pageLoop: false,
    slowMedia: null,
    clock: () => new Date().getTime(),
  } as unknown as GoogleMock;
  const created = () => new Date(mock.clock()).toISOString();
  const newId = () => `1${crypto.randomBytes(16).toString('base64url')}`;
  const md5 = (b: Buffer) => crypto.createHash('md5').update(b).digest('hex');

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url || '/', 'http://x');
      const isForm = String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
      const form = isForm ? Object.fromEntries(new URLSearchParams(body.toString())) : undefined;
      mock.requests.push({ at: Date.now(), method: req.method || '', path: u.pathname + u.search, headers: req.headers, bodySize: body.length, form });
      const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers });
        res.end(data !== undefined ? JSON.stringify(data) : undefined);
      };
      if (mock.before) {
        const instead = await mock.before({ method: req.method || '', path: u.pathname + u.search, headers: req.headers, bodySize: body.length, form });
        if (instead) return send(instead.status, instead.json, instead.headers);
      }
      if (u.pathname === '/revoke' && req.method === 'POST') {
        if (!form?.token) return send(400, { error: 'invalid_request' });
        mock.revoked.add(form.token);
        return send(200, {});
      }
      const err = (status: number, reason: string, message: string) => send(status, { error: { code: status, message, errors: [{ reason, message }] } });

      if (u.pathname === '/device/code' && req.method === 'POST') {
        if (form?.client_id !== OAUTH_CLIENT.id) return send(401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
        if (form?.scope !== 'https://www.googleapis.com/auth/drive.file') return send(400, { error: 'invalid_scope' });
        const deviceCode = `4/mock-device-${crypto.randomBytes(8).toString('hex')}`;
        devices.add(deviceCode);
        return send(200, { device_code: deviceCode, user_code: mock.userCode, verification_url: 'https://www.google.com/device', expires_in: mock.deviceExpiresIn, interval: mock.deviceInterval });
      }
      if (u.pathname === '/token' && req.method === 'POST') {
        const grant = form?.grant_type;
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (form?.client_id !== OAUTH_CLIENT.id || form?.client_secret !== OAUTH_CLIENT.secret) return send(401, { error: 'invalid_client' });
          if (!devices.has(String(form?.device_code))) return send(400, { error: 'invalid_grant' });
          const step = mock.deviceScript.shift() ?? 'pending';
          if (step === 'pending') return send(428, { error: 'authorization_pending', error_description: 'Precondition Required' });
          if (step === 'slow_down') return send(403, { error: 'slow_down', error_description: 'Forbidden' });
          if (step === 'denied') return send(403, { error: 'access_denied', error_description: 'Forbidden' });
          if (step === 'expired') return send(400, { error: 'expired_token', error_description: 'Bad Request' });
          devices.delete(String(form?.device_code));
          return send(200, { access_token: mock.userToken, expires_in: 3599, refresh_token: mock.refreshToken, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' });
        }
        if (grant === 'refresh_token') {
          if (form?.client_id !== OAUTH_CLIENT.id || form?.client_secret !== OAUTH_CLIENT.secret) return send(401, { error: 'invalid_client' });
          if (form?.refresh_token !== mock.refreshToken || mock.revoked.has(form.refresh_token)) return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
          return send(200, { access_token: mock.userToken, expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' });
        }
        if (grant !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return send(400, { error: 'unsupported_grant_type' });
        const [h, c, s] = String(form?.assertion).split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), sa.publicKey, Buffer.from(s ?? '', 'base64url'));
        if (!ok) return send(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        const header = JSON.parse(Buffer.from(h, 'base64url').toString());
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        mock.jwts.push({ header, claims });
        if (claims.iss !== sa.email || claims.aud !== 'https://oauth2.googleapis.com/token') return send(400, { error: 'invalid_grant', error_description: 'Invalid issuer or audience.' });
        return send(200, { access_token: mock.token, expires_in: 3599, token_type: 'Bearer' });
      }

      const isUploadPut = u.pathname === '/upload/drive/v3/files' && req.method === 'PUT';
      const who = req.headers.authorization === `Bearer ${mock.token}` ? 'sa' : req.headers.authorization === `Bearer ${mock.userToken}` ? 'user' : '';
      if (!who && !isUploadPut) return err(401, 'authError', 'Invalid Credentials');
      // drive.file: the OAuth app sees only what it made.
      const sees = (f: DriveFile | undefined) => Boolean(f && (who === 'sa' || f.by === who));
      const parentOk = (parents: string[]) => parents.every((p) => who === 'sa' || sees(files.get(p)));

      if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        if (mock.failStart) {
          const f = mock.failStart;
          mock.failStart = null;
          return err(f.status, f.reason, f.message);
        }
        if (u.searchParams.get('uploadType') !== 'resumable' || u.searchParams.get('supportsAllDrives') !== 'true') return err(400, 'badRequest', 'resumable + supportsAllDrives expected');
        const meta = JSON.parse(body.toString() || '{}');
        if (!parentOk(meta.parents ?? [])) return err(404, 'notFound', `File not found: ${meta.parents?.[0]}.`);
        const id = crypto.randomBytes(8).toString('hex');
        sessions.set(id, { name: meta.name, parents: meta.parents ?? [], total: Number(req.headers['x-upload-content-length']), got: [], size: 0, appProperties: meta.appProperties, by: who, fields: u.searchParams.get('fields') || 'id,name' });
        return send(200, undefined, { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` });
      }
      if (isUploadPut) {
        const s = sessions.get(u.searchParams.get('upload_id') || '');
        if (!s) return err(404, 'notFound', 'No such upload');
        const range = String(req.headers['content-range'] || '');
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
        if (m) {
          if (Number(m[1]) !== s.size || Number(m[2]) - Number(m[1]) + 1 !== body.length) return err(400, 'badRange', `bad range ${range} at ${s.size}`);
          s.got.push(body);
          s.size += body.length;
          mock.chunks.push(body.length);
        } else if (!/^bytes \*\/\d+$/.test(range)) return err(400, 'badRange', range);
        if (s.size < s.total) return send(308, undefined, s.size ? { range: `bytes=0-${s.size - 1}` } : {});
        const id = newId();
        const data = Buffer.concat(s.got);
        const createdTime = created();
        files.set(id, { id, name: s.name, parents: s.parents, data, createdTime, appProperties: s.appProperties, by: s.by });
        // Only the fields asked for (fields=…), as Drive answers.
        const all: Record<string, string> = { id, name: s.name, size: String(mock.tamper.size ? data.length + 1 : data.length), md5Checksum: mock.tamper.md5 ? '0'.repeat(32) : md5(data), createdTime };
        const asked = s.fields.split(',');
        return send(200, Object.fromEntries(Object.entries(all).filter(([k]) => asked.includes(k))));
      }
      // about.get (drive.file allows it): who is connected.
      if (u.pathname === '/drive/v3/about' && req.method === 'GET') {
        if (who !== 'user' || !mock.userEmail) return err(403, 'insufficientPermissions', 'Insufficient Permission');
        return send(200, { user: { emailAddress: mock.userEmail, displayName: 'Shop Owner' } });
      }
      // Create a folder (metadata only).
      if (u.pathname === '/drive/v3/files' && req.method === 'POST') {
        const meta = JSON.parse(body.toString() || '{}');
        if (!parentOk(meta.parents ?? [])) return err(404, 'notFound', 'File not found.');
        const id = newId();
        files.set(id, { id, name: meta.name, parents: meta.parents ?? ['root'], data: Buffer.alloc(0), createdTime: created(), mimeType: meta.mimeType, appProperties: meta.appProperties, by: who });
        return send(200, { id });
      }
      const one = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
      if (one && req.method === 'DELETE') {
        const f = files.get(one[1]);
        if (!sees(f)) return err(404, 'notFound', 'File not found');
        files.delete(one[1]);
        return send(204);
      }
      if (one && req.method === 'GET') {
        const f = files.get(one[1]);
        if (!sees(f)) return err(404, 'notFound', 'File not found');
        if (u.searchParams.get('alt') !== 'media') return send(200, { id: f!.id, name: f!.name, mimeType: f!.mimeType ?? 'application/octet-stream', trashed: false });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(f!.data.length) });
        // In pieces, like a real download.
        for (let i = 0; i < f!.data.length; i += 64 * 1024) {
          res.write(f!.data.subarray(i, i + 64 * 1024));
          if (i === 0 && mock.slowMedia) await mock.slowMedia;
        }
        return res.end();
      }
      if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
        if (mock.pageLoop) return send(200, { files: [], nextPageToken: 'same-page-again' });
        const q = u.searchParams.get('q') || '';
        const marked = /appProperties has \{ key='buhBackup' and value='1' \}/.test(q);
        const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]);
        const byName = /name = '([^']+)'/.exec(q)?.[1];
        const folderOnly = /mimeType = 'application\/vnd\.google-apps\.folder'/.test(q);
        const list = [...files.values()]
          .filter(sees)
          .filter((f) => (!parents.length || f.parents.some((p) => parents.includes(p))) && (!byName || f.name === byName) && (!folderOnly || f.mimeType === 'application/vnd.google-apps.folder') && (!/name contains 'buh-backup-'/.test(q) || f.name.includes('buh-backup-')) && (!marked || f.appProperties?.buhBackup === '1'))
          .map((f) => ({ id: f.id, name: f.name, size: String(f.data.length), md5Checksum: md5(f.data), createdTime: f.createdTime, mimeType: f.mimeType, ...(f.appProperties ? { appProperties: f.appProperties } : {}) }));
        return send(200, { files: list });
      }
      return err(404, 'notFound', `no route ${req.method} ${u.pathname}`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  mock.close = () => new Promise((r) => server.close(() => r()));
  return mock;
}

/** Put a file in the mock folder as someone else would (the owner's own files). */
export function addForeignFile(mock: GoogleMock, folderId: string, name: string, data = Buffer.from('not ours'), mimeType?: string, extra: { appProperties?: Record<string, string>; by?: string } = {}): string {
  const id = `1${crypto.randomBytes(16).toString('base64url')}`;
  mock.files.set(id, { id, name, parents: [folderId], data, createdTime: new Date().toISOString(), mimeType, by: extra.by ?? 'owner', appProperties: extra.appProperties });
  return id;
}
