'use client';

import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { Building2, Check, CheckCircle2, Copy, Loader2, MessageCircle, Upload } from 'lucide-react';
import type { BankState, BankTransferDetails } from '@/types';
import { postJson } from '@/lib/apiClient';
import { formatAed, toFils } from '@/lib/money';
import { useLocale, useT, type Words } from '@/lib/i18n';
import { serverSaid } from './serverWords';

interface PayTransferProps {
  token: string;
  shopName: string;
  order: { id: string; total: number; firstName: string; state: BankState; uploads: number };
  bank: BankTransferDetails;
  /** Bank transfer "on request": no account on this page; the customer asks for it. */
  onRequest?: boolean;
  /** The shop's WhatsApp, with the request typed (null without the shop's number). */
  askLink?: string | null;
  /** The link is the order's WhatsApp confirmation (with its code), which also asks for the details. */
  askConfirms?: boolean;
  /** Where to ask instead when the shop has no WhatsApp number. */
  supportEmail?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

const WORDS = {
  copyLabel: { en: 'Copy {label}', ar: 'نسخ {label}' },
  copied: { en: 'Copied', ar: 'تم النسخ' },
  copy: { en: 'Copy', ar: 'نسخ' },
  tooBig: { en: 'That file is larger than 5 MB. Please choose a smaller screenshot or PDF.', ar: 'حجم الملف أكبر من 5 ميغابايت. اختر لقطة شاشة أو ملف PDF أصغر.' },
  badType: { en: 'Please choose a screenshot (PNG, JPEG or WebP) or a PDF.', ar: 'اختر لقطة شاشة (PNG أو JPEG أو WebP) أو ملف PDF.' },
  unreadable: { en: 'That file could not be read. Please try another one.', ar: 'تعذّرت قراءة الملف. جرّب ملفاً آخر.' },
  notSent: { en: 'The screenshot could not be sent. Please try again.', ar: 'تعذّر إرسال لقطة الشاشة. حاول مرة أخرى.' },
  bank: { en: 'Bank', ar: 'البنك' },
  accountName: { en: 'Account name', ar: 'اسم الحساب' },
  iban: { en: 'IBAN', ar: 'IBAN' },
  accountNumber: { en: 'Account number', ar: 'رقم الحساب' },
  swift: { en: 'SWIFT', ar: 'SWIFT' },
  branch: { en: 'Branch', ar: 'الفرع' },
  title: { en: 'Pay by bank transfer', ar: 'الدفع بالتحويل البنكي' },
  thanksName: { en: 'Thank you, {name}. ', ar: 'شكراً لك يا {name}. ' },
  thanks: { en: 'Thank you. ', ar: 'شكراً لك. ' },
  intro: { en: 'Please transfer the amount below, then upload a screenshot of the transfer here.', ar: 'حوّل المبلغ أدناه، ثم ارفع لقطة شاشة للتحويل هنا.' },
  yourOrder: { en: 'Your order', ar: 'طلبك' },
  orderNumber: { en: 'Order number', ar: 'رقم الطلب' },
  amount: { en: 'Amount to transfer', ar: 'المبلغ المطلوب تحويله' },
  ourBank: { en: 'Our bank account', ar: 'حسابنا البنكي' },
  emailUs: { en: 'Email us at', ar: 'راسلنا على' },
  emailSend: { en: 'and we’ll send you our bank details.', ar: 'وسنرسل لك بيانات حسابنا البنكي.' },
  phoneSend: { en: 'We’ll contact you on the phone number of your order with our bank details.', ar: 'سنتواصل معك على رقم الهاتف المسجل في طلبك ونرسل لك بياناتنا البنكية.' },
  confirmAsk: { en: 'Confirm your order on WhatsApp and we’ll send you our bank details. The message is already typed: just tap Send.', ar: 'أكّد طلبك على واتساب وسنرسل لك بياناتنا البنكية. الرسالة جاهزة: فقط اضغط إرسال.' },
  waAsk: { en: 'Message us on WhatsApp and we’ll send you our bank details.', ar: 'راسلنا على واتساب وسنرسل لك بياناتنا البنكية.' },
  confirmBtn: { en: 'Confirm & ask for bank details on WhatsApp', ar: 'أكّد واطلب البيانات البنكية على واتساب' },
  askBtn: { en: 'Ask for bank details on WhatsApp', ar: 'اطلب البيانات البنكية على واتساب' },
  reference: { en: 'Reference', ar: 'المرجع' },
  refNote: { en: 'Please use your order number as the transfer reference, so we can match it.', ar: 'استخدم رقم طلبك كمرجع للتحويل لنتمكن من مطابقته.' },
  uploadTitle: { en: 'Upload your transfer screenshot', ar: 'ارفع لقطة شاشة التحويل' },
  thanksSeen: { en: "Thank you, we'll confirm your order once we see the transfer.", ar: 'شكراً لك، سنؤكد طلبك فور وصول التحويل.' },
  notSeen: { en: "We haven't seen your transfer in our account yet. Transfers can take a little while; if you have a new screenshot, please upload it.", ar: 'لم يصل تحويلك إلى حسابنا بعد. قد يستغرق التحويل بعض الوقت؛ إن كانت لديك لقطة شاشة جديدة فارفعها.' },
  howTo: { en: 'A screenshot or PDF of the transfer from your banking app (up to 5 MB). Or send it to us on WhatsApp or by email.', ar: 'لقطة شاشة أو ملف PDF للتحويل من تطبيق البنك (حتى 5 ميغابايت). أو أرسله لنا على واتساب أو بالبريد.' },
  sending: { en: 'Sending…', ar: 'جارٍ الإرسال…' },
  different: { en: 'Upload a different screenshot', ar: 'ارفع لقطة شاشة أخرى' },
  choose: { en: 'Choose screenshot or PDF', ar: 'اختر لقطة شاشة أو ملف PDF' },
  haveOne: { en: 'We have your screenshot.', ar: 'وصلتنا لقطة الشاشة.' },
  haveMany: { en: 'We have {n} screenshots from you; the latest is the one we check.', ar: 'وصلتنا منك {n} لقطات شاشة؛ نراجع آخرها.' },
  private: { en: "This page is only for you: please don't share its link.", ar: 'هذه الصفحة لك وحدك: لا تشارك رابطها.' },
} as const satisfies Words;

/** One detail with a copy button (the IBAN, the reference). */
function CopyLine({ label, value, mono, compact }: { label: string; value: string; mono?: boolean; compact?: boolean }) {
  const t = useT(WORDS);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(compact ? value.replace(/\s+/g, '') : value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // the clipboard is not available: the value is on screen to copy by hand
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-line last:border-b-0 min-w-0">
      <div className="min-w-0">
        <span className="block text-[11px] text-ink-muted">{label}</span>
        <strong className={`block text-ink break-anywhere ${mono ? 'font-mono text-[13px]' : 'text-sm'}`}>{value}</strong>
      </div>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t('copyLabel', { label })}
        className="shrink-0 min-h-10 inline-flex items-center gap-1 px-3 rounded-xl border border-line-strong bg-surface text-[11px] font-semibold text-ink hover:bg-ivory focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-success" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
        <span>{copied ? t('copied') : t('copy')}</span>
      </button>
    </div>
  );
}

/**
 * The customer's private page for a bank-transfer order: what to pay, where, with which
 * reference, and an upload for the transfer screenshot (an image or a PDF, up to 5 MB). Sending
 * another replaces it; the shop keeps the earlier ones.
 */
export function PayTransfer({ token, shopName, order, bank, onRequest = false, askLink, askConfirms = false, supportEmail = '' }: PayTransferProps) {
  const t = useT(WORDS);
  const { locale } = useLocale();
  const [uploads, setUploads] = useState(order.uploads);
  const [state, setState] = useState<BankState>(order.state);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [justSent, setJustSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const amount = `AED ${formatAed(toFils(order.total))}`;

  const send = (file: File | undefined) => {
    setProblem('');
    setJustSent(false);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setProblem(t('tooBig'));
      return;
    }
    if (!/^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.type)) {
      setProblem(t('badType'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setProblem(t('unreadable'));
    reader.onload = async () => {
      setBusy(true);
      const { ok, status, data } = await postJson<{ uploads?: number; message?: string }>(`/api/pay/${encodeURIComponent(token)}`, { file: reader.result });
      setBusy(false);
      if (input.current) input.current.value = '';
      if (!ok) {
        setProblem(serverSaid({ status, data }, locale, t('notSent')));
        return;
      }
      setUploads(data.uploads ?? uploads + 1);
      setState('uploaded');
      setJustSent(true);
    };
    reader.readAsDataURL(file);
  };

  const details: Array<[keyof typeof WORDS, string, boolean?]> = [
    ['bank', bank.bankName],
    ['accountName', bank.accountName],
    ['iban', bank.iban, true],
    ['accountNumber', bank.accountNumber, true],
    ['swift', bank.swiftCode, true],
    ['branch', bank.branch],
  ];

  return (
    <main className="min-h-[100dvh] w-full px-4 py-6 sm:py-10 pt-safe">
      <div className="max-w-lg mx-auto space-y-5 min-w-0">
        <header className="text-center space-y-1">
          <Link href="/" prefetch={false} className="font-serif text-xl text-ink hover:text-gold-deep">{shopName}</Link>
          <h1 className="font-serif text-3xl text-ink">{t('title')}</h1>
          <p className="text-[13px] text-ink-soft leading-relaxed">
            {order.firstName ? t('thanksName', { name: order.firstName }) : t('thanks')}{t('intro')}
          </p>
        </header>

        <section aria-label={t('yourOrder')} className="bg-surface rounded-2xl border border-line p-4 text-xs space-y-2">
          <div className="flex justify-between items-center gap-3">
            <span className="text-ink-muted font-medium">{t('orderNumber')}</span>
            <span className="font-mono text-sm text-ink break-anywhere text-end">{order.id}</span>
          </div>
          <div className="flex justify-between items-center gap-3 pt-2 border-t border-line">
            <span className="font-semibold text-ink">{t('amount')}</span>
            <span data-testid="pay-amount" className="font-semibold text-lg text-ink">{amount}</span>
          </div>
        </section>

        <section aria-labelledby="pay-bank-title" className="bg-surface rounded-2xl border border-line p-4 space-y-1">
          <h2 id="pay-bank-title" className="text-sm font-semibold text-ink flex items-center gap-1.5 mb-1">
            <Building2 className="w-4 h-4 text-gold-deep" aria-hidden="true" /> {t('ourBank')}
          </h2>
          {details.filter(([, v]) => v && v.trim()).map(([label, value, mono]) => (
            <CopyLine key={label} label={t(label)} value={value} mono={mono} compact={label === 'iban'} />
          ))}
          {onRequest && !askLink && (
            <p data-testid="pay-ask-bank-email" className="text-xs text-ink-soft leading-relaxed pb-1 break-anywhere">
              {supportEmail ? (
                <>
                  {t('emailUs')}{' '}
                  <a className="font-semibold text-ink underline" href={`mailto:${supportEmail}?subject=${encodeURIComponent(`Bank details for order ${order.id}`)}`}>
                    {supportEmail}
                  </a>{' '}
                  {t('emailSend')}
                </>
              ) : (
                t('phoneSend')
              )}
            </p>
          )}
          {askLink && (
            <div className="space-y-2 pb-1">
              <p className="text-xs text-ink-soft leading-relaxed">
                {askConfirms ? t('confirmAsk') : t('waAsk')}
              </p>
              <a
                data-testid="pay-ask-bank"
                href={askLink}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full min-h-12 bg-whatsapp hover:brightness-110 text-paper font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
              >
                <MessageCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{askConfirms ? t('confirmBtn') : t('askBtn')}</span>
              </a>
            </div>
          )}
          <div className="pt-2">
            <CopyLine label={t('reference')} value={order.id} mono />
            <p className="text-[11px] text-ink-soft leading-relaxed mt-1">{t('refNote')}</p>
            {bank.instructions && <p className="text-[11px] text-ink-soft leading-relaxed mt-1">{bank.instructions}</p>}
          </div>
        </section>

        <section aria-labelledby="pay-upload-title" className="bg-surface rounded-2xl border border-line p-4 space-y-3 text-xs">
          <h2 id="pay-upload-title" className="text-sm font-semibold text-ink">{t('uploadTitle')}</h2>
          {justSent || (state === 'uploaded' && uploads > 0) ? (
            <p role="status" className="flex items-start gap-1.5 font-semibold text-success bg-success-soft border border-success-line rounded-xl px-3 py-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
              <span>{t('thanksSeen')}</span>
            </p>
          ) : state === 'not_received' ? (
            <p className="text-ink-soft leading-relaxed bg-warning-soft border border-warning-line rounded-xl px-3 py-2">
              {t('notSeen')}
            </p>
          ) : (
            <p className="text-ink-soft leading-relaxed">{t('howTo')}</p>
          )}
          <label className={`w-full min-h-12 flex items-center justify-center gap-2 px-4 rounded-xl text-sm font-semibold cursor-pointer focus-within:ring-2 focus-within:ring-gold focus-within:ring-offset-2 ${busy ? 'opacity-60 pointer-events-none' : ''} ${uploads > 0 ? 'bg-surface text-ink border border-line-strong hover:bg-ivory' : 'bg-ink text-ivory hover:bg-ink-2'}`}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
            <span>{busy ? t('sending') : uploads > 0 ? t('different') : t('choose')}</span>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              disabled={busy}
              onChange={(e) => send(e.target.files?.[0])}
              className="sr-only"
            />
          </label>
          {uploads > 0 && !busy && <p className="text-[11px] text-ink-muted text-center">{uploads === 1 ? t('haveOne') : t('haveMany', { n: uploads })}</p>}
          {problem && (
            <p role="alert" className="text-danger font-semibold">
              {problem}
            </p>
          )}
        </section>

        <p className="text-[11px] text-ink-muted text-center leading-relaxed">{t('private')}</p>
      </div>
    </main>
  );
}
