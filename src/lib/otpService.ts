import { SmsGatewaySettings } from '@/types';

interface StoredOtpRecord {
  code: string;
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

// In-memory server-side OTP cache (persists during server runtime)
const otpStore = new Map<string, StoredOtpRecord>();

// Clean expired OTPs every 15 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [phone, record] of otpStore.entries()) {
      if (now > record.expiresAt) {
        otpStore.delete(phone);
      }
    }
  }, 15 * 60 * 1000);
}

/**
 * Standardize UAE and international phone numbers into E.164 format
 * Examples:
 *  "050 123 4567" -> "+971501234567"
 *  "+971 50 123 4567" -> "+971501234567"
 *  "501234567" -> "+971501234567"
 */
export function normalizePhoneNumber(rawPhone: string): string {
  let cleaned = rawPhone.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('00971')) {
    cleaned = '+971' + cleaned.slice(5);
  } else if (cleaned.startsWith('05')) {
    cleaned = '+971' + cleaned.slice(1);
  } else if (cleaned.startsWith('5') && cleaned.length === 9) {
    cleaned = '+971' + cleaned;
  } else if (!cleaned.startsWith('+') && cleaned.startsWith('971')) {
    cleaned = '+' + cleaned;
  } else if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  return cleaned;
}

export interface SendOtpResult {
  success: boolean;
  message: string;
  provider: string;
  messageId?: string;
  isSimulated: boolean;
  devOtpCode?: string; // only provided when in sandbox/unconfigured mode
}

/**
 * Dispatch real carrier SMS via Twilio, Infobip, Unifonic, or Webhook
 */
export async function sendRealSmsOtp(
  phone: string,
  settings?: SmsGatewaySettings
): Promise<SendOtpResult> {
  const normalizedPhone = normalizePhoneNumber(phone);

  // Check rate limiting: max 1 OTP request per 30 seconds
  const existing = otpStore.get(normalizedPhone);
  if (existing && Date.now() - existing.createdAt < 25000) {
    const remainingSeconds = Math.ceil((25000 - (Date.now() - existing.createdAt)) / 1000);
    return {
      success: false,
      message: `Please wait ${remainingSeconds} seconds before requesting another SMS.`,
      provider: 'rate_limited',
      isSimulated: false,
    };
  }

  // Generate 4-digit numeric OTP code
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  otpStore.set(normalizedPhone, {
    code,
    expiresAt,
    attempts: 0,
    createdAt: Date.now(),
  });

  const smsText = `Beautiful UAE Home: Your verification code is ${code}. Valid for 10 minutes. Please do not share this code.`;

  // 1. Check Twilio Credentials (from settings or process.env)
  const twilioAccountSid = settings?.twilio?.accountSid || process.env.TWILIO_ACCOUNT_SID;
  const twilioAuthToken = settings?.twilio?.authToken || process.env.TWILIO_AUTH_TOKEN;
  const twilioFromNumber = settings?.twilio?.fromNumber || process.env.TWILIO_FROM_PHONE;

  if (twilioAccountSid && twilioAuthToken && twilioFromNumber) {
    try {
      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
      const authHeader = 'Basic ' + Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');

      const formData = new URLSearchParams();
      formData.append('To', normalizedPhone);
      formData.append('From', twilioFromNumber);
      formData.append('Body', smsText);

      const twilioRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const data = await twilioRes.json();

      if (twilioRes.ok && data.sid) {
        return {
          success: true,
          message: `Real SMS OTP dispatched to ${normalizedPhone} via Twilio Carrier Network.`,
          provider: 'Twilio Carrier SMS',
          messageId: data.sid,
          isSimulated: false,
        };
      } else {
        console.warn('Twilio SMS delivery warning:', data);
        return {
          success: true,
          message: `Attempted Twilio delivery (${data.message || 'Check balance/number'}). Sandbox fallback active.`,
          provider: 'Twilio (Notice: ' + (data.message || 'error') + ')',
          isSimulated: true,
          devOtpCode: code,
        };
      }
    } catch (err) {
      console.error('Twilio SMS error:', err);
    }
  }

  // 2. Check Infobip Credentials
  const infobipApiKey = settings?.infobip?.apiKey || process.env.INFOBIP_API_KEY;
  const infobipBaseUrl = settings?.infobip?.baseUrl || process.env.INFOBIP_BASE_URL;

  if (infobipApiKey && infobipBaseUrl) {
    try {
      const cleanBase = infobipBaseUrl.replace(/\/$/, '');
      const endpoint = `${cleanBase}/sms/2/text/advanced`;

      const infobipRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `App ${infobipApiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              destinations: [{ to: normalizedPhone }],
              from: settings?.senderId || 'BUHome',
              text: smsText,
            },
          ],
        }),
      });

      const data = await infobipRes.json();
      if (infobipRes.ok && data.messages?.[0]?.status?.groupName !== 'FAILED') {
        return {
          success: true,
          message: `Real SMS OTP dispatched to ${normalizedPhone} via Infobip UAE Gateway.`,
          provider: 'Infobip UAE SMS',
          messageId: data.messages?.[0]?.messageId,
          isSimulated: false,
        };
      }
    } catch (err) {
      console.error('Infobip SMS error:', err);
    }
  }

  // 3. Check Custom Webhook
  const webhookUrl = settings?.customWebhook?.endpointUrl || process.env.SMS_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const webhookRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings?.customWebhook?.bearerToken
            ? { Authorization: `Bearer ${settings.customWebhook.bearerToken}` }
            : {}),
        },
        body: JSON.stringify({
          to: normalizedPhone,
          code,
          message: smsText,
        }),
      });
      if (webhookRes.ok) {
        return {
          success: true,
          message: `SMS OTP dispatched to ${normalizedPhone} via Custom Webhook.`,
          provider: 'Custom Webhook Gateway',
          isSimulated: false,
        };
      }
    } catch (err) {
      console.error('Custom Webhook SMS error:', err);
    }
  }

  // 4. Default Sandbox / Guided Mode when no Gateway API keys are entered yet
  return {
    success: true,
    message: `Verification code generated. (Carrier SMS Gateway not yet configured in Admin Hub. Enter Twilio or Infobip keys to deliver physical SMS to carrier towers).`,
    provider: 'Sandbox / Demo Gateway',
    isSimulated: true,
    devOtpCode: code,
  };
}

/**
 * Verify customer input code against stored OTP
 */
export function verifyRealSmsOtp(
  phone: string,
  inputCode: string
): { valid: boolean; message: string } {
  const normalizedPhone = normalizePhoneNumber(phone);
  const record = otpStore.get(normalizedPhone);

  if (!record) {
    return {
      valid: false,
      message: 'No OTP verification request found for this phone number. Please request a new code.',
    };
  }

  if (Date.now() > record.expiresAt) {
    otpStore.delete(normalizedPhone);
    return {
      valid: false,
      message: 'The verification code has expired. Please request a new code.',
    };
  }

  if (record.attempts >= 5) {
    otpStore.delete(normalizedPhone);
    return {
      valid: false,
      message: 'Too many incorrect attempts. Please request a new OTP code.',
    };
  }

  record.attempts += 1;

  if (record.code === inputCode.trim()) {
    // Successfully verified! Delete record to prevent replay attacks
    otpStore.delete(normalizedPhone);
    return {
      valid: true,
      message: 'Mobile number successfully verified.',
    };
  }

  return {
    valid: false,
    message: `Incorrect verification code. Please check the SMS and try again (${5 - record.attempts} attempts remaining).`,
  };
}
