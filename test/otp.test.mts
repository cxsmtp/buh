import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
const otp = await import('@/lib/otpService');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e) => (typeof e?.status === "number" ? e.status : -1));
const env = process.env as Record<string, string | undefined>;

test('phone validation: UAE only by default, junk refused', () => {
  assert.equal(otp.validatePhone('050 123 4567'), '+971501234567');
  assert.equal(otp.validatePhone('00971501234567'), '+971501234567');
  assert.throws(() => otp.validatePhone('+44 7700 900123'));
  assert.throws(() => otp.validatePhone('12'));
  assert.throws(() => otp.validatePhone({} as unknown as string));
});

test('codes are 6 digits, single use, and limited to 5 guesses', async () => {
  _clearAllRateLimits();
  otp._clearOtpStore();
  const sent = await otp.sendRealSmsOtp('+971501111111', { gateways: {}, ip: 'a' });
  assert.match(sent.devOtpCode!, /^\d{6}$/);
  assert.equal(otp.verifyRealSmsOtp('+971501111111', '000000x').valid, false);
  assert.equal(otp.verifyRealSmsOtp('0501111111', sent.devOtpCode!).valid, true);
  assert.equal(otp.verifyRealSmsOtp('+971501111111', sent.devOtpCode!).valid, false, 'single use');

  _clearAllRateLimits();
  const again = await otp.sendRealSmsOtp('+971501111111', { gateways: {}, ip: 'a' });
  const wrong = again.devOtpCode === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal(otp.verifyRealSmsOtp('+971501111111', wrong).valid, false);
  assert.equal(otp.verifyRealSmsOtp('+971501111111', again.devOtpCode!).valid, false, 'burned after 5 guesses');
});

test('send limits: 30 s per phone, 10 per hour per IP', async () => {
  _clearAllRateLimits();
  await otp.sendRealSmsOtp('+971502222222', { gateways: {}, ip: 'b' });
  assert.equal(await statusOf(otp.sendRealSmsOtp('+971502222222', { gateways: {}, ip: 'b' })), 429);

  _clearAllRateLimits();
  for (let i = 0; i < 10; i++) await otp.sendRealSmsOtp(`+97150300000${i}`, { gateways: {}, ip: 'c' });
  assert.equal(await statusOf(otp.sendRealSmsOtp('+971503000099', { gateways: {}, ip: 'c' })), 429);
});

test('production never hands the code to the browser', async () => {
  _clearAllRateLimits();
  const before = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    const res = await otp.sendRealSmsOtp('+971504444444', { gateways: {}, ip: 'd' });
    assert.equal(res.success, false);
    assert.equal(res.devOtpCode, undefined);
  } finally {
    env.NODE_ENV = before;
  }
});

test('admin-entered gateway URLs pointing inside the network are refused', async () => {
  await assert.rejects(otp.gatewaysFromSettings({ customWebhook: { endpointUrl: 'https://169.254.169.254/latest' } }));
  await assert.rejects(otp.gatewaysFromSettings({ infobip: { apiKey: 'k', baseUrl: 'http://10.0.0.5', fromSender: 'x' } }));
});

test('regression: an unknown client IP does not share one OTP limit across all shoppers', async () => {
  _clearAllRateLimits();
  for (let i = 0; i < 15; i++) {
    const res = await otp.sendRealSmsOtp(`+9715550001${String(i).padStart(2, '0')}`, { gateways: {}, ip: null });
    assert.equal(res.success, true, `shopper ${i}`);
  }
});
