'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseBackup, Loader2, XCircle } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { copyingText, mb, type DriveCopying } from './settings/DriveBackupCard';
import { BACKUP_PASSWORD_EVENT } from './settings/BackupPasswordCard';
import { BACKUP_SCHEDULE_EVENT } from './settings/BackupScheduleCard';

interface Health {
  level: 'ok' | 'warning' | 'failing';
  intervalHours: number;
  emailConfigured: boolean;
  encrypted: boolean;
  nextDueAt: string | null;
  lastSuccessAt?: string;
  lastSummary?: string;
  lastError?: string;
  lastEmailedAt?: string;
  lastEmailError?: string;
  lastEmailSkipped?: string;
  notice?: string;
  /** Nothing has left the server for 2 days (no Drive, newer backups not emailed). */
  offServerWarning?: string;
  clockWarning?: string;
  /** Why it is failing when no backup failed: changes waiting too long, or no backup for 8 days. */
  overdueText?: string;
  /** What waits for the next backup. */
  pending?: { total: number; labels: string };
  lastChanges?: { total: number };
  lastChangesText?: string;
  lastReason?: 'changes' | 'weekly-check' | 'manual' | 'startup';
  weeklyCheckAt?: string | null;
  retryAt?: string | null;
  /** The off-server copy (Settings → System & backups → Google Drive). */
  drive?: { enabled: boolean; level: 'off' | 'ok' | 'failing'; lastSuccessAt?: string; lastSize?: number; lastError?: string; copying?: DriveCopying | null };
}

function ago(iso?: string) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** "2:10 pm", "yesterday 2:10 pm" or "Sun 18 Oct, 2:10 pm", in the viewer's time. */
export function when(iso?: string | null, now = Date.now()) {
  if (!iso) return '';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
  const day = (x: Date) => x.toDateString();
  if (day(d) === day(new Date(now))) return time;
  if (day(d) === day(new Date(now + 86_400_000))) return `tomorrow ${time}`;
  if (day(d) === day(new Date(now - 86_400_000))) return `yesterday ${time}`;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Backups at a glance: green when the last one is recent and was emailed, amber or red otherwise. */
export const BackupStatus: React.FC = () => {
  const [health, setHealth] = useState<Health | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const load = () =>
      void getJson<Health>('/api/admin/backup').then(({ ok, data }) => {
        if (ok) setHealth(data);
      });
    load();
    const t = setInterval(load, 5 * 60_000);
    // A backup password just set (or changed): the "unencrypted" notice goes at once.
    window.addEventListener(BACKUP_PASSWORD_EVENT, load);
    // The backup choices just saved (Settings → System & backups): the next time changes.
    window.addEventListener(BACKUP_SCHEDULE_EVENT, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(BACKUP_PASSWORD_EVENT, load);
      window.removeEventListener(BACKUP_SCHEDULE_EVENT, load);
    };
  }, []);

  // A copy to Google Drive going up after the backup: follow it every few seconds until it is done.
  const copying = Boolean(health?.drive?.copying);
  useEffect(() => {
    if (!copying) return;
    const t = setInterval(
      () =>
        void getJson<Health>('/api/admin/backup').then(({ ok, data }) => {
          if (ok) setHealth(data);
        }),
      3000
    );
    return () => clearInterval(t);
  }, [copying]);

  const runNow = async () => {
    setRunning(true);
    const { ok, data } = await postJson<Health>('/api/admin/backup', {});
    setRunning(false);
    if (ok) setHealth(data);
  };

  if (!health) return null;
  const drive = health.drive?.enabled ? health.drive : null;
  // A failed Drive copy never makes the local backup look failed: it turns an all-green line amber.
  const level = health.level === 'ok' && drive?.level === 'failing' ? 'warning' : health.level;
  const tone =
    level === 'ok'
      ? 'bg-success-soft border-success-line text-success'
      : level === 'warning'
      ? 'bg-warning-soft border-warning-line text-warning'
      : 'bg-danger-soft border-danger-line text-danger';
  const Icon = level === 'ok' ? CheckCircle2 : level === 'warning' ? AlertTriangle : XCircle;
  const detail =
    health.level === 'failing'
      ? health.lastError
        ? `Last backup failed: ${health.lastError}`
        : health.overdueText || 'Backups need attention.'
      : health.clockWarning
      ? health.clockWarning
      : health.lastEmailError
      ? health.lastEmailError
      : health.notice
      ? `${health.notice} Emailed ${ago(health.lastEmailedAt)}.`
      : health.offServerWarning
      ? `${health.offServerWarning} Last emailed ${ago(health.lastEmailedAt)}.`
      : health.lastEmailSkipped && health.lastEmailedAt
      ? `Last emailed ${ago(health.lastEmailedAt)}${health.encrypted ? ', encrypted' : ''}.`
      : health.lastEmailSkipped
      ? health.lastEmailSkipped
      : `Emailed ${ago(health.lastEmailedAt)}${health.encrypted ? ', encrypted' : ''}.`;
  const pending = health.pending?.total ?? 0;
  const why = health.lastReason === 'weekly-check' ? 'weekly check' : health.lastReason === 'manual' ? 'Back up now' : health.lastReason === 'startup' ? 'first backup' : '';
  const held = health.lastChanges?.total
    ? `after ${plural(health.lastChanges.total, 'change')}${health.lastChangesText ? `: ${health.lastChangesText}` : ''}`
    : why
    ? why
    : '';
  const next = pending
    ? `Next: by ${when(health.retryAt && health.nextDueAt && health.retryAt > health.nextDueAt ? health.retryAt : health.nextDueAt)} — ${plural(pending, 'change')} waiting${health.pending?.labels ? ` (${health.pending.labels})` : ''}.`
    : health.retryAt
    ? `Trying again by ${when(health.retryAt)}.`
    : 'Nothing new since the last backup — none needed.';

  return (
    <div className={`rounded-2xl border px-3.5 py-2.5 text-xs space-y-1.5 ${tone}`} role="status">
      {/* The status and the button on one line; the explanation below at full width, so a long notice
          (an unencrypted backup, say) never squeezes into a narrow column on a phone. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <DatabaseBackup className="w-4 h-4 shrink-0" />
        <span className="font-bold flex items-center gap-1 min-w-0">
          <Icon className="w-3.5 h-3.5 shrink-0" />
          Backup {ago(health.lastSuccessAt)}
        </span>
        <button
          type="button"
          onClick={runNow}
          disabled={running}
          className="ml-auto px-2.5 py-1 rounded-lg border border-current/30 bg-surface/70 hover:bg-surface font-semibold flex items-center gap-1 disabled:opacity-60"
        >
          {running && <Loader2 className="w-3 h-3 animate-spin" />}
          {running ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      <p data-testid="backup-detail" className="opacity-80 break-words">
        {detail}
        {health.lastSummary ? ` Holds ${health.lastSummary}.` : ''}
      </p>
      {health.lastSuccessAt && (
        <p data-testid="backup-last" className="opacity-80 break-words">
          Last backup: {when(health.lastSuccessAt)}
          {held ? ` (${held})` : ''}.
        </p>
      )}
      <p data-testid="backup-next" className="opacity-80 break-words">
        {next}
        {health.weeklyCheckAt ? (
          <span data-testid="backup-weekly">
            {' '}Weekly check: {new Date(health.weeklyCheckAt).toLocaleDateString('en-GB', { weekday: 'long' })}.
          </span>
        ) : null}
      </p>
      {drive && (
        <p data-testid="backup-drive" className="opacity-80 break-words">
          {drive.copying
            ? copyingText(drive.copying)
            : drive.level === 'failing'
            ? `Google Drive copy failed: ${drive.lastError || 'see Settings → System & backups'}.`
            : drive.lastSuccessAt
            ? `Copied to Google Drive ${ago(drive.lastSuccessAt)}${drive.lastSize ? ` (${mb(drive.lastSize)})` : ''}.`
            : 'Google Drive: no copy yet.'}
        </p>
      )}
    </div>
  );
};
