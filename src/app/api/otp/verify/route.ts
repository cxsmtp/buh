import { NextRequest } from 'next/server';
import { validatePhone, verifyRealSmsOtp } from '@/lib/otpService';
import { issuePhoneToken } from '@/lib/server/phoneToken';
import { enforceIpLimit } from '@/lib/server/guard';
import { assertSameOrigin, handleRouteError, json, readJsonBody, str } from '@/lib/server/http';

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'otp:verify', 30, 15 * 60 * 1000, 'Too many attempts. Please wait a few minutes.');
    const body = await readJsonBody(req, 2 * 1024);
    const phone = str(body.phone, 'Phone', 32);
    const code = str(body.code ?? body.otp, 'Verification code', 12);
    const result = verifyRealSmsOtp(phone, code);
    // Proof for /api/orders that this number passed verification (30 minutes).
    return json(result.valid ? { ...result, verificationToken: issuePhoneToken(validatePhone(phone)) } : result);
  } catch (error) {
    return handleRouteError(error, 'otp/verify', { valid: false });
  }
}
