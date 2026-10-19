'use client';

import React, { useEffect, useState } from 'react';
import { Check, History, Loader2, Monitor, Moon, Sun } from 'lucide-react';
import type { LookSettings } from '@/types';
import { LOOK_PRESET_IDS, LOOK_PRESETS, MODE_LABELS, paletteStyle, type LookMode, type LookPresetId, type Palette } from '@/lib/design/themes';
import { getJson, sendJson } from '@/lib/apiClient';

/**
 * Settings → Look: the shop's look (Ivory & Gold, Noir & Champagne, Pearl & Emerald, Sand & Rose),
 * each with a light and a dark variant, and whether the device picks light or dark. Applies to
 * the shop and to this hub. Every change is kept with its time and who made it; any earlier look
 * (the one from before looks existed among them) can be put back with Switch back. Festival
 * themes (their own section) still colour the shop on their dates, in every look.
 */

interface Entry {
  id: number;
  preset: LookPresetId;
  mode: LookMode;
  label: string;
  changedAt: string;
  changedBy: string;
  pinned: boolean;
}
interface LookData {
  current: LookSettings;
  earlier: Entry[];
}

const DUBAI = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** "18 Oct 2026, 20:31" in Dubai time (stored as ISO, UTC). */
export function dubaiTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DUBAI.format(t) : '';
}

const MODE_ICONS: Record<LookMode, React.ReactNode> = {
  system: <Monitor className="w-4 h-4" aria-hidden="true" />,
  light: <Sun className="w-4 h-4" aria-hidden="true" />,
  dark: <Moon className="w-4 h-4" aria-hidden="true" />,
};

/** The page picks up a new look at once (the stylesheet is fetched again). */
function reloadLookCss() {
  const link = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href^="/look.css"]');
  if (link) link.href = `/look.css?v=${Date.now()}`;
}

export function LookSettingsCard() {
  const [data, setData] = useState<LookData | null>(null);
  const [preset, setPreset] = useState<LookPresetId>('ivory-gold');
  const [mode, setMode] = useState<LookMode>('system');
  const [busy, setBusy] = useState<'save' | number | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState(false);

  const take = (d: LookData) => {
    setData(d);
    setPreset(d.current.preset);
    setMode(d.current.mode);
  };

  useEffect(() => {
    void getJson<LookData>('/api/admin/look').then(({ ok, data: d }) => (ok ? take(d) : setLoadError(true)));
  }, []);

  const changed = data !== null && (preset !== data.current.preset || mode !== data.current.mode);

  const save = async () => {
    setBusy('save');
    setStatus(null);
    const { ok, data: d } = await sendJson<LookData & { message?: string }>('PUT', '/api/admin/look', { preset, mode });
    setBusy(null);
    if (!ok) return setStatus({ ok: false, text: d.message || 'Could not save the look.' });
    take(d);
    reloadLookCss();
    setStatus({ ok: true, text: `Saved: ${d.current.label}. The shop shows it on the next page load.` });
  };

  const switchBack = async (e: Entry) => {
    if (!window.confirm(`Switch back to “${e.label}” (from ${dubaiTime(e.changedAt)})? The look you have now stays in this list.`)) return;
    setBusy(e.id);
    setStatus(null);
    const { ok, data: d } = await sendJson<LookData & { message?: string }>('POST', '/api/admin/look', { switchBack: e.id });
    setBusy(null);
    if (!ok) return setStatus({ ok: false, text: d.message || 'Could not switch back.' });
    take(d);
    reloadLookCss();
    setStatus({ ok: true, text: `Switched back to ${LOOK_PRESETS[d.current.preset].name} · ${MODE_LABELS[d.current.mode]}.` });
  };

  if (loadError) return <p role="alert" className="text-sm text-danger">Could not load the look. Reload the page to try again.</p>;
  if (!data) return <p className="text-sm text-ink-muted flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…</p>;

  const cur = data.current;
  return (
    <div className="space-y-5 text-sm">
      <p className="rounded-2xl border border-line bg-ivory px-3 py-2.5 text-ink" data-testid="look-current">
        <span className="font-semibold">Current: {LOOK_PRESETS[cur.preset].name} · {MODE_LABELS[cur.mode]}</span>
        <span className="text-ink-muted"> · since {dubaiTime(cur.changedAt)}{cur.changedBy ? ` by ${cur.changedBy}` : ''}</span>
      </p>

      <fieldset className="space-y-2">
        <legend className="font-bold text-ink mb-2">Look</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {LOOK_PRESET_IDS.map((id) => {
            const p = LOOK_PRESETS[id];
            const on = preset === id;
            return (
              <label
                key={id}
                className={`relative block rounded-2xl border p-3 cursor-pointer transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold-deep has-[:focus-visible]:outline-offset-2 ${on ? 'border-ink ring-1 ring-ink bg-surface' : 'border-line bg-surface hover:border-line-strong'}`}
              >
                <input type="radio" name="look-preset" value={id} checked={on} onChange={() => setPreset(id)} className="sr-only" />
                <span className="flex items-center justify-between gap-2">
                  <span className="font-serif text-lg text-ink leading-tight">{p.name}</span>
                  {on && <Check className="w-4 h-4 text-gold-deep shrink-0" aria-hidden="true" />}
                </span>
                <span className="block text-xs text-ink-muted mt-0.5 mb-2.5">{p.description}</span>
                <span className="grid grid-cols-2 gap-2" aria-hidden="true">
                  <Sample colors={p.light.colors} caption="Light" />
                  <Sample colors={p.dark.colors} caption="Dark" />
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-bold text-ink mb-1">Light or dark</legend>
        <p className="text-xs text-ink-muted">Match the device follows each phone or computer’s own setting (dark at night if the visitor chose so). The shop and this hub both follow it.</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(MODE_LABELS) as LookMode[]).map((m) => (
            <label
              key={m}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 min-h-11 rounded-full border text-xs font-semibold cursor-pointer has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold-deep has-[:focus-visible]:outline-offset-2 ${mode === m ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink-soft border-line-strong hover:bg-ivory'}`}
            >
              <input type="radio" name="look-mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="sr-only" />
              {MODE_ICONS[m]} {MODE_LABELS[m]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={!changed || busy !== null} className="px-5 py-2.5 min-h-11 rounded-xl bg-ink text-paper font-semibold flex items-center gap-2 disabled:opacity-50">
          {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Save look
        </button>
        {changed && <span className="text-xs text-ink-muted">Not saved yet: {LOOK_PRESETS[preset].name} · {MODE_LABELS[mode]}</span>}
      </div>
      {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}

      <section className="space-y-2 border-t border-line pt-4" aria-labelledby="earlier-looks">
        <h3 id="earlier-looks" className="font-bold text-ink flex items-center gap-2"><History className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Earlier looks</h3>
        <p className="text-xs text-ink-muted">Each change keeps the look it replaced (times in Dubai). The look from before looks existed is always here.</p>
        <ul className="divide-y divide-line border border-line rounded-xl bg-surface">
          {data.earlier.length === 0 && <li className="p-3 text-ink-muted text-xs">Nothing yet.</li>}
          {data.earlier.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-2.5 min-w-0">
              <span className="flex shrink-0 rounded-full overflow-hidden border border-line-strong" aria-hidden="true">
                <span className="w-3 h-5" style={{ background: LOOK_PRESETS[e.preset].light.colors.ivory }} />
                <span className="w-3 h-5" style={{ background: LOOK_PRESETS[e.preset][e.mode === 'dark' ? 'dark' : 'light'].colors.gold }} />
                <span className="w-3 h-5" style={{ background: LOOK_PRESETS[e.preset].dark.colors.ivory }} />
              </span>
              <span className="min-w-0 flex-1 basis-40">
                <span className="block font-semibold text-ink break-anywhere">{e.label}</span>
                <span className="block text-xs text-ink-muted">
                  {LOOK_PRESETS[e.preset].name} · {MODE_LABELS[e.mode]} · {dubaiTime(e.changedAt)}
                  {e.changedBy ? ` · ${e.changedBy}` : ''}
                </span>
              </span>
              <button
                type="button"
                onClick={() => void switchBack(e)}
                disabled={busy !== null}
                aria-label={`Switch back to ${e.label}, from ${dubaiTime(e.changedAt)}`}
                className="ml-auto px-3 py-1.5 min-h-11 rounded-lg border border-line-strong text-xs font-semibold text-ink flex items-center gap-1 hover:bg-ivory disabled:opacity-50"
              >
                {busy === e.id && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />} Switch back
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** A tiny shop front in one variant: the tokens set on the box, so its classes show that look. */
function Sample({ colors, caption }: { colors: Palette; caption: string }) {
  return (
    <span className="block rounded-xl overflow-hidden border border-line bg-ivory" style={paletteStyle(colors) as React.CSSProperties}>
      <span className="flex items-center justify-between px-2 py-1 bg-ivory border-b border-line">
        <span className="font-serif text-[11px] text-ink leading-none">Beautiful UAE Home</span>
        <span className="text-[9px] uppercase tracking-[0.12em] text-ink-muted">{caption}</span>
      </span>
      <span className="block p-2 space-y-1.5">
        <span className="block h-8 rounded-md bg-sand border border-line relative">
          <span className="absolute left-1.5 top-1.5 w-2.5 h-2.5 rounded-full border border-gold" />
        </span>
        <span className="block text-[10px] text-ink leading-tight">Jaipur block-print set</span>
        <span className="flex items-center justify-between gap-1">
          <span className="text-[10px] font-semibold text-gold-deep">AED 349</span>
          <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-ink text-paper">Add</span>
        </span>
      </span>
    </span>
  );
}
