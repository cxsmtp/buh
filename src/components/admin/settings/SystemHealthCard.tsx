'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { getJson } from '@/lib/apiClient';

/** Settings → System: what needs attention now (also emailed), and disk space. */

interface Health {
  problems: Array<{ id: string; level: 'warning' | 'failing'; text: string }>;
  disk: { free: number; total: number } | null;
  version: string;
}

export function SystemHealthCard() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const load = () =>
      void getJson<Health>('/api/admin/health').then(({ ok, data }) => {
        if (ok) setHealth(data);
      });
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  if (!health) return null;
  const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
  return (
    <div className="space-y-2 text-xs">
      <h3 className="font-bold text-sm text-ink">Health</h3>
      {health.problems.length === 0 ? (
        <p className="flex items-center gap-1.5 text-success font-semibold"><CheckCircle2 className="w-4 h-4" /> Everything is running normally.</p>
      ) : (
        <ul className="space-y-1.5">
          {health.problems.map((p) => (
            <li key={p.id} className={`flex items-start gap-1.5 rounded-lg px-2.5 py-2 border ${p.level === 'failing' ? 'bg-danger-soft border-danger-line text-danger' : 'bg-warning-soft border-warning-line text-warning'}`}>
              {p.level === 'failing' ? <XCircle className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
              <span>{p.text}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-ink-muted">
        {health.disk && <>Disk: {gb(health.disk.free)} GB free of {gb(health.disk.total)} GB. </>}
        Problems are emailed to the backup address, and a summary of yesterday&apos;s orders arrives every morning at 8:00.
      </p>
    </div>
  );
}
