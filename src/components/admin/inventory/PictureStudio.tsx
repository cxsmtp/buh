'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, CheckCheck, ExternalLink, ImagePlus, Loader2, RotateCcw, Settings, Sparkles, Trash2 } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { PICTURE_PROVIDERS, PROVIDER_INFO, type PictureProvider } from '@/lib/pictureProviders';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { DEFAULT_SCENES, DEFAULT_STAGING_SET, STAGING_EXTRA_MAX, STAGING_FIXED_RULES, STAGING_MAX_SET, STAGING_SCENE_MAX, type StagingScene } from '@/lib/staging';

/**
 * The Picture studio: new pictures of a product, made by Google Gemini (the owner's key, Settings →
 * AI pictures) from one of its photos, to show it in different, beautiful settings
 * (src/lib/server/stagePhoto.ts). Used in two places: Inventory → Make pictures (an existing
 * product: added to its photos on the server) and the product editor's Photos step (added to the
 * editor's photos).
 *
 * Pick the photo (or upload one), the scenes (the default trio preselected; 1 to 4 of the owner's
 * scenes), an optional note; one press makes one picture per scene, each shown as it arrives with
 * its own Add, Again and Discard, plus Add all. One failing loses none of the others. Each result is
 * a NEW photo: the original stays as it is and stays first. The fixed rules (the product unchanged,
 * no people, no text) are always sent after the owner's words. Without a Gemini key the studio shows
 * how to get one, step by step, with a button to Settings → AI pictures.
 */

/** The server waits up to 90 seconds for Gemini; a little longer here. */
// Longer than the server can take for any picture service (fal: up to about 5 minutes with its
// queue and download), so a picture already paid for is never thrown away because the page gave up.
const WAIT_MS = 330_000;

interface Slot {
  key: number;
  preset: string;
  state: 'busy' | 'done' | 'failed';
  url?: string;
  error?: string;
  /** The picture service's own words (the key always removed on the server), to tell billing, quota and project apart. */
  said?: string;
  /** Waiting before trying again (the service's per-minute limit). */
  waiting?: string;
}

export interface StudioStatus {
  ready: boolean;
  reason: 'no_provider' | 'no_key' | 'no_model' | null | string;
  provider?: string;
  writer?: string;
  scenes?: StagingScene[];
  defaultSet?: string[];
  references?: string[];
  useReferences?: boolean;
  /** The numbered angles in the owner's prompt: one picture each, made one after another. */
  angles?: Array<{ n: number; name: string }>;
  photoOrder?: 'styled-first' | 'photo-first';
}

const input = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const base = 'min-h-11 rounded-xl border text-sm font-bold flex items-center justify-center gap-1 px-1 disabled:opacity-50';
const btn = `${base} border-line-strong bg-surface text-ink`;

const SHORT: Record<string, string> = { gemini: 'Gemini', openai: 'OpenAI', fal: 'fal.ai' };

/** What to do before pictures can be made: choose a service, add its key, or choose a model (also in Settings → AI pictures). */
export function PictureSetup({ onOpenSettings, reason, provider }: { onOpenSettings?: () => void; reason?: string | null; provider?: string }) {
  const open = onOpenSettings && (
    <button type="button" onClick={onOpenSettings} className="min-h-12 px-4 rounded-xl bg-ink text-paper font-bold inline-flex items-center justify-center gap-2">
      <Settings className="w-4 h-4" aria-hidden="true" /> Open Settings → AI pictures
    </button>
  );
  const info = provider && provider in PROVIDER_INFO ? PROVIDER_INFO[provider as PictureProvider] : null;
  if (reason === 'no_model' && info) {
    return (
      <div className="space-y-2 rounded-xl border border-warning-line bg-warning-soft p-3 text-sm text-ink" data-testid="studio-setup">
        <p className="font-semibold">Your {info.name} key is saved: now choose an image model.</p>
        <p className="text-xs text-ink-soft">In Settings → AI pictures, press &ldquo;Test and list image models&rdquo;, pick one and save.</p>
        {open}
      </div>
    );
  }
  if (reason === 'no_key' && info) {
    return (
      <div className="space-y-3 rounded-xl border border-gold/60 bg-surface p-3 text-sm text-ink" data-testid="studio-setup">
        <p className="font-semibold">Pictures need {provider === 'openai' ? 'an' : 'a'} {info.name} key.</p>
        <ol className="list-decimal pl-5 space-y-1.5 text-sm">
          {info.steps.map((st) => (
            <li key={st}>{st.replace(/below/, 'in Settings → AI pictures')}</li>
          ))}
        </ol>
        <div className="flex flex-col sm:flex-row gap-2">
          <a href={info.keyUrl} target="_blank" rel="noopener noreferrer" className="min-h-12 px-4 rounded-xl border border-ink bg-surface text-ink font-bold inline-flex items-center justify-center gap-2 text-center">
            <ExternalLink className="w-4 h-4 shrink-0" aria-hidden="true" /> Create API key ({info.keyUrlLabel})
          </a>
          {open}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-xl border border-gold/60 bg-surface p-3 text-sm text-ink" data-testid="studio-setup">
      <p className="font-semibold">Pictures need a picture service and its key.</p>
      <p className="text-xs text-ink-soft">DeepSeek and Claude can&rsquo;t make pictures; your writing AI can stay as it is. Choose one of these in Settings → AI pictures and paste its key there:</p>
      <ul className="space-y-2">
        {PICTURE_PROVIDERS.map((id) => (
          <li key={id} className="text-sm">
            <a href={PROVIDER_INFO[id].keyUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline flex items-start gap-1 min-h-11 min-w-0 break-anywhere">
              <ExternalLink className="w-4 h-4 shrink-0" aria-hidden="true" /> {PROVIDER_INFO[id].name} key ({PROVIDER_INFO[id].keyUrlLabel})
            </a>
            <span className="block text-xs text-ink-soft">{PROVIDER_INFO[id].cost}</span>
          </li>
        ))}
      </ul>
      {open}
    </div>
  );
}

export function PictureStudio({
  photos,
  originals = {},
  room,
  notes: notesProp,
  onNotes,
  context,
  onAdd,
  onOpenSettings,
  allowUpload = false,
  title = 'AI pictures',
  intro = 'Gemini makes new pictures of this product in beautiful settings to help shoppers fall for it: the whole bed, a close-up of the print, a lifestyle moment, or any of your scenes. Your original photo is kept as it is.',
  testId = 'stage-in-bedroom',
}: {
  /** The product's photos (uploaded URLs; first = cover). */
  photos: string[];
  /** Photos added in this session, as taken (data URLs). */
  originals?: Record<string, string>;
  /** How many more photos the product can take. */
  room: number;
  /** The owner's note (the editor keeps it with its draft); without it, the studio keeps its own. */
  notes?: string;
  onNotes?: (v: string) => void;
  /** The product's own words, so the setting suits it (never changes the product). */
  context: { title?: string; motif?: string; colors?: string[]; design?: string };
  /** Add the styled photos (in order) where Settings → AI pictures puts them; what was added, or why not. */
  onAdd: (urls: string[], source: string, order: 'styled-first' | 'photo-first') => Promise<{ added: string[]; message?: string }>;
  /** Opens Settings → AI pictures (shown with the setup steps). */
  onOpenSettings?: () => void;
  /** Offer "Upload a photo" as the source too. */
  allowUpload?: boolean;
  title?: string;
  intro?: string;
  testId?: string;
}) {
  const id = useId();
  const [ownNotes, setOwnNotes] = useState('');
  const notes = notesProp ?? ownNotes;
  const setNotes = onNotes ?? setOwnNotes;
  const [uploads, setUploads] = useState<string[]>([]);
  const sources = [...photos, ...uploads];
  const [pick, setPick] = useState(0);
  const [chosenSet, setChosenSet] = useState<string[] | null>(null);
  const [scenes, setScenes] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  /** This batch: send the style photos (from Settings → AI pictures) or not. */
  const [useRefs, setUseRefs] = useState<boolean | null>(null);
  const counter = useRef(0);
  /** Slots still on screen: a picture that arrives for one discarded meanwhile is thrown away. */
  const live = useRef(new Set<number>());
  /** This set's first angle picture: sent with the next angles so the room stays the same. */
  const firstAngle = useRef('');

  useEffect(() => {
    let on = true;
    void getJson<StudioStatus>('/api/admin/products/stage-photo').then(({ ok, data }) => {
      if (on && ok) setStatus(data);
    });
    return () => {
      on = false;
    };
  }, []);

  // The angles in the owner's prompt come first (and are the one-press set), then the scenes.
  const angleChoices: StagingScene[] = (status?.angles ?? []).map((a) => ({ id: `angle:${a.n}`, name: a.name, scene: '' }));
  const allScenes = [...angleChoices, ...(status?.scenes?.length ? status.scenes : DEFAULT_SCENES)];
  const sceneOf = (sid: string) => allScenes.find((s) => s.id === sid);
  const nameOf = (sid: string) => sceneOf(sid)?.name ?? sid;
  const isAngle = (sid: string) => sid.startsWith('angle:');
  const set = (chosenSet ?? (angleChoices.length ? angleChoices.map((a) => a.id) : status?.defaultSet?.length ? status.defaultSet : DEFAULT_STAGING_SET)).filter((sid) => sceneOf(sid));
  const at = Math.min(pick, Math.max(0, sources.length - 1));
  const chosen = sources[at];
  const busy = slots.some((s) => s.state === 'busy');
  const refCount = status?.references?.length ?? 0;
  const refsOn = useRefs ?? status?.useReferences !== false;

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
  const make = async (key: number, preset: string, field: Record<string, string>, attempt = 0): Promise<void> => {
    const scene = (scenes[preset] ?? '').trim();
    const ctx = Object.fromEntries(Object.entries(context).filter(([, v]) => (Array.isArray(v) ? v.length : typeof v === 'string' && v.trim())));
    const call = postJson<{ url?: string; message?: string; code?: string; reason?: string; detail?: string; retryAfterSec?: number }>('/api/admin/products/stage-photo', {
      ...field,
      // One of the angles in the owner's prompt (with the set's first picture, so the room matches), or a scene.
      ...(isAngle(preset) ? { angle: Number(preset.slice(6)), ...(firstAngle.current ? { sameRoom: firstAngle.current } : {}) } : { preset }),
      ...(notes.trim() ? { extra: notes.trim() } : {}),
      ...(!isAngle(preset) && scene && scene !== sceneOf(preset)?.scene ? { scene } : {}),
      ...(Object.keys(ctx).length ? { context: ctx } : {}),
      ...(refCount ? { useReferences: refsOn } : {}),
    });
    const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), WAIT_MS));
    const answer = await Promise.race([call, late]);
    const update = (patch: Partial<Slot>) => setSlots((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    if (answer === 'late') {
      // A picture that arrives after this is not wanted: thrown away when it comes.
      void call.then(({ ok, data }) => {
        if (ok && data.url) void discard(data.url);
      });
      return update({ state: 'failed', error: `${SHORT[status?.provider ?? ''] ?? 'The picture service'} took too long. Try again in a moment.` });
    }
    const { ok, data } = answer;
    // Google's per-minute limit: wait as long as it asks (shown on the picture), then try once more.
    if (!ok && data.code === 'ai_busy' && attempt === 0 && live.current.has(key)) {
      const wait = Math.min(90, Math.max(5, Number(data.retryAfterSec) || 30));
      update({ waiting: `Google asked to wait: trying again in ${wait} s…` });
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      if (!live.current.has(key)) return;
      update({ waiting: undefined });
      return make(key, preset, field, 1);
    }
    if (!ok || !data.url) {
      if (data.code === 'staging_off') setStatus((st) => ({ ...(st ?? {}), ready: false, reason: data.reason || 'no_key' }));
      return update({ state: 'failed', error: data.message || 'Could not make the picture. Please try again.', said: typeof data.detail === 'string' ? data.detail.slice(0, 300) : undefined });
    }
    // Discarded (or tried again) while it was being made: thrown away.
    if (!live.current.has(key)) return void discard(data.url);
    if (isAngle(preset) && !firstAngle.current) firstAngle.current = data.url;
    update({ state: 'done', url: data.url });
  };

  const start = async () => {
    if (!chosen) return setError('Add a photo first.');
    const field = imageField(chosen);
    if (!field) return setError('This photo is not stored in the shop: add it again from the gallery, then make pictures.');
    if (!set.length) return setError('Choose at least one scene.');
    setError('');
    setNote('');
    // Earlier pictures not added are thrown away first.
    for (const s of slots) if (s.url) void discard(s.url);
    setSource(chosen);
    const fresh = set.map((preset) => ({ key: ++counter.current, preset, state: 'busy' as const }));
    live.current = new Set(fresh.map((s) => s.key));
    firstAngle.current = '';
    setSlots(fresh);
    // One at a time with Gemini (a new account's per-minute limit isn't hit by three at once) and
    // for angles (each one after the first is sent with it, so the room stays the same).
    if (status?.provider === 'gemini' || fresh.some((s) => isAngle(s.preset))) {
      for (const s of fresh) await make(s.key, s.preset, field).catch(() => undefined);
    } else {
      await Promise.allSettled(fresh.map((s) => make(s.key, s.preset, field)));
    }
  };

  const retry = async (slot: Slot) => {
    const field = imageField(source);
    if (!field) return setError('This photo is not stored in the shop: add it again from the gallery, then make pictures.');
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

  const add = async (picked: Slot[]) => {
    const ready = picked.filter((s) => s.state === 'done' && s.url);
    if (!ready.length || adding) return;
    if (room <= 0) return setError('This product already has 8 photos: remove one first.');
    const taking = ready.slice(0, room);
    setAdding(true);
    const { added, message } = await onAdd(
      taking.map((s) => s.url!),
      source,
      status?.photoOrder ?? 'styled-first'
    );
    setAdding(false);
    const done = taking.filter((t) => added.includes(t.url!));
    for (const t of done) live.current.delete(t.key);
    setSlots((all) => all.filter((s) => !done.some((t) => t.key === s.key)));
    if (message) setError(message);
    else setError(taking.length < ready.length ? `Only ${room} more ${room === 1 ? 'photo fits' : 'photos fit'}: remove one to add the rest.` : '');
    if (done.length) setNote(`${done.length === 1 ? 'Added' : `${done.length} added`} to the photos (where Settings → AI pictures puts them). Shoppers see a small “Styled image” tag on ${done.length === 1 ? 'it' : 'them'}.`);
  };

  const toggle = (preset: string) => setChosenSet(set.includes(preset) ? set.filter((p) => p !== preset) : set.length >= STAGING_MAX_SET ? set : [...set, preset]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    try {
      const url = await shrinkPhoto(file);
      setUploads((u) => [...u, url]);
      setPick(sources.length);
    } catch (err) {
      setError((err as Error).message || 'Could not read that photo.');
    }
  };

  const off = status && !status.ready;
  const maker = SHORT[status?.provider ?? ''] ?? 'Gemini';
  const writerNote = status?.provider && status.writer && status.writer !== status.provider ? ` Your text is written by ${status.writer === 'deepseek' ? 'DeepSeek' : status.writer === 'gemini' ? 'Gemini' : 'Claude'}; pictures are made by ${maker}.` : '';
  const done = slots.filter((s) => s.state === 'done');

  return (
    <section className="rounded-2xl border border-line bg-surface p-3 space-y-3 min-w-0" aria-labelledby={`${id}-h`} data-testid={testId}>
      <h3 id={`${id}-h`} className="font-semibold text-ink flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-gold-deep shrink-0" aria-hidden="true" /> {title}
      </h3>
      <p className="text-xs text-ink-soft">
        {intro}
        {writerNote}
      </p>
      {off ? (
        <PictureSetup onOpenSettings={onOpenSettings} reason={status?.reason} provider={status?.provider} />
      ) : (
        <div className="space-y-3">
          {(sources.length > 1 || allowUpload) && (
            <fieldset className="space-y-1 min-w-0">
              <legend className="text-sm font-semibold text-ink mb-1">Photo to start from</legend>
              <div className="flex flex-wrap gap-2" data-testid="studio-sources">
                {sources.map((src, i) => (
                  <label key={`${i}-${src.slice(-24)}`} className={`relative w-20 shrink-0 rounded-xl border-2 overflow-hidden cursor-pointer focus-within:ring-2 focus-within:ring-gold ${i === at ? 'border-ink' : 'border-line'}`}>
                    <input type="radio" name={`${id}-src`} className="absolute top-1 left-1 w-5 h-5" checked={i === at} onChange={() => setPick(i)} aria-label={i < photos.length ? (i === 0 ? 'Photo 1 (cover)' : `Photo ${i + 1}`) : `Uploaded photo ${i - photos.length + 1}`} />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" className="w-full aspect-[4/5] object-cover" />
                  </label>
                ))}
                {allowUpload && (
                  <label className="w-20 aspect-[4/5] shrink-0 rounded-xl border-2 border-dashed border-line-strong flex flex-col items-center justify-center gap-1 text-[11px] text-ink-soft text-center cursor-pointer focus-within:ring-2 focus-within:ring-gold px-1">
                    <ImagePlus className="w-5 h-5" aria-hidden="true" />
                    Upload
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload a photo to start from" onChange={(e) => void upload(e.target.files?.[0])} />
                  </label>
                )}
              </div>
            </fieldset>
          )}
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold text-ink mb-1">{angleChoices.length ? 'Angles from your prompt, or scenes' : 'Scenes to make'} (1 to {STAGING_MAX_SET})</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {allScenes.map((p) => (
                <label key={p.id} className="min-h-11 flex items-center gap-2 text-sm rounded-xl border border-line px-2">
                  <input type="checkbox" className="w-5 h-5 shrink-0" checked={set.includes(p.id)} disabled={!set.includes(p.id) && set.length >= STAGING_MAX_SET} onChange={() => toggle(p.id)} />
                  <span className="min-w-0 break-words">{p.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {refCount > 0 && (
            <div className="rounded-xl border border-line p-2 space-y-2" data-testid="studio-references">
              <label className="flex items-center gap-2 text-sm font-semibold min-h-11">
                <input type="checkbox" className="w-5 h-5 shrink-0" checked={refsOn} onChange={(e) => setUseRefs(e.target.checked)} />
                Use my style photos ({refCount}) for these pictures
              </label>
              <div className="flex flex-wrap gap-1.5" aria-hidden="true">
                {status!.references!.map((r) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={r} src={r} alt="" className={`w-12 aspect-[4/5] object-cover rounded-lg border border-line ${refsOn ? '' : 'opacity-40'}`} />
                ))}
              </div>
              <p className="text-[11px] text-ink-muted">Pictures copy their light, angle and mood (scenes set to their description only skip them). Change them in Settings → AI pictures.</p>
            </div>
          )}
          <label className="block text-sm">
            <span className="block font-semibold text-ink mb-1">Your note for every picture (optional)</span>
            <input value={notes} maxLength={STAGING_EXTRA_MAX} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. morning light, olive green wall" className={`${input} min-h-11`} aria-label="Your note (optional)" />
            <span className="block text-[11px] text-ink-muted mt-1">
              {onNotes ? 'Kept with this product’s draft. ' : 'For these pictures only. '}Up to {STAGING_EXTRA_MAX} characters.
            </span>
          </label>
          <details className="rounded-xl border border-line px-3 py-2" data-testid="stage-prompt">
            <summary className="min-h-11 flex items-center font-semibold cursor-pointer text-sm">What Gemini is asked (edit the scenes for these pictures)</summary>
            <div className="space-y-2 pb-2">
              {set.filter((preset) => isAngle(preset)).length > 0 && <p className="text-xs text-ink-soft">The angles come from your picture prompt in Settings → AI pictures: one picture each, made one after another.</p>}
              {set.filter((preset) => !isAngle(preset)).map((preset) => (
                <label key={preset} className="block text-sm">
                  <span className="block font-semibold text-ink mb-1">{nameOf(preset)}: scene</span>
                  <textarea rows={3} maxLength={STAGING_SCENE_MAX} value={scenes[preset] ?? sceneOf(preset)?.scene ?? ''} onChange={(e) => setScenes((s) => ({ ...s, [preset]: e.target.value }))} className={input} aria-label={`Scene for ${nameOf(preset)}`} />
                </label>
              ))}
              {notes.trim() && <p className="text-xs text-ink-soft break-words">Your note: {notes.trim()}</p>}
              <p className="text-xs text-ink-soft">The look and mood, and the scenes themselves, are in Settings → AI pictures.</p>
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
            disabled={busy || !sources.length || !set.length}
            aria-busy={busy}
            className="w-full min-h-12 rounded-xl bg-ink text-paper font-bold flex items-center justify-center gap-2 px-3 text-center disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden="true" /> : <Sparkles className="w-5 h-5 text-gold shrink-0" aria-hidden="true" />}
            {busy ? 'Making the pictures…' : `Make ${set.length} ${set.length === 1 ? 'picture' : 'pictures'} (${maker})`}
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
              <li key={s.key} className="min-w-0 space-y-2 rounded-xl border border-line p-2" data-testid="stage-result" aria-label={nameOf(s.preset)}>
                <p className="text-xs font-semibold text-ink break-words">{nameOf(s.preset)}</p>
                {s.state === 'busy' && (
                  <div className="w-full aspect-[4/5] rounded-xl border border-dashed border-line-strong flex flex-col items-center justify-center gap-1 text-ink-soft">
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    <span className="text-[11px] text-center px-2" role="status">{s.waiting ?? 'Making…'}</span>
                  </div>
                )}
                {s.state === 'failed' && (
                  <p role="alert" className="text-xs font-semibold text-danger break-words" data-testid="stage-failed">
                    Not made: {s.error}
                  </p>
                )}
                {s.state === 'failed' && s.said && (
                  <p className="text-[11px] text-ink-soft break-words" data-testid="stage-said">
                    {SHORT[status?.provider ?? ''] ?? 'The service'} said: {s.said}
                  </p>
                )}
                {s.state === 'done' && s.url && (
                  <figure className="min-w-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.url} alt={`Styled photo: ${nameOf(s.preset)}`} className="w-full aspect-[4/5] object-cover rounded-xl border border-gold" />
                    <figcaption className="text-[11px] text-ink-soft mt-1">Styled by AI</figcaption>
                  </figure>
                )}
                <div className="grid grid-cols-3 gap-1">
                  <button type="button" onClick={() => void add([s])} disabled={s.state !== 'done' || adding} className={`${base} border-ink bg-ink text-paper`} aria-label={`Add to gallery: ${nameOf(s.preset)}`}>
                    <Check className="w-4 h-4 shrink-0" aria-hidden="true" /> Add
                  </button>
                  <button type="button" onClick={() => void retry(s)} disabled={s.state === 'busy'} className={btn} aria-label={`Try again: ${nameOf(s.preset)}`}>
                    <RotateCcw className="w-4 h-4 shrink-0" aria-hidden="true" /> Again
                  </button>
                  <button type="button" onClick={() => remove(s)} className={`${base} border-line-strong bg-surface text-danger`} aria-label={`Discard: ${nameOf(s.preset)}`}>
                    <Trash2 className="w-4 h-4 shrink-0" aria-hidden="true" /> Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {done.length > 1 && (
            <button type="button" onClick={() => void add(done)} disabled={adding} className="w-full min-h-11 rounded-xl bg-ink text-paper text-sm font-bold flex items-center justify-center gap-1 disabled:opacity-60">
              <CheckCheck className="w-4 h-4" aria-hidden="true" /> Add all {done.length} to photos
            </button>
          )}
        </div>
      )}
    </section>
  );
}
