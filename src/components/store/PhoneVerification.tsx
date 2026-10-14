'use client';

import React, { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Globe2, Loader2, Mail, MessageSquareText, Pencil, RotateCcw, ShieldCheck, Smartphone } from 'lucide-react';
import { postJson } from '@/lib/apiClient';

export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || 'orders@beautifuluaehome.com';

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
}

export const PhoneVerification: React.FC<PhoneVerificationProps> = ({
  phone,
  onPhoneChange,
  verified,
  onVerifiedChange,
  orderSummary,
}) => {
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

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resetCode = () => setDigits(Array(CODE_LENGTH).fill(''));

  const changeNumber = () => {
    onVerifiedChange(false);
    setStage('enter');
    resetCode();
    setSandboxCode('');
    setError('');
    setNotice('');
  };

  const sendCode = async () => {
    if (info.kind !== 'uae') {
      setError('Enter a UAE mobile number, e.g. 50 123 4567.');
      return;
    }
    setSending(true);
    setError('');
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
          ? `Test mode: no SMS gateway is set up yet, so no text was sent to +971 ${formatLocal(info.local)}.`
          : `We sent a 6-digit code by SMS to +971 ${formatLocal(info.local)}.`
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
      setError(data.message || 'We could not send the code. Please try again.');
    }
  };

  const verify = async (code: string) => {
    if (verifying.current) return; // one check at a time (double taps, autofill + typing)
    verifying.current = true;
    setChecking(true);
    setError('');
    const { data } = await postJson<{ valid?: boolean; message?: string; verificationToken?: string }>('/api/otp/verify', { phone: info.e164, code });
    verifying.current = false;
    setChecking(false);
    if (data.valid) {
      onVerifiedChange(true, data.verificationToken);
      setNotice('');
      setSandboxCode('');
    } else {
      setError(data.message || 'That code did not match. Please try again.');
      resetCode();
      setTimeout(() => boxes.current[0]?.focus(), 50);
    }
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
      <div className="sm:col-span-2 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-3.5 flex items-center gap-3 animate-in fade-in-50">
        <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-sm shrink-0">
          <BadgeCheck className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-bold text-emerald-900">Mobile number verified</p>
          <p className="text-[11px] text-emerald-800/80 font-mono">+971 {formatLocal(info.local)}</p>
        </div>
        <button
          type="button"
          onClick={changeNumber}
          className="text-[11px] font-semibold text-emerald-900 hover:text-emerald-700 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-emerald-100 transition-colors"
        >
          <Pencil className="w-3 h-3" />
          Change
        </button>
      </div>
    );
  }

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('International order request')}&body=${encodeURIComponent(
    `Hello Beautiful UAE Home,\n\nI would like to order:\n${orderSummary}\n\nMy phone number: ${phone}\nDelivery country/city: \n\nThank you!`
  )}`;

  return (
    <div className="sm:col-span-2 rounded-2xl border border-stone-200 bg-white overflow-hidden shadow-xs">
      {/* Title strip */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-gradient-to-r from-[#0f1c2e] to-[#1b2d47] text-white">
        <ShieldCheck className="w-4 h-4 text-[#c5a059]" />
        <div className="flex-1">
          <p className="text-[11px] font-bold tracking-wide">Verify your UAE mobile to place your order</p>
          <p className="text-[10px] text-stone-300">Free • takes 30 seconds • protects your delivery</p>
        </div>
        <span className="text-[10px] font-bold bg-[#c5a059] text-[#0f1c2e] px-2 py-0.5 rounded-full">Required</span>
      </div>

      <div className="p-3.5 space-y-3">
        {stage === 'enter' && (
          <>
            <label htmlFor="checkout-phone" className="block text-xs font-semibold text-stone-800">
              UAE Mobile Number <span className="text-red-500">*</span>
            </label>
            <div className="flex flex-col min-[380px]:flex-row gap-2">
              <div
                className={`flex-1 min-w-0 flex items-center rounded-xl border bg-white transition-shadow focus-within:ring-2 focus-within:ring-[#c5a059] ${
                  info.kind === 'invalid' || info.kind === 'international' ? 'border-amber-400' : 'border-stone-300'
                }`}
              >
                <span className="flex items-center gap-1.5 pl-3 pr-2.5 py-2.5 border-r border-stone-200 text-xs font-semibold text-stone-700 select-none">
                  {info.kind === 'international' ? (
                    <Globe2 className="w-3.5 h-3.5 text-stone-500" aria-label="International number" />
                  ) : (
                    <>
                      <span aria-hidden>🇦🇪</span>+971
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
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void sendCode();
                    }
                  }}
                  className="flex-1 min-w-0 px-3 py-2.5 bg-transparent text-stone-900 placeholder:text-stone-400 font-medium text-xs tracking-wide focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={sendCode}
                disabled={sending || info.kind !== 'uae' || wait > 0}
                className="px-4 py-2.5 bg-[#0f1c2e] hover:bg-stone-800 disabled:bg-stone-300 disabled:cursor-not-allowed text-white rounded-xl text-[11px] font-bold shrink-0 transition-colors flex items-center justify-center gap-1.5"
              >
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquareText className="w-3.5 h-3.5 text-amber-300" />}
                {sending ? 'Sending…' : wait > 0 ? `Wait ${wait}s` : 'Send code'}
              </button>
            </div>

            {info.kind === 'uae' && (
              <p className="text-[11px] text-emerald-700 font-medium flex items-center gap-1">
                <Smartphone className="w-3 h-3" /> +971 {formatLocal(info.local)} — we&apos;ll text you a 6-digit code.
              </p>
            )}
            {info.kind === 'invalid' && (
              <p className="text-[11px] text-amber-800">UAE mobile numbers start with 50, 52, 54, 55, 56 or 58 and have 9 digits.</p>
            )}

            {info.kind === 'international' && (
              <div className="rounded-xl border border-[#c5a059]/40 bg-gradient-to-br from-amber-50 to-stone-50 p-3.5 space-y-2.5 animate-in fade-in-50">
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-white border border-amber-200 flex items-center justify-center shrink-0">
                    <Globe2 className="w-4 h-4 text-[#c5a059]" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-xs font-bold text-[#0f1c2e]">Ordering from outside the UAE?</p>
                    <p className="text-[11px] text-stone-600 leading-relaxed">
                      Online checkout verifies UAE mobile numbers only. Email us and our team will arrange your order, delivery and payment personally.
                    </p>
                  </div>
                </div>
                <a
                  href={mailto}
                  className="flex items-center justify-center gap-2 w-full bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold text-[11px] py-2.5 rounded-xl transition-colors"
                >
                  <Mail className="w-3.5 h-3.5 text-amber-300" />
                  Email {SUPPORT_EMAIL}
                </a>
              </div>
            )}
          </>
        )}

        {stage === 'code' && (
          <div className="space-y-3 animate-in fade-in-50">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-stone-600 leading-relaxed">{notice}</p>
              <button
                type="button"
                onClick={changeNumber}
                className="text-[11px] font-semibold text-stone-700 hover:text-[#0f1c2e] flex items-center gap-1 shrink-0"
              >
                <Pencil className="w-3 h-3" /> Edit number
              </button>
            </div>

            <div className="flex justify-center gap-1.5 sm:gap-2" role="group" aria-label="6-digit verification code">
              {digits.map((d, i) => (
                <input
                  key={i}
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  type="text"
                  inputMode="numeric"
                  autoComplete={i === 0 ? 'one-time-code' : 'off'}
                  aria-label={`Digit ${i + 1}`}
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
                  className={`w-10 h-12 sm:w-11 sm:h-13 text-center text-lg font-bold font-mono rounded-xl border bg-white text-[#0f1c2e] transition-all focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:border-[#c5a059] ${
                    d ? 'border-[#c5a059] bg-amber-50/50' : 'border-stone-300'
                  } ${error ? 'border-red-300' : ''}`}
                />
              ))}
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-stone-500 flex items-center gap-1">
                {checking ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" /> Checking…
                  </>
                ) : (
                  'Code is valid for 10 minutes.'
                )}
              </span>
              <button
                type="button"
                onClick={sendCode}
                disabled={sending || wait > 0}
                className="font-semibold text-[#0f1c2e] hover:underline disabled:text-stone-400 disabled:no-underline flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                {wait > 0 ? `Resend in ${wait}s` : 'Resend code'}
              </button>
            </div>

            {sandboxCode && (
              <button
                type="button"
                disabled={checking}
                onClick={() => onDigit(0, sandboxCode)}
                className="w-full text-[11px] text-amber-900 bg-amber-50 border border-dashed border-amber-300 rounded-xl py-2 hover:bg-amber-100 transition-colors"
              >
                Test mode (no SMS gateway yet): tap to use code <strong className="font-mono tracking-widest">{sandboxCode}</strong>
              </button>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5 font-medium">
            {error}
          </p>
        )}
      </div>
    </div>
  );
};
