'use client';

import React, { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Globe2, Loader2, Mail, MessageSquareText, Pencil, RotateCcw, ShieldCheck, Smartphone } from 'lucide-react';
import type { ConfirmationResult } from 'firebase/auth';
import { postJson } from '@/lib/apiClient';
import { confirmFirebaseCode, firebaseErrorMessage, preloadFirebasePhone, sendFirebaseCode } from '@/lib/firebasePhoneClient';
import type { PhoneVerificationConfig } from '@/types';
import { useT, type Words } from '@/lib/i18n';

/** Shown until the shop's settings load (the real address comes from the server at runtime). */
export const DEFAULT_SUPPORT_EMAIL = 'orders@beautifuluaehome.com';

const WORDS = {
  enterUae: { en: 'Enter a UAE mobile number, e.g. 50 123 4567.', ar: 'أدخل رقم جوال إماراتي، مثل 50 123 4567.' },
  sent: { en: 'We sent a 6-digit code by SMS to +971 {num}.', ar: 'أرسلنا رمزاً من 6 أرقام برسالة نصية إلى \u2066+971 {num}\u2069.' },
  testMode: { en: 'Test mode: no SMS gateway is set up yet, so no text was sent to +971 {num}.', ar: 'وضع التجربة: لم تُضبط خدمة الرسائل بعد، لذلك لم تُرسل رسالة إلى \u2066+971 {num}\u2069.' },
  sendFailed: { en: 'We could not send the code. Please try again.', ar: 'تعذّر إرسال الرمز. حاول مرة أخرى.' },
  noMatch: { en: 'That code did not match. Please try again.', ar: 'الرمز غير صحيح. حاول مرة أخرى.' },
  tapResend: { en: 'Please tap “Resend code” for a new code.', ar: 'اضغط «إعادة إرسال الرمز» للحصول على رمز جديد.' },
  verified: { en: 'Mobile number verified', ar: 'تم التحقق من رقم الجوال' },
  change: { en: 'Change', ar: 'تغيير' },
  waTitle: { en: 'Your UAE mobile number', ar: 'رقم جوالك الإماراتي' },
  courierTitle: { en: 'Your UAE mobile, for the courier', ar: 'جوالك الإماراتي، لشركة التوصيل' },
  verifyTitle: { en: 'Verify your UAE mobile to place your order', ar: 'تحقق من جوالك الإماراتي لإتمام طلبك' },
  waSub: { en: 'We confirm orders over WhatsApp.', ar: 'نؤكد الطلبات عبر واتساب.' },
  cardSub: { en: 'Paying by card: no SMS code needed', ar: 'الدفع بالبطاقة: لا حاجة لرمز SMS' },
  verifySub: { en: 'Free • takes 30 seconds • protects your delivery', ar: 'مجاني • يستغرق 30 ثانية • يحمي توصيلك' },
  required: { en: 'Required', ar: 'مطلوب' },
  label: { en: 'UAE Mobile Number', ar: 'رقم الجوال الإماراتي' },
  intl: { en: 'International number', ar: 'رقم دولي' },
  uae: { en: 'UAE', ar: 'الإمارات' },
  sending: { en: 'Sending…', ar: 'جارٍ الإرسال…' },
  wait: { en: 'Wait {n}s', ar: 'انتظر {n} ث' },
  sendCode: { en: 'Send code', ar: 'أرسل الرمز' },
  willText: { en: "we'll text you a 6-digit code.", ar: 'سنرسل لك رمزاً من 6 أرقام.' },
  starts: { en: 'UAE mobile numbers start with 50, 52, 54, 55, 56 or 58 and have 9 digits.', ar: 'أرقام الجوال الإماراتية تبدأ بـ 50 أو 52 أو 54 أو 55 أو 56 أو 58 وتتكون من 9 أرقام.' },
  outside: { en: 'Ordering from outside the UAE?', ar: 'تطلب من خارج الإمارات؟' },
  outsideText: { en: 'Online checkout verifies UAE mobile numbers only. Email us and our team will arrange your order, delivery and payment personally.', ar: 'الدفع عبر الموقع يتحقق من الأرقام الإماراتية فقط. راسلنا بالبريد وسيرتب فريقنا طلبك وتوصيله ودفعه شخصياً.' },
  email: { en: 'Email {email}', ar: 'راسلنا على {email}' },
  edit: { en: 'Edit number', ar: 'تعديل الرقم' },
  codeGroup: { en: '6-digit verification code', ar: 'رمز التحقق من 6 أرقام' },
  digit: { en: 'Digit {n}', ar: 'الرقم {n}' },
  checking: { en: 'Checking…', ar: 'جارٍ التحقق…' },
  valid: { en: 'Code is valid for 10 minutes.', ar: 'الرمز صالح لمدة 10 دقائق.' },
  resendIn: { en: 'Resend in {n}s', ar: 'إعادة الإرسال بعد {n} ث' },
  resend: { en: 'Resend code', ar: 'إعادة إرسال الرمز' },
  testTap: { en: 'Test mode (no SMS gateway yet): tap to use code', ar: 'وضع التجربة (لا توجد خدمة رسائل بعد): اضغط لاستخدام الرمز' },
} as const satisfies Words;

const CODE_LENGTH = 6;
const RESEND_SECONDS = 30;
// UAE mobile networks: 50, 52, 54, 55, 56, 58 (e& / du / Virgin).
const UAE_MOBILE = /^5[024568]\d{7}$/;

export type PhoneKind = 'empty' | 'uae' | 'uae-partial' | 'international' | 'invalid';

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits, as typed on Arabic keyboards, to 0-9. */
export function toAsciiDigits(s: string): string {
  return s.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) & 0xf));
}

/** Classify what the customer typed, accepting +971 / 00971 / 971 / 05x / 5x forms and Arabic digits. */
export function classifyPhone(raw: string): { kind: PhoneKind; local: string; e164: string } {
  const trimmed = toAsciiDigits(raw.trim());
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return { kind: trimmed.startsWith('+') ? 'uae-partial' : 'empty', local: '', e164: '' };

  const explicitIntl = trimmed.startsWith('+') || digits.startsWith('00');
  let local = digits;
  if (explicitIntl) {
    const cc = digits.startsWith('00') ? digits.slice(2) : digits;
    // Still typing the country code ("+9", "+97", "00", "009"…): not foreign yet.
    if (cc.length < 3 && '971'.startsWith(cc)) return { kind: 'uae-partial', local: '', e164: '' };
    if (!cc.startsWith('971')) return { kind: 'international', local: '', e164: '' };
    local = cc.slice(3);
  } else if (digits.startsWith('971')) {
    local = digits.slice(3);
  } else if ('971'.startsWith(digits)) {
    return { kind: 'uae-partial', local: '', e164: '' };
  }
  if (local.startsWith('0')) local = local.slice(1);

  if (UAE_MOBILE.test(local)) return { kind: 'uae', local, e164: `+971${local}` };
  if (local === '' || /^5\d{0,7}$/.test(local)) return { kind: 'uae-partial', local, e164: '' };
  return { kind: 'invalid', local, e164: '' };
}

function formatLocal(local: string) {
  // 50 123 4567
  return [local.slice(0, 2), local.slice(2, 5), local.slice(5, 9)].filter(Boolean).join(' ');
}

interface PhoneVerificationProps {
  phone: string;
  onPhoneChange: (phone: string) => void;
  verified: boolean;
  /** On success, `token` is the server's signed proof, sent with the order. */
  onVerifiedChange: (verified: boolean, token?: string) => void;
  /** Used to pre-fill the email for international customers. */
  orderSummary: string;
  /** Where international customers email (from the server's settings). */
  supportEmail?: string;
  /** 'server' (default): the shop texts the code. 'firebase': Firebase Phone Authentication does. */
  verification?: PhoneVerificationConfig;
  /** Paying by card: the number is still needed for the courier, but no SMS code (paying is the proof). */
  codeOptional?: boolean;
  /** Settings → Phone check "WhatsApp (free)": the number only, no code; the order is confirmed on WhatsApp. */
  whatsapp?: boolean;
}

type VerifyResponse = { valid?: boolean; message?: string; verificationToken?: string };

export const PhoneVerification: React.FC<PhoneVerificationProps> = ({
  phone,
  onPhoneChange,
  verified,
  onVerifiedChange,
  orderSummary,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
  verification,
  codeOptional: cardNoCode = false,
  whatsapp = false,
}) => {
  const tr = useT(WORDS);
  const codeOptional = cardNoCode || whatsapp;
  const firebase = verification?.method === 'firebase' ? verification.firebase : undefined;
  // Firebase: the pending sign-in for the code that was sent, and where its invisible reCAPTCHA renders.
  const confirmation = useRef<ConfirmationResult | null>(null);
  const recaptchaHost = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<'enter' | 'code'>('enter');
  const [digits, setDigits] = useState<string[]>(() => Array(CODE_LENGTH).fill(''));
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sandboxCode, setSandboxCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  // The resend wait belongs to the number it was for: a new number can be sent at once.
  const [cooldownFor, setCooldownFor] = useState('');
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const verifying = useRef(false);

  const info = classifyPhone(phone);
  const wait = cooldownFor === info.e164 ? cooldown : 0;

  // Firebase only: fetch the SDK while the shopper types, so "Send code" answers quickly.
  useEffect(() => {
    if (firebase) preloadFirebasePhone(firebase);
  }, [firebase]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resetCode = () => setDigits(Array(CODE_LENGTH).fill(''));

  const changeNumber = () => {
    onVerifiedChange(false);
    setStage('enter');
    confirmation.current = null;
    resetCode();
    setSandboxCode('');
    setError('');
    setNotice('');
  };

  const sendCode = async () => {
    if (info.kind !== 'uae') {
      setError(tr('enterUae'));
      return;
    }
    setSending(true);
    setError('');
    if (firebase) {
      try {
        if (!recaptchaHost.current) throw new Error('reCAPTCHA host missing');
        confirmation.current = await sendFirebaseCode(firebase, info.e164, recaptchaHost.current);
      } catch (err) {
        setSending(false);
        setError(firebaseErrorMessage(err, supportEmail));
        return;
      }
      setSending(false);
      resetCode();
      setStage('code');
      setCooldown(RESEND_SECONDS);
      setCooldownFor(info.e164);
      setSandboxCode('');
      setNotice(tr('sent', { num: formatLocal(info.local) }));
      setTimeout(() => boxes.current[0]?.focus(), 50);
      return;
    }
    const { ok, status, data } = await postJson<{ success?: boolean; message?: string; devOtpCode?: string }>(
      '/api/otp/send',
      { phone: info.e164 }
    );
    setSending(false);
    if (ok && data.success) {
      resetCode();
      setStage('code');
      setCooldown(RESEND_SECONDS);
      setCooldownFor(info.e164);
      setSandboxCode(data.devOtpCode || '');
      setNotice(
        data.devOtpCode
          ? tr('testMode', { num: formatLocal(info.local) })
          : tr('sent', { num: formatLocal(info.local) })
      );
      setTimeout(() => boxes.current[0]?.focus(), 50);
    } else {
      if (status === 429) {
        const seconds = Number(String(data.message).match(/(\d+) seconds/)?.[1]);
        if (seconds) {
          setCooldown(seconds);
          setCooldownFor(info.e164);
        }
      }
      setError(data.message || tr('sendFailed'));
    }
  };

  const verify = async (code: string) => {
    if (verifying.current) return; // one check at a time (double taps, autofill + typing)
    verifying.current = true;
    setChecking(true);
    setError('');
    const data = firebase ? await verifyWithFirebase(code) : (await postJson<VerifyResponse>('/api/otp/verify', { phone: info.e164, code })).data;
    verifying.current = false;
    setChecking(false);
    if (data.valid) {
      onVerifiedChange(true, data.verificationToken);
      setNotice('');
      setSandboxCode('');
    } else {
      setError(data.message || tr('noMatch'));
      resetCode();
      setTimeout(() => boxes.current[0]?.focus(), 50);
    }
  };

  /** Firebase checks the code; our server then checks Firebase's signed answer and issues the phone token. */
  const verifyWithFirebase = async (code: string): Promise<VerifyResponse> => {
    if (!firebase || !confirmation.current) return { valid: false, message: tr('tapResend') };
    let idToken: string;
    try {
      idToken = await confirmFirebaseCode(firebase, confirmation.current, code);
    } catch (err) {
      return { valid: false, message: firebaseErrorMessage(err, supportEmail) };
    }
    confirmation.current = null; // used: a new code is needed for another try
    return (await postJson<VerifyResponse>('/api/otp/firebase', { idToken })).data;
  };

  const setCode = (next: string[]) => {
    setDigits(next);
    const code = next.join('');
    if (code.length === CODE_LENGTH && /^\d+$/.test(code)) void verify(code);
  };

  const onDigit = (index: number, value: string) => {
    const clean = toAsciiDigits(value).replace(/\D/g, '');
    if (clean.length > 1) {
      // Pasted or autofilled: spread across the boxes.
      const next = [...digits];
      clean.slice(0, CODE_LENGTH - index).split('').forEach((d, i) => (next[index + i] = d));
      setCode(next);
      boxes.current[Math.min(index + clean.length, CODE_LENGTH - 1)]?.focus();
      return;
    }
    const next = [...digits];
    next[index] = clean;
    setCode(next);
    if (clean && index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) boxes.current[index - 1]?.focus();
    if (e.key === 'ArrowLeft' && index > 0) boxes.current[index - 1]?.focus();
    if (e.key === 'ArrowRight' && index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus();
  };

  // ── Verified ───────────────────────────────────────────────────────────
  if (verified && info.kind === 'uae') {
    return (
      <div className="sm:col-span-2 rounded-2xl border border-success-line bg-gradient-to-br from-success-soft to-paper p-3.5 flex items-center gap-3 animate-in fade-in-50">
        <div className="w-10 h-10 rounded-xl bg-success text-paper flex items-center justify-center shrink-0">
          <BadgeCheck className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-success">{tr('verified')}</p>
          <p className="text-[11px] text-success/80 font-mono" dir="ltr">+971 {formatLocal(info.local)}</p>
        </div>
        <button
          type="button"
          onClick={changeNumber}
          className="text-[11px] font-semibold text-success hover:text-success flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-success-soft transition-colors"
        >
          <Pencil className="w-3 h-3" />
          {tr('change')}
        </button>
      </div>
    );
  }

  const mailto = `mailto:${supportEmail}?subject=${encodeURIComponent('International order request')}&body=${encodeURIComponent(
    `Hello Beautiful UAE Home,\n\nI would like to order:\n${orderSummary}\n\nMy phone number: ${phone}\nDelivery country/city: \n\nThank you!`
  )}`;

  return (
    <div className="sm:col-span-2 rounded-2xl border border-line bg-surface overflow-hidden">
      {/* Title strip */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-gradient-to-r from-ink to-ink-2 text-paper">
        <ShieldCheck className="w-4 h-4 text-gold" />
        <div className="flex-1">
          <p className="text-[11px] font-semibold tracking-wide">{whatsapp ? tr('waTitle') : codeOptional ? tr('courierTitle') : tr('verifyTitle')}</p>
          <p className="text-[10px] text-sand">{whatsapp ? tr('waSub') : codeOptional ? tr('cardSub') : tr('verifySub')}</p>
        </div>
        <span className="text-[10px] font-semibold bg-gold text-ink px-2 py-0.5 rounded-full">{tr('required')}</span>
      </div>

      <div className="p-3.5 space-y-3">
        {stage === 'enter' && (
          <>
            <label htmlFor="checkout-phone" className="block text-xs font-semibold text-ink">
              {tr('label')} <span className="text-danger">*</span>
            </label>
            <div className="flex flex-col min-[380px]:flex-row gap-2">
              <div
                dir="ltr"
                className={`flex-1 min-w-0 flex items-center rounded-xl border bg-surface transition-shadow focus-within:ring-2 focus-within:ring-gold ${
                  info.kind === 'invalid' || info.kind === 'international' ? 'border-gold' : 'border-line-strong'
                }`}
              >
                <span className="flex items-center gap-1.5 ps-3 pe-2.5 py-2.5 border-e border-line text-xs font-semibold text-ink-soft select-none">
                  {info.kind === 'international' ? (
                    <Globe2 className="w-3.5 h-3.5 text-ink-muted" aria-label={tr('intl')} />
                  ) : (
                    <>
                      <span className="label-caps !text-[10px] text-ink-muted" aria-hidden>{tr('uae')}</span>+971
                    </>
                  )}
                </span>
                <input
                  id="checkout-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                  maxLength={20}
                  placeholder="50 123 4567"
                  value={phone}
                  onChange={(e) => {
                    onPhoneChange(e.target.value);
                    onVerifiedChange(false);
                    setError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !codeOptional) {
                      e.preventDefault();
                      void sendCode();
                    }
                  }}
                  className="flex-1 min-w-0 px-3 py-2.5 bg-transparent text-ink placeholder:text-ink-muted font-medium text-xs tracking-wide focus:outline-none"
                />
              </div>
              {!codeOptional && <button
                type="button"
                onClick={sendCode}
                disabled={sending || info.kind !== 'uae' || wait > 0}
                className="px-4 py-2.5 bg-ink hover:bg-ink disabled:bg-line-strong disabled:cursor-not-allowed text-paper rounded-xl text-[11px] font-semibold shrink-0 transition-colors flex items-center justify-center gap-1.5"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquareText className="w-3.5 h-3.5 text-gold-light" />}
                {sending ? tr('sending') : wait > 0 ? tr('wait', { n: wait }) : tr('sendCode')}
              </button>}
            </div>

            {info.kind === 'uae' && (
              <p className="text-[11px] text-success font-medium flex items-center gap-1">
                <Smartphone className="w-3 h-3" /> <span dir="ltr">+971 {formatLocal(info.local)}</span>{codeOptional ? '' : <> — {tr('willText')}</>}
              </p>
            )}
            {info.kind === 'invalid' && (
              <p className="text-[11px] text-warning">{tr('starts')}</p>
            )}

            {info.kind === 'international' && (
              <div className="rounded-xl border border-gold/40 bg-gradient-to-br from-warning-soft to-ivory p-3.5 space-y-2.5 animate-in fade-in-50">
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-surface border border-warning-line flex items-center justify-center shrink-0">
                    <Globe2 className="w-4 h-4 text-gold" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-xs font-semibold text-ink">{tr('outside')}</p>
                    <p className="text-[11px] text-ink-soft leading-relaxed">
                      {tr('outsideText')}
                    </p>
                  </div>
                </div>
                <a
                  href={mailto}
                  className="flex items-center justify-center gap-2 w-full bg-ink hover:bg-ink text-paper font-semibold text-[11px] py-2.5 rounded-xl transition-colors"
                >
                  <Mail className="w-3.5 h-3.5 text-gold-light" />
                  {tr('email', { email: supportEmail })}
                </a>
              </div>
            )}
          </>
        )}

        {stage === 'code' && (
          <div className="space-y-3 animate-in fade-in-50">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-ink-soft leading-relaxed">{notice}</p>
              <button
                type="button"
                onClick={changeNumber}
                className="text-[11px] font-semibold text-ink-soft hover:text-ink flex items-center gap-1 shrink-0"
              >
                <Pencil className="w-3 h-3" /> {tr('edit')}
              </button>
            </div>

            <div className="flex justify-center gap-1.5 sm:gap-2" dir="ltr" role="group" aria-label={tr('codeGroup')}>
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  autoComplete={i === 0 ? 'one-time-code' : 'off'}
                  aria-label={tr('digit', { n: i + 1 })}
                  maxLength={i === 0 ? CODE_LENGTH * 2 : 1}
                  value={d}
                  disabled={checking}
                  onChange={(e) => onDigit(i, e.target.value)}
                  onPaste={(e) => {
                    // A pasted code fills all six boxes, whichever box has focus.
                    const pasted = toAsciiDigits(e.clipboardData.getData('text')).replace(/\D/g, '');
                    if (pasted.length > 1) {
                      e.preventDefault();
                      onDigit(0, pasted.slice(0, CODE_LENGTH));
                    }
                  }}
                  onKeyDown={(e) => onKeyDown(i, e)}
                  onFocus={(e) => e.target.select()}
                  className={`w-10 h-12 sm:w-11 sm:h-13 text-center text-lg font-semibold font-mono rounded-xl border bg-surface text-ink transition-all focus:outline-none focus:ring-2 focus:ring-gold focus:border-gold ${
                    d ? 'border-gold bg-warning-soft/50' : 'border-line-strong'
                  } ${error ? 'border-danger-line' : ''}`}
                />
              ))}
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-ink-muted flex items-center gap-1">
                {checking ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" /> {tr('checking')}
                  </>
                ) : (
                  tr('valid')
                )}
              </span>
              <button
                type="button"
                onClick={sendCode}
                disabled={sending || wait > 0}
                className="font-semibold text-ink hover:underline disabled:text-ink-muted disabled:no-underline flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                {wait > 0 ? tr('resendIn', { n: wait }) : tr('resend')}
              </button>
            </div>

            {sandboxCode && (
              <button
                type="button"
                disabled={checking}
                onClick={() => onDigit(0, sandboxCode)}
                className="w-full text-[11px] text-warning bg-warning-soft border border-dashed border-warning-line rounded-xl py-2 hover:bg-warning-soft transition-colors"
              >
                {tr('testTap')} <strong className="font-mono tracking-widest">{sandboxCode}</strong>
              </button>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-[11px] text-danger bg-danger-soft border border-danger-line rounded-lg px-2.5 py-1.5 font-medium">
            {error}
          </p>
        )}
        {/* Firebase only: its invisible reCAPTCHA renders here when "Send code" is tapped. */}
        {firebase && <div ref={recaptchaHost} className="empty:hidden" />}
      </div>
    </div>
  );
};
