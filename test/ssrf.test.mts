import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertPublicHttpsUrl, isPrivateAddress, safeFetch } from '@/lib/server/outbound';

test('regression: IPv6 spellings of internal addresses are blocked', () => {
  for (const ip of [
    '::ffff:7f00:1', // ::ffff:127.0.0.1 as the URL parser writes it
    '::ffff:a9fe:a9fe', // 169.254.169.254 (cloud metadata)
    '::ffff:127.0.0.1',
    '::7f00:1', // IPv4-compatible
    '::ffff:0:7f00:1', // IPv4-translated
    '2002:7f00:1::', // 6to4 wrapping 127.0.0.1
    '100::1', // discard prefix
    '64:ff9b::7f00:1', // NAT64
    '2001::1', // Teredo
    '2001:db8::1',
    'fd12:3456::1',
    'fe80::1%eth0',
    'ff02::1',
    '::',
    '::1',
    'not-an-ip',
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test('regression: URLs using those spellings are refused before any request', async () => {
  for (const url of ['https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[::7f00:1]/', 'https://[2002:7f00:1::]/', 'https://[100::1]/', 'https://2130706433/', 'https://0x7f.1/', 'https://0177.0.0.1/']) {
    await assert.rejects(assertPublicHttpsUrl(url), url);
  }
});

test('safeFetch refuses internal targets even when given directly or by name', async () => {
  await assert.rejects(safeFetch('https://127.0.0.1/'), (e: { code?: string }) => e.code === 'EBLOCKED');
  await assert.rejects(safeFetch('https://[::1]/'), (e: { code?: string }) => e.code === 'EBLOCKED');
  // "localhost" resolves to loopback: the connection's own lookup refuses it (no rebinding window).
  await assert.rejects(safeFetch('https://localhost:9/'), (e: { code?: string }) => e.code === 'EBLOCKED');
  await assert.rejects(safeFetch('http://8.8.8.8/'), /Only https/);
});
