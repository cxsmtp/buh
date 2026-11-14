'use client';

import type { Auth, ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';
import type { FirebaseWebConfig } from '@/types';

/**
 * Firebase Phone Authentication in the browser, used by checkout only when the
 * shop switched Firebase on. The SDK is loaded on demand (dynamic import), so
 * it never weighs on the storefront otherwise.
 *
 * Auth runs with in-memory persistence and no popup/redirect resolver: nothing
 * is stored in the shopper's browser and no extra Google iframes load. After
 * the code is confirmed the ID token goes to /api/otp/firebase and the
 * Firebase session is signed out.
 */

let cached: { key: string; auth: Promise<Auth> } | null = null;

function authFor(config: FirebaseWebConfig): Promise<Auth> {
  const key = `${config.projectId}|${config.appId}|${config.apiKey}|${config.authDomain}`;
  if (cached?.key === key) return cached.auth;
  const auth = (async () => {
    const [{ initializeApp, getApps }, { initializeAuth, inMemoryPersistence }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const name = `buh-phone-${config.projectId}`;
    const app = getApps().find((a) => a.name === name) ?? initializeApp(config, name);
    const instance = initializeAuth(app, { persistence: inMemoryPersistence });
    instance.useDeviceLanguage();
    return instance;
  })();
  cached = { key, auth };
  auth.catch(() => {
    if (cached?.auth === auth) cached = null;
  });
  return auth;
}

/** Start loading the SDK early (e.g. when the phone box appears), so "Send code" is quick. */
export function preloadFirebasePhone(config: FirebaseWebConfig): void {
  void authFor(config).catch(() => {});
}

/**
 * Ask Firebase to text a code to `e164`, behind an invisible reCAPTCHA
 * rendered into `host` (a fresh widget each time, cleared afterwards).
 */
export async function sendFirebaseCode(config: FirebaseWebConfig, e164: string, host: HTMLElement): Promise<ConfirmationResult> {
  const auth = await authFor(config);
  const { RecaptchaVerifier, signInWithPhoneNumber } = await import('firebase/auth');
  const slot = document.createElement('div');
  host.appendChild(slot);
  let verifier: RecaptchaVerifier | null = null;
  try {
    verifier = new RecaptchaVerifier(auth, slot, { size: 'invisible' });
    return await signInWithPhoneNumber(auth, e164, verifier);
  } finally {
    try {
      verifier?.clear();
    } catch {
      // already gone
    }
    slot.remove();
  }
}

/** Confirm the code and return a Firebase ID token for the server to check. Signs out of Firebase afterwards. */
export async function confirmFirebaseCode(config: FirebaseWebConfig, confirmation: ConfirmationResult, code: string): Promise<string> {
  const credential = await confirmation.confirm(code);
  try {
    return await credential.user.getIdToken();
  } finally {
    await signOutFirebase(config);
  }
}

export async function signOutFirebase(config: FirebaseWebConfig): Promise<void> {
  try {
    const [auth, { signOut }] = await Promise.all([authFor(config), import('firebase/auth')]);
    await signOut(auth);
  } catch {
    // nothing to sign out of
  }
}

/** What went wrong with a Firebase phone check, in English and UAE Arabic ({email}: the shop's). */
const FIREBASE_WORDS = {
  mismatch: { en: 'That code did not match. Please check the SMS and try again.', ar: 'الرمز غير مطابق. يرجى التحقق من الرسالة النصية والمحاولة مرة أخرى.' },
  expired: { en: 'That code has expired. Please tap “Resend code” for a new one.', ar: 'انتهت صلاحية الرمز. اضغط «إعادة إرسال الرمز» للحصول على رمز جديد.' },
  tooMany: { en: 'Too many attempts from this device. Please wait a while and try again, or email {email} to order.', ar: 'محاولات كثيرة من هذا الجهاز. يرجى الانتظار قليلاً ثم المحاولة، أو راسلنا على {email} للطلب.' },
  quota: { en: 'We cannot send more codes right now. Please email {email} and we will take your order.', ar: 'لا يمكننا إرسال رموز أخرى الآن. يرجى مراسلتنا على {email} وسنستلم طلبك.' },
  badNumber: { en: 'Enter a UAE mobile number, e.g. 50 123 4567.', ar: 'أدخل رقم جوال إماراتي، مثلاً 50 123 4567.' },
  security: { en: 'The security check did not pass. Please try again.', ar: 'لم ينجح التحقق الأمني. حاول مرة أخرى.' },
  network: { en: 'Network problem: please check your connection and try again.', ar: 'مشكلة في الشبكة: يرجى التحقق من اتصالك والمحاولة مرة أخرى.' },
  unavailable: { en: 'Phone verification is not available right now. Please email {email} and we will take your order.', ar: 'خدمة تأكيد الهاتف غير متاحة الآن. يرجى مراسلتنا على {email} وسنستلم طلبك.' },
  notSent: { en: 'We could not send the code just now. Please try again in a minute, or email {email} to order.', ar: 'تعذّر إرسال الرمز الآن. يرجى المحاولة بعد دقيقة، أو راسلنا على {email} للطلب.' },
} as const;

function firebaseProblem(code: unknown): keyof typeof FIREBASE_WORDS {
  switch (code) {
    case 'auth/invalid-verification-code':
      return 'mismatch';
    case 'auth/code-expired':
    case 'auth/session-expired':
    case 'auth/missing-verification-id':
      return 'expired';
    case 'auth/too-many-requests':
      return 'tooMany';
    case 'auth/quota-exceeded':
      return 'quota';
    case 'auth/invalid-phone-number':
    case 'auth/missing-phone-number':
      return 'badNumber';
    case 'auth/captcha-check-failed':
    case 'auth/invalid-app-credential':
      return 'security';
    case 'auth/network-request-failed':
      return 'network';
    case 'auth/unauthorized-domain':
    case 'auth/operation-not-allowed':
    case 'auth/billing-not-enabled':
    case 'auth/invalid-api-key':
    case 'auth/app-not-authorized':
      return 'unavailable';
    default:
      return 'notSent';
  }
}

/** A message a shopper can act on, for a Firebase error code, in their language. */
export function firebaseErrorMessage(err: unknown, supportEmail: string, locale: 'en' | 'ar' = 'en'): string {
  const code = (err as { code?: unknown } | null)?.code;
  // The code only (no phone, no token): lets the owner see e.g. auth/unauthorized-domain in the browser console.
  console.warn('Firebase phone verification:', typeof code === 'string' ? code : 'unknown error');
  const words = FIREBASE_WORDS[firebaseProblem(code)];
  // In Arabic the email address keeps its own left-to-right order inside the sentence.
  return locale === 'ar' ? words.ar.replace('{email}', `\u2068${supportEmail}\u2069`) : words.en.replace('{email}', supportEmail);
}
