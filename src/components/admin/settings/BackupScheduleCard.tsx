'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Loader2 } from 'lucide-react';
import { getJson, sendJson } from '@/lib/apiClient';

/**
 * Settings → System & backups → "When to back up": backups run when there is something new (2 h
 * after the first change to orders, stock, products, payments, expenses or settings by default),
 * the weekly check proves they still work in a quiet week, and the owner picks which are emailed.
 * The server checks every value again (backupPolicy.ts).
 */

/** The warning when nothing leaves the server (the same words as the status line's). */
const ONLY_ON_SERVER = 'Your newest backups are only on the server: connect Google Drive or email them.';

/** Sent when the backup choices are saved, so the status line above reloads. */
export const BACKUP_SCHEDULE_EVENT = 'buh:backup-schedule';

type EmailChoice = 'every' | 'daily' | 'weekly' | 'never';
interface Schedule {
  delayMinutes: number;
  email: EmailChoice;
  weeklyCheck: boolean;
}
interface Health {
  settings: Schedule;
  emailConfigured: boolean;
  drive?: { enabled: boolean };
}

const DELAYS = [30, 60, 90, 120, 180, 240, 360, 480, 720];
const delayLabel = (m: number) => (m < 60 ? `${m} minutes` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} hour${m === 60 ? '' : 's'}`);

const EMAIL_OPTIONS: Array<{ value: EmailChoice; title: string; text: string }> = [
  { value: 'daily', title: 'At most one a day (recommended)', text: 'The first backup after changes each day (UAE time), the weekly check, and “Back up now”. Later backups that day are emailed the next day if nothing else is.' },
  { value: 'every', title: 'Email every backup', text: 'One email for each backup: more emails on a busy day.' },
  { value: 'weekly', title: 'Only the weekly check', text: 'One email a week. Best with Google Drive connected.' },
  { value: 'never', title: 'Never (Google Drive or downloads only)', text: 'No backup emails. Failures are still emailed.' },
];

const label = 'block text-xs font-semibold text-ink-soft mb-1';

export function BackupScheduleCard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [d, setD] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    void getJson<Health>('/api/admin/backup').then(({ ok, data }) => {
      if (!ok) return;
      setHealth(data);
      setD((x) => x ?? data.settings);
    });
  }, [epoch]);

  if (!health || !d) return null;
  const driveOn = Boolean(health.drive?.enabled);
  const gapWarning =
    driveOn
      ? null
      : d.email === 'never'
      ? `${ONLY_ON_SERVER} Google Drive is not connected and backups would not be emailed at all.`
      : d.email === 'weekly'
      ? `${ONLY_ON_SERVER} Google Drive is not connected, and with only the weekly check emailed changes can stay on this server alone for up to a week.`
      : !health.emailConfigured
      ? 'Email is not set up and Google Drive is not connected: backups are only on this server. Set up email (Settings → Email) or connect Google Drive below.'
      : null;
  const delays = DELAYS.includes(d.delayMinutes) ? DELAYS : [...DELAYS, d.delayMinutes].sort((a, b) => a - b);
  const changed = JSON.stringify(d) !== JSON.stringify(health.settings);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    const { ok, data } = await sendJson<{ message?: string }>('PUT', '/api/admin/settings/backups', { settings: d });
    setSaving(false);
    if (!ok) {
      setStatus({ ok: false, text: data.message || 'Not saved. The earlier choices are still in use.' });
      return;
    }
    setStatus({ ok: true, text: 'Saved. The next backup follows these choices.' });
    setEpoch((n) => n + 1);
    window.dispatchEvent(new CustomEvent(BACKUP_SCHEDULE_EVENT));
  };

  return (
    <section className="space-y-3 text-sm rounded-2xl border border-line p-3.5" data-testid="backup-schedule-card" aria-labelledby="backup-schedule-title">
      <div className="flex gap-3 items-start">
        <CalendarClock className="w-5 h-5 text-gold-deep shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <h3 id="backup-schedule-title" className="font-semibold text-ink">When to back up</h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            The shop backs up when there is something new: a while after the first change to orders, stock, products, prices, payments, expenses or settings (chats and visits wait for the next one, or a day). Later changes never push it back. When nothing changes, there is no backup and no email.
          </p>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="backup-delay">Back up after the first change</label>
        <select
          id="backup-delay"
          value={d.delayMinutes}
          onChange={(e) => setD({ ...d, delayMinutes: Number(e.target.value) })}
          className="w-full sm:w-56 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        >
          {delays.map((m) => (
            <option key={m} value={m}>
              {delayLabel(m)}
              {m === 120 ? ' (recommended)' : ''}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-ink-muted mt-1">From half an hour to 12 hours. Data is never longer than this without a backup while people keep working.</p>
      </div>

      <fieldset className="space-y-2">
        <legend className={label}>Email backups</legend>
        {EMAIL_OPTIONS.map((o) => (
          <label key={o.value} className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer ${d.email === o.value ? 'border-gold bg-ivory' : 'border-line bg-surface'}`}>
            <input type="radio" name="backup-email" className="mt-1" value={o.value} checked={d.email === o.value} onChange={() => setD({ ...d, email: o.value })} />
            <span className="min-w-0">
              <span className="block font-semibold text-ink text-xs">{o.title}</span>
              <span className="block text-[11px] text-ink-muted mt-0.5">{o.text}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {gapWarning && (
        <p role="alert" data-testid="backup-offserver-warning" className="flex items-start gap-2 text-xs text-ink bg-warning-soft border border-warning-line rounded-xl p-3 break-words">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
          <span className="min-w-0">{gapWarning}</span>
        </p>
      )}

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" className="mt-1" checked={d.weeklyCheck} onChange={(e) => setD({ ...d, weeklyCheck: e.target.checked })} />
        <span className="min-w-0">
          <span className="block font-semibold text-ink text-xs">Weekly check</span>
          <span className="block text-[11px] text-ink-muted mt-0.5">A backup (and its email) once a week even when nothing changes, so you know backups still work. Skipped when one ran in the last 7 days.</span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving || !changed} className="min-h-11 px-4 py-2 rounded-xl bg-ink text-paper font-bold text-xs disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save backup choices
        </button>
        {status && (
          <span role="status" data-testid="backup-schedule-status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>
            {status.text}
          </span>
        )}
      </div>
    </section>
  );
}
