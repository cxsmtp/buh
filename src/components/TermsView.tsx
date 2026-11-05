'use client';

import React from 'react';
import Link from 'next/link';
import { LanguageSwitch } from '@/components/common/LanguageSwitch';
import { LocaleBoot } from '@/components/common/LocaleBoot';
import { fill, LocaleProvider, useLocale } from '@/lib/i18n';
import { TERMS, TERMS_UPDATED } from '@/lib/terms';

export interface TermsSeller {
  legal: string;
  licence?: string;
  authority?: string;
  address?: string;
  phone?: string;
  email?: string;
  /** The shop's address (empty: "our website"). */
  site: string;
}

function Body({ seller }: { seller: TermsSeller }) {
  const { locale } = useLocale();
  const ar = locale === 'ar';
  const licence = seller.licence ? (ar ? `، رخصة تجارية رقم ${seller.licence}${seller.authority ? ` صادرة عن ${seller.authority}` : ''}` : `, trade licence ${seller.licence}${seller.authority ? ` issued by ${seller.authority}` : ''}`) : '';
  const address = seller.address ? (ar ? `، ${seller.address}` : `, ${seller.address}`) : '';
  const contact = [seller.phone ? (ar ? `واتساب ${seller.phone}` : `WhatsApp ${seller.phone}`) : '', seller.email ?? ''].filter(Boolean).join(ar ? ' أو ' : ' or ') || (ar ? 'واتساب' : 'WhatsApp');
  const vars = { legal: seller.legal, licence, address, contact, site: seller.site || (ar ? 'موقعنا' : 'our website') };
  const [y, m, d] = TERMS_UPDATED.split('-').map(Number);
  const updated = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(ar ? 'ar-AE-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <main className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10 space-y-6 text-ink" data-testid="terms">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href="/" className="text-sm text-ink-soft underline">{ar ? 'العودة إلى المتجر' : 'Back to the shop'}</Link>
          <h1 className="font-serif text-3xl sm:text-4xl mt-2">{ar ? 'الشروط والأحكام' : 'Terms & Conditions'}</h1>
          <p className="text-sm text-ink-soft mt-1">{ar ? `آخر تحديث: ${updated}` : `Last updated: ${updated}`}</p>
        </div>
        <LanguageSwitch className="shrink-0" />
      </div>
      <nav aria-label={ar ? 'المحتويات' : 'Contents'} className="rounded-2xl border border-line bg-surface p-4">
        <ol className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {TERMS.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="underline decoration-line-strong underline-offset-2 hover:text-gold-deep">{s.title[locale]}</a>
            </li>
          ))}
        </ol>
      </nav>
      {TERMS.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="space-y-2 scroll-mt-4">
          <h2 id={`${s.id}-h`} className="text-lg font-bold">{s.title[locale]}</h2>
          {s.body[locale].map((p, i) => (
            <p key={i} className="text-[15px] leading-relaxed text-ink-soft">{fill(p, vars)}</p>
          ))}
        </section>
      ))}
    </main>
  );
}

/** The Terms page in the visitor's language (their choice, else their device's), with the switch. */
export function TermsView({ seller }: { seller: TermsSeller }) {
  return (
    <LocaleProvider>
      <LocaleBoot />
      <Body seller={seller} />
    </LocaleProvider>
  );
}
