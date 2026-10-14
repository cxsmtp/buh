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

test('regression: typing the country code shows no warning or foreign-number panel yet', () => {
  for (const partial of ['+', '+9', '+97', '+971', '00', '009', '0097', '00971', '9', '97', '971', '0', '+971 0']) {
    assert.equal(classifyPhone(partial).kind, 'uae-partial', partial);
  }
  assert.equal(classifyPhone('+44').kind, 'international');
  assert.equal(classifyPhone('+1 ').kind, 'international');
});

test('regression: Arabic-Indic and Persian digits are understood', () => {
  assert.equal(classifyPhone('٠٥٠١٢٣٤٥٦٧').e164, '+971501234567');
  assert.equal(classifyPhone('+٩٧١ ٥٠ ١٢٣ ٤٥٦٧').e164, '+971501234567');
  assert.equal(classifyPhone('۰۵۵۱۲۳۴۵۶۷').e164, '+971551234567');
});
