'use client';

import React, { useEffect, useState } from 'react';
import { getJson } from '@/lib/apiClient';
import { DESCRIPTION_MAX, fitDescription, fitTitle, TITLE_MAX } from '@/lib/seo/text';
import { SEO_LIMITS } from '@/lib/seo/types';

/**
 * How a page looks in Google's results: the address, the blue title and the grey description,
 * cut where Google would cut them (about 60 and 155 characters). Used in Settings → Search (SEO)
 * and in the product editor's Publish step.
 */
export function SnippetPreview({ title, url, description, testId }: { title: string; url: string; description: string; testId?: string }) {
  const shownTitle = title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
  const shownDescription = description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : description;
  let crumbs = url;
  try {
    const u = new URL(url);
    crumbs = `${u.host}${u.pathname === '/' ? '' : u.pathname.split('/').filter(Boolean).map((s) => ` › ${decodeURIComponent(s)}`).join('')}`;
  } catch {
    // shown as given
  }
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5 min-w-0" data-testid={testId ?? 'snippet-preview'}>
      <p className="text-[12px] text-ink-soft truncate">{crumbs}</p>
      <p className="text-[17px] leading-snug font-medium text-ink underline decoration-line-strong underline-offset-2 break-words">{shownTitle || <span className="text-ink-muted">No title</span>}</p>
      <p className="text-[13px] leading-snug text-ink-soft break-words">{shownDescription || <span className="text-ink-muted">No description: Google picks some words from the page.</span>}</p>
    </div>
  );
}

/** "48 / 60", in warning colours past the limit. */
export function CharCount({ n, max, id }: { n: number; max: number; id?: string }) {
  return (
    <span id={id} className={`text-[11px] tabular-nums ${n > max ? 'text-danger font-semibold' : 'text-ink-muted'}`} aria-live="polite">
      {n} / {max}
    </span>
  );
}

let cachedShop = '';

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';

/**
 * The product editor's "Search (Google)" fields: optional; empty means the shop writes them
 * ("<name> | <shop>", and the short description cut at a sentence). Live preview and counters.
 */
export function ProductSeoFields({
  name,
  shop,
  url,
  categoryLabel,
  shortDescription,
  description,
  seoTitle,
  seoDescription,
  onChange,
}: {
  name: string;
  /** The shop's name (read from the shop's public settings when not given). */
  shop?: string;
  url: string;
  /** The category's name (the description made when no text is written says it). */
  categoryLabel?: string;
  shortDescription: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  onChange: (patch: { seoTitle?: string; seoDescription?: string }) => void;
}) {
  const [shopName, setShopName] = useState(shop ?? cachedShop);
  useEffect(() => {
    if (shopName) return;
    let alive = true;
    void getJson<{ brand?: { storeName?: string } }>('/api/settings/public').then((r) => {
      const n = r.data?.brand?.storeName || 'Beautiful UAE Home';
      cachedShop = n;
      if (alive) setShopName(n);
    });
    return () => {
      alive = false;
    };
  }, [shopName]);
  const autoTitle = fitTitle(name || 'Product name', shopName || 'Beautiful UAE Home');
  // As the shop writes it (src/lib/server/seo.ts productDescription).
  const autoDescription =
    fitDescription(shortDescription || '') ||
    fitDescription(description || '') ||
    (name.trim() ? fitDescription(`${name.trim()}${categoryLabel ? `, ${categoryLabel.toLowerCase()}` : ''} from ${shopName || 'Beautiful UAE Home'}, delivered across the UAE.`) : '');
  const title = seoTitle.trim() || autoTitle;
  const desc = seoDescription.trim() || autoDescription;
  return (
    <details className="rounded-xl border border-line bg-surface px-3 py-2" data-testid="product-seo">
      <summary className="cursor-pointer min-h-11 flex items-center text-sm font-semibold text-ink">Search (Google): title and description</summary>
      <div className="space-y-3 pt-2 pb-1">
        <SnippetPreview title={title} url={url} description={desc} testId="product-snippet-preview" />
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="pe-seo-title" className="text-xs font-semibold text-ink-soft">SEO title (optional)</label>
            <CharCount n={title.length} max={TITLE_MAX} />
          </div>
          <input id="pe-seo-title" className={field} value={seoTitle} maxLength={SEO_LIMITS.title} placeholder={autoTitle} onChange={(e) => onChange({ seoTitle: e.target.value })} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="pe-seo-description" className="text-xs font-semibold text-ink-soft">SEO description (optional)</label>
            <CharCount n={desc.length} max={DESCRIPTION_MAX} />
          </div>
          <textarea id="pe-seo-description" className={`${field} min-h-20`} value={seoDescription} maxLength={SEO_LIMITS.description} placeholder={autoDescription || 'Written from the short description'} onChange={(e) => onChange({ seoDescription: e.target.value })} />
        </div>
        <p className="text-[11px] text-ink-muted">Left empty, the shop writes them from the name and the short description, and keeps them up to date.</p>
      </div>
    </details>
  );
}
