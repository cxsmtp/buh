'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { BedDouble, Check, CheckCheck, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { DEFAULT_STAGING_SET, STAGING_EXTRA_MAX, STAGING_FIXED_RULES, STAGING_MAX_SET, STAGING_PRESETS, STAGING_SCENE_MAX } from '@/lib/staging';

/**
 * "Style in a bedroom" in the product editor's Photos step. The chosen photo goes to the shop's
 * server, which asks Google Gemini (the owner's key, Settings → AI writing) for the same product in
 * a new setting (src/lib/server/stagePhoto.ts). One press makes 3 pictures side by side (the whole
 * bed, a close-up of the print and a lifestyle moment; the owner can pick 1–4 others), each shown
 * as it arrives with its own Add, Try again and Discard, plus Add all. One failing loses none of the
 * others. Each result is a NEW photo: the original stays as it is and stays first. The owner can
 * reword each scene and add a note; the fixed rules (the product unchanged, no people, no text) are
 * always sent after them. Shoppers see a small "Styled image" tag on styled photos.
 */

/** The server waits up to 90 seconds for Gemini; a little longer here. */
const WAIT_MS = 95_000;

interface Slot {
  key: number;
  preset: string;
  state: 'busy' | 'done' | 'failed';
  url?: string;
  error?: string;
}

const PRESET_NAME = Object.fromEntries(STAGING_PRESETS.map((p) => [p.id, p.name]));
const PRESET_SHOT = Object.fromEntries(STAGING_PRESETS.map((p) => [p.id, p.shot]));
const input = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const base = 'min-h-11 rounded-xl border text-sm font-bold flex items-center justify-center gap-1 px-1 disabled:opacity-50';
const btn = `${base} border-line-strong bg-surface text-ink`;

export function StageInBedroom({
  photos,
  originals,
  room,
  notes,
  onNotes,
  context,
  onAdd,
}: {
  /** The editor's photos (uploaded URLs; first = cover). */
  photos: string[];
  /** Photos added in this session, as taken (data URLs). */
  originals: Record<string, string>;
  /** How many more photos the product can take. */
  room: number;
  /** The owner's note (kept with the editor's draft, so it is there next time). */
  notes: string;
  onNotes: (v: string) => void;
  /** The product's own words, so the setting suits it (never changes the product). */
  context: { title?: string; motif?: string; colors?: string[]; design?: string };
  /** Add the styled photo after the one it was made from. */
  onAdd: (url: string, after: string) => void;
}) {
  const id = useId();
  const [pick, setPick] = useState(0);
  const [chosenSet, setChosenSet] = useState<string[]>(DEFAULT_STAGING_SET);
  const [scenes, setScenes] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ ready: boolean; reason: string | null; writer?: string } | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const counter = useRef(0);
  /** Slots still on screen: a picture that arrives for one discarded meanwhile is thrown away. */
  const live = useRef(new Set<number>());

  useEffect(() => {
    let live = true;
    void getJson<{ ready: boolean; reason: string | null; writer?: string }>('/api/admin/products/stage-photo').then(({ ok, data }) => {
      if (live && ok) setStatus({ ready: data.ready, reason: data.reason, writer: data.writer });
    });
    return () => {
      live = false;
    };
  }, []);

  const chosen = photos[Math.min(pick, photos.length - 1)];
  const busy = slots.some((s) => s.state === 'busy');

  const imageField = (src: string): Record<string, string> | null => {
    if (src.startsWith('/api/images/')) return { imageId: src.slice('/api/images/'.length) };
    if (src.startsWith('data:')) return { image: src };
    if (originals[src]) return { image: originals[src] };
    return null;
  };

  const discard = async (url?: string) => {
    if (url) await sendJson('DELETE', '/api/admin/products/stage-photo', { url });
  };

  /** One picture for one slot (its own request: each one is checked, stored and counted on its own). */
  const make = async (key: number, preset: string, field: Record<string, string>) => {
    const scene = (scenes[preset] ?? '').trim();
    const ctx = Object.fromEntries(Object.entries(context).filter(([, v]) => (Array.isArray(v) ? v.length : typeof v === 'string' && v.trim())));
    const call = postJson<{ url?: string; message?: string; code?: string }>('/api/admin/products/stage-photo', {
      ...field,
      preset,
      ...(notes.trim() ? { extra: notes.trim() } : {}),
      ...(scene && scene !== PRESET_SHOT[preset] ? { scene } : {}),
      ...(Object.keys(ctx).length ? { context: ctx } : {}),
    });
    const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), WAIT_MS));
    const answer = await Promise.race([call, late]);
    const update = (patch: Partial<Slot>) => setSlots((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    if (answer === 'late') {
      // A picture that arrives after this is not wanted: thrown away when it comes.
      void call.then(({ ok, data }) => {
        if (ok && data.url) void discard(data.url);
      });
      return update({ state: 'failed', error: 'Gemini took too long. Try again in a moment.' });
    }
    const { ok, data } = answer;
    if (!ok || !data.url) {
      if (data.code === 'staging_off') setStatus((st) => ({ ...(st ?? {}), ready: false, reason: 'no_key' }));
      return update({ state: 'failed', error: data.message || 'Could not style the photo. Please try again.' });
    }
    // Discarded (or tried again) while it was being made: thrown away.
    if (!live.current.has(key)) return void discard(data.url);
    update({ state: 'done', url: data.url });
  };

  const start = async () => {
    if (!chosen) return setError('Add a photo first.');
    const field = imageField(chosen);
    if (!field) return setError('This photo is not stored in the shop: add it again from the gallery, then style it.');
    if (!chosenSet.length) return setError('Choose at least one picture to make.');
    setError('');
    setNote('');
    // Earlier pictures not added are thrown away first.
    for (const s of slots) if (s.url) void discard(s.url);
    setSource(chosen);
    const fresh = chosenSet.map((preset) => ({ key: ++counter.current, preset, state: 'busy' as const }));
    live.current = new Set(fresh.map((s) => s.key));
    setSlots(fresh);
    await Promise.allSettled(fresh.map((s) => make(s.key, s.preset, field)));
  };

  const retry = async (slot: Slot) => {
    const field = imageField(source);
    if (!field) return setError('This photo is not stored in the shop: add it again from the gallery, then style it.');
    void discard(slot.url);
    const key = ++counter.current;
    live.current.delete(slot.key);
    live.current.add(key);
    setSlots((all) => all.map((s) => (s.key === slot.key ? { key, preset: slot.preset, state: 'busy' } : s)));
    await make(key, slot.preset, field);
  };

  const remove = (slot: Slot) => {
    live.current.delete(slot.key);
    void discard(slot.url);
    setSlots((all) => all.filter((s) => s.key !== slot.key));
  };

  const add = (slots: Slot[]) => {
    const ready = slots.filter((s) => s.state === 'done' && s.url);
    if (!ready.length) return;
    if (room <= 0) return setError('This product already has 8 photos: remove one first.');
    const taking = ready.slice(0, room);
    // Added in order, each after the original (so the last added sits right after it): reversed here.
    for (const s of [...taking].reverse()) onAdd(s.url!, source);
    for (const t of taking) live.current.delete(t.key);
    setSlots((all) => all.filter((s) => !taking.some((t) => t.key === s.key)));
    setError(taking.length < ready.length ? `Only ${room} more ${room === 1 ? 'photo fits' : 'photos fit'}: remove one to add the rest.` : '');
    setNote(`${taking.length === 1 ? 'Added' : `${taking.length} added`} after the original photo. Shoppers see a small “Styled image” tag on ${taking.length === 1 ? 'it' : 'them'}.`);
  };

  const toggle = (preset: string) =>
    setChosenSet((set) => (set.includes(preset) ? set.filter((p) => p !== preset) : set.length >= STAGING_MAX_SET ? set : [...set, preset]));

  const off = status && !status.ready;
  const writerNote = status?.writer && status.writer !== 'gemini' ? ` Your text is written by ${status.writer === 'deepseek' ? 'DeepSeek' : 'Claude'}; styling always uses Gemini.` : '';
  const done = slots.filter((s) => s.state === 'done');

  return (
    <section className="rounded-2xl border border-line bg-surface p-3 space-y-3 min-w-0" aria-labelledby={`${id}-h`} data-testid="stage-in-bedroom">
      <h3 id={`${id}-h`} className="font-semibold text-ink flex items-center gap-2">
        <BedDouble className="w-4 h-4 text-gold-deep shrink-0" aria-hidden="true" /> Style in a bedroom (AI)
      </h3>
      <p className="text-xs text-ink-soft">Gemini makes new photos of this product to help shoppers decide: the whole bed, a close-up of the print, and a lifestyle moment. Your original photo is kept as it is.{writerNote}</p>
      {off ? (
        <p className="text-xs text-ink-soft" data-testid="stage-off-note">
          Styling uses Google Gemini (even when Claude or DeepSeek writes your text): add a Gemini key in Settings → AI writing (aistudio.google.com → Get API key). It stays on the shop&rsquo;s server.
        </p>
      ) : (
        <div className="space-y-3">
          {photos.length > 1 && (
            <label className="block text-sm">
              <span className="block font-semibold text-ink mb-1">Photo to style</span>
              <select value={Math.min(pick, photos.length - 1)} onChange={(e) => setPick(Number(e.target.value))} className={`${input} min-h-11`}>
                {photos.map((_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? 'Photo 1 (cover)' : `Photo ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold text-ink mb-1">Pictures to make (1 to {STAGING_MAX_SET})</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {STAGING_PRESETS.map((p) => (
                <label key={p.id} className="min-h-11 flex items-center gap-2 text-sm rounded-xl border border-line px-2">
                  <input type="checkbox" className="w-5 h-5 shrink-0" checked={chosenSet.includes(p.id)} disabled={!chosenSet.includes(p.id) && chosenSet.length >= STAGING_MAX_SET} onChange={() => toggle(p.id)} />
                  <span className="min-w-0 break-words">{p.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm">
            <span className="block font-semibold text-ink mb-1">Your note for every picture (optional)</span>
            <input value={notes} maxLength={STAGING_EXTRA_MAX} onChange={(e) => onNotes(e.target.value)} placeholder="e.g. morning light, olive green wall" className={`${input} min-h-11`} aria-label="Your note (optional)" />
            <span className="block text-[11px] text-ink-muted mt-1">
              Kept with this product&rsquo;s draft. Up to {STAGING_EXTRA_MAX} characters.
            </span>
          </label>
          <details className="rounded-xl border border-line px-3 py-2" data-testid="stage-prompt">
            <summary className="min-h-11 flex items-center font-semibold cursor-pointer text-sm">What Gemini is asked (edit the scenes)</summary>
            <div className="space-y-2 pb-2">
              {chosenSet.map((preset) => (
                <label key={preset} className="block text-sm">
                  <span className="block font-semibold text-ink mb-1">{PRESET_NAME[preset]}: scene</span>
                  <textarea rows={3} maxLength={STAGING_SCENE_MAX} value={scenes[preset] ?? PRESET_SHOT[preset]} onChange={(e) => setScenes((s) => ({ ...s, [preset]: e.target.value }))} className={input} aria-label={`Scene for ${PRESET_NAME[preset]}`} />
                </label>
              ))}
              {notes.trim() && <p className="text-xs text-ink-soft break-words">Your note: {notes.trim()}</p>}
              <div className="text-xs text-ink-muted">
                <p className="font-semibold">Always added after your words (they can&rsquo;t be changed):</p>
                <ul className="list-disc pl-4 space-y-0.5">
                  {STAGING_FIXED_RULES.filter((r) => !r.startsWith('-')).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
          <button
            type="button"
            onClick={() => void start()}
            disabled={busy || !photos.length || !chosenSet.length}
            aria-busy={busy}
            className="w-full min-h-12 rounded-xl bg-ink text-paper font-bold flex items-center justify-center gap-2 px-3 text-center disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden="true" /> : <BedDouble className="w-5 h-5 text-gold shrink-0" aria-hidden="true" />}
            {busy ? 'Styling the photo…' : `Style in a bedroom (${chosenSet.length} ${chosenSet.length === 1 ? 'picture' : 'pictures'}, Gemini)`}
          </button>
        </div>
      )}
      {busy && (
        <p role="status" className="text-xs text-ink-soft">
          Each picture usually takes 10 to 30 seconds; they appear as they are ready.
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
      {slots.length > 0 && (
        <div className="space-y-2" role="region" aria-label="Styled photos" data-testid="stage-results">
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={source} alt="Original photo" className="w-16 aspect-[4/5] object-cover rounded-lg border border-line" />
            <p className="text-xs font-semibold text-ink">Check the pattern and colours match the real product before adding.</p>
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {slots.map((s) => (
              <li key={s.key} className="min-w-0 space-y-2 rounded-xl border border-line p-2" data-testid="stage-result" aria-label={PRESET_NAME[s.preset]}>
                <p className="text-xs font-semibold text-ink break-words">{PRESET_NAME[s.preset]}</p>
                {s.state === 'busy' && (
                  <div className="w-full aspect-[4/5] rounded-xl border border-dashed border-line-strong flex flex-col items-center justify-center gap-1 text-ink-soft">
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    <span className="text-[11px]">Styling…</span>
                  </div>
                )}
                {s.state === 'failed' && (
                  <p role="alert" className="text-xs font-semibold text-danger break-words" data-testid="stage-failed">
                    Not made: {s.error}
                  </p>
                )}
                {s.state === 'done' && s.url && (
                  <figure className="min-w-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.url} alt={`Styled photo: ${PRESET_NAME[s.preset]}`} className="w-full aspect-[4/5] object-cover rounded-xl border border-gold" />
                    <figcaption className="text-[11px] text-ink-soft mt-1">Styled by AI</figcaption>
                  </figure>
                )}
                <div className="grid grid-cols-3 gap-1">
                  <button type="button" onClick={() => add([s])} disabled={s.state !== 'done'} className={`${base} border-ink bg-ink text-paper`} aria-label={`Add to gallery: ${PRESET_NAME[s.preset]}`}>
                    <Check className="w-4 h-4 shrink-0" aria-hidden="true" /> Add
                  </button>
                  <button type="button" onClick={() => void retry(s)} disabled={s.state === 'busy'} className={btn} aria-label={`Try again: ${PRESET_NAME[s.preset]}`}>
                    <RotateCcw className="w-4 h-4 shrink-0" aria-hidden="true" /> Again
                  </button>
                  <button type="button" onClick={() => remove(s)} className={`${base} border-line-strong bg-surface text-danger`} aria-label={`Discard: ${PRESET_NAME[s.preset]}`}>
                    <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" /> Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {done.length > 1 && (
            <button type="button" onClick={() => add(done)} className="w-full min-h-11 rounded-xl bg-ink text-paper text-sm font-bold flex items-center justify-center gap-1">
              <CheckCheck className="w-4 h-4" aria-hidden="true" /> Add all {done.length} to photos
            </button>
          )}
        </div>
      )}
    </section>
  );
}
