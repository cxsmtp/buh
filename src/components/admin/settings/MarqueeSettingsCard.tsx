'use client';

import React, { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import type { BrandSettings } from '@/types';
import { MarqueeStrip } from '@/components/common/MarqueeBar';
import { DEFAULT_MARQUEE, MARQUEE_MAX_CHARS, MARQUEE_MAX_ITEMS, marqueeItems, marqueeProblem, stripEmoji } from '@/lib/marquee';

const field = 'w-full min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold';

/**
 * Settings → Store & contact → Announcement bar: the thin line at the very top of the shop. Up to
 * three short lines (60 characters each), shown calmly: one line stays still in the middle, more
 * drift slowly. The preview below is the bar as customers see it.
 */
export function MarqueeSettingsCard({ brand, onSave }: { brand: BrandSettings; onSave: (b: BrandSettings) => Promise<string | null> }) {
  const [enabled, setEnabled] = useState(brand.marquee?.enabled ?? true);
  const [lines, setLines] = useState<string[]>(() => {
    const now = marqueeItems(brand.marquee?.messages);
    return now.length ? now : [''];
  });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const clean = lines.map((l) => stripEmoji(l)).filter(Boolean);
  const problem = marqueeProblem(lines);
  const set = (i: number, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? v : l)));

  const save = async () => {
    if (problem) return;
    setSaving(true);
    setStatus(null);
    const error = await onSave({ ...brand, marquee: { ...brand.marquee, enabled, messages: clean } });
    setSaving(false);
    setStatus(error ? { ok: false, text: error } : { ok: true, text: 'Saved. The shop shows it now.' });
  };

  return (
    <section aria-labelledby="marquee-title" className="mt-6 pt-5 border-t border-line space-y-4 text-sm">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="marquee-title" className="font-serif text-xl text-ink">Announcement bar</h3>
          <p className="text-xs text-ink-muted">The thin line at the top of the shop. Up to {MARQUEE_MAX_ITEMS} short lines, {MARQUEE_MAX_CHARS} characters each.</p>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Show the bar
        </label>
      </div>

      <ol className="space-y-2.5">
        {lines.map((line, i) => {
          const len = stripEmoji(line).length;
          const over = len > MARQUEE_MAX_CHARS;
          return (
            <li key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor={`marquee-${i}`}>Announcement {i + 1}</label>
                <input
                  id={`marquee-${i}`}
                  className={`${field} ${over ? 'border-danger' : ''}`}
                  value={line}
                  maxLength={MARQUEE_MAX_CHARS + 20}
                  placeholder={DEFAULT_MARQUEE[i] ?? 'A short line'}
                  aria-describedby={`marquee-${i}-count`}
                  aria-invalid={over || undefined}
                  onChange={(e) => set(i, e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ['']))}
                  aria-label={`Remove announcement ${i + 1}`}
                  className="shrink-0 w-10 h-10 flex items-center justify-center rounded-full text-ink-muted hover:text-danger hover:bg-sand"
                >
                  <Trash2 className="w-4 h-4" strokeWidth={1.5} aria-hidden="true" />
                </button>
              </div>
              <p id={`marquee-${i}-count`} className={`text-[11px] ${over ? 'text-danger' : 'text-ink-muted'}`}>
                {len} / {MARQUEE_MAX_CHARS}
                {line !== stripEmoji(line) && line.trim() ? ' · emoji are left out' : ''}
              </p>
            </li>
          );
        })}
      </ol>
      {lines.length < MARQUEE_MAX_ITEMS && (
        <button type="button" onClick={() => setLines((ls) => [...ls, ''])} className="inline-flex items-center gap-1.5 text-xs text-ink underline underline-offset-4">
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Add a line
        </button>
      )}

      <div className="space-y-1.5">
        <p className="label-caps text-ink-muted">Preview</p>
        {enabled && clean.length ? (
          <div className="rounded-xl overflow-hidden border border-line">
            <MarqueeStrip messages={clean} label="Announcement bar preview" />
          </div>
        ) : (
          <p className="text-xs text-ink-muted">{enabled ? 'Add a line to show the bar.' : 'The bar is hidden.'}</p>
        )}
      </div>

      {problem && <p role="alert" className="text-xs text-danger">{problem}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving || Boolean(problem)} className="px-4 py-2 rounded-xl bg-ink text-ivory font-medium text-xs disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save announcements
        </button>
        <button type="button" onClick={() => setLines([...DEFAULT_MARQUEE])} className="text-xs text-ink-soft underline underline-offset-4">
          Use the suggested lines
        </button>
        {status && <span role="status" className={`text-xs ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</span>}
      </div>
    </section>
  );
}
