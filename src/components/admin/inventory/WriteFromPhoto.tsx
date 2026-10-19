'use client';

import React, { useEffect, useId, useState } from 'react';
import { Check, Loader2, Palette, Sparkles, X } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';

/**
 * "Write name & descriptions from photo" in the product editor's Photos step. The chosen photo
 * (the cover unless the owner picks another) goes to the shop's server, which asks the AI chosen in
 * Settings → AI writing (src/lib/server/aiWriting.ts). The answer only fills the editor's fields:
 * nothing is saved until the owner publishes, as with anything typed.
 *
 * - Empty name and descriptions are filled in; when there is text already, the suggestion is shown
 *   next to it with "Use these" / "Keep mine".
 * - Colours and weave are offered, each added only with a tap (colours show to customers only once
 *   they are on the product).
 * - Without a key, the button stays and says how to switch it on.
 */

export interface PhotoText {
  title: string;
  shortDescription: string;
  description: string;
  colors: Array<{ name: string; hex: string }>;
  weave: string;
}

interface Suggestion {
  title: string;
  shortDescription: string;
  description: string;
  colors: Array<{ name: string; hex: string }>;
  weave: string | null;
  motif: string;
}

/** A new product's starting values: not the owner's facts, so not sent as hints. */
const NEW_DEFAULTS = { material: '100% Cotton', threadCount: '300', weave: 'Percale' };

export function WriteFromPhoto({
  photos,
  originals,
  isNew,
  current,
  facts,
  onApply,
}: {
  /** The editor's photos (uploaded URLs; first = cover). */
  photos: string[];
  /** Photos added in this session, as taken (data URLs). */
  originals: Record<string, string>;
  isNew: boolean;
  current: PhotoText;
  /** What the owner typed that the AI may use as given. */
  facts: { category: string; material: string; threadCount: string };
  onApply: (patch: Partial<PhotoText>) => void;
}) {
  const id = useId();
  const [pick, setPick] = useState(0);
  const [status, setStatus] = useState<{ ready: boolean; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Suggestion | null>(null);
  const [extras, setExtras] = useState<Suggestion | null>(null);
  const [filled, setFilled] = useState('');

  useEffect(() => {
    let live = true;
    void getJson<{ ready: boolean; reason: string | null }>('/api/admin/products/describe').then(({ ok, data }) => {
      if (live && ok) setStatus({ ready: data.ready, reason: data.reason });
    });
    return () => {
      live = false;
    };
  }, []);

  const chosen = photos[Math.min(pick, photos.length - 1)];

  const imageField = (src: string): Record<string, string> => {
    if (src.startsWith('/api/images/')) return { imageId: src.slice('/api/images/'.length) };
    if (src.startsWith('data:')) return { image: src };
    if (originals[src]) return { image: originals[src] };
    return { imageUrl: src };
  };

  const fill = (s: Suggestion) => {
    onApply({ title: s.title, shortDescription: s.shortDescription, description: s.description });
    setPreview(null);
    setFilled('Name, short and full description filled in from the photo. Check them in the next step (Details) and edit anything you like.');
  };

  const run = async () => {
    if (!chosen) return setError('Add a photo first.');
    setBusy(true);
    setError('');
    setFilled('');
    setPreview(null);
    setExtras(null);
    const hints: Record<string, unknown> = { category: facts.category, colors: current.colors.map((c) => c.name).filter(Boolean) };
    if (!isNew || facts.material !== NEW_DEFAULTS.material) hints.material = facts.material;
    if (!isNew || facts.threadCount !== NEW_DEFAULTS.threadCount) hints.threadCount = Number(facts.threadCount) || undefined;
    if (!isNew || current.weave !== NEW_DEFAULTS.weave) hints.weave = current.weave;
    const { ok, data } = await postJson<{ suggestion?: Suggestion; message?: string; code?: string }>('/api/admin/products/describe', { ...imageField(chosen), hints });
    setBusy(false);
    if (!ok || !data.suggestion) {
      if (data.code === 'ai_off') setStatus({ ready: false, reason: 'no_key' });
      return setError(data.message || 'Could not write from the photo. Please try again.');
    }
    const s = data.suggestion;
    setExtras(s);
    const hasText = Boolean(current.title.trim() || current.shortDescription.trim() || current.description.trim());
    if (hasText) setPreview(s);
    else fill(s);
  };

  const have = new Set(current.colors.map((c) => c.name.trim().toLowerCase()));
  const newColors = (extras?.colors ?? []).filter((c) => !have.has(c.name.toLowerCase()));
  const newWeave = extras?.weave && extras.weave !== current.weave ? extras.weave : null;

  return (
    <section className="rounded-2xl border border-gold/50 bg-surface p-3 space-y-3" aria-labelledby={`${id}-h`} data-testid="write-from-photo">
      <h3 id={`${id}-h`} className="sr-only">
        Write from photo
      </h3>
      {photos.length > 1 && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-ink">Photo to use</span>
          <select value={Math.min(pick, photos.length - 1)} onChange={(e) => setPick(Number(e.target.value))} className="min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm">
            {photos.map((_, i) => (
              <option key={i} value={i}>
                {i === 0 ? 'Photo 1 (cover)' : `Photo ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || !photos.length}
        aria-busy={busy}
        className="w-full min-h-12 rounded-xl bg-ink text-paper font-bold flex items-center justify-center gap-2 px-3 text-center disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden="true" /> : <Sparkles className="w-5 h-5 text-gold shrink-0" aria-hidden="true" />}
        {busy ? 'Looking at the photo…' : 'Write name & descriptions from photo'}
      </button>
      {!photos.length && <p className="text-xs text-ink-muted">Add a photo first: the AI writes from what it sees.</p>}
      {status && !status.ready && !error && (
        <p className="text-xs text-ink-soft" data-testid="ai-off-note">
          {status.reason === 'off'
            ? 'AI writing is switched off: switch it on in Settings → AI writing.'
            : status.reason === 'no_model'
            ? 'Choose a Gemini writing model: press Test in Settings → AI writing, pick one and save.'
            : 'To use this, add your AI key (Anthropic or Gemini) in Settings → AI writing (it stays on the shop’s server).'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-danger">
          {error}
        </p>
      )}
      {filled && (
        <p role="status" className="text-xs font-semibold text-success flex items-start gap-1">
          <Check className="w-4 h-4 shrink-0" aria-hidden="true" /> {filled}
        </p>
      )}

      {preview && (
        <div className="rounded-xl border border-line bg-ivory p-3 space-y-2" role="region" aria-label="Suggested text" data-testid="ai-preview">
          <p className="text-xs text-ink-soft">You already have some text. Here is the suggestion: use it, or keep yours.</p>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs font-semibold text-ink-muted">Name</dt>
              <dd className="text-ink font-semibold break-words">{preview.title || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-ink-muted">Short description</dt>
              <dd className="text-ink break-words">{preview.shortDescription || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-ink-muted">Full description</dt>
              <dd className="text-ink whitespace-pre-line break-words">{preview.description || '—'}</dd>
            </div>
          </dl>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => fill(preview)} className="min-h-11 rounded-xl bg-ink text-paper text-sm font-bold flex items-center justify-center gap-1">
              <Check className="w-4 h-4" aria-hidden="true" /> Use these
            </button>
            <button type="button" onClick={() => setPreview(null)} className="min-h-11 rounded-xl border border-line-strong bg-surface text-ink text-sm font-bold flex items-center justify-center gap-1">
              <X className="w-4 h-4" aria-hidden="true" /> Keep mine
            </button>
          </div>
        </div>
      )}

      {extras && (newColors.length > 0 || newWeave || extras.motif) && (
        <div className="space-y-2 text-sm" data-testid="ai-extras">
          {extras.motif && (
            <p className="text-xs text-ink-soft">
              Motif seen: <span className="text-ink">{extras.motif}</span>
            </p>
          )}
          {newColors.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <ul className="flex flex-wrap gap-1.5" aria-label="Colours seen">
                {newColors.map((c) => (
                  <li key={c.name} className="inline-flex items-center gap-1 rounded-full border border-line bg-ivory px-2 py-1 text-xs text-ink">
                    <span className="w-3.5 h-3.5 rounded-full border border-line-strong" style={{ background: c.hex }} aria-hidden="true" />
                    {c.name}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => {
                  onApply({ colors: [...current.colors, ...newColors].slice(0, 12) });
                }}
                className="min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-sm font-semibold inline-flex items-center gap-1"
              >
                <Palette className="w-4 h-4" aria-hidden="true" /> Add {newColors.length === 1 ? 'this colour' : 'these colours'}
              </button>
            </div>
          )}
          {newWeave && (
            <button type="button" onClick={() => onApply({ weave: newWeave })} className="min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-sm font-semibold">
              Set weave to {newWeave}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
