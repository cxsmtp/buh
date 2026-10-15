import { validatePhone } from '@/lib/otpService';
import { supportEmail } from './runtimeConfig';
import { FirebaseTokenError, verifyFirebaseIdToken, type FetchCerts } from './firebaseAuth';
import { HttpError } from './http';
import { logEvent, maskPhone } from './log';
import { issuePhoneToken } from './phoneToken';
import { phoneVerificationConfig } from './settings';

/**
 * The logic behind POST /api/otp/firebase: a Firebase ID token for *this*
 * shop's project, from a phone sign-in, for a UAE mobile, becomes the same
 * signed phone token /api/otp/verify hands out.
 */
export async function confirmFirebasePhone(
  idToken: unknown,
  options: { fetchCerts?: FetchCerts; now?: number } = {}
): Promise<{ valid: true; message: string; verificationToken: string; phone: string }> {
  const config = phoneVerificationConfig();
  // Only while Firebase is the switched-on option: a token is never accepted otherwise.
  if (config.method !== 'firebase' || !config.firebase) throw new HttpError(404, 'Firebase phone verification is not switched on.');

  let phone: string;
  try {
    ({ phone } = await verifyFirebaseIdToken(idToken, config.firebase.projectId, options));
  } catch (err) {
    if (err instanceof FirebaseTokenError) {
      logEvent('warn', 'otp_firebase_refused', { reason: err.reason });
      throw new HttpError(401, 'We could not confirm your number. Please request a new code.');
    }
    logEvent('error', 'otp_firebase_certs_unavailable', { error: (err as Error).message });
    throw new HttpError(503, `Phone verification is not available right now. Please try again shortly, or email ${supportEmail()} to order.`);
  }

  // Firebase can verify any country; checkout only takes UAE mobiles (throws a 400 the customer can act on).
  let uaePhone: string;
  try {
    uaePhone = validatePhone(phone);
  } catch (err) {
    logEvent('warn', 'otp_firebase_phone_refused', { phone: maskPhone(phone) });
    throw err;
  }
  logEvent('info', 'otp_firebase_verified', { phone: maskPhone(uaePhone) });
  return { valid: true, message: 'Mobile number successfully verified.', verificationToken: issuePhoneToken(uaePhone), phone: uaePhone };
}
