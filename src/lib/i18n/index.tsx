'use client';

import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';

/**
 * The shop in two languages, English and UAE Arabic (asked by the owner). The language is the
 * visitor's own choice when they made one (the switch at the top right, remembered in this browser),
 * otherwise their device's language (Arabic when it is Arabic, else English). Arabic is laid out
 * right to left. Only the shop's own words are translated here; product names and descriptions show
 * their Arabic version when the owner has added one (Catalogue), else the English.
 *
 * Each screen keeps its words beside it: `const t = useT(WORDS)` with WORDS = { key: { en, ar } };
 * `t('key', { name: 'Layla' })` fills {name}. A key with no Arabic falls back to the English.
 */

export type Locale = 'en' | 'ar';
export type Words = Record<string, { en: string; ar: string }>;

export { LOCALE_KEY } from './boot';
import { LOCALE_KEY } from './boot';

/** The language to start in: the visitor's stored choice, else the device's. */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved === 'en' || saved === 'ar') return saved;
  } catch {
    // storage unavailable: the device decides
  }
  const langs = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return langs.some((l) => /^ar\b/i.test(l ?? '')) ? 'ar' : 'en';
}

/** Put the page in this language's direction at once (also run by the inline script before paint). */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale === 'ar' ? 'ar-AE' : 'en';
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
}

interface Ctx {
  locale: Locale;
  setLocale: (l: Locale) => void;
}
const LocaleContext = createContext<Ctx>({ locale: 'en', setLocale: () => undefined });

// The visitor's language lives outside React (their saved choice or their device), so it is read
// with useSyncExternalStore: English on the server and while hydrating, theirs right after.
const listeners = new Set<() => void>();
let current: Locale | null = null;
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function snapshot(): Locale {
  if (current === null) {
    current = detectLocale();
    applyDocumentLocale(current);
  }
  return current;
}
const serverSnapshot = (): Locale => 'en';

/** The shop's language for everything inside (ShopApp and the pages around it). */
export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const setLocale = useCallback((l: Locale) => {
    try {
      localStorage.setItem(LOCALE_KEY, l);
    } catch {
      // not remembered: still switched for this visit
    }
    current = l;
    applyDocumentLocale(l);
    listeners.forEach((fn) => fn());
  }, []);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Ctx {
  return useContext(LocaleContext);
}

/** Fill {name} placeholders. */
export function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}

/**
 * One of a screen's words in a language (for code outside a component, and for tests). In Arabic,
 * each filled-in value (an English product or delivery name, "1–2 days", a number) is isolated, so
 * it keeps its own order inside the right-to-left sentence.
 */
export function translate<W extends Words>(words: W, key: keyof W & string, locale: Locale, vars?: Record<string, string | number>): string {
  const w = words[key];
  if (!w) return key;
  if (locale !== 'ar' || !w.ar) return fill(w.en, vars);
  return fill(w.ar, vars && Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, `\u2068${v}\u2069`])));
}

/** The words of one screen in the current language. */
export function useT<W extends Words>(words: W): (key: keyof W & string, vars?: Record<string, string | number>) => string {
  const { locale } = useLocale();
  return useCallback((key, vars) => translate(words, key, locale, vars), [locale, words]);
}

/** Numbers stay in Western digits in both languages (prices, phone numbers, order numbers), as UAE shops do. */
export const isArabic = (l: Locale) => l === 'ar';
