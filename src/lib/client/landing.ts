'use client';

/**
 * Where a visitor came from, and moving a bag between browsers.
 *
 * Most customers arrive from Instagram or WhatsApp, often inside the app's own
 * browser, which keeps its own storage (a bag filled there is not in Safari or
 * Chrome). So:
 *  - the first source (utm_source, the referrer or the in-app browser) is kept
 *    for 30 days and sent with the order, so the owner sees what brings sales;
 *  - a bag can be carried as a link (?bag=…), e.g. "open in browser" or sent
 *    to oneself on WhatsApp, and is restored when the link is opened.
 */

export const SOURCES = ['instagram', 'whatsapp', 'facebook', 'tiktok', 'google', 'email', 'direct', 'other'] as const;
export type Source = (typeof SOURCES)[number];

export interface Landing {
  source: Source;
  campaign?: string;
}

const KEY = 'buh_source';
const KEEP_MS = 30 * 86_400_000;

function classify(params: URLSearchParams, referrer: string, ua: string): Source {
  const utm = (params.get('utm_source') || '').toLowerCase();
  const ref = referrer.toLowerCase();
  const hit = (...words: string[]) => words.some((w) => utm.includes(w) || ref.includes(w));
  if (params.has('igshid') || /instagram/i.test(ua) || hit('instagram', 'ig')) return 'instagram';
  if (/whatsapp/i.test(ua) || hit('whatsapp', 'wa.me')) return 'whatsapp';
  if (params.has('fbclid') || /FBAN|FBAV/.test(ua) || hit('facebook', 'fb.')) return 'facebook';
  if (/tiktok|musical_ly|bytedance/i.test(ua) || hit('tiktok')) return 'tiktok';
  if (params.has('gclid') || hit('google')) return 'google';
  if (hit('email', 'newsletter', 'mail')) return 'email';
  if (utm || ref) return 'other';
  return 'direct';
}

/** The first source seen in the last 30 days (recorded now if none). */
export function captureLanding(): Landing {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as (Landing & { at: number }) | null;
    if (saved && Date.now() - saved.at < KEEP_MS && SOURCES.includes(saved.source)) return { source: saved.source, campaign: saved.campaign };
  } catch {
    // storage blocked: work it out each time
  }
  const params = new URLSearchParams(window.location.search);
  const source = classify(params, document.referrer, navigator.userAgent);
  const campaign = (params.get('utm_campaign') || '').replace(/[^\w -]/g, '').slice(0, 60) || undefined;
  try {
    localStorage.setItem(KEY, JSON.stringify({ source, campaign, at: Date.now() }));
  } catch {
    // not essential
  }
  return { source, campaign };
}

/** True inside Instagram's, Facebook's, TikTok's or similar in-app browsers. */
export function inAppBrowser(): boolean {
  return /Instagram|FBAN|FBAV|TikTok|musical_ly|Line\//i.test(navigator.userAgent);
}

export interface BagLine {
  productId: string;
  profileId: string;
  color?: string;
  quantity: number;
}

/** The bag as a short link parameter. */
export function encodeBag(lines: BagLine[]): string {
  const compact = lines.slice(0, 20).map((l) => [l.productId, l.profileId, l.color ?? '', l.quantity]);
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(compact))));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Read ?bag=…; anything malformed gives an empty list (prices and stock are always rechecked). */
export function decodeBag(param: string | null): BagLine[] {
  if (!param || param.length > 4000) return [];
  try {
    const json = decodeURIComponent(escape(atob(param.replace(/-/g, '+').replace(/_/g, '/'))));
    const rows = JSON.parse(json) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 20).flatMap((r) => {
      if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string' || !Number.isInteger(r[3]) || r[3] < 1 || r[3] > 20) return [];
      return [{ productId: r[0].slice(0, 80), profileId: r[1].slice(0, 30), color: typeof r[2] === 'string' && r[2] ? r[2].slice(0, 40) : undefined, quantity: r[3] }];
    });
  } catch {
    return [];
  }
}
