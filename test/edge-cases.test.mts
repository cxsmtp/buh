import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const { assertSameOrigin, readJsonBody, str } = await import('@/lib/server/http');
const { rateLimit, _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { normalizePhoneNumber, validatePhone } = await import('@/lib/otpService');

const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

test('streamed (chunked) bodies with no Content-Length are still capped', async () => {
  const big = new ReadableStream({
    start(c) {
      for (let i = 0; i < 50; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      c.close();
    },
  });
  const req = new Request('http://shop.test/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big, duplex: 'half' } as RequestInit);
  await assert.rejects(readJsonBody(req, 4096), (e: { status?: number }) => e.status === 413);
});

test('a lying Content-Length cannot sneak a big body through', async () => {
  const req = new Request('http://shop.test/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '10' },
    body: JSON.stringify({ a: 'x'.repeat(10_000) }),
  });
  await assert.rejects(readJsonBody(req, 1024), (e: { status?: number }) => e.status === 413);
});

test('regression: X-Forwarded-Host is never trusted for the same-site check, even behind a proxy', () => {
  const req = (h: Record<string, string>) => new Request('http://shop.test/', { method: 'POST', headers: { host: 'shop.test', ...h } });
  const spoofed = { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' };
  delete process.env.TRUST_PROXY;
  assert.equal(statusOf(() => assertSameOrigin(req(spoofed))), 403);
  process.env.TRUST_PROXY = '1';
  assert.equal(statusOf(() => assertSameOrigin(req(spoofed))), 403);
  delete process.env.TRUST_PROXY;
  process.env.NEXT_PUBLIC_APP_URL = 'https://beautifuluaehome.ae';
  assert.equal(statusOf(() => assertSameOrigin(req({ origin: 'https://beautifuluaehome.ae' }))), 0, 'the public URL is accepted');
  delete process.env.NEXT_PUBLIC_APP_URL;
});

test('a lookalike origin (same host as a prefix or suffix) is refused', () => {
  const req = (origin: string) => new Request('http://shop.test/', { method: 'POST', headers: { host: 'shop.test', origin } });
  assert.equal(statusOf(() => assertSameOrigin(req('http://shop.test.evil.example'))), 403);
  assert.equal(statusOf(() => assertSameOrigin(req('http://evilshop.test'))), 403);
  assert.equal(statusOf(() => assertSameOrigin(req('not a url'))), 403);
});

test('text fields: required, type and length are enforced; passwords keep their spaces', () => {
  assert.equal(statusOf(() => str(undefined, 'Name', 10)), 400);
  assert.equal(statusOf(() => str(42, 'Name', 10)), 400);
  assert.equal(statusOf(() => str('x'.repeat(11), 'Name', 10)), 400);
  assert.equal(str('  a  ', 'Name', 10), 'a');
  assert.equal(str('  a  ', 'Password', 10, { trim: false }), '  a  ');
  assert.equal(str(undefined, 'Optional', 10, { required: false }), '');
});

test('rate limiter memory stays bounded under a flood of distinct keys', () => {
  _clearAllRateLimits();
  for (let i = 0; i < 60_000; i++) rateLimit(`flood:${i}`, 1, 60_000);
  // The oldest keys were evicted, so the very first one is allowed again.
  assert.equal(rateLimit('flood:0', 1, 60_000).ok, true);
  _clearAllRateLimits();
});

test('every way of writing the same UAE number shares one rate-limit key', () => {
  const forms = ['0501234567', '050 123 4567', '050-123-4567', '+971 50 123 4567', '00971501234567', '971501234567', '501234567', '+971(50)1234567'];
  assert.deepEqual(new Set(forms.map(normalizePhoneNumber)), new Set(['+971501234567']));
  for (const f of forms) assert.equal(validatePhone(f), '+971501234567', f);
});

test('the country allow-list can be widened by the owner', () => {
  process.env.OTP_ALLOWED_PREFIXES = '+971,+968';
  assert.equal(validatePhone('+968 9123 4567'), '+96891234567');
  delete process.env.OTP_ALLOWED_PREFIXES;
  assert.throws(() => validatePhone('+968 9123 4567'));
});
