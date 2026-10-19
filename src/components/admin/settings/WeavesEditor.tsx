'use client';

import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';

/**
 * Settings → Catalogue → Weaves: the weaves the product editor offers (Sateen, Percale, …). Add,
 * reorder and remove save with the rest of the card (autosave). A weave that products still use
 * can't be removed (the server refuses it too); Rename changes it on every product at once.
 */

const field = 'w-full min-w-0 px-2.5 py-1.5 rounded-lg border border-line-strong bg-surface text-ink text-base sm:text-xs focus:outline-none focus:ring-2 focus:ring-gold';
const MAX = 30;
const MAX_LEN = 30;

/** The same rule as the server's: 1–30 characters, letters or digits first, no markup. */
export function weaveProblem(name: string, list: string[], except?: string): string | null {
  if (!name) return 'Type a name.';
  if (name.length > MAX_LEN) return `At most ${MAX_LEN} characters.`;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '’&/().+-]*$/u.test(name)) return 'Letters, digits, spaces and \' & / ( ) . + - only.';
  if (list.some((w) => w !== except && w.toLowerCase() === name.toLowerCase())) return `“${name}” is already in the list.`;
  return null;
}

export function WeavesEditor({ weaves, onChange, onRenamed }: { weaves: string[]; onChange: (next: string[]) => void; onRenamed: (from: string, to: string, saved: string[]) => void }) {
  const [usage, setUsage] = useState<Record<string, number> | null>(null);
  const [adding, setAdding] = useState('');
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void getJson<{ usage: Record<string, number> }>('/api/admin/catalog/weaves').then(({ ok, data }) => {
      if (live && ok) setUsage(data.usage);
    });
    return () => {
      live = false;
    };
  }, []);

  const move = (i: number, to: number) => {
    if (to < 0 || to >= weaves.length) return;
    const next = [...weaves];
    const [w] = next.splice(i, 1);
    next.splice(to, 0, w);
    onChange(next);
  };

  const add = () => {
    const name = adding.trim().replace(/\s+/g, ' ');
    const problem = weaveProblem(name, weaves);
    if (problem) return setStatus({ ok: false, text: problem });
    onChange([...weaves, name]);
    setAdding('');
    setStatus(null);
  };

  const rename = async () => {
    if (!renaming) return;
    const to = renaming.to.trim().replace(/\s+/g, ' ');
    const from = renaming.from;
    if (to === from) return setRenaming(null);
    const merging = weaves.find((w) => w !== from && w.toLowerCase() === to.toLowerCase());
    const problem = merging ? weaveProblem(to, [], from) : weaveProblem(to, weaves, from);
    if (problem) return setStatus({ ok: false, text: problem });
    // Not saved yet (just added here): nothing uses it, so it is renamed in the list only.
    if (!usage || usage[from] === undefined) {
      onChange(weaves.map((w) => (w === from ? to : w)));
      setRenaming(null);
      return setStatus(null);
    }
    if (merging && !window.confirm(`“${merging}” is already in the list. Move every ${from} product to ${merging}, and take ${from} off the list?`)) return;
    setBusy(true);
    setStatus(null);
    const { ok, data } = await postJson<{ message?: string; to?: string; weaves?: string[]; products?: number; usage?: Record<string, number> }>('/api/admin/catalog/weaves', { from, to });
    setBusy(false);
    if (!ok || !data.weaves) return setStatus({ ok: false, text: data.message || 'Could not rename the weave.' });
    setRenaming(null);
    if (data.usage) setUsage(data.usage);
    onRenamed(from, data.to ?? to, data.weaves);
    const n = data.products ?? 0;
    setStatus({ ok: true, text: `Renamed to ${data.to ?? to}${n ? ` on ${n} ${n === 1 ? 'product' : 'products'}` : ''}.` });
  };

  return (
    <section className="space-y-2" aria-labelledby="weaves-h" data-testid="weaves-editor">
      <h3 id="weaves-h" className="font-bold text-sm text-ink">
        Weaves
      </h3>
      <p className="text-ink-muted">Offered in the product editor, in this order. Rename changes the weave on every product that has it.</p>
      <ul className="space-y-1.5">
        {weaves.map((w, i) => {
          const used = usage?.[w] ?? 0;
          return (
            <li key={w} className="rounded-xl border border-line bg-surface">
              {renaming?.from === w ? (
                <div className="flex flex-wrap items-center gap-2 p-2">
                  <label className="flex-1 min-w-[10rem]">
                    <span className="sr-only">New name for {w}</span>
                    <input
                      className={field}
                      value={renaming.to}
                      maxLength={MAX_LEN}
                      autoFocus
                      onChange={(e) => setRenaming({ from: w, to: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  </label>
                  <button type="button" onClick={() => void rename()} disabled={busy} className="min-h-9 px-3 rounded-lg bg-ink text-paper font-bold inline-flex items-center gap-1 disabled:opacity-50">
                    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Rename
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} className="min-h-9 px-2 font-semibold underline">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 p-2">
                  <span className="font-semibold text-ink flex-1 min-w-0 truncate">{w}</span>
                  <span className="text-ink-muted shrink-0" data-testid={`weave-used-${w}`}>
                    {usage ? `${used} ${used === 1 ? 'product' : 'products'}` : ''}
                  </span>
                  <button type="button" onClick={() => move(i, i - 1)} disabled={i === 0} className="p-1.5 disabled:opacity-30" aria-label={`Move ${w} up`}>
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => move(i, i + 1)} disabled={i === weaves.length - 1} className="p-1.5 disabled:opacity-30" aria-label={`Move ${w} down`}>
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => setRenaming({ from: w, to: w })} className="p-1.5" aria-label={`Rename ${w}`}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (used > 0) return setStatus({ ok: false, text: `${w} is the weave of ${used} ${used === 1 ? 'product' : 'products'}: change their weave first, or use Rename to move them to another weave.` });
                      onChange(weaves.filter((x) => x !== w));
                      setStatus(null);
                    }}
                    disabled={weaves.length === 1}
                    className={`p-1.5 text-ink-muted disabled:opacity-30 ${used > 0 ? 'opacity-40' : ''}`}
                    aria-label={used > 0 ? `${w} is in use and can't be removed` : `Remove ${w}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {weaves.length < MAX && (
        <div className="flex items-center gap-2">
          <label className="flex-1 min-w-0">
            <span className="sr-only">New weave</span>
            <input
              className={field}
              value={adding}
              maxLength={MAX_LEN}
              placeholder="e.g. Waffle"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
              }}
            />
          </label>
          <button type="button" onClick={add} className="min-h-9 px-3 rounded-lg border border-line-strong font-semibold text-ink inline-flex items-center gap-1 shrink-0">
            <Plus className="w-3.5 h-3.5" /> Add a weave
          </button>
        </div>
      )}
      {status && (
        <p role={status.ok ? 'status' : 'alert'} className={`font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>
          {status.text}
        </p>
      )}
    </section>
  );
}
