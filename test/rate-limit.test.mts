import assert from 'node:assert/strict';
import { test } from 'node:test';
import { _clearAllRateLimits, rateLimit, takeAll } from '@/lib/server/rateLimit';

test('regression: a request refused by one limit uses up none of the others', () => {
  _clearAllRateLimits();
  const rules = (ip: string) => [
    { key: `ip:${ip}`, max: 1, windowMs: 60_000 },
    { key: 'global:cap', max: 3, windowMs: 60_000 },
  ];
  assert.equal(takeAll(rules('spammer')), null);
  for (let i = 0; i < 100; i++) assert.equal(takeAll(rules('spammer'))?.rule.key, 'ip:spammer');
  // The 100 refused requests did not touch the shop-wide cap: 2 of 3 are left.
  assert.equal(takeAll(rules('customer-1')), null);
  assert.equal(takeAll(rules('customer-2')), null);
  assert.equal(takeAll(rules('customer-3'))?.rule.key, 'global:cap');
});

test('regression: a flood of new keys cannot evict (and so reset) a shop-wide counter', () => {
  _clearAllRateLimits();
  assert.ok(rateLimit('global:otp-test', 1, 60_000).ok);
  for (let i = 0; i < 60_000; i++) rateLimit(`junk:${i}`, 1, 60_000);
  assert.equal(rateLimit('global:otp-test', 1, 60_000).ok, false, 'still counted');
  _clearAllRateLimits();
});
