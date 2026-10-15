'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, History, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { MiniMarkdown } from '@/components/common/MiniMarkdown';

/**
 * Settings → Versions: every release with what changed (the changelog), which
 * one runs, and a button to switch to any of them. The updater does the switch
 * the zero-downtime way (snapshot first, the new copy takes over only when
 * healthy). Without the updater, the server commands are shown instead.
 */

interface Entry {
  version: string;
  label: string;
  date: string;
  pr: number | null;
  lines: string[];
}
interface Info {
  current: string;
  oldestRollback: string;
  changelog: Entry[];
  updater: {
    updatedAt: string;
    running: string;
    onServer: string[];
    autoUpdateMinutes: number;
    lastRequest: { request: string; result: string; message: string; at: string };
  } | null;
  pending: string | null;
}

const older = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
};
const label = (v: string) => `BUH-${v.split('.').map((n) => n.padStart(2, '0')).join('.')}`;

export function VersionsCard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(
    () =>
      getJson<Info & { message?: string }>('/api/admin/versions').then(({ ok, data }) => {
        if (ok) setInfo(data);
        else setError(data.message || 'Could not load the versions.');
      }),
    []
  );
  useEffect(() => {
    const fetchNow = () =>
      void getJson<Info & { message?: string }>('/api/admin/versions').then(({ ok, data }) => {
        if (ok) setInfo(data);
        else setError(data.message || 'Could not load the versions.');
      });
    fetchNow();
    const t = setInterval(fetchNow, 15_000);
    return () => clearInterval(t);
  }, []);

  const switchTo = async (target: string) => {
    const what = target === 'latest' ? 'the latest version' : label(target);
    if (!window.confirm(`Switch the shop to ${what}? A database snapshot is taken first; the shop stays open while it switches.`)) return;
    setBusy(target);
    setStatus(null);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/versions', { target });
    setBusy(null);
    setStatus({ ok, text: data.message || (ok ? 'Requested.' : 'Could not switch.') });
    void load();
  };

  if (!info) return <p className="text-xs text-stone-500">{error || 'Loading…'}</p>;
  const running = info.updater?.running || info.current;
  const managed = Boolean(info.updater);

  return (
    <div className="space-y-4 text-xs text-stone-700">
      <div className="rounded-2xl border border-stone-200 bg-white p-3 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <History className="w-4 h-4 text-[#c5a059]" />
          <span>
            This page is <strong className="font-mono">{label(info.current)}</strong>
            {running !== info.current && <> · the server now runs <strong className="font-mono">{label(running)}</strong> (reload to see it)</>}
          </span>
          {managed && (
            <button type="button" onClick={() => void switchTo('latest')} disabled={Boolean(busy) || Boolean(info.pending) || info.updater?.lastRequest.result === 'working'} className="ml-auto px-3 py-1.5 rounded-lg bg-[#0f1c2e] text-white font-bold flex items-center gap-1 disabled:opacity-50">
              {busy === 'latest' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Update to the latest
            </button>
          )}
        </div>
        {managed ? (
          <p className="text-stone-500">
            Automatic updates: {info.updater!.autoUpdateMinutes > 0 ? `checked every ${info.updater!.autoUpdateMinutes} minutes` : 'only when you ask'}.
            {info.pending && <strong className="text-amber-700"> A switch is waiting to start (within a minute).</strong>}
            {info.updater!.lastRequest.at && !info.pending && (
              <span className={info.updater!.lastRequest.result === 'ok' ? 'text-emerald-700' : info.updater!.lastRequest.result === 'working' ? 'text-amber-700 font-semibold' : 'text-red-700'}>
                {' '}
                {info.updater!.lastRequest.result === 'working' ? info.updater!.lastRequest.message : `Last request: ${info.updater!.lastRequest.message}`}
              </span>
            )}
          </p>
        ) : (
          <div className="text-stone-600 space-y-1">
            <p>Automatic updates are not running on this server, so switch versions with a command (on the server, in the shop folder):</p>
            <code className="block bg-stone-100 rounded-lg p-2 break-all">docker compose run --rm updater rollback ghcr.io/cxsmtp/buh:2.0.0</code>
            <p>Change 2.0.0 to the version you want. To let this page do it, turn on automatic updates (deployment guide, section 5).</p>
          </div>
        )}
        {status && <p role="status" className={`font-semibold ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</p>}
      </div>

      <ol className="space-y-2">
        {info.changelog.map((e) => {
          const isRunning = e.version === running;
          const tooOld = older(e.version, info.oldestRollback);
          return (
            <li key={e.version} className={`rounded-2xl border p-3 bg-white ${isRunning ? 'border-[#c5a059]' : 'border-stone-200'}`}>
              <details open={e.version === info.changelog[0]?.version}>
                <summary className="cursor-pointer flex flex-wrap items-center gap-x-2 gap-y-1">
                  <strong className="font-mono text-[#0f1c2e]">{e.label}</strong>
                  <span className="text-stone-500">{e.date}</span>
                  {e.pr && (
                    <a href={`https://github.com/cxsmtp/buh/pull/${e.pr}`} target="_blank" rel="noopener noreferrer" className="text-stone-500 underline inline-flex items-center gap-0.5" onClick={(ev) => ev.stopPropagation()}>
                      #{e.pr} <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {isRunning && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold">Running</span>}
                  <span className="ml-auto">
                    {!isRunning && managed && !tooOld && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.preventDefault();
                          void switchTo(e.version);
                        }}
                        disabled={Boolean(busy) || Boolean(info.pending) || info.updater?.lastRequest.result === 'working'}
                        className="px-2.5 py-1 rounded-lg border border-stone-300 font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                        aria-label={`Switch to ${e.label}`}
                      >
                        {busy === e.version ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Switch to this version
                      </button>
                    )}
                    {!isRunning && tooOld && <span className="text-stone-400">Can&apos;t run on today&apos;s database</span>}
                  </span>
                </summary>
                <div className="mt-2 leading-relaxed">
                  <MiniMarkdown lines={e.lines} />
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
