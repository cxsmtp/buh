'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { ThemeSettings } from '@/types';
import { DEFAULT_THEME, FESTIVALS, themeFor } from '@/lib/festivals/catalog';
import { FestiveGreeting } from '@/components/store/FestiveGreeting';
import { FestiveMotif } from '@/components/store/FestiveMotif';
import { getJson, postJson } from '@/lib/apiClient';

/**
 * Settings → Themes. Automatic: each festival's look shows from 3 weeks before
 * it until 1 week after (shorter for smaller festivals), using dates refreshed
 * weekly from public holiday calendars. The owner can pick a look by hand,
 * switch themes off, or switch off single festivals.
 */

interface Upcoming {
  id: string;
  name: string;
  tier: 1 | 2;
  start: string;
  end: string;
  daysToStart: number;
  phase: string;
  themeFrom: string;
  themeUntil: string;
  disabled: boolean;
}
interface Overview {
  today: string;
  pick: { themeId: string; festivalId?: string; phase: string; reason: string };
  upcoming: Upcoming[];
  lastRefresh: { at: string; ok: boolean; updated: number; errors: string[] } | null;
}

const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function ThemeSettingsCard({ value, onSave }: { value: ThemeSettings; onSave: (v: ThemeSettings) => Promise<string | null> }) {
  const [d, setD] = useState<ThemeSettings>(value);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => getJson<Overview>('/api/admin/themes').then(({ ok, data }) => ok && setOverview(data));
  useEffect(() => {
    void getJson<Overview>('/api/admin/themes').then(({ ok, data }) => {
      if (ok) setOverview(data);
    });
  }, []);

  const save = async (next: ThemeSettings) => {
    const before = d;
    setD(next);
    setSaving(true);
    setStatus(null);
    const problem = await onSave(next);
    setSaving(false);
    if (problem) setD(before); // show what is really saved
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. The shop shows it now.' });
    void load();
  };

  const refresh = async () => {
    setRefreshing(true);
    const { ok, data } = await postJson<{ ok?: boolean; updated?: string[]; errors?: string[]; message?: string }>('/api/admin/themes/refresh', {});
    setRefreshing(false);
    setStatus(
      ok && data.ok
        ? { ok: true, text: `Dates refreshed (${data.updated?.length ?? 0} changed).` }
        : { ok: false, text: data.message || `Some calendars could not be reached: ${(data.errors ?? []).join('; ')}. The built-in dates stay in use.` }
    );
    void load();
  };

  const current = overview?.pick.festivalId ? FESTIVALS.find((f) => f.id === overview.pick.festivalId) : null;
  // Preview any look here before choosing it (nothing is saved until you pick it above).
  const [previewId, setPreviewId] = useState<string | null>(null);
  const shownId = previewId ?? current?.id ?? 'default';
  const shown = FESTIVALS.find((f) => f.id === shownId) ?? null;
  const preview = shown ? shown.theme : DEFAULT_THEME;

  return (
    <div className="space-y-5 text-xs">
      {/* Showing now */}
      <section aria-label="Preview" className="space-y-2.5 rounded-2xl border border-line bg-ivory p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label-caps text-ink-muted">{previewId ? 'Preview' : 'Showing now'}</span>
          <span className="font-serif text-base text-ink">{shown ? shown.name : 'Everyday look'}</span>
          <select
            className="ml-auto min-w-0 max-w-full px-2.5 py-1.5 rounded-lg border border-line-strong bg-surface"
            value={shownId}
            onChange={(e) => setPreviewId(e.target.value)}
            aria-label="Preview a look"
          >
            <option value="default">Everyday look</option>
            {FESTIVALS.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
        {shown ? <FestiveGreeting theme={preview} /> : <p className="text-ink-soft">No greeting: the shop shows its everyday gold.</p>}
        <div className="rounded-lg bg-ink text-sand text-[11px] tracking-[0.06em] px-3 py-2 text-center truncate" aria-label="Announcement bar preview">
          {preview.marquee[0]}
        </div>
        {overview && !previewId && <p className="text-ink-muted">{overview.pick.reason}</p>}
        {previewId && <button type="button" className="text-ink underline underline-offset-4" onClick={() => setPreviewId(null)}>Back to what the shop shows now</button>}
      </section>

      {/* Mode */}
      <fieldset className="space-y-2">
        <legend className="font-bold text-sm text-ink mb-1">How the look is chosen</legend>
        {(
          [
            ['auto', 'Automatic', 'Each festival from 3 weeks before until 1 week after (major ones); smaller ones for a few days around them.'],
            ['manual', 'Always this look', 'Pick one below; it stays until you change it.'],
            ['off', 'Everyday look only', 'No festival themes.'],
          ] as Array<[ThemeSettings['mode'], string, string]>
        ).map(([mode, title, hint]) => (
          <label key={mode} className="flex items-start gap-2">
            <input type="radio" name="theme-mode" className="mt-0.5" checked={d.mode === mode} disabled={saving} onChange={() => void save({ ...d, mode })} />
            <span>
              <strong className="text-ink">{title}</strong>
              <span className="block text-ink-muted">{hint}</span>
            </span>
          </label>
        ))}
        {d.mode === 'manual' && (
          <select
            className="mt-1 w-full sm:w-80 px-2.5 py-2 rounded-lg border border-line-strong bg-surface"
            value={d.themeId}
            onChange={(e) => void save({ ...d, themeId: e.target.value })}
            aria-label="Theme to show"
          >
            <option value="default">Everyday look</option>
            {FESTIVALS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </fieldset>

      <fieldset className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2"><input type="checkbox" checked={d.showBanner} onChange={(e) => void save({ ...d, showBanner: e.target.checked })} /> Festival greeting in the banner</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={d.showMarquee} onChange={(e) => void save({ ...d, showMarquee: e.target.checked })} /> Festival lines in the scrolling bar</label>
      </fieldset>

      {/* Coming up */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-sm text-ink">Coming up</h3>
          <button type="button" onClick={() => void refresh()} disabled={refreshing} className="ml-auto px-2.5 py-1 rounded-lg border border-line-strong font-semibold flex items-center gap-1 disabled:opacity-50">
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh dates now
          </button>
        </div>
        {overview?.lastRefresh ? (
          <p className="text-ink-muted">
            Dates last checked online {new Date(overview.lastRefresh.at).toLocaleString()}
            {overview.lastRefresh.ok ? '.' : ` (some calendars unreachable; built-in dates used for those).`}
          </p>
        ) : (
          <p className="text-ink-muted">Dates are built in, and checked online weekly once the shop is running.</p>
        )}
        <ul className="divide-y divide-line border border-line rounded-xl bg-surface">
          {(overview?.upcoming ?? []).map((u) => (
            <li key={`${u.id}-${u.start}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5">
              <span className="text-gold-deep"><FestiveMotif motif={themeFor(u.id).motif} className="w-4 h-4" /></span>
              <span className={`font-semibold ${u.disabled ? 'line-through text-ink-muted' : 'text-ink'}`}>{u.name}</span>
              <span className="text-ink-muted">{fmt(u.start)}{u.end !== u.start ? ` – ${fmt(u.end)}` : ''}</span>
              <span className="text-ink-muted">look {fmt(u.themeFrom)} → {fmt(u.themeUntil)}</span>
              <label className="ml-auto flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={!d.disabledFestivals.includes(u.id)}
                  onChange={(e) =>
                    void save({ ...d, disabledFestivals: e.target.checked ? d.disabledFestivals.filter((x) => x !== u.id) : [...d.disabledFestivals, u.id] })
                  }
                />
                Show
              </label>
            </li>
          ))}
          {!overview && <li className="p-3 text-ink-muted">Loading…</li>}
        </ul>
      </section>

      {status && <p role="status" className={`font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}
    </div>
  );
}
