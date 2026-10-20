'use client';

import React, { useState } from 'react';
import { Copy, Eye, FlaskConical, Loader2, Lock, RotateCcw, ScrollText } from 'lucide-react';
import { postJson } from '@/lib/apiClient';
import {
  CONTRACT_CLOSE,
  DEFAULT_WRITING_INSTRUCTIONS,
  FIELD_GUIDE_MAX,
  PROMPT_INSTRUCTIONS_MAX,
  RULES_FIRST,
  WRITING_FIELDS,
  WRITING_FIXED_RULES,
  writingSystem,
  writingUser,
  type AiPromptSettings,
  type WritingFieldId,
} from '@/lib/aiPrompt';

/**
 * Settings → AI writing → Prompt: exactly what "Write from photo" sends (every writer: Claude,
 * Gemini, DeepSeek, and the gift lines).
 * - The shop's instructions (who the shop is, the goal, the voice): the owner edits them.
 * - What each field should say (the field guides): the owner rewords them; the limits are fixed
 *   and the shop cuts every field to its limit whatever the AI sends.
 * - The fixed rules (honesty, the answer format), read-only: always sent after the owner's words.
 * Reset (per box or all), Preview (the whole prompt for a sample product, copyable), and Try on a
 * photo (the unsaved prompt on one of the shop's product photos; nothing is saved).
 */

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const small = 'min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';

export interface PromptTryProduct {
  id: string;
  title: string;
  photo: string;
  hints: Record<string, unknown>;
}

interface Suggestion {
  title: string;
  shortDescription: string;
  description: string;
  giftLine?: string;
}

/** A sample product for the preview: the owner's facts as the editor sends them. */
const SAMPLE_NOTES = { category: 'Bed sheets', colors: ['Indigo', 'Ivory'], sizes: ['King: for a 180 x 200 cm mattress; pillowcases 2 pcs (50 x 80 cm)'] };

const guideDefault = (id: WritingFieldId) => WRITING_FIELDS.find((f) => f.id === id)!.guide;

/** What is sent to the server: '' where the text is the shop's default (so later defaults reach it). */
function toSettings(instructions: string, guides: Record<WritingFieldId, string>): AiPromptSettings {
  const fields: Partial<Record<WritingFieldId, string>> = {};
  for (const f of WRITING_FIELDS) {
    const g = guides[f.id].trim();
    fields[f.id] = g === f.guide ? '' : g;
  }
  return { instructions: instructions.trim() === DEFAULT_WRITING_INSTRUCTIONS ? '' : instructions.trim(), fields };
}

export function AiPromptCard({ value, weaves, products, onSave }: { value: AiPromptSettings; weaves: string[]; products: PromptTryProduct[]; onSave: (v: AiPromptSettings) => Promise<string | null> }) {
  const [instructions, setInstructions] = useState(value.instructions?.trim() ? value.instructions : DEFAULT_WRITING_INSTRUCTIONS);
  const [guides, setGuides] = useState<Record<WritingFieldId, string>>(() => Object.fromEntries(WRITING_FIELDS.map((f) => [f.id, value.fields?.[f.id]?.trim() ? value.fields[f.id]! : f.guide])) as Record<WritingFieldId, string>);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const withPhotos = products.filter((p) => p.photo.startsWith('/api/images/'));
  const [tryId, setTryId] = useState(withPhotos[0]?.id ?? '');
  const [trying, setTrying] = useState(false);
  const [tried, setTried] = useState<{ photo: string; suggestion?: Suggestion; error?: string } | null>(null);

  const settings = toSettings(instructions, guides);
  // Built only while the preview is open (a few kilobytes of text).
  const assembled = preview ? `SYSTEM\n${writingSystem(settings)}\n\nUSER (with the product's photo)\n${writingUser(SAMPLE_NOTES, weaves, settings)}` : '';
  const customised = Boolean(settings.instructions) || Object.values(settings.fields).some(Boolean);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    const problem = await onSave(settings);
    setSaving(false);
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: customised ? 'Saved. Every writer now uses your prompt.' : 'Saved. The shop’s default prompt is used.' });
  };

  const resetAll = () => {
    setInstructions(DEFAULT_WRITING_INSTRUCTIONS);
    setGuides(Object.fromEntries(WRITING_FIELDS.map((f) => [f.id, f.guide])) as Record<WritingFieldId, string>);
    setStatus({ ok: true, text: 'Back to the shop’s default. Press Save to keep it.' });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(assembled);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const tryIt = async () => {
    const p = withPhotos.find((x) => x.id === tryId);
    if (!p) return;
    setTrying(true);
    setTried(null);
    const { ok, data } = await postJson<{ suggestion?: Suggestion; message?: string }>('/api/admin/products/describe', { imageId: p.photo.slice('/api/images/'.length), hints: p.hints, prompt: settings });
    setTrying(false);
    setTried(ok && data.suggestion ? { photo: p.photo, suggestion: data.suggestion } : { photo: p.photo, error: data.message || 'The AI could not write from this photo.' });
  };

  return (
    <section className="space-y-4 rounded-xl border border-line p-3 text-sm" data-testid="ai-prompt" aria-labelledby="ai-prompt-h">
      <div className="space-y-1">
        <h3 id="ai-prompt-h" className="font-bold text-ink flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Prompt: what the AI is asked
        </h3>
        <p className="text-xs text-ink-soft">This is exactly what Claude, Gemini or DeepSeek is sent with the product&rsquo;s photo, in this order. Edit your part to change the style; the fixed rules are always sent after it.</p>
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label className="block text-xs font-semibold text-ink-soft" htmlFor="ai-prompt-instructions">
            1. Your shop&rsquo;s instructions (style and voice)
          </label>
          <button type="button" className={small} onClick={() => setInstructions(DEFAULT_WRITING_INSTRUCTIONS)} aria-label="Reset the instructions to the shop's default" disabled={instructions === DEFAULT_WRITING_INSTRUCTIONS}>
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset to the shop&rsquo;s default
          </button>
        </div>
        <textarea id="ai-prompt-instructions" rows={7} className={field} value={instructions} maxLength={PROMPT_INSTRUCTIONS_MAX} onChange={(e) => setInstructions(e.target.value)} />
        <p className="text-[11px] text-ink-muted">
          {instructions.length.toLocaleString('en-GB')} / {PROMPT_INSTRUCTIONS_MAX.toLocaleString('en-GB')} characters. Who the shop is, who it is for, the goal (helping shoppers choose and buy) and the tone.
        </p>
      </div>

      <div className="space-y-2 rounded-xl border border-line bg-sand p-3" data-testid="ai-prompt-fixed">
        <p className="text-xs font-bold text-ink flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5" aria-hidden="true" /> 2. Fixed rules: always sent, can&rsquo;t be removed (they keep the shop honest)
        </p>
        <p className="text-xs text-ink">{RULES_FIRST}</p>
        <ul className="text-xs text-ink-soft space-y-0.5">
          {WRITING_FIXED_RULES.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold text-ink-soft">3. What each part should say (the answer format stays fixed; the shop cuts each part to its limit)</legend>
        {WRITING_FIELDS.map((f) => (
          <div key={f.id} className="space-y-1">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label className="block text-xs font-semibold text-ink" htmlFor={`ai-guide-${f.id}`}>
                {f.label} <span className="font-normal text-ink-muted">({f.limitText})</span>
              </label>
              <button type="button" className={small} onClick={() => setGuides((g) => ({ ...g, [f.id]: f.guide }))} disabled={guides[f.id] === f.guide} aria-label={`Reset ${f.label} to the shop's default`}>
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Default
              </button>
            </div>
            <textarea id={`ai-guide-${f.id}`} rows={2} className={field} value={guides[f.id]} maxLength={FIELD_GUIDE_MAX} onChange={(e) => setGuides((g) => ({ ...g, [f.id]: e.target.value }))} placeholder={guideDefault(f.id)} />
          </div>
        ))}
        <p className="text-[11px] text-ink-muted flex items-start gap-1">
          <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden="true" /> Always last: the colours, weave and motif, and &ldquo;{CONTRACT_CLOSE}&rdquo;
        </p>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void save()} disabled={saving} className="min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Save prompt
        </button>
        <button type="button" onClick={resetAll} className={small}>
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset all to the shop&rsquo;s default
        </button>
        <button type="button" onClick={() => setPreview((v) => !v)} className={small} aria-expanded={preview} aria-controls="ai-prompt-preview">
          <Eye className="w-3.5 h-3.5" aria-hidden="true" /> {preview ? 'Hide preview' : 'Preview'}
        </button>
        {status && (
          <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>
            {status.text}
          </p>
        )}
      </div>

      {preview && (
        <div id="ai-prompt-preview" className="space-y-2" data-testid="ai-prompt-preview">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-ink-soft flex-1 min-w-0">The whole prompt for a sample product (King size, indigo and ivory), as it is sent. Read-only.</p>
            <button type="button" onClick={() => void copy()} className={small}>
              <Copy className="w-3.5 h-3.5" aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre tabIndex={0} aria-label="The whole prompt" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-xs text-ink font-mono">
            {assembled}
          </pre>
        </div>
      )}

      <div className="space-y-2 rounded-xl border border-line p-3" data-testid="ai-prompt-try">
        <p className="text-xs font-bold text-ink flex items-center gap-1.5">
          <FlaskConical className="w-3.5 h-3.5" aria-hidden="true" /> Try on a photo
        </p>
        <p className="text-xs text-ink-soft">Writes from one of your products&rsquo; photos with the prompt above, saved or not. Nothing is saved; it counts as one description.</p>
        {withPhotos.length ? (
          <div className="flex flex-col sm:flex-row gap-2">
            <select className={`${field} min-h-11 sm:flex-1`} value={tryId} onChange={(e) => setTryId(e.target.value)} aria-label="Product photo to try on">
              {withPhotos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void tryIt()} disabled={trying || !tryId} className="min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
              {trying && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Try on this photo
            </button>
          </div>
        ) : (
          <p className="text-xs text-ink-muted">Add a product with a photo first.</p>
        )}
        {tried && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="ai-prompt-try-result">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={tried.photo} alt="The photo tried" className="w-full max-w-xs aspect-[4/5] object-cover rounded-xl border border-line" />
            {tried.error ? (
              <p role="alert" className="text-xs font-semibold text-danger break-words">
                {tried.error}
              </p>
            ) : (
              <div className="space-y-2 min-w-0 text-xs text-ink">
                <p className="font-serif font-bold text-base break-words">{tried.suggestion!.title}</p>
                <p className="font-semibold break-words">{tried.suggestion!.shortDescription}</p>
                <p className="whitespace-pre-line break-words text-ink-soft">{tried.suggestion!.description}</p>
                {tried.suggestion!.giftLine && <p className="italic break-words">{tried.suggestion!.giftLine}</p>}
                <p className="text-[11px] text-ink-muted">Not saved. Like it? Press Save prompt above.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
