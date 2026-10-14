import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPhone } from '@/components/store/PhoneVerification';

test('checkout phone classifier: UAE forms accepted, international routed to email', () => {
  for (const raw of ['50 123 4567', '050-123-4567', '+971 50 123 4567', '00971501234567', '971501234567', '+971 058 123 4567']) {
    const r = classifyPhone(raw);
    assert.equal(r.kind, 'uae', raw);
  }
  assert.equal(classifyPhone('0501234567').e164, '+971501234567');
  assert.equal(classifyPhone('+44 7700 900123').kind, 'international');
  assert.equal(classifyPhone('0044 7700 900123').kind, 'international');
  assert.equal(classifyPhone('50 12').kind, 'uae-partial');
  assert.equal(classifyPhone('04 123 4567').kind, 'invalid', 'landline');
  assert.equal(classifyPhone('51 123 4567').kind, 'invalid', 'no such mobile prefix');
  assert.equal(classifyPhone('').kind, 'empty');
});
