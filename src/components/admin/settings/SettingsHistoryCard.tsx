'use client';

import React, { useEffect, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';

/**
 * Settings → System → History: every save keeps the version it replaced (the
 * last 30 per group). Restoring one puts it back as it was, keeping the keys
 * saved now, and can itself be undone the same way.
 */

const NAMES: Record<string, string> = {
  brand: 'Branding',
  bank: 'Bank details',
  courier: 'Couriers',
  sms: 'SMS gateway',
  phoneCheck: 'Phone check',
  catalog: 'Catalogue',
  store: 'Store & contact',
  theme: 'Festival themes',
  look: 'Look',
  ai: 'AI writing',
  aiPrompt: 'AI writing prompt',
  aiPictures: 'AI pictures',
  seo: 'Search (SEO)',
};

interface Version {
  id: number;
  key: string;
  savedAt: string;
}

export function SettingsHistoryCard({ onRestored }: { onRestored: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    void getJson<{ versions: Version[] }>('/api/admin/settings/history').then(({ ok, data }) => {
      if (ok) setVersions(data.versions);
    });
  }, [nonce]);

  const restore = async (v: Version) => {
    if (!window.confirm(`Put ${NAMES[v.key] ?? v.key} back as it was on ${new Date(v.savedAt).toLocaleString()}? You can undo this the same way.`)) return;
    setBusy(v.id);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/settings/history', { id: v.id });
    setBusy(null);
    setStatus(ok ? { ok: true, text: `${NAMES[v.key] ?? v.key} restored.` } : { ok: false, text: data.message || 'Could not restore that version.' });
    setNonce((n) => n + 1);
    if (ok) onRestored();
  };

  return (
    <div className="space-y-2 text-xs">
      <h3 className="font-bold text-sm text-ink flex items-center gap-1.5"><History className="w-4 h-4" /> Settings history</h3>
      <p className="text-ink-muted">Each save keeps the version it replaced. Restore one to go back to a setup that worked.</p>
      {status && <p role="status" className={`font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}
      <ul className="divide-y divide-line border border-line rounded-xl bg-surface max-h-80 overflow-y-auto">
        {versions === null && <li className="p-3 text-ink-muted">Loading…</li>}
        {versions?.length === 0 && <li className="p-3 text-ink-muted">Nothing yet: versions appear after the first change.</li>}
        {versions?.map((v) => (
          <li key={v.id} className="flex items-center gap-2 p-2.5">
            <span className="font-semibold text-ink">{NAMES[v.key] ?? v.key}</span>
            <span className="text-ink-muted">as of {new Date(v.savedAt).toLocaleString()}</span>
            <button type="button" onClick={() => void restore(v)} disabled={busy !== null} className="ml-auto px-2 py-1 rounded-lg border border-line-strong font-semibold flex items-center gap-1 disabled:opacity-50">
              {busy === v.id && <Loader2 className="w-3 h-3 animate-spin" />} Restore
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
