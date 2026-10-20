'use client';

import React, { useEffect, useId, useState } from 'react';
import { Check, Gift, Loader2, Palette, RotateCcw, Sparkles, X } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { COPY_LIMITS, composeDescription, highlightLines } from '@/lib/productCopy';
import type { BedProfileMeasurement } from '@/types';

/**
 * "Write name & descriptions from photo" in the product editor's Photos step. The chosen photo
 * (the cover unless the owner picks another) goes to the shop's server, which asks the AI chosen in
 * Settings → AI writing (src/lib/server/aiWriting.ts). The answer only fills the editor's fields:
 * nothing is saved until the owner publishes, as with anything typed.
 *
 * - The suggestion is shown field by field (name, short description, design, comfort, closing line,
 *   highlights, gift line, motif), each in its own box to edit, with Use (or "Use as full
 *   description" for the parts that make it), Use all, and Write again for one field or all.
 * - Empty name and descriptions are filled in at once; when there is text already, nothing is used
 *   until the owner presses Use.
 * - Gift lines are per festival: the box says which festival it is for, with a picker (the one the
 *   shop is themed for now, then the next ones) and "Write gift lines for the next festivals".
 * - Colours and weave are offered, each added only with a tap.
 * - Without a key, the button stays and says how to switch it on.
 */

export interface PhotoText {
  title: string;
  shortDescription: string;
  description: string;
  colors: Array<{ name: string; hex: string }>;
  weave: string;
  giftLines: Record<string, string>;
  aiMotif: string;
  aiDesign: string;
}

interface Suggestion {
  title: string;
  shortDescription: string;
  description: string;
  design: string;
  comfort: string;
  closing: string;
  highlights: string[];
  giftLine: string;
  giftFor: string;
  colors: Array<{ name: string; hex: string }>;
  weave: string | null;
  motif: string;
}

interface GiftFestival {
  id: string;
  name: string;
  start: string;
  end: string;
  now: boolean;
}

/** The suggestion as the owner edits it (highlights one per line). */
interface Review {
  title: string;
  shortDescription: string;
  design: string;
  comfort: string;
  closing: string;
  highlights: string;
  /** An older-style answer's own full description (no design or comfort parts). */
  description: string;
  motif: string;
}

type FieldKey = 'title' | 'shortDescription' | 'design' | 'comfort' | 'closing' | 'highlights' | 'gift';

const EVERYDAY = 'everyday';
/** A new product's starting values: not the owner's facts, so not sent as hints. */
const NEW_DEFAULTS = { material: '100% Cotton', threadCount: '300', weave: 'Percale' };
const box = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const small = 'min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-sm font-semibold inline-flex items-center justify-center gap-1 disabled:opacity-50';

const reviewOf = (s: Suggestion): Review => ({
  title: s.title,
  shortDescription: s.shortDescription,
  design: s.design ?? '',
  comfort: s.comfort ?? '',
  closing: s.closing ?? '',
  highlights: (s.highlights ?? []).join('\n'),
  description: s.design || s.comfort ? '' : s.description,
  motif: s.motif,
});

/** The full description from the parts as edited (or an older-style answer's own). */
const fullOf = (r: Review) => (r.design.trim() || r.comfort.trim() ? composeDescription({ design: r.design, comfort: r.comfort, closing: r.closing, highlights: r.highlights }) : r.description);

const dateText = (f: GiftFestival) => {
  const d = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return f.start === f.end ? d(f.start) : `${d(f.start)} – ${d(f.end)}`;
};

/** The product's sizes and what is in each set, as facts for the AI (only sizes the owner has stock for, or a saved product's). */
export function sizeFacts(sizes: BedProfileMeasurement[] | undefined, stock: Record<string, number> | undefined, isNew: boolean, simple: boolean, fitted: boolean): string[] {
  return (sizes ?? [])
    .filter((s) => !isNew || (stock?.[s.id] ?? 0) > 0)
    .slice(0, 8)
    .map((s) => {
      if (simple) return [s.name, s.dimensions].filter(Boolean).join(': ');
      const pieces = [
        s.mattressSize && `for a ${s.mattressSize} mattress`,
        fitted ? s.fittedSheet && `fitted sheet ${s.fittedSheet}` : s.flatSheet && `flat sheet ${s.flatSheet}`,
        s.pillowcases && `pillowcases ${s.pillowcases}`,
        s.duvetCover && `duvet cover ${s.duvetCover}`,
        s.otherPieces,
      ].filter(Boolean);
      return `${s.name}${pieces.length ? `: ${pieces.join('; ')}` : ''}`;
    })
    .filter(Boolean);
}

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
  facts: { category: string; material: string; threadCount: string; sizes?: BedProfileMeasurement[]; stock?: Record<string, number>; productType?: string; fitted?: boolean };
  onApply: (patch: Partial<PhotoText>) => void;
}) {
  const id = useId();
  const [pick, setPick] = useState(0);
  const [status, setStatus] = useState<{ ready: boolean; reason: string | null } | null>(null);
  const [festivals, setFestivals] = useState<GiftFestival[]>([]);
  const [busy, setBusy] = useState<FieldKey | 'all' | 'gifts' | null>(null);
  const [error, setError] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [extras, setExtras] = useState<Suggestion | null>(null);
  const [filled, setFilled] = useState('');
  /** Gift lines as edited here (by festival id), and which one the box shows. */
  const [gifts, setGifts] = useState<Record<string, string>>({});
  const [giftFor, setGiftFor] = useState('');

  useEffect(() => {
    let live = true;
    void getJson<{ ready: boolean; reason: string | null; festivals?: GiftFestival[] }>('/api/admin/products/describe').then(({ ok, data }) => {
      if (!live || !ok) return;
      setStatus({ ready: data.ready, reason: data.reason });
      const list = data.festivals ?? [];
      setFestivals(list);
      setGiftFor((g) => g || list[0]?.id || EVERYDAY);
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

  const hints = () => {
    const h: Record<string, unknown> = { category: facts.category, colors: current.colors.map((c) => c.name).filter(Boolean) };
    if (!isNew || facts.material !== NEW_DEFAULTS.material) h.material = facts.material;
    if (!isNew || facts.threadCount !== NEW_DEFAULTS.threadCount) h.threadCount = Number(facts.threadCount) || undefined;
    if (!isNew || current.weave !== NEW_DEFAULTS.weave) h.weave = current.weave;
    const sizes = sizeFacts(facts.sizes, facts.stock, isNew, facts.productType === 'simple', facts.fitted === true);
    if (sizes.length) h.sizes = sizes;
    return h;
  };

  /** One describe call; the suggestion, or null with the error shown. */
  const ask = async (target: string): Promise<Suggestion | null> => {
    if (!chosen) {
      setError('Add a photo first.');
      return null;
    }
    const { ok, data } = await postJson<{ suggestion?: Suggestion; message?: string; code?: string }>('/api/admin/products/describe', { ...imageField(chosen), hints: hints(), giftFor: target || EVERYDAY });
    if (!ok || !data.suggestion) {
      if (data.code === 'ai_off') setStatus({ ready: false, reason: 'no_key' });
      setError(data.message || 'Could not write from the photo. Please try again.');
      return null;
    }
    return data.suggestion;
  };

  const applyAll = (r: Review, giftMap: Record<string, string>, note: string) => {
    const lines = Object.fromEntries(Object.entries({ ...current.giftLines, ...giftMap }).filter(([, v]) => v.trim()));
    onApply({ title: r.title.trim(), shortDescription: r.shortDescription.trim(), description: fullOf(r), giftLines: lines, aiMotif: r.motif.trim(), aiDesign: r.design.trim() });
    setFilled(note);
  };

  const run = async () => {
    setBusy('all');
    setError('');
    setFilled('');
    const s = await ask(giftFor);
    setBusy(null);
    if (!s) return;
    const r = reviewOf(s);
    const g = { ...gifts, ...(s.giftLine ? { [s.giftFor]: s.giftLine } : {}) };
    setReview(r);
    setGifts(g);
    if (s.giftFor) setGiftFor(s.giftFor);
    setExtras(s);
    const hasText = Boolean(current.title.trim() || current.shortDescription.trim() || current.description.trim());
    if (!hasText) applyAll(r, g, 'Name, short and full description filled in from the photo. Edit any of them below, or in the next step (Details).');
    else onApply({ aiMotif: r.motif.trim(), aiDesign: r.design.trim() });
  };

  /** Write one field again (another call; only that field changes). */
  const again = async (key: FieldKey) => {
    if (!review) return;
    setBusy(key);
    setError('');
    const s = await ask(giftFor);
    setBusy(null);
    if (!s) return;
    if (key === 'gift') return setGifts((g) => ({ ...g, [giftFor]: s.giftLine }));
    const fresh = reviewOf(s);
    setReview((r) => (r ? { ...r, [key]: fresh[key], ...(key === 'design' || key === 'comfort' ? { description: '' } : {}) } : r));
  };

  const writeGifts = async () => {
    if (!chosen) return setError('Add a photo first.');
    setBusy('gifts');
    setError('');
    const { ok, data } = await postJson<{ giftLines?: Record<string, string>; festivals?: GiftFestival[]; message?: string }>('/api/admin/products/gift-lines', {
      ...imageField(chosen),
      hints: hints(),
      ...(review?.title || current.title ? { title: (review?.title || current.title).slice(0, 60) } : {}),
    });
    setBusy(null);
    if (!ok || !data.giftLines) return setError(data.message || 'Could not write the gift lines. Please try again.');
    setGifts((g) => ({ ...g, ...data.giftLines }));
    if (data.festivals?.length) setFestivals((list) => [...list, ...data.festivals!.filter((f) => !list.some((x) => x.id === f.id))]);
  };

  const have = new Set(current.colors.map((c) => c.name.trim().toLowerCase()));
  const newColors = (extras?.colors ?? []).filter((c) => !have.has(c.name.toLowerCase()));
  const newWeave = extras?.weave && extras.weave !== current.weave ? extras.weave : null;
  const set = (k: keyof Review, v: string) => setReview((r) => (r ? { ...r, [k]: v } : r));
  const giftText = gifts[giftFor] ?? current.giftLines[giftFor] ?? '';
  const giftName = giftFor === EVERYDAY ? 'Everyday (no festival)' : festivals.find((f) => f.id === giftFor)?.name ?? giftFor;
  const working = busy !== null;

  const againBtn = (key: FieldKey, name: string) => (
    <button type="button" onClick={() => void again(key)} disabled={working} className={small} aria-label={`Write ${name} again`}>
      {busy === key ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="w-4 h-4" aria-hidden="true" />} Write again
    </button>
  );
  const textField = (key: keyof Review, name: string, max: number, rows: number, againKey?: FieldKey, use?: () => void) => (
    <div className="space-y-1">
      <label htmlFor={`${id}-${key}`} className="block text-xs font-semibold text-ink-muted">
        {name}
      </label>
      {rows > 1 ? (
        <textarea id={`${id}-${key}`} rows={rows} maxLength={max} value={review![key]} onChange={(e) => set(key, e.target.value)} className={box} />
      ) : (
        <input id={`${id}-${key}`} maxLength={max} value={review![key]} onChange={(e) => set(key, e.target.value)} className={`${box} min-h-11`} />
      )}
      {(againKey || use) && (
        <div className="flex flex-wrap gap-2">
          {use && (
            <button type="button" onClick={use} disabled={working} className={small} aria-label={`Use ${name.toLowerCase()}`}>
              <Check className="w-4 h-4" aria-hidden="true" /> Use
            </button>
          )}
          {againKey && againBtn(againKey, name.replace(/ \(.*\)$/, '').toLowerCase())}
        </div>
      )}
    </div>
  );

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
        disabled={working || !photos.length}
        aria-busy={busy === 'all'}
        className="w-full min-h-12 rounded-xl bg-ink text-paper font-bold flex items-center justify-center gap-2 px-3 text-center disabled:opacity-50"
      >
        {busy === 'all' ? <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden="true" /> : <Sparkles className="w-5 h-5 text-gold shrink-0" aria-hidden="true" />}
        {busy === 'all' ? 'Looking at the photo…' : review ? 'Write all again' : 'Write name & descriptions from photo'}
      </button>
      {!photos.length && <p className="text-xs text-ink-muted">Add a photo first: the AI writes from what it sees.</p>}
      {status && !status.ready && !error && (
        <p className="text-xs text-ink-soft" data-testid="ai-off-note">
          {status.reason === 'off'
            ? 'AI writing is switched off: switch it on in Settings → AI writing.'
            : status.reason === 'no_model'
            ? 'Choose a writing model: press Test in Settings → AI writing, pick one and save.'
            : status.reason === 'text_only'
            ? 'The chosen DeepSeek model can’t read photos: choose deepseek-flash in Settings → AI writing.'
            : 'To use this, add your AI key (Anthropic, Gemini or DeepSeek) in Settings → AI writing (it stays on the shop’s server).'}
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

      {review && (
        <div className="rounded-xl border border-line bg-ivory p-3 space-y-3 min-w-0" role="region" aria-label="Suggested text" data-testid="ai-preview">
          <p className="text-xs text-ink-soft">Edit anything below, then press Use (one field) or Use all. Nothing is saved until you publish the product.</p>
          {textField('title', 'Name', COPY_LIMITS.title, 1, 'title', () => onApply({ title: review.title.trim() }))}
          {textField('shortDescription', 'Short description', COPY_LIMITS.shortDescription, 2, 'shortDescription', () => onApply({ shortDescription: review.shortDescription.trim() }))}
          {review.description ? (
            textField('description', 'Full description', COPY_LIMITS.description, 6)
          ) : (
            <>
              {textField('design', 'Design', COPY_LIMITS.design, 4, 'design')}
              {textField('comfort', 'Comfort', COPY_LIMITS.comfort, 3, 'comfort')}
              {textField('closing', 'Closing line', COPY_LIMITS.closing, 1, 'closing')}
              {textField('highlights', 'Highlights (one per line)', 600, 4, 'highlights')}
            </>
          )}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-ink-muted">Full description (as shoppers see it)</p>
            <p className="text-sm text-ink whitespace-pre-line break-words rounded-xl border border-line bg-surface p-2" data-testid="ai-full-description">
              {fullOf(review) || '—'}
            </p>
            <button type="button" onClick={() => onApply({ description: fullOf(review), aiDesign: review.design.trim() })} disabled={working} className={small}>
              <Check className="w-4 h-4" aria-hidden="true" /> Use as full description
            </button>
            {!review.description && <p className="text-[11px] text-ink-muted">{highlightLines(review.highlights).length} highlights. Made from design, comfort, closing line and highlights.</p>}
          </div>

          <div className="space-y-1 rounded-xl border border-line bg-surface p-2" data-testid="gift-line-box">
            <p className="text-xs font-semibold text-ink-muted flex items-center gap-1">
              <Gift className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Gift line for: <span className="text-ink">{giftName}</span>
            </p>
            <label htmlFor={`${id}-gift-for`} className="sr-only">
              Festival for the gift line
            </label>
            <select id={`${id}-gift-for`} value={giftFor} onChange={(e) => setGiftFor(e.target.value)} className={`${box} min-h-11`}>
              {festivals.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} · {f.now ? 'now' : dateText(f)}
                  {gifts[f.id] || current.giftLines[f.id] ? ' ✓' : ''}
                </option>
              ))}
              <option value={EVERYDAY}>Everyday (no festival){gifts[EVERYDAY] || current.giftLines[EVERYDAY] ? ' ✓' : ''}</option>
            </select>
            <label htmlFor={`${id}-gift`} className="block text-xs font-semibold text-ink-muted">
              Gift line
            </label>
            <textarea id={`${id}-gift`} rows={2} maxLength={COPY_LIMITS.giftLine} value={giftText} onChange={(e) => setGifts((g) => ({ ...g, [giftFor]: e.target.value }))} className={box} />
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => onApply({ giftLines: Object.fromEntries(Object.entries({ ...current.giftLines, [giftFor]: giftText.trim() }).filter(([, v]) => v)) })} disabled={working} className={small} aria-label="Use gift line">
                <Check className="w-4 h-4" aria-hidden="true" /> Use
              </button>
              {againBtn('gift', 'gift line')}
              <button type="button" onClick={() => void writeGifts()} disabled={working} className={small}>
                {busy === 'gifts' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Gift className="w-4 h-4" aria-hidden="true" />} Write gift lines for the next festivals
              </button>
            </div>
            <p className="text-[11px] text-ink-muted">The shop shows the line for the festival it is themed for, else the everyday one: lines change by themselves as festivals come and go.</p>
          </div>

          {textField('motif', 'Motif (helps “Style in a bedroom”)', COPY_LIMITS.motif, 1)}

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => applyAll(review, gifts, 'Used: name, short and full description and gift lines. Check them in the next step (Details).')} disabled={working} className="min-h-11 rounded-xl bg-ink text-paper text-sm font-bold flex items-center justify-center gap-1">
              <Check className="w-4 h-4" aria-hidden="true" /> Use all
            </button>
            <button type="button" onClick={() => setReview(null)} className="min-h-11 rounded-xl border border-line-strong bg-surface text-ink text-sm font-bold flex items-center justify-center gap-1">
              <X className="w-4 h-4" aria-hidden="true" /> Keep mine
            </button>
          </div>
        </div>
      )}

      {extras && (newColors.length > 0 || newWeave) && (
        <div className="space-y-2 text-sm" data-testid="ai-extras">
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
              <button type="button" onClick={() => onApply({ colors: [...current.colors, ...newColors].slice(0, 12) })} className={small}>
                <Palette className="w-4 h-4" aria-hidden="true" /> Add {newColors.length === 1 ? 'this colour' : 'these colours'}
              </button>
            </div>
          )}
          {newWeave && (
            <button type="button" onClick={() => onApply({ weave: newWeave })} className={small}>
              Set weave to {newWeave}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
