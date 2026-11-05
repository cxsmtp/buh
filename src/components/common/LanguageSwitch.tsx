'use client';

import React from 'react';
import { useLocale } from '@/lib/i18n';

/**
 * The language switch at the top right of the shop (asked by the owner): shows the other language
 * ("العربية" in English, "English" in Arabic), remembered in this browser.
 */
export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const other = locale === 'ar' ? 'en' : 'ar';
  return (
    <button
      type="button"
      onClick={() => setLocale(other)}
      lang={other === 'ar' ? 'ar' : 'en'}
      data-testid="language-switch"
      aria-label={other === 'ar' ? 'العربية: عرض المتجر بالعربية' : 'English: show the shop in English'}
      className={`h-10 px-3 rounded-full text-sm font-semibold text-ink border border-line-strong bg-surface hover:bg-sand-deep/60 ${className}`}
    >
      {other === 'ar' ? 'العربية' : 'English'}
    </button>
  );
}
