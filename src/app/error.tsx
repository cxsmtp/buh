'use client';

import { useEffect, useState } from 'react';
import { reloadOnceForChunk } from '@/lib/client/chunkReload';
import { detectLocale, type Locale } from '@/lib/i18n';

/**
 * When a page of the shop breaks (most often: the shop was updated while this page was open, and a
 * piece of the old version is gone), the customer gets the shop's own words and a Reload button,
 * never a blank "Application error" page. A missing piece reloads the page once by itself. The bag
 * and the details typed at checkout are saved in the browser, so nothing is lost.
 * (The Admin Hub has its own: src/app/hub/error.tsx.)
 */
const WORDS = {
  en: { title: 'Please reload the page', text: 'Something went wrong while showing this page. Your bag and your details are saved.', reload: 'Reload', again: 'Try again', loading: 'One moment…' },
  ar: { title: 'يرجى إعادة تحميل الصفحة', text: 'حدث خطأ أثناء عرض هذه الصفحة. حقيبتك وبياناتك محفوظة.', reload: 'إعادة التحميل', again: 'حاول مرة أخرى', loading: 'لحظة من فضلك…' },
} as const;

export default function ShopError({ error, retry }: { error: unknown; retry: () => void }) {
  const [locale, setLocale] = useState<Locale>('en');
  // reloading: a missing piece of the shop, and the page is loading again by itself.
  const [reloading, setReloading] = useState(true);
  useEffect(() => {
    // After mount only (the browser's language and storage are not known on the server).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocale(detectLocale());
    setReloading(reloadOnceForChunk(error));
  }, [error]);
  const w = WORDS[locale];

  return (
    <main className="min-h-screen bg-ivory flex items-center justify-center px-4" dir={locale === 'ar' ? 'rtl' : 'ltr'} lang={locale === 'ar' ? 'ar-AE' : 'en'}>
      {reloading ? (
        <p role="status" className="text-sm text-ink-soft">{w.loading}</p>
      ) : (
        <div role="alert" data-testid="shop-error" className="max-w-sm w-full space-y-3 text-ink text-center">
          <h1 className="font-serif text-2xl">{w.title}</h1>
          <p className="text-sm text-ink-soft">{w.text}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" onClick={() => window.location.reload()} className="min-h-11 px-5 rounded-full bg-ink text-paper text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2">
              {w.reload}
            </button>
            <button type="button" onClick={() => retry()} className="min-h-11 px-5 rounded-full border border-line-strong text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
              {w.again}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
