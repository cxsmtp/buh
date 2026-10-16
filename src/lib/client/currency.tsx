'use client';

import React, { useEffect, useState } from 'react';
import { getJson } from '@/lib/apiClient';
import { useShop } from './shop';

/**
 * Prices are in AED. Visitors outside the UAE also see an approximate price in
 * their own currency ("≈ ₹2,450"), worked out from their device's region and
 * time zone, with rates updated daily on the server. They always pay in AED.
 */

const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', IN: 'INR', PK: 'PKR', PH: 'PHP', BD: 'BDT', LK: 'LKR', NP: 'NPR', SA: 'SAR', OM: 'OMR', QA: 'QAR',
  KW: 'KWD', BH: 'BHD', EG: 'EGP', JO: 'JOD', CN: 'CNY', RU: 'RUB', CA: 'CAD', AU: 'AUD', CH: 'CHF', TR: 'TRY', IR: 'IRR',
  ZA: 'ZAR', NG: 'NGN', KE: 'KES', SG: 'SGD', MY: 'MYR', ID: 'IDR', JP: 'JPY', KR: 'KRW', UA: 'UAH',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', IE: 'EUR', PT: 'EUR', AT: 'EUR', GR: 'EUR', FI: 'EUR',
};

/** The visitor's currency, or null for the UAE (or when it can't be told). */
export function visitorCurrency(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz === 'Asia/Dubai') return null;
    const region = (navigator.languages?.[0] || navigator.language || '').split('-')[1]?.toUpperCase();
    if (!region || region === 'AE') return null;
    return REGION_CURRENCY[region] ?? null;
  } catch {
    return null;
  }
}

let ratesPromise: Promise<Record<string, number> | null> | null = null;
function loadRates() {
  ratesPromise ??= getJson<{ rates: { rates: Record<string, number> } | null }>('/api/rates').then(({ ok, data }) => {
    if (ok && data.rates) return data.rates.rates;
    ratesPromise = null; // none yet (the server fetches them): ask again next time
    return null;
  });
  return ratesPromise;
}

/** "≈ ₹2,450" next to an AED price, for visitors abroad (Settings → Store & contact). */
export function LocalPrice({ aed, className = '' }: { aed: number; className?: string }) {
  const { store } = useShop();
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!store.showLocalCurrency) return;
    const currency = visitorCurrency();
    if (!currency) return;
    let live = true;
    void loadRates().then((rates) => {
      const rate = rates?.[currency];
      if (!live || !rate) return;
      setShown(new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: aed * rate >= 100 ? 0 : 2 }).format(aed * rate));
    });
    return () => {
      live = false;
    };
  }, [aed, store.showLocalCurrency]);
  if (!shown) return null;
  return (
    <span className={`text-ink-muted font-normal ${className}`} title="Approximate; you pay in AED">
      ≈ {shown}
    </span>
  );
}
