/**
 * The second backup place (asked by the owner: Google Drive drops its connection): an
 * S3-compatible bucket (Amazon S3, Backblaze B2, Cloudflare R2). Requests signed with AWS
 * Signature Version 4 (checked against Amazon's published example); settings allow-listed and
 * checked; the secret never leaves the server (only "saved" and its last 4); only encrypted backups
 * go, and only with a backup password; each backup is copied after it is taken (big ones in parts);
 * the newest N are kept; a refusal is recorded in plain words; "Test" writes and removes a file.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
process.env.BACKUP_PASSPHRASE = 'a-long-backup-passphrase-for-tests';
const s3 = await import('@/lib/server/s3Backup');
const backup = await import('@/lib/server/backup');

const KEY_ID = 'AKIATESTKEY0000001';
const SECRET = 'TestSecretAccessKey0123456789abcdefWXYZ';

// A stand-in bucket: stores objects, does multipart uploads and listings, refuses a wrong key.
const objects = new Map<string, Buffer>();
const uploads = new Map<string, Map<number, Buffer>>();
const seen: Array<{ method: string; url: string; auth: string }> = [];
let refuse = false;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, 'http://x');
    const auth = String(req.headers.authorization ?? '');
    seen.push({ method: req.method!, url: req.url!, auth });
    if (refuse || !auth.startsWith(`AWS4-HMAC-SHA256 Credential=${KEY_ID}/`)) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      return res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error>');
    }
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    assert.equal(bucket, 'buh-backups');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
    }
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = `up${uploads.size + 1}`;
      uploads.set(id, new Map());
      res.writeHead(200);
      return res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    const uploadId = url.searchParams.get('uploadId');
    if (req.method === 'PUT' && uploadId) {
      uploads.get(uploadId)!.set(Number(url.searchParams.get('partNumber')), body);
      res.writeHead(200, { etag: `"etag-${url.searchParams.get('partNumber')}"` });
      return res.end();
    }
    if (req.method === 'POST' && uploadId) {
      const parts = uploads.get(uploadId)!;
      objects.set(key, Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((n) => parts.get(n)!)));
      res.writeHead(200);
      return res.end('<CompleteMultipartUploadResult/>');
    }
    if (req.method === 'PUT') {
      objects.set(key, body);
      res.writeHead(200);
      return res.end();
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(400);
    res.end();
  });
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.S3_TEST_API = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
after(() => server.close());

/** A sealed (encrypted) backup file as the shop names them. */
function sealedFile(name: string, size = 2048): string {
  const file = path.join(dir, name);
  const body = Buffer.alloc(size, 7);
  Buffer.from('BUHBK1\n').copy(body, 0);
  fs.writeFileSync(file, body);
  return file;
}

test('the request signing is AWS Signature Version 4: Amazon’s published example gives its signature', () => {
  const auth = s3.signV4({
    method: 'GET',
    canonicalUri: '/test.txt',
    canonicalQuery: '',
    headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    amzDate: '20130524T000000Z',
  });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('the settings: allow-listed and checked; the secret stays on the server (saved, ••••last4 only)', async () => {
  const bad = (body: Record<string, unknown>) => assert.rejects(s3.updateS3Settings(body, 'owner@shop.test'), (e: { status?: number }) => e.status === 400, JSON.stringify(body));
  await bad({ extra: 1 });
  await bad({ endpoint: 'http://' });
  await bad({ endpoint: 'https://s3.example.com/path' });
  await bad({ bucket: 'Bad_Bucket' });
  await bad({ region: 'US EAST' });
  await bad({ keep: 0 });
  await bad({ secretAccessKey: 'short' });
  await bad({ enabled: true });
  // Not a public provider address: refused (its name is checked again each time it is used).
  await bad({ endpoint: 'https://127.0.0.1' });
  await bad({ endpoint: 'https://storage.local' });
  await bad({ endpoint: 'https://s3.example.com:8443' });
  const saved = await s3.updateS3Settings({ endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', bucket: 'buh-backups', prefix: 'shop', keep: 2, accessKeyId: KEY_ID, secretAccessKey: SECRET, enabled: true }, 'owner@shop.test');
  assert.equal(saved.enabled, true);
  assert.equal(saved.secretSet, true);
  assert.equal(saved.secretHint, '••••WXYZ');
  const text = JSON.stringify(s3.s3Status());
  assert.ok(!text.includes(SECRET) && !text.includes(KEY_ID), 'neither key goes to the browser');
  assert.ok(!fs.readFileSync(path.join(dir, 'shop.db')).includes(Buffer.from(SECRET)), 'the secret is not in the database (so not in a backup)');
  // A blank secret keeps the saved one.
  assert.equal((await s3.updateS3Settings({ secretAccessKey: '' }, 'owner@shop.test')).secretSet, true);
});

test('each encrypted backup is copied; big ones in parts; the newest N kept; a plain one never goes', async () => {
  const a = sealedFile('buh-backup-2026-11-05T10-00-00Z.tar.gz.enc');
  await s3.copyBackupToS3(a, 'test');
  assert.deepEqual(objects.get('shop/buh-backup-2026-11-05T10-00-00Z.tar.gz.enc'), fs.readFileSync(a));
  assert.ok(seen.every((r) => r.auth.includes('/us-west-004/s3/aws4_request')));
  // Over 16 MB: a multipart upload, put back together in order.
  const big = sealedFile('buh-backup-2026-11-05T11-00-00Z.tar.gz.enc', s3.S3_PART_BYTES + 1234);
  await s3.copyBackupToS3(big, 'test');
  assert.ok(seen.some((r) => r.method === 'POST' && r.url.includes('uploads')));
  assert.deepEqual(objects.get('shop/buh-backup-2026-11-05T11-00-00Z.tar.gz.enc'), fs.readFileSync(big));
  fs.rmSync(big);
  // Keep 2: the oldest goes.
  await s3.copyBackupToS3(sealedFile('buh-backup-2026-11-05T12-00-00Z.tar.gz.enc'), 'test');
  assert.deepEqual([...objects.keys()].sort(), ['shop/buh-backup-2026-11-05T11-00-00Z.tar.gz.enc', 'shop/buh-backup-2026-11-05T12-00-00Z.tar.gz.enc']);
  assert.equal(s3.s3Status().state.lastFile, 'buh-backup-2026-11-05T12-00-00Z.tar.gz.enc');
  assert.equal(s3.s3Status().state.lastError, undefined);
  // Not encrypted: refused, said so.
  const plain = path.join(dir, 'buh-backup-2026-11-05T13-00-00Z.tar.gz.enc');
  fs.writeFileSync(plain, 'not sealed');
  await s3.copyBackupToS3(plain, 'test');
  assert.match(s3.s3Status().state.lastError ?? '', /not encrypted/);
  assert.equal(objects.has('shop/buh-backup-2026-11-05T13-00-00Z.tar.gz.enc'), false);
});

test('a real backup is copied there by itself after it is taken', async () => {
  await backup.runBackup('manual');
  await s3.waitForS3Copy();
  const name = backup.readBackupState().lastFile!;
  assert.match(name, /\.tar\.gz\.enc$/);
  assert.ok(objects.has(`shop/${name}`), [...objects.keys()].join(', '));
});

test('refused by the provider: recorded in plain words; "Test" says what is wrong, or that it works', async () => {
  refuse = true;
  await s3.copyBackupToS3(sealedFile('buh-backup-2026-11-05T14-00-00Z.tar.gz.enc'), 'test');
  assert.match(s3.s3Status().state.lastError ?? '', /access key ID or secret is wrong/);
  const failed = await s3.testS3();
  assert.equal(failed.ok, false);
  assert.match(failed.message, /access key ID or secret is wrong/);
  refuse = false;
  const ok = await s3.testS3();
  assert.equal(ok.ok, true, ok.message);
  assert.ok(![...objects.keys()].some((k) => k.includes('.buh-test')), 'the test file is removed');
});
