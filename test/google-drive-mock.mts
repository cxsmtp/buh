import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Google's token endpoint and the Drive v3 API on 127.0.0.1 (the shop and the
 * restore script are pointed at it with BUH_TEST_GOOGLE_API, loopback only). It checks the JWT the
 * shop signs against the service account's public key, keeps files in memory, answers a resumable
 * upload like Drive (308 with a Range until the last piece; Location on www.googleapis.com), and
 * records every request. `tamper` makes it misreport a finished upload's size or MD5.
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

export interface DriveFile {
  id: string;
  name: string;
  parents: string[];
  data: Buffer;
  createdTime: string;
  appProperties?: Record<string, string>;
}

export interface GoogleMock {
  url: string;
  files: Map<string, DriveFile>;
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; bodySize: number }>;
  /** Byte counts of each upload PUT carrying data. */
  chunks: number[];
  /** Every JWT claims set seen at /token. */
  jwts: Array<{ header: Record<string, unknown>; claims: Record<string, unknown> }>;
  tamper: { size?: boolean; md5?: boolean };
  /** Answer the next upload start with this error (status, reason). */
  failStart: { status: number; reason: string; message: string } | null;
  token: string;
  close: () => Promise<void>;
}

export async function startGoogleMock(sa: { publicKey: crypto.KeyObject; email: string }): Promise<GoogleMock> {
  const files = new Map<string, DriveFile>();
  const sessions = new Map<string, { name: string; parents: string[]; total: number; got: Buffer[]; size: number; appProperties?: Record<string, string> }>();
  const mock = { files, requests: [], chunks: [], jwts: [], tamper: {}, failStart: null, token: `ya29.mock-${crypto.randomBytes(12).toString('hex')}` } as unknown as GoogleMock;
  const newId = () => `1${crypto.randomBytes(16).toString('base64url')}`;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url || '/', 'http://x');
      mock.requests.push({ method: req.method || '', path: u.pathname + u.search, headers: req.headers, bodySize: body.length });
      const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...headers });
        res.end(data !== undefined ? JSON.stringify(data) : undefined);
      };
      const err = (status: number, reason: string, message: string) => send(status, { error: { code: status, message, errors: [{ reason, message }] } });

      if (u.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(body.toString());
        if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return send(400, { error: 'unsupported_grant_type' });
        const [h, c, s] = String(form.get('assertion')).split('.');
        const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), sa.publicKey, Buffer.from(s ?? '', 'base64url'));
        if (!ok) return send(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        const header = JSON.parse(Buffer.from(h, 'base64url').toString());
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        mock.jwts.push({ header, claims });
        if (claims.iss !== sa.email || claims.aud !== 'https://oauth2.googleapis.com/token') return send(400, { error: 'invalid_grant', error_description: 'Invalid issuer or audience.' });
        return send(200, { access_token: mock.token, expires_in: 3599, token_type: 'Bearer' });
      }
      if (req.headers.authorization !== `Bearer ${mock.token}` && !(u.pathname === '/upload/drive/v3/files' && req.method === 'PUT')) return err(401, 'authError', 'Invalid Credentials');

      if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        if (mock.failStart) {
          const f = mock.failStart;
          mock.failStart = null;
          return err(f.status, f.reason, f.message);
        }
        if (u.searchParams.get('uploadType') !== 'resumable' || u.searchParams.get('supportsAllDrives') !== 'true') return err(400, 'badRequest', 'resumable + supportsAllDrives expected');
        const meta = JSON.parse(body.toString() || '{}');
        const id = crypto.randomBytes(8).toString('hex');
        sessions.set(id, { name: meta.name, parents: meta.parents ?? [], total: Number(req.headers['x-upload-content-length']), got: [], size: 0, appProperties: meta.appProperties });
        return send(200, undefined, { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` });
      }
      if (u.pathname === '/upload/drive/v3/files' && req.method === 'PUT') {
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
        files.set(id, { id, name: s.name, parents: s.parents, data, createdTime: new Date().toISOString(), appProperties: s.appProperties });
        const md5 = crypto.createHash('md5').update(data).digest('hex');
        return send(200, { id, name: s.name, size: String(mock.tamper.size ? data.length + 1 : data.length), md5Checksum: mock.tamper.md5 ? '0'.repeat(32) : md5 });
      }
      const one = /^\/drive\/v3\/files\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
      if (one && req.method === 'DELETE') {
        if (!files.delete(one[1])) return err(404, 'notFound', 'File not found');
        return send(204);
      }
      if (one && req.method === 'GET' && u.searchParams.get('alt') === 'media') {
        const f = files.get(one[1]);
        if (!f) return err(404, 'notFound', 'File not found');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(f.data.length) });
        // In pieces, like a real download.
        for (let i = 0; i < f.data.length; i += 64 * 1024) res.write(f.data.subarray(i, i + 64 * 1024));
        return res.end();
      }
      if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
        const q = u.searchParams.get('q') || '';
        const folder = /'([^']+)' in parents/.exec(q)?.[1] ?? '';
        const list = [...files.values()]
          .filter((f) => f.parents.includes(folder) && (!/name contains 'buh-backup-'/.test(q) || f.name.includes('buh-backup-')))
          .map((f) => ({ id: f.id, name: f.name, size: String(f.data.length), md5Checksum: crypto.createHash('md5').update(f.data).digest('hex'), createdTime: f.createdTime }));
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
export function addForeignFile(mock: GoogleMock, folderId: string, name: string, data = Buffer.from('not ours')): string {
  const id = `1${crypto.randomBytes(16).toString('base64url')}`;
  mock.files.set(id, { id, name, parents: [folderId], data, createdTime: new Date().toISOString() });
  return id;
}
