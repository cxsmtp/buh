'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { ThemeSettings } from '@/types';
import { DEFAULT_THEME, FESTIVALS, themeFor } from '@/lib/festivals/catalog';
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
  const preview = current ? current.theme : DEFAULT_THEME;

  return (
    <div className="space-y-5 text-xs">
      {/* Showing now */}
      <div className="rounded-2xl p-4 text-white" style={{ backgroundImage: `linear-gradient(110deg, ${preview.gradient[0]}, ${preview.gradient[1]})` }}>
        <div className="text-[10px] uppercase tracking-wider opacity-80">Showing now</div>
        <div className="text-base font-bold">
          {preview.ornament} {current ? current.name : 'Everyday look'}
        </div>
        {current && <div className="opacity-90">{preview.greeting} · {preview.headline}</div>}
        {overview && <div className="mt-1 opacity-75">{overview.pick.reason}</div>}
      </div>

      {/* Mode */}
      <fieldset className="space-y-2">
        <legend className="font-bold text-sm text-[#0f1c2e] mb-1">How the look is chosen</legend>
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
              <strong className="text-stone-800">{title}</strong>
              <span className="block text-stone-500">{hint}</span>
            </span>
          </label>
        ))}
        {d.mode === 'manual' && (
          <select
            className="mt-1 w-full sm:w-80 px-2.5 py-2 rounded-lg border border-stone-300 bg-white"
            value={d.themeId}
            onChange={(e) => void save({ ...d, themeId: e.target.value })}
            aria-label="Theme to show"
          >
            <option value="default">Everyday look</option>
            {FESTIVALS.map((f) => (
              <option key={f.id} value={f.id}>
                {themeFor(f.id).ornament} {f.name}
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
          <h3 className="font-bold text-sm text-[#0f1c2e]">Coming up</h3>
          <button type="button" onClick={() => void refresh()} disabled={refreshing} className="ml-auto px-2.5 py-1 rounded-lg border border-stone-300 font-semibold flex items-center gap-1 disabled:opacity-50">
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh dates now
          </button>
        </div>
        {overview?.lastRefresh ? (
          <p className="text-stone-500">
            Dates last checked online {new Date(overview.lastRefresh.at).toLocaleString()}
            {overview.lastRefresh.ok ? '.' : ` (some calendars unreachable; built-in dates used for those).`}
          </p>
        ) : (
          <p className="text-stone-500">Dates are built in, and checked online weekly once the shop is running.</p>
        )}
        <ul className="divide-y divide-stone-100 border border-stone-200 rounded-xl bg-white">
          {(overview?.upcoming ?? []).map((u) => (
            <li key={`${u.id}-${u.start}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-2.5">
              <span aria-hidden="true">{themeFor(u.id).ornament}</span>
              <span className={`font-semibold ${u.disabled ? 'line-through text-stone-500' : 'text-stone-800'}`}>{u.name}</span>
              <span className="text-stone-500">{fmt(u.start)}{u.end !== u.start ? ` – ${fmt(u.end)}` : ''}</span>
              <span className="text-stone-500">look {fmt(u.themeFrom)} → {fmt(u.themeUntil)}</span>
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
          {!overview && <li className="p-3 text-stone-500">Loading…</li>}
        </ul>
      </section>

      {status && <p role="status" className={`font-semibold ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</p>}
    </div>
  );
}
