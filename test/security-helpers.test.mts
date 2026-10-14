import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSameOrigin, clientIp, readJsonBody } from '@/lib/server/http';
import { _clearAllRateLimits, rateLimit } from '@/lib/server/rateLimit';
import { assertPublicHttpsUrl, isPrivateAddress } from '@/lib/server/outbound';
import { redact } from '@/lib/server/log';
import { parseImageDataUrl } from '@/lib/server/imageInput';
import { jsonRequest } from './helpers.mjs';

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : -1;
  }
  return 0;
};

test('CSRF: same-origin passes, foreign / null origins and cross-site fetches are refused', () => {
  assert.equal(status(() => assertSameOrigin(jsonRequest({}, { origin: 'http://shop.test' }))), 0);
  assert.equal(status(() => assertSameOrigin(jsonRequest({}, { origin: 'https://evil.example' }))), 403);
  assert.equal(status(() => assertSameOrigin(jsonRequest({}, { origin: 'null' }))), 403);
  assert.equal(status(() => assertSameOrigin(jsonRequest({}, { referer: 'https://evil.example/page' }))), 403);
  assert.equal(status(() => assertSameOrigin(jsonRequest({}, { referer: 'http://shop.test/checkout' }))), 0);
  assert.equal(status(() => assertSameOrigin(jsonRequest({}, { 'sec-fetch-site': 'cross-site' }))), 403);
  // No Origin/Referer at all (curl, server-to-server): no ambient cookies, allowed.
  assert.equal(status(() => assertSameOrigin(jsonRequest({}))), 0);
});

test('client IP ignores forwarded headers unless TRUST_PROXY=1', () => {
  const req = jsonRequest({}, { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' });
  delete process.env.TRUST_PROXY;
  assert.equal(clientIp(req), null, 'unknown, so per-IP limits are skipped instead of shared');
  process.env.TRUST_PROXY = '1';
  assert.equal(clientIp(req), '5.6.7.8');
  delete process.env.TRUST_PROXY;
});

test('JSON bodies: wrong type, oversized, malformed and non-object bodies are refused', async () => {
  const code = async (req: Request, max?: number) =>
    readJsonBody(req, max).then(() => 0, (e) => (typeof e?.status === "number" ? e.status : -1));
  assert.equal(await code(jsonRequest({ a: 1 })), 0);
  assert.equal(await code(jsonRequest({ a: 'x'.repeat(100) }), 50), 413);
  assert.equal(await code(jsonRequest('{oops')), 400);
  assert.equal(await code(jsonRequest('[1,2]')), 400);
  assert.equal(await code(jsonRequest({}, { 'content-type': 'text/plain' })), 415);
});

test('rate limiter: sliding window, then recovers', () => {
  _clearAllRateLimits();
  const t0 = 1_000_000;
  assert.ok(rateLimit('k', 2, 1000, t0).ok);
  assert.ok(rateLimit('k', 2, 1000, t0 + 10).ok);
  const blocked = rateLimit('k', 2, 1000, t0 + 20);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.ok(rateLimit('k', 2, 1000, t0 + 1001).ok);
});

test('SSRF guard: private, loopback, metadata and mapped addresses are blocked', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);

  const refused = async (url: string) => assertPublicHttpsUrl(url).then(() => false, () => true);
  assert.ok(await refused('http://8.8.8.8/hook'));
  assert.ok(await refused('https://169.254.169.254/latest/meta-data'));
  assert.ok(await refused('https://user:pw@8.8.8.8/'));
  assert.ok(await refused('https://localhost/hook'));
  assert.ok(await refused('https://8.8.8.8:8443/'));
  assert.ok(await refused('https://[::1]/'));
  assert.equal(await refused('https://8.8.8.8/hook'), false);
});

test('log redaction hides secrets, phone numbers and emails', () => {
  const out = JSON.stringify(redact({ authToken: 'abc', nested: { apiKey: 'k' }, note: 'call +971 50 123 4567 or a.person@example.com' }));
  assert.ok(!out.includes('abc') && !out.includes('"k"'));
  assert.ok(!out.includes('123 4567'));
  assert.ok(!out.includes('a.person@'));
});

test('image uploads: only real png/jpeg/webp under the cap', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  assert.equal(status(() => parseImageDataUrl(`data:image/png;base64,${png.toString('base64')}`)), 0);
  assert.equal(status(() => parseImageDataUrl(`data:image/jpeg;base64,${png.toString('base64')}`)), 400);
  assert.equal(status(() => parseImageDataUrl(`data:image/svg+xml;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`)), 400);
  assert.equal(status(() => parseImageDataUrl(`data:image/png;base64,${png.toString('base64')}`, 4)), 413);
});
