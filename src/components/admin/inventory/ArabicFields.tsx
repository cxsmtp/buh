'use client';

import React, { useState } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import { postJson } from '@/lib/apiClient';

export interface ArabicDraft {
  titleAr: string;
  shortDescriptionAr: string;
  descriptionAr: string;
}

/**
 * The product's words for the Arabic shop. Empty fields show the English text there. "Translate to
 * Arabic" fills them from the English (with the main photo for context, through AI writing); nothing
 * is saved until the owner saves the product, so every word can be checked and edited first.
 */
export function ArabicFields({
  value,
  english,
  photo,
  original,
  field,
  label,
  onChange,
}: {
  value: ArabicDraft;
  english: { title: string; shortDescription: string; description: string };
  photo?: string;
  original?: string;
  field: string;
  label: string;
  onChange: (patch: Partial<ArabicDraft>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const translate = async () => {
    setError('');
    if (!english.title.trim()) return setError('Give the product an English name first.');
    if (!photo) return setError('Add a photo first: the translation uses it to pick the right words.');
    const image: Record<string, string> = photo.startsWith('/api/images/') ? { imageId: photo.slice('/api/images/'.length) } : photo.startsWith('data:') ? { image: photo } : original ? { image: original } : { imageUrl: photo };
    setBusy(true);
    const { ok, data } = await postJson<{ titleAr?: string; shortDescriptionAr?: string; descriptionAr?: string; message?: string }>('/api/admin/products/translate', {
      ...image,
      title: english.title.trim(),
      shortDescription: english.shortDescription.trim(),
      description: english.description.trim(),
    });
    setBusy(false);
    if (!ok || !data.titleAr) return setError(data.message || 'Could not translate. Please try again.');
    onChange({ titleAr: data.titleAr, shortDescriptionAr: data.shortDescriptionAr ?? '', descriptionAr: data.descriptionAr ?? '' });
  };

  return (
    <fieldset className="sm:col-span-2 space-y-3 rounded-xl border border-line p-3" data-testid="pe-arabic">
      <legend className={`${label} px-1`}>Arabic shop (optional)</legend>
      <p className="text-xs text-ink-soft">Shoppers who read Arabic see these. Left empty, they see the English. Check the words before you save.</p>
      <button type="button" onClick={() => void translate()} disabled={busy} className="inline-flex items-center gap-2 min-h-10 px-3 rounded-lg border border-line-strong text-sm font-semibold disabled:opacity-60" data-testid="pe-translate">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Languages className="w-4 h-4" aria-hidden="true" />}
        {busy ? 'Translating…' : 'Translate to Arabic'}
      </button>
      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      <div>
        <label className={label} htmlFor="pe-title-ar">
          Arabic title
        </label>
        <input id="pe-title-ar" dir="rtl" lang="ar" className={field} value={value.titleAr} maxLength={160} onChange={(e) => onChange({ titleAr: e.target.value })} />
      </div>
      <div>
        <label className={label} htmlFor="pe-short-ar">
          Arabic card line
        </label>
        <input id="pe-short-ar" dir="rtl" lang="ar" className={field} value={value.shortDescriptionAr} maxLength={300} onChange={(e) => onChange({ shortDescriptionAr: e.target.value })} />
      </div>
      <div>
        <label className={label} htmlFor="pe-desc-ar">
          Arabic details
        </label>
        <textarea id="pe-desc-ar" dir="rtl" lang="ar" className={`${field} min-h-[90px]`} value={value.descriptionAr} maxLength={4000} onChange={(e) => onChange({ descriptionAr: e.target.value })} />
      </div>
    </fieldset>
  );
}
