'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { BedDouble, Check, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { STAGING_EXTRA_MAX, STAGING_PRESETS } from '@/lib/staging';

/**
 * "Style in a bedroom" in the product editor's Photos step. The chosen photo goes to the shop's
 * server, which asks Google Gemini (the owner's key, Settings → AI writing) for the same product in
 * a bedroom (src/lib/server/stagePhoto.ts). The result is a NEW photo: the original stays as it is
 * and stays first. The owner looks at both side by side and adds it, tries again or discards it.
 * Shoppers see a small "Styled image" tag on it (Settings → AI writing, on by default).
 */

/** The server waits up to 90 seconds for Gemini; a little longer here. */
const WAIT_MS = 95_000;

interface Result {
  url: string;
  source: string;
  model: string;
}

export function StageInBedroom({
  photos,
  originals,
  room,
  onAdd,
}: {
  /** The editor's photos (uploaded URLs; first = cover). */
  photos: string[];
  /** Photos added in this session, as taken (data URLs). */
  originals: Record<string, string>;
  /** How many more photos the product can take. */
  room: number;
  /** Add the styled photo after the one it was made from. */
  onAdd: (url: string, after: string) => void;
}) {
  const id = useId();
  const [pick, setPick] = useState(0);
  const [preset, setPreset] = useState(STAGING_PRESETS[0].id);
  const [extra, setExtra] = useState('');
  const [status, setStatus] = useState<{ ready: boolean; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [note, setNote] = useState('');
  const run = useRef(0);

  useEffect(() => {
    let live = true;
    void getJson<{ ready: boolean; reason: string | null }>('/api/admin/products/stage-photo').then(({ ok, data }) => {
      if (live && ok) setStatus({ ready: data.ready, reason: data.reason });
    });
    return () => {
      live = false;
    };
  }, []);

  const chosen = photos[Math.min(pick, photos.length - 1)];

  const imageField = (src: string): Record<string, string> | null => {
    if (src.startsWith('/api/images/')) return { imageId: src.slice('/api/images/'.length) };
    if (src.startsWith('data:')) return { image: src };
    if (originals[src]) return { image: originals[src] };
    return null;
  };

  const discard = async (r: Result | null) => {
    if (r) await sendJson('DELETE', '/api/admin/products/stage-photo', { url: r.url });
  };

  const start = async () => {
    if (!chosen) return setError('Add a photo first.');
    const field = imageField(chosen);
    if (!field) return setError('This photo is not stored in the shop: add it again from the gallery, then style it.');
    const mine = ++run.current;
    setBusy(true);
    setError('');
    setNote('');
    const previous = result;
    setResult(null);
    // The earlier picture (Try again) is thrown away first.
    await discard(previous);
    const call = postJson<{ url?: string; staged?: { source: string }; model?: string; message?: string; code?: string }>('/api/admin/products/stage-photo', { ...field, preset, ...(extra.trim() ? { extra: extra.trim() } : {}) });
    const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), WAIT_MS));
    const answer = await Promise.race([call, late]);
    if (mine !== run.current) return;
    setBusy(false);
    if (answer === 'late') {
      // A picture that arrives after this is not wanted: thrown away when it comes.
      void call.then(({ ok, data }) => {
        if (ok && data.url) void discard({ url: data.url, source: '', model: '' });
      });
      return setError('Gemini took too long. Please try again in a moment.');
    }
    const { ok, data } = answer;
    if (!ok || !data.url) {
      if (data.code === 'staging_off') setStatus({ ready: false, reason: 'no_key' });
      return setError(data.message || 'Could not style the photo. Please try again.');
    }
    setResult({ url: data.url, source: chosen, model: data.model ?? '' });
  };

  const add = () => {
    if (!result) return;
    if (room <= 0) return setError('This product already has 8 photos: remove one first.');
    onAdd(result.url, result.source);
    setResult(null);
    setNote('Added after the original photo. Shoppers see a small “Styled image” tag on it.');
  };

  const off = status && !status.ready;

  return (
    <section className="rounded-2xl border border-line bg-surface p-3 space-y-3" aria-labelledby={`${id}-h`} data-testid="stage-in-bedroom">
      <h3 id={`${id}-h`} className="font-semibold text-ink flex items-center gap-2">
        <BedDouble className="w-4 h-4 text-gold-deep shrink-0" aria-hidden="true" /> Style in a bedroom (AI)
      </h3>
      <p className="text-xs text-ink-soft">Gemini places this product in a bedroom and makes a new photo. Your original photo is kept as it is.</p>
      {off ? (
        <p className="text-xs text-ink-soft" data-testid="stage-off-note">
          To use this, add a Google Gemini key in Settings → AI writing (aistudio.google.com → Get API key). It stays on the shop&rsquo;s server.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {photos.length > 1 && (
            <label className="block text-sm sm:col-span-2">
              <span className="block font-semibold text-ink mb-1">Photo to style</span>
              <select value={Math.min(pick, photos.length - 1)} onChange={(e) => setPick(Number(e.target.value))} className="w-full min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm">
                {photos.map((_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? 'Photo 1 (cover)' : `Photo ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="block font-semibold text-ink mb-1">Style</span>
            <select value={preset} onChange={(e) => setPreset(e.target.value)} className="w-full min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm">
              {STAGING_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="block font-semibold text-ink mb-1">Extra words (optional)</span>
            <input value={extra} maxLength={STAGING_EXTRA_MAX} onChange={(e) => setExtra(e.target.value)} placeholder="e.g. morning light, olive green wall" className="w-full min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm" />
          </label>
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy || !photos.length}
            aria-busy={busy}
            className="sm:col-span-2 w-full min-h-12 rounded-xl bg-ink text-paper font-bold flex items-center justify-center gap-2 px-3 text-center disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden="true" /> : <BedDouble className="w-5 h-5 text-gold shrink-0" aria-hidden="true" />}
            {busy ? 'Styling the photo…' : 'Style in a bedroom'}
          </button>
        </div>
      )}
      {busy && (
        <p role="status" className="text-xs text-ink-soft">
          This usually takes 10 to 30 seconds.
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-danger">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="text-xs font-semibold text-success flex items-start gap-1">
          <Check className="w-4 h-4 shrink-0" aria-hidden="true" /> {note}
        </p>
      )}
      {result && (
        <div className="space-y-2 max-w-lg" role="region" aria-label="Styled photo" data-testid="stage-result">
          <div className="grid grid-cols-2 gap-2">
            <figure className="min-w-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result.source} alt="Original photo" className="w-full aspect-[4/5] object-cover rounded-xl border border-line" />
              <figcaption className="text-[11px] text-ink-soft mt-1">Original</figcaption>
            </figure>
            <figure className="min-w-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={result.url} alt="Styled photo" className="w-full aspect-[4/5] object-cover rounded-xl border border-gold" />
              <figcaption className="text-[11px] text-ink-soft mt-1">Styled by AI</figcaption>
            </figure>
          </div>
          <p className="text-xs font-semibold text-ink">Check the pattern and colours match the real product before adding.</p>
          <div className="grid grid-cols-3 gap-2">
            <button type="button" onClick={add} className="min-h-11 rounded-xl bg-ink text-paper text-sm font-bold flex items-center justify-center gap-1 px-1">
              <Check className="w-4 h-4 shrink-0" aria-hidden="true" /> Add to photos
            </button>
            <button type="button" onClick={() => void start()} className="min-h-11 rounded-xl border border-line-strong bg-surface text-ink text-sm font-bold flex items-center justify-center gap-1 px-1">
              <RotateCcw className="w-4 h-4 shrink-0" aria-hidden="true" /> Try again
            </button>
            <button
              type="button"
              onClick={() => {
                void discard(result);
                setResult(null);
              }}
              className="min-h-11 rounded-xl border border-line-strong bg-surface text-danger text-sm font-bold flex items-center justify-center gap-1 px-1"
            >
              <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" /> Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
