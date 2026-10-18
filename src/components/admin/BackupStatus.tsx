'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, DatabaseBackup, Loader2, XCircle } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';

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
  notice?: string;
}

function ago(iso?: string) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

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
    return () => clearInterval(t);
  }, []);

  const runNow = async () => {
    setRunning(true);
    const { ok, data } = await postJson<Health>('/api/admin/backup', {});
    setRunning(false);
    if (ok) setHealth(data);
  };

  if (!health) return null;
  const tone =
    health.level === 'ok'
      ? 'bg-success-soft border-success-line text-success'
      : health.level === 'warning'
      ? 'bg-warning-soft border-warning-line text-warning'
      : 'bg-danger-soft border-danger-line text-danger';
  const Icon = health.level === 'ok' ? CheckCircle2 : health.level === 'warning' ? AlertTriangle : XCircle;
  const detail =
    health.level === 'failing'
      ? health.lastError
        ? `Last backup failed: ${health.lastError}`
        : `No backup in the last ${health.intervalHours + 1} hours.`
      : health.lastEmailError
      ? health.lastEmailError
      : health.notice
      ? `${health.notice} Emailed ${ago(health.lastEmailedAt)}.`
      : `Emailed ${ago(health.lastEmailedAt)}${health.encrypted ? ', encrypted' : ''}.`;

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
        {detail} Every {health.intervalHours} h{health.lastSummary ? ` • ${health.lastSummary}` : ''}.
      </p>
    </div>
  );
};
