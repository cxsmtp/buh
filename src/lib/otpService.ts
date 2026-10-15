import crypto from 'node:crypto';
import { SmsGatewaySettings } from '@/types';
import { HttpError } from '@/lib/server/http';
import { logEvent, maskPhone } from '@/lib/server/log';
import { assertPublicHttpsUrl, safeFetch } from '@/lib/server/outbound';
import { takeAll, type LimitRule } from '@/lib/server/rateLimit';
import { audit } from '@/lib/server/audit';
import { contactEmail as supportEmail } from '@/lib/server/settings';

/**
 * Phone verification codes.
 *
 * - Codes are 6 digits from crypto.randomInt, valid 10 minutes, single use,
 *   at most 5 guesses each. Only an HMAC of (phone, code) is kept in memory.
 * - Sending is limited per phone (1 per 30 s, 5 per hour), per IP (10 per
 *   hour) and in total (OTP_MAX_PER_HOUR, default 300) so the shop cannot be
 *   used to pump paid SMS, and only to the country prefixes in
 *   OTP_ALLOWED_PREFIXES (default +971).
 * - The public endpoint only ever uses gateways configured in the server
 *   environment. A code is returned to the browser only when no gateway is
 *   configured and this is not production (or OTP_DEV_MODE=true).
 *
 * State is per process: run a single instance (see ecosystem.config.cjs).
 */

export const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_RECORDS = 50_000;

interface StoredOtpRecord {
  hash: string;
  expiresAt: number;
  attempts: number;
}

const otpStore = new Map<string, StoredOtpRecord>();
const otpKey = crypto.randomBytes(32);

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [phone, record] of otpStore) {
    if (now > record.expiresAt) otpStore.delete(phone);
  }
}, 5 * 60 * 1000);
sweeper.unref?.();

function codeHash(phone: string, code: string): string {
  return crypto.createHmac('sha256', otpKey).update(`${phone}\n${code}`).digest('base64url');
}

/**
 * Standardize UAE and international phone numbers into E.164 format
 * Examples:
 *  "050 123 4567" -> "+971501234567"
 *  "+971 50 123 4567" -> "+971501234567"
 *  "501234567" -> "+971501234567"
 */
/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits to 0-9. */
function toAsciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) & 0xf));
}

export function normalizePhoneNumber(rawPhone: string): string {
  let cleaned = toAsciiDigits(rawPhone).replace(/[^\d+]/g, '');

  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2);
  } else if (cleaned.startsWith('05')) {
    cleaned = '+971' + cleaned.slice(1);
  } else if (cleaned.startsWith('5') && cleaned.length === 9) {
    cleaned = '+971' + cleaned;
  } else if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  // "+971 050…" (international prefix plus the domestic trunk 0) is the same
  // number as "+971 50…": fold it, so one number has one rate-limit key.
  return cleaned.replace(/^\+9710/, '+971');
}

// UAE mobile networks: 50, 52, 54, 55, 56, 58. Matches the checkout form.
const UAE_MOBILE = /^\+9715[024568]\d{7}$/;


function allowedPrefixes(): string[] {
  return (process.env.OTP_ALLOWED_PREFIXES || '+971')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Normalise and validate a phone number, or throw a 400 the customer can act on. */
export function validatePhone(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 32) {
    throw new HttpError(400, 'Please provide a valid phone number (e.g. +971 50 123 4567)');
  }
  const phone = normalizePhoneNumber(raw);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new HttpError(400, 'Please provide a valid phone number (e.g. +971 50 123 4567)');
  }
  if (!allowedPrefixes().some((prefix) => phone.startsWith(prefix))) {
    throw new HttpError(400, `Online checkout verifies UAE mobile numbers only. For international orders, please email ${supportEmail()}.`);
  }
  // A UAE number must be a mobile: landlines and short codes cannot receive the SMS.
  if (phone.startsWith('+971') && !UAE_MOBILE.test(phone)) {
    throw new HttpError(400, 'Please enter a UAE mobile number starting with 50, 52, 54, 55, 56 or 58.');
  }
  return phone;
}

export interface SendOtpResult {
  success: boolean;
  message: string;
  provider: string;
  messageId?: string;
  isSimulated: boolean;
  devOtpCode?: string; // only outside production, when no gateway is configured
}

export interface GatewayConfig {
  twilio?: { accountSid: string; authToken: string; fromNumber: string };
  infobip?: { apiKey: string; baseUrl: string; sender: string };
  webhook?: { url: string; bearerToken?: string };
}

/**
 * The gateways live checkout uses: the server environment first, then the SMS
 * settings saved in the admin hub (when switched on). Never from a request.
 */
export async function liveGateways(): Promise<GatewayConfig> {
  const env = envGateways();
  if (env.twilio || env.infobip || env.webhook) return env;
  const { getSettings } = await import('@/lib/server/settings');
  const saved = getSettings('sms');
  if (!saved.isEnabled) return {};
  return gatewaysFromSettings(saved).catch(() => ({}));
}

/** Gateways from the server environment. */
export function envGateways(): GatewayConfig {
  const env = process.env;
  const config: GatewayConfig = {};
  const fromNumber = env.TWILIO_FROM_PHONE || env.TWILIO_PHONE_NUMBER;
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && fromNumber) {
    config.twilio = { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber };
  }
  if (env.INFOBIP_API_KEY && env.INFOBIP_BASE_URL) {
    config.infobip = { apiKey: env.INFOBIP_API_KEY, baseUrl: env.INFOBIP_BASE_URL, sender: env.INFOBIP_SENDER_ID || 'BUHome' };
  }
  if (env.SMS_WEBHOOK_URL) {
    config.webhook = { url: env.SMS_WEBHOOK_URL, bearerToken: env.SMS_WEBHOOK_TOKEN };
  }
  return config;
}

/** Gateways an admin entered in the SMS tab, for a test send. URLs are SSRF-checked. */
export async function gatewaysFromSettings(settings: Partial<SmsGatewaySettings> | undefined): Promise<GatewayConfig> {
  const config: GatewayConfig = {};
  if (!settings || typeof settings !== 'object') return config;
  // Only the gateway the admin chose (not whichever keys happen to be saved).
  const chosen = (p: SmsGatewaySettings['provider']) => !settings.provider || settings.provider === p;
  const t = chosen('twilio') ? settings.twilio : undefined;
  if (t?.accountSid && t.authToken && t.fromNumber) {
    config.twilio = { accountSid: String(t.accountSid), authToken: String(t.authToken), fromNumber: String(t.fromNumber) };
  }
  const i = chosen('infobip') ? settings.infobip : undefined;
  if (i?.apiKey && i.baseUrl) {
    await assertPublicHttpsUrl(String(i.baseUrl), 'Infobip base URL');
    config.infobip = { apiKey: String(i.apiKey), baseUrl: String(i.baseUrl), sender: String(settings.senderId || 'BUHome').slice(0, 11) };
  }
  const w = chosen('custom_webhook') ? settings.customWebhook : undefined;
  if (w?.endpointUrl) {
    await assertPublicHttpsUrl(String(w.endpointUrl), 'Webhook URL');
    config.webhook = { url: String(w.endpointUrl), bearerToken: w.bearerToken ? String(w.bearerToken) : undefined };
  }
  return config;
}

function hasGateway(config: GatewayConfig) {
  return Boolean(config.twilio || config.infobip || config.webhook);
}

function devCodesAllowed() {
  return process.env.NODE_ENV !== 'production' || process.env.OTP_DEV_MODE === 'true';
}

let lastGlobalAlert = 0;
/** Record (at most hourly) that the shop-wide cap was hit: a sign of SMS-pumping or a checkout outage. */
function alertGlobalLimit(ip: string | null) {
  logEvent('warn', 'otp_global_limit', { ip });
  if (Date.now() - lastGlobalAlert > 60 * 60 * 1000) {
    lastGlobalAlert = Date.now();
    audit('otp.global_limit_reached', { limit: Number(process.env.OTP_MAX_PER_HOUR) || 300 });
  }
}

function limited(message: string, retryAfterSec: number): never {
  throw new HttpError(429, message, { 'Retry-After': String(retryAfterSec) });
}

export async function sendRealSmsOtp(
  rawPhone: string,
  options: { gateways: GatewayConfig; ip: string | null }
): Promise<SendOtpResult> {
  const phone = validatePhone(rawPhone);
  const { gateways, ip } = options;

  // All limits are checked together and counted only if every one allows the
  // send, so a refused request never uses up the shop-wide cap or a number's
  // allowance. The shop-wide counter cannot be evicted (see rateLimit.ts).
  const HOUR = 60 * 60 * 1000;
  const rules: Array<LimitRule & { message: string }> = [
    ...(ip ? [{ key: `otp:ip:${ip}`, max: 10, windowMs: HOUR, message: 'Too many codes requested. Please try again later.' }] : []),
    { key: `otp:phone:30s:${phone}`, max: 1, windowMs: 30 * 1000, message: 'Please wait {s} seconds before requesting another SMS.' },
    { key: `otp:phone:1h:${phone}`, max: 5, windowMs: HOUR, message: 'Too many codes requested for this number. Please try again later.' },
    { key: 'global:otp', max: Number(process.env.OTP_MAX_PER_HOUR) || 300, windowMs: HOUR, message: 'Phone verification is busy right now. Please try again shortly.' },
  ];
  const refused = takeAll(rules);
  if (refused) {
    if (refused.rule.key === 'global:otp') alertGlobalLimit(ip);
    const message = (refused.rule as (typeof rules)[number]).message.replace('{s}', String(refused.result.retryAfterSec));
    limited(message, refused.result.retryAfterSec);
  }

  const code = crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, '0');
  otpStore.delete(phone);
  otpStore.set(phone, { hash: codeHash(phone, code), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
  if (otpStore.size > MAX_RECORDS) {
    const oldest = otpStore.keys().next().value;
    if (oldest !== undefined) otpStore.delete(oldest);
  }

  const smsText = `Beautiful UAE Home: Your verification code is ${code}. Valid for 10 minutes. Please do not share this code.`;

  if (!hasGateway(gateways)) {
    if (devCodesAllowed()) {
      return {
        success: true,
        message: 'Verification code generated (sandbox: no SMS gateway is configured, so the code is shown here).',
        provider: 'Sandbox / Demo Gateway',
        isSimulated: true,
        devOtpCode: code,
      };
    }
    otpStore.delete(phone);
    logEvent('error', 'otp_no_gateway', {});
    return {
      success: false,
      message: `Phone verification is not available right now. Please try again shortly, or email ${supportEmail()} to order.`,
      provider: 'none',
      isSimulated: false,
    };
  }

  const sent = await deliver(phone, code, smsText, gateways);
  if (sent) {
    logEvent('info', 'otp_sent', { phone: maskPhone(phone), provider: sent.provider });
    return {
      success: true,
      message: `Verification code sent by SMS to ${maskPhone(phone)}.`,
      provider: sent.provider,
      messageId: sent.messageId,
      isSimulated: false,
    };
  }

  otpStore.delete(phone);
  return {
    success: false,
    message: `We could not send the SMS just now. Please try again in a minute, or email ${supportEmail()} to order.`,
    provider: 'unavailable',
    isSimulated: false,
  };
}

async function deliver(
  phone: string,
  code: string,
  text: string,
  gateways: GatewayConfig
): Promise<{ provider: string; messageId?: string } | null> {
  if (gateways.twilio) {
    const { accountSid, authToken, fromNumber } = gateways.twilio;
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) {
      logEvent('warn', 'otp_twilio_bad_sid', {});
    } else {
      try {
        const form = new URLSearchParams({ To: phone, From: fromNumber, Body: text });
        const res = await safeFetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        });
        const data = res.data as { sid?: string; message?: string } | null;
        if (res.ok && data?.sid) return { provider: 'Twilio Carrier SMS', messageId: data.sid };
        logEvent('warn', 'otp_twilio_failed', { status: res.status, message: data?.message });
      } catch (err) {
        logEvent('warn', 'otp_twilio_error', { error: (err as Error).message });
      }
    }
  }

  if (gateways.infobip) {
    try {
      const base = await assertPublicHttpsUrl(gateways.infobip.baseUrl, 'Infobip base URL');
      const res = await safeFetch(new URL('/sms/2/text/advanced', base), {
        method: 'POST',
        headers: {
          Authorization: `App ${gateways.infobip.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ messages: [{ destinations: [{ to: phone }], from: gateways.infobip.sender, text }] }),
      });
      const data = res.data as { messages?: Array<{ messageId?: string; status?: { groupName?: string } }> } | null;
      const first = data?.messages?.[0];
      if (res.ok && first && first.status?.groupName !== 'REJECTED' && first.status?.groupName !== 'UNDELIVERABLE') {
        return { provider: 'Infobip UAE SMS', messageId: first.messageId };
      }
      logEvent('warn', 'otp_infobip_failed', { status: res.status });
    } catch (err) {
      logEvent('warn', 'otp_infobip_error', { error: (err as Error).message });
    }
  }

  if (gateways.webhook) {
    try {
      const url = await assertPublicHttpsUrl(gateways.webhook.url, 'Webhook URL');
      const res = await safeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(gateways.webhook.bearerToken ? { Authorization: `Bearer ${gateways.webhook.bearerToken}` } : {}),
        },
        body: JSON.stringify({ to: phone, code, message: text }),
      });
      if (res.ok) return { provider: 'Custom Webhook Gateway' };
      logEvent('warn', 'otp_webhook_failed', { status: res.status });
    } catch (err) {
      logEvent('warn', 'otp_webhook_error', { error: (err as Error).message });
    }
  }

  return null;
}

/**
 * Verify customer input code against stored OTP
 */
export function verifyRealSmsOtp(rawPhone: string, inputCode: string): { valid: boolean; message: string } {
  const phone = validatePhone(rawPhone);
  const record = otpStore.get(phone);

  if (!record) {
    return { valid: false, message: 'No verification code is waiting for this number. Please request a new code.' };
  }
  if (Date.now() > record.expiresAt) {
    otpStore.delete(phone);
    return { valid: false, message: 'The verification code has expired. Please request a new code.' };
  }

  record.attempts += 1;
  const given = Buffer.from(codeHash(phone, toAsciiDigits(String(inputCode)).replace(/\s+/g, '')));
  const expected = Buffer.from(record.hash);
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
    otpStore.delete(phone); // single use
    return { valid: true, message: 'Mobile number successfully verified.' };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    otpStore.delete(phone);
    return { valid: false, message: 'Too many incorrect attempts. Please request a new code.' };
  }
  const left = MAX_ATTEMPTS - record.attempts;
  return { valid: false, message: `Incorrect verification code (${left} attempt${left === 1 ? '' : 's'} remaining).` };
}

/** Test hook. */
export function _clearOtpStore() {
  otpStore.clear();
}
