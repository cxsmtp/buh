'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, ExternalLink, History, Loader2, RotateCcw, ShieldAlert, Sparkles } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { MiniMarkdown } from '@/components/common/MiniMarkdown';
import { SETUP_CMD, SETUP_POWERSHELL } from '@/lib/podmanSetup';

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
    /** single: one Podman container, a few seconds' pause at a switch; compose: blue/green, no pause. */
    mode?: 'compose' | 'single';
    running: string;
    onServer: string[];
    autoUpdateMinutes: number;
    lastRequest: { request: string; result: string; message: string; at: string };
    /** Set while the registry refuses downloads (login missing or expired). */
    registryProblem?: string;
    /** New versions are installed by themselves (off: only when asked here). */
    auto?: boolean;
    lastCheck?: { at: string; result: string };
    history?: { at: string; version: string; digest: string; why: string }[];
    digests?: { version: string; digest: string; verified: boolean }[];
    integrityProblem?: string;
  } | null;
  pending: string | null;
}

const older = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
};
const IMAGE = 'ghcr.io/cxsmtp/buh';
const PODMAN_RUN = `podman run --replace -d --name beautifuluaehome -p 443:3000 -v beautifuluaehome-data:/data -e TZ=Asia/Dubai --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true ${IMAGE}:latest`;
const label = (v: string) => `BUH-${v.split('.').map((n) => n.padStart(2, '0')).join('.')}`;
/** sha256:2c1f…: the first 12 hex digits, as `podman images --digests` shows them; "id:…" (built here) as is. */
const shortDigest = (d: string) => (d.startsWith('sha256:') ? `sha256:${d.slice(7, 19)}` : d);
const WHY: Record<string, string> = { scheduled: 'automatic', manual: 'asked for', rollback: 'switched back', 'set-up': 'set-up' };

export function VersionsCard() {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  // The setting asked for, until the updater's status confirms it.
  const [autoWanted, setAutoWanted] = useState<boolean | null>(null);

  const load = useCallback(
    () =>
      getJson<Info & { message?: string }>('/api/admin/versions').then(({ ok, data }) => {
        if (ok) {
          setInfo(data);
          // The updater confirmed the setting asked for: nothing to wait for any more.
          setAutoWanted((w) => (w !== null && (data.updater?.auto !== false) === w ? null : w));
        } else setError(data.message || 'Could not load the versions.');
      }),
    []
  );
  useEffect(() => {
    const fetchNow = () =>
      void getJson<Info & { message?: string }>('/api/admin/versions').then(({ ok, data }) => {
        if (ok) {
          setInfo(data);
          // The updater confirmed the setting asked for: nothing to wait for any more.
          setAutoWanted((w) => (w !== null && (data.updater?.auto !== false) === w ? null : w));
        } else setError(data.message || 'Could not load the versions.');
      });
    fetchNow();
    const t = setInterval(fetchNow, 15_000);
    return () => clearInterval(t);
  }, []);

  const switchTo = async (target: string) => {
    const what = target === 'latest' ? 'the latest version' : label(target);
    const pause = info?.updater?.mode === 'single' ? 'the shop closes for a few seconds while it switches' : 'the shop stays open while it switches';
    if (!window.confirm(`Switch the shop to ${what}? A database snapshot is taken first; ${pause}.`)) return;
    setBusy(target);
    setStatus(null);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/versions', { target });
    setBusy(null);
    setStatus({ ok, text: data.message || (ok ? 'Requested.' : 'Could not switch.') });
    void load();
  };

  const setAuto = async (on: boolean) => {
    setAutoWanted(on);
    setStatus(null);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/versions', { auto: on });
    if (!ok) setAutoWanted(null);
    setStatus({ ok, text: data.message || (ok ? 'Requested.' : 'Could not change the setting.') });
    void load();
  };
  // While the updater has not confirmed a new setting yet, look every 2 s (it takes up to a minute).
  const waitingForUpdater = autoWanted !== null && Boolean(info?.updater) && autoWanted !== (info?.updater?.auto !== false);
  useEffect(() => {
    if (!waitingForUpdater) return;
    const t = setInterval(() => void load(), 2_000);
    return () => clearInterval(t);
  }, [waitingForUpdater, load]);

  if (!info) return <p className="text-xs text-ink-muted">{error || 'Loading…'}</p>;
  const running = info.updater?.running || info.current;
  const managed = Boolean(info.updater);
  const autoNow = info.updater?.auto !== false;
  // Asked for, and the updater's status does not say so yet.
  const autoWaiting = managed && autoWanted !== null && autoWanted !== autoNow;

  return (
    <div className="space-y-4 text-xs text-ink-soft">
      <div className="rounded-2xl border border-line bg-surface p-3 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <History className="w-4 h-4 text-gold" />
          <span>
            This page is <strong className="font-mono">{label(info.current)}</strong>
            {running !== info.current && <> · the server now runs <strong className="font-mono">{label(running)}</strong> (reload to see it)</>}
          </span>
          {managed && (
            <button type="button" onClick={() => void switchTo('latest')} disabled={Boolean(busy) || Boolean(info.pending) || info.updater?.lastRequest.result === 'working'} className="ml-auto px-3 py-1.5 rounded-lg bg-ink text-paper font-bold flex items-center gap-1 disabled:opacity-50">
              {busy === 'latest' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Update to the latest
            </button>
          )}
        </div>
        {managed && (
          <p className="text-ink-muted">
            Automatic updates{info.updater!.mode === 'single' ? ': Podman (one container), ' : ': '}
            {info.updater!.autoUpdateMinutes > 0 && info.updater!.auto !== false ? `checked every ${info.updater!.autoUpdateMinutes} minutes` : 'new versions only when you ask'}
            {info.updater!.mode === 'single' ? '; a switch closes the shop for a few seconds (the new version is tried first, the database saved).' : '.'}
            {info.updater!.mode === 'single' && (
              <>
                {' '}
                Update with <strong>Update to the latest</strong>, not with podman pull/stop/rm/run; to do it by hand, stop the updater first (<code>podman stop beautifuluaehome-updater</code>).
              </>
            )}
            {info.pending && !info.pending.startsWith('auto') && <strong className="text-warning"> A switch is waiting to start (within a minute).</strong>}
            {info.updater!.lastRequest.at && !info.pending && (
              <span className={info.updater!.lastRequest.result === 'ok' ? 'text-success' : info.updater!.lastRequest.result === 'working' ? 'text-warning font-semibold' : 'text-danger'}>
                {' '}
                {info.updater!.lastRequest.result === 'working' ? info.updater!.lastRequest.message : `Last request: ${info.updater!.lastRequest.message}`}
              </span>
            )}
          </p>
        )}
        {managed && (
          <div className="space-y-1">
            <label className="flex flex-wrap items-center gap-2 font-semibold text-ink cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-ink"
                checked={autoWaiting ? autoWanted! : autoNow}
                disabled={autoWaiting}
                onChange={(e) => void setAuto(e.target.checked)}
              />
              Install new versions automatically
              {autoWaiting && (
                <span role="status" className="font-normal text-warning">
                  Waiting for the updater…
                </span>
              )}
            </label>
            <p className="text-ink-muted">
              {info.updater!.auto === false
                ? 'Off: nothing is checked or installed by itself (the shop, the HTTPS proxy and the updater). Update to the latest and switching versions still work, and a stopped shop is still started again.'
                : 'On: new versions of the shop, the HTTPS proxy and the updater are installed by themselves.'}{' '}
              {info.updater!.lastCheck?.at ? (
                <>
                  Last check: <time dateTime={info.updater!.lastCheck.at}>{new Date(info.updater!.lastCheck.at).toLocaleString()}</time>, {info.updater!.lastCheck.result}.
                </>
              ) : (
                'No check yet.'
              )}
            </p>
          </div>
        )}
        {managed && info.updater!.integrityProblem && (
          <p role="alert" className="rounded-lg bg-danger-soft border border-danger-line text-danger p-2 break-words flex gap-1.5">
            <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>{info.updater!.integrityProblem}</span>
          </p>
        )}
        {managed && info.updater!.registryProblem && (
          <p role="alert" className="rounded-lg bg-danger-soft border border-danger-line text-danger p-2 break-words">
            {info.updater!.registryProblem.charAt(0).toUpperCase() + info.updater!.registryProblem.slice(1)}.
          </p>
        )}
        {!managed && (
          <div className="text-ink-soft space-y-1.5">
            <p>Automatic updates are not running on this server, so update with these two commands on the computer that runs the shop (Podman):</p>
            <p>
              The images are private, so Podman must be logged in to <code>ghcr.io</code> once, with a GitHub token that can only read packages: on Windows <code>podman login ghcr.io -u YOUR-GITHUB-NAME</code>; on a Linux server as in the deployment guide (&quot;Private images&quot;), so that the login lasts.
            </p>
            <code className="block bg-sand rounded-lg p-2 break-all">podman pull {IMAGE}:latest</code>
            <code className="block bg-sand rounded-lg p-2 break-all">{PODMAN_RUN}</code>
            <p>
              Use your own container and data-volume names if they differ (<code>podman ps</code> lists them); the data volume must be the one the shop already uses. For an older version, change <code>latest</code> to its number, e.g. <code>2.0.0</code>.
            </p>
            <p>
              Then reload this page. If it still says <strong className="font-mono">{label(info.current)}</strong>, another, older container is still answering: <code>podman ps</code> shows which one holds the port; stop it.
            </p>
            <p>To have the shop update itself (and this page switch versions), paste one line once on that computer, with Podman running. Nothing to download first; use your container&apos;s name if it is not beautifuluaehome. In <strong>Command Prompt (cmd), not PowerShell</strong>:</p>
            <code className="block bg-sand rounded-lg p-2 break-all">{SETUP_CMD}</code>
            <p>Or in PowerShell:</p>
            <code className="block bg-sand rounded-lg p-2 break-all">{SETUP_POWERSHELL}</code>
            <p>It keeps your container&apos;s data, port and settings, checks for new versions every 15 minutes, and keeps itself up to date; a switch closes the shop for a few seconds. On a Linux server, see the deployment guide.</p>
            <details>
              <summary className="cursor-pointer">Docker Compose server (Hostinger guide)</summary>
              <code className="block bg-sand rounded-lg p-2 mt-1 break-all">docker compose run --rm updater rollback {IMAGE}:2.0.0</code>
              <p className="mt-1">To let this page switch versions, turn on automatic updates (deployment guide, section 5).</p>
            </details>
          </div>
        )}
        {status && <p role="status" className={`font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}
      </div>

      {managed && (info.updater!.history?.length ?? 0) > 0 && (
        <section aria-labelledby="installed-here" className="rounded-2xl border border-line bg-surface p-3 space-y-1.5">
          <h4 id="installed-here" className="font-bold text-ink">
            Installed on this server
          </h4>
          <ul className="space-y-1">
            {info.updater!.history!.map((h) => (
              <li key={`${h.at}-${h.digest}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="font-mono">{/^\d/.test(h.version) ? label(h.version) : 'unknown version'}</strong>
                <code className="text-ink-muted break-all">{shortDigest(h.digest)}</code>
                <time dateTime={h.at} className="text-ink-muted">
                  {new Date(h.at).toLocaleString()}
                </time>
                <span className="text-ink-soft">{WHY[h.why] ?? h.why}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ol className="space-y-2">
        {info.changelog.map((e) => {
          const isRunning = e.version === running;
          const tooOld = older(e.version, info.oldestRollback);
          const recorded = info.updater?.digests?.find((d) => d.version === e.version);
          return (
            <li key={e.version} className={`rounded-2xl border p-3 bg-surface ${isRunning ? 'border-gold' : 'border-line'}`}>
              <details open={e.version === info.changelog[0]?.version}>
                <summary className="cursor-pointer flex flex-wrap items-center gap-x-2 gap-y-1">
                  <strong className="font-mono text-ink">{e.label}</strong>
                  <span className="text-ink-muted">{e.date}</span>
                  {e.pr && (
                    <a href={`https://github.com/cxsmtp/buh/pull/${e.pr}`} target="_blank" rel="noopener noreferrer" className="text-ink-muted underline inline-flex items-center gap-0.5" onClick={(ev) => ev.stopPropagation()}>
                      #{e.pr} <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  {isRunning && <span className="px-2 py-0.5 rounded-full bg-warning-soft text-warning font-bold">Running</span>}
                  {recorded && (
                    <span className="inline-flex items-center gap-1 text-ink-muted">
                      <code className="break-all">{shortDigest(recorded.digest)}</code>
                      {recorded.verified && (
                        <span className="inline-flex items-center gap-0.5 text-success font-semibold" title="Installed here under the digest this version first came with">
                          <BadgeCheck className="w-3.5 h-3.5" aria-hidden="true" /> verified
                        </span>
                      )}
                    </span>
                  )}
                  <span className="ml-auto">
                    {!isRunning && managed && !tooOld && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.preventDefault();
                          void switchTo(e.version);
                        }}
                        disabled={Boolean(busy) || Boolean(info.pending) || info.updater?.lastRequest.result === 'working'}
                        className="px-2.5 py-1 rounded-lg border border-line-strong font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                        aria-label={`Switch to ${e.label}`}
                      >
                        {busy === e.version ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Switch to this version
                      </button>
                    )}
                    {!isRunning && tooOld && <span className="text-ink-muted">Can&apos;t run on today&apos;s database</span>}
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
