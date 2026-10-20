'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudUpload, Copy, ExternalLink, Loader2, Upload, XCircle } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { clientIdLooksRight, parseClientJson } from '@/lib/driveClientJson';
import { BACKUP_PASSWORD_EVENT, PasswordMaker } from './BackupPasswordCard';
import { DriveSetupWizard, type DriveWizard } from './DriveSetupWizard';

/**
 * Settings → System & backups → "Copy each backup to Google Drive":
 * - Connect my Google Drive (any Google account, a Gmail too): a guided "Set up Google Drive"
 *   wizard for the one-time Google Cloud part, then the OAuth client (pasted, or read from the file
 *   Google downloads), then a big "Connect Google Drive": a code to enter at google.com/device. The
 *   hub notices when it is done ("Connected to …") and makes the first copy at once. "Copy restore
 *   details" (password needed) gives what a new server needs.
 * - Advanced (Google Workspace): a service account and a shared drive folder.
 * Copies are always encrypted: without a backup password, the card offers to make one right here.
 */

export interface DriveStatus {
  enabled: boolean;
  mode: 'oauth' | 'service_account';
  keep: number;
  passphraseSet: boolean;
  copies: number;
  level: 'off' | 'ok' | 'failing';
  folderId: string;
  clientEmail: string;
  keySaved: boolean;
  oauthClientId: string;
  oauthSecretSaved: boolean;
  connected: boolean;
  connectedAt?: string;
  accountEmail: string;
  waitingForPassword: boolean;
  wizard: DriveWizard;
  needsReconnect: boolean;
  oauthFolderId: string;
  folderName: string;
  connecting: { userCode: string; verificationUrl: string; expiresAt: string; interval: number } | null;
  /** A copy going up now (the backup itself is done). */
  copying: DriveCopying | null;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastError?: string;
}

type Outcome = 'none' | 'pending' | 'connected' | 'denied' | 'expired';

const field = 'w-full min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const darkButton = 'min-h-11 px-4 py-2 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-60';
const bigButton = 'min-h-12 px-5 py-3 rounded-xl bg-ink text-paper text-sm font-bold inline-flex items-center justify-center gap-2 disabled:opacity-60';
const lightButton = 'min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold inline-flex items-center justify-center gap-1.5 hover:bg-ivory disabled:opacity-60';
const label = 'block text-xs font-semibold text-ink-soft mb-1';

export function mb(n?: number): string {
  if (n === undefined) return '';
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export interface DriveCopying {
  file: string;
  size: number;
  sent: number;
}

/** "Copying to Google Drive: 4.0 MB of 12.0 MB (33%)." */
export function copyingText(c: DriveCopying): string {
  const pct = c.size ? Math.min(100, Math.floor((c.sent / c.size) * 100)) : 0;
  return `Copying to Google Drive: ${c.size ? `${mb(c.sent)} of ${mb(c.size)} (${pct}%)` : 'starting'}.`;
}

export function when(iso?: string): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function DriveBackupCard() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [mode, setMode] = useState<DriveStatus['mode']>('oauth');
  const [enabled, setEnabled] = useState(false);
  const [folder, setFolder] = useState('');
  const [keep, setKeep] = useState('60');
  const [key, setKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [clientFileNote, setClientFileNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [wizardOpen, setWizardOpen] = useState<boolean | null>(null);
  const [makePassword, setMakePassword] = useState(false);
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'remove' | 'connect' | 'details' | 'first-copy'>('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [details, setDetails] = useState('');
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [nextPoll, setNextPoll] = useState<{ n: number; interval: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const apply = useCallback((s: DriveStatus) => {
    setStatus(s);
    setMode(s.mode);
    setEnabled(s.enabled);
    setFolder(s.folderId);
    setKeep(String(s.keep));
    setClientId(s.oauthClientId);
  }, []);

  const refresh = useCallback(() => void getJson<DriveStatus>('/api/admin/backup/drive').then((r) => r.ok && apply(r.data)), [apply]);

  /** The first copy, right after connecting: "Back up now" (the copy to Drive follows; its progress shows here). */
  const firstCopy = useCallback(async () => {
    setBusy('first-copy');
    const { ok, data } = await postJson<{ drive?: DriveStatus; lastError?: string; message?: string }>('/api/admin/backup', {});
    setBusy('');
    if (ok && data.drive) setStatus(data.drive);
    if (!ok || (data.lastError && !data.drive?.copying)) setMessage({ ok: false, text: data.message || `The first backup failed: ${data.lastError ?? 'please press Back up now.'}` });
  }, []);

  // While a connection is in progress: ask the server every `interval` seconds (it asks Google).
  const schedule = useCallback((interval: number) => setNextPoll((p) => ({ n: (p?.n ?? 0) + 1, interval })), []);
  useEffect(() => {
    if (!nextPoll) return;
    const t = setTimeout(async () => {
      const { ok, data } = await postJson<{ outcome?: Outcome; status?: DriveStatus; message?: string }>('/api/admin/backup/drive/connect', { action: 'poll' });
      if (!ok || !data.status) {
        setMessage({ ok: false, text: data.message || 'Could not finish connecting. Press Connect Google Drive to try again.' });
        refresh();
        return;
      }
      apply(data.status);
      if (data.outcome === 'pending' && data.status.connecting) schedule(data.status.connecting.interval);
      else if (data.outcome === 'connected') {
        const to = data.status.accountEmail ? `Connected to ${data.status.accountEmail}.` : 'Connected.';
        if (data.status.enabled) {
          setMessage({ ok: true, text: `${to} Making the first copy now; after that, each backup is copied to your Google Drive.` });
          void firstCopy();
        } else {
          setMessage({ ok: true, text: `${to} Make a backup password below and copies start at once.` });
          setMakePassword(true);
        }
      } else if (data.outcome === 'denied') setMessage({ ok: false, text: 'Google says access was refused. Press Connect Google Drive and choose Allow.' });
      else if (data.outcome === 'expired') setMessage({ ok: false, text: 'The code ran out before it was entered. Press Connect Google Drive for a new one.' });
    }, Math.max(1, nextPoll.interval) * 1000);
    return () => clearTimeout(t);
  }, [nextPoll, apply, schedule, refresh, firstCopy]);

  // A copy going up: follow it every few seconds (the status only; the form stays as typed).
  useEffect(() => {
    if (!status?.copying) return;
    const t = setTimeout(() => void getJson<DriveStatus>('/api/admin/backup/drive').then(({ ok, data }) => ok && setStatus(data)), 3000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    void getJson<DriveStatus>('/api/admin/backup/drive').then(({ ok, data }) => {
      if (cancelled || !ok) return;
      apply(data);
      if (data.connecting) schedule(data.connecting.interval);
    });
    // The password set elsewhere (its own card): copies may be possible, or switched on, now.
    const on = () => refresh();
    window.addEventListener(BACKUP_PASSWORD_EVENT, on);
    return () => {
      cancelled = true;
      window.removeEventListener(BACKUP_PASSWORD_EVENT, on);
    };
  }, [apply, schedule, refresh]);

  const save = async (overrides: Record<string, unknown> = {}) => {
    setMessage(null);
    setBusy(overrides.serviceAccountKey === null || overrides.disconnect ? 'remove' : 'save');
    const body: Record<string, unknown> = { mode, enabled, keep: Number(keep), ...(mode === 'service_account' ? { folderId: folder, ...(key.trim() ? { serviceAccountKey: key } : {}) } : {}), ...overrides };
    const { ok, data } = await sendJson<DriveStatus & { message?: string }>('PUT', '/api/admin/backup/drive', body);
    setBusy('');
    if (!ok) {
      setMessage({ ok: false, text: data.message || 'Could not save. Please try again.' });
      return;
    }
    setKey('');
    apply(data);
    setMessage({ ok: true, text: data.enabled ? 'Saved. Each backup is now copied to Google Drive.' : 'Saved.' });
  };

  const readClientFile = (text: string) => {
    const r = parseClientJson(text);
    if (!r.ok) {
      setClientFileNote({ ok: false, text: r.error });
      return;
    }
    setClientId(r.clientId);
    setClientSecret(r.clientSecret);
    setPasteOpen(false);
    setPasted('');
    setClientFileNote({ ok: true, text: 'Read the client ID and secret from the file. Now press Connect Google Drive.' });
    if (r.projectId && status && r.projectId !== status.wizard.projectId) {
      void sendJson<{ wizard?: DriveWizard }>('PUT', '/api/admin/backup/drive/wizard', { projectId: r.projectId }).then(({ ok, data }) => ok && data.wizard && setStatus((s) => (s ? { ...s, wizard: data.wizard! } : s)));
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 20_000) {
      setClientFileNote({ ok: false, text: 'That file is too big to be a Google client file.' });
      return;
    }
    readClientFile(await f.text());
  };

  const connect = async () => {
    setMessage(null);
    setBusy('connect');
    const { ok, data } = await postJson<{ status?: DriveStatus; message?: string }>('/api/admin/backup/drive/connect', { action: 'start', clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) });
    setBusy('');
    if (!ok || !data.status) {
      setMessage({ ok: false, text: data.message || 'Could not start connecting. Please try again.' });
      return;
    }
    setClientSecret('');
    setClientFileNote(null);
    setCodeCopied(false);
    apply(data.status);
    if (data.status.connecting) schedule(data.status.connecting.interval);
  };

  const cancel = async () => {
    setNextPoll(null);
    const { ok, data } = await postJson<{ status?: DriveStatus }>('/api/admin/backup/drive/connect', { action: 'cancel' });
    if (ok && data.status) apply(data.status);
  };

  const test = async () => {
    setMessage(null);
    setBusy('test');
    const body = mode === 'oauth' ? { mode } : { mode, folderId: folder, ...(key.trim() ? { serviceAccountKey: key } : {}) };
    const { ok, data } = await postJson<{ message?: string; clientEmail?: string }>('/api/admin/backup/drive/test', body);
    setBusy('');
    setMessage(
      ok
        ? { ok: true, text: mode === 'oauth' ? `Connected: a test file was uploaded to “${status?.folderName}” and deleted again.` : `Connected: a test file was uploaded to the folder and deleted again, as ${data.clientEmail}.` }
        : { ok: false, text: data.message || 'The test failed. Please try again.' }
    );
    refresh();
  };

  const reveal = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('details');
    const { ok, data } = await postJson<{ text?: string; message?: string }>('/api/admin/backup/drive/restore-details', { currentPassword: password });
    setBusy('');
    setPassword('');
    if (!ok || !data.text) {
      setMessage({ ok: false, text: data.message || 'Could not show the restore details.' });
      return;
    }
    setMessage(null);
    setDetails(data.text);
    setCopied(false);
  };

  const copyText = async (text: string, done: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      done(true);
    } catch {
      done(false);
    }
  };

  if (!status) return null;
  const Icon = status.level === 'failing' ? XCircle : status.lastSuccessAt ? CheckCircle2 : AlertTriangle;
  const canTest = mode === 'oauth' ? status.connected : status.keySaved || Boolean(key.trim());
  const connectedOk = status.connected && !status.needsReconnect;
  // The wizard: open until connected (or the client is saved), unless the owner closed it.
  const showWizard = wizardOpen ?? (!status.connected && !status.oauthClientId);
  const idTyped = clientId.trim();
  const idOk = clientIdLooksRight(idTyped);

  return (
    <div className="space-y-3 text-sm rounded-2xl border border-line p-3.5" data-testid="drive-backup-card">
      <div className="flex gap-3 items-start">
        <CloudUpload className="w-5 h-5 text-gold-deep shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <h3 className="font-semibold text-ink">Copy each backup to Google Drive</h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            An off-server copy, so a lost server never means lost orders. Copies are always encrypted with your backup password; the newest ones are kept and older copies this shop made are deleted (nothing else in your Drive is touched).
          </p>
        </div>
      </div>

      {!status.passphraseSet && (
        <div role="alert" data-testid="drive-needs-password" className="text-xs rounded-xl border border-warning-line bg-warning-soft text-warning px-3 py-2 space-y-2">
          <p>Copies to Google Drive are always encrypted, so they need a backup password first{status.waitingForPassword ? ': Google Drive is connected, and copies start as soon as you make one.' : '.'}</p>
          {!makePassword ? (
            <button type="button" onClick={() => setMakePassword(true)} className={darkButton}>Make a password first</button>
          ) : (
            <div className="rounded-xl bg-surface border border-line p-3 text-ink">
              <PasswordMaker
                replacing={false}
                compact
                onSaved={(r) => {
                  setMakePassword(false);
                  if (r.drive) apply(r.drive as DriveStatus);
                  else refresh();
                  if (r.driveSwitchedOn) {
                    setMessage({ ok: true, text: 'Password saved, and copies to Google Drive are on. Making the first copy now.' });
                    void firstCopy();
                  } else setMessage({ ok: true, text: 'Password saved: backups are encrypted from now on.' });
                }}
              />
            </div>
          )}
        </div>
      )}

      {status.mode === 'oauth' && status.needsReconnect && (
        <p role="alert" data-testid="drive-reconnect" className="text-xs rounded-xl border border-danger-line bg-danger-soft text-danger px-3 py-2">
          Google no longer accepts the shop&rsquo;s access to your Drive (removed, or it ran out). Press <strong>Reconnect Google Drive</strong> below.
        </p>
      )}

      {status.enabled && (
        <p data-testid="drive-last-copy" className={`text-xs flex items-start gap-1.5 rounded-xl border px-3 py-2 break-words ${status.level === 'failing' ? 'border-danger-line bg-danger-soft text-danger' : status.lastSuccessAt ? 'border-success-line bg-success-soft text-success' : 'border-warning-line bg-warning-soft text-warning'}`}>
          <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {status.level === 'failing' && status.lastError ? <>Last copy failed: {status.lastError} </> : null}
            {status.lastSuccessAt ? <>{status.level === 'failing' ? 'Last good copy' : 'Last copy'} {when(status.lastSuccessAt)}, {mb(status.lastSize)} ({status.copies} in Drive).</> : status.level !== 'failing' && !status.copying ? <>{busy === 'first-copy' ? 'Making the first backup…' : 'No copy yet: press Back up now above, or wait for the next backup.'}</> : null}
          </span>
        </p>
      )}
      {status.enabled && status.copying && (
        <div data-testid="drive-copying" role="status" className="text-xs rounded-xl border border-line px-3 py-2 break-words text-ink-soft space-y-1.5">
          <p className="flex items-start gap-1.5">
            <Loader2 className="w-4 h-4 shrink-0 animate-spin" aria-hidden="true" />
            <span className="min-w-0">{copyingText(status.copying)}</span>
          </p>
          <progress className="w-full h-2 accent-current" max={Math.max(1, status.copying.size)} value={status.copying.sent} aria-label="Copy to Google Drive" />
        </div>
      )}

      {mode === 'oauth' ? (
        <div className="space-y-3" data-testid="drive-oauth">
          {status.connecting ? (
            <div role="status" data-testid="drive-connect-code" className="rounded-2xl border border-gold bg-ivory p-4 space-y-3 text-xs text-ink">
              <p className="text-sm">On your phone or computer, open <strong>google.com/device</strong>, sign in with the Google account for the backups, and enter this code:</p>
              <p className="font-mono text-4xl sm:text-5xl font-bold tracking-widest text-center select-all py-1 [overflow-wrap:anywhere]" data-testid="drive-user-code">{status.connecting.userCode}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => void copyText(status.connecting!.userCode, setCodeCopied)} className={lightButton}>
                  <Copy className="w-4 h-4" aria-hidden="true" />
                  {codeCopied ? 'Code copied' : 'Copy the code'}
                </button>
                <a href={status.connecting.verificationUrl} target="_blank" rel="noopener noreferrer" className={darkButton}>
                  <ExternalLink className="w-4 h-4" aria-hidden="true" />
                  Open {status.connecting.verificationUrl.replace(/^https:\/\/(www\.)?/, '')}
                </a>
              </div>
              <p className="text-ink-soft">If Google warns that the app isn&rsquo;t verified: it is your own app. Press <em>Advanced</em> → <em>Go to {'Beautiful UAE Home backups'}</em>, then <em>Continue</em>.</p>
              <p className="text-ink-soft flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Waiting for Google… this page notices by itself. The code works until {when(status.connecting.expiresAt)}.
              </p>
              <button type="button" onClick={() => void cancel()} className={lightButton}>Cancel</button>
            </div>
          ) : connectedOk ? (
            <p data-testid="drive-connected" className="text-xs flex items-start gap-1.5 rounded-xl border border-success-line bg-success-soft text-success px-3 py-2 [overflow-wrap:anywhere]">
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                <strong>{status.accountEmail ? `Connected to ${status.accountEmail}` : 'Connected'}</strong>
                {status.connectedAt ? ` since ${when(status.connectedAt)}` : ''}. Copies go to the folder <strong>{status.folderName}</strong> in that Google Drive (the shop sees only the files it made).
              </span>
            </p>
          ) : null}

          {!status.connecting && !connectedOk && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setWizardOpen(!showWizard)} className={lightButton} aria-expanded={showWizard} aria-controls="drive-wizard-box">
                  {showWizard ? 'Hide the setup steps' : 'Set up Google Drive'}
                </button>
                {!showWizard && <span className="text-xs text-ink-muted">{status.wizard.done.length} of 4 setup steps done</span>}
              </div>
              {showWizard && (
                <div id="drive-wizard-box">
                  <DriveSetupWizard wizard={status.wizard} onChange={(w) => setStatus((s) => (s ? { ...s, wizard: w } : s))} />
                </div>
              )}
            </>
          )}

          {!status.connecting && (
            <div className={`space-y-3 ${connectedOk ? '' : 'rounded-2xl border border-line p-3.5'}`} data-testid="drive-client">
              {!connectedOk && (
                <div className="space-y-2">
                  <h4 className="font-semibold text-ink text-sm">Your Google client</h4>
                  <div className="flex flex-wrap gap-2">
                    <input ref={fileInput} type="file" accept="application/json,.json" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => void onFile(e)} data-testid="drive-client-file" />
                    <button type="button" onClick={() => fileInput.current?.click()} className={lightButton}>
                      <Upload className="w-4 h-4" aria-hidden="true" />
                      Upload the client file (client_secret_….json)
                    </button>
                    <button type="button" onClick={() => setPasteOpen((x) => !x)} className={lightButton} aria-expanded={pasteOpen}>
                      Paste the file&rsquo;s text
                    </button>
                  </div>
                  {pasteOpen && (
                    <div className="space-y-2">
                      <label htmlFor="drive-client-json" className={label}>The client file&rsquo;s text</label>
                      <textarea id="drive-client-json" rows={3} spellCheck={false} autoComplete="off" maxLength={20000} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder='{"installed":{"client_id":"…","client_secret":"…"}}' className={`${field} font-mono text-xs`} />
                      <button type="button" onClick={() => readClientFile(pasted)} disabled={!pasted.trim()} className={lightButton}>Read it</button>
                    </div>
                  )}
                  {clientFileNote && (
                    <p role={clientFileNote.ok ? 'status' : 'alert'} data-testid="drive-client-file-note" className={`text-xs break-words ${clientFileNote.ok ? 'text-success' : 'text-danger'}`}>{clientFileNote.text}</p>
                  )}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="drive-client-id" className={label}>OAuth client ID</label>
                  <input id="drive-client-id" type="text" autoComplete="off" spellCheck={false} maxLength={200} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" aria-describedby="drive-client-id-check" aria-invalid={Boolean(idTyped) && !idOk} className={`${field} font-mono text-xs`} />
                  <p id="drive-client-id-check" data-testid="drive-client-id-check" className={`text-[11px] mt-1 ${!idTyped ? 'text-ink-muted' : idOk ? 'text-success' : 'text-danger'}`}>
                    {!idTyped ? 'Ends with .apps.googleusercontent.com' : idOk ? '✓ Looks right' : 'Not a client ID yet: it ends with .apps.googleusercontent.com'}
                  </p>
                </div>
                <div className="min-w-0">
                  <label htmlFor="drive-client-secret" className={label}>Client secret</label>
                  <input id="drive-client-secret" type="password" autoComplete="off" spellCheck={false} maxLength={200} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={status.oauthSecretSaved ? 'Saved (hidden)' : 'GOCSPX-…'} className={`${field} font-mono text-xs`} />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void connect()} disabled={Boolean(busy) || !idOk || (!clientSecret.trim() && !(status.oauthSecretSaved && idTyped === status.oauthClientId))} className={connectedOk ? lightButton : bigButton}>
                  {busy === 'connect' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                  {status.connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
                </button>
                {status.connected && (
                  <>
                    <button type="button" onClick={() => { setDetailsOpen((x) => !x); setDetails(''); }} className={lightButton} aria-expanded={detailsOpen}>
                      Copy restore details
                    </button>
                    <button type="button" onClick={() => void save({ disconnect: true, enabled: false })} disabled={Boolean(busy)} className={lightButton}>
                      Disconnect
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {detailsOpen && status.connected && (
            <div className="rounded-2xl border border-line bg-ivory p-3.5 space-y-2.5 text-xs" data-testid="drive-restore-details">
              <p className="text-ink-soft leading-relaxed">
                What a new server needs to restore from your Drive. Keep it in your password manager, never in an email or chat: anyone with it can read the encrypted copies (they still need your backup password).
              </p>
              {!details ? (
                <form onSubmit={(e) => void reveal(e)} className="flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="drive-details-password" className={label}>Current password</label>
                    <input id="drive-details-password" type="password" autoComplete="current-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
                  </div>
                  <button type="submit" disabled={!password || Boolean(busy)} className={darkButton}>
                    {busy === 'details' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                    Show
                  </button>
                </form>
              ) : (
                <>
                  <pre className="font-mono text-[11px] bg-surface border border-line rounded-lg px-2.5 py-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-ink" data-testid="drive-details-text">{details}</pre>
                  <button type="button" onClick={() => void copyText(details, setCopied)} className={lightButton}>
                    <Copy className="w-4 h-4" aria-hidden="true" />
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3" data-testid="drive-service-account">
          <div>
            <label htmlFor="drive-key" className={label}>Service account key (JSON)</label>
            {status.keySaved && (
              <p className="text-xs text-ink-muted mb-1 [overflow-wrap:anywhere]" data-testid="drive-key-saved">
                Saved: <strong className="text-ink">{status.clientEmail}</strong>. Paste a new key only to replace it.
              </p>
            )}
            <textarea id="drive-key" rows={3} spellCheck={false} autoComplete="off" maxLength={12000} value={key} onChange={(e) => setKey(e.target.value)} placeholder={status.keySaved ? 'Saved (hidden)' : '{ "type": "service_account", … }'} className={`${field} font-mono text-xs`} />
          </div>
          <div className="min-w-0">
            <label htmlFor="drive-folder" className={label}>Shared drive folder link or id</label>
            <input id="drive-folder" type="text" inputMode="url" autoComplete="off" maxLength={500} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" className={field} />
          </div>
          <ol className="list-decimal pl-5 space-y-1 leading-relaxed text-xs text-ink-soft">
            <li>In console.cloud.google.com, make a project and switch on the Google Drive API.</li>
            <li>IAM &amp; Admin → Service accounts → Create (no roles needed) → Keys → Add key → JSON: a file downloads.</li>
            <li>In a shared drive (Google Workspace), add the service account&rsquo;s email as Content manager and make a folder.</li>
            <li>Paste the whole JSON file and the folder&rsquo;s link here, press Test connection, then switch this on and Save.</li>
          </ol>
        </div>
      )}

      <div className="grid gap-3 grid-cols-[1fr_auto] items-end">
        <label className="flex items-center gap-2 text-sm font-semibold text-ink min-h-11">
          <input type="checkbox" className="w-5 h-5 accent-current" checked={enabled} disabled={!status.passphraseSet && !enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Copy each backup to Google Drive
        </label>
        <div className="w-28">
          <label htmlFor="drive-keep" className={label}>Copies to keep</label>
          <input id="drive-keep" type="number" min={1} max={365} step={1} value={keep} onChange={(e) => setKeep(e.target.value)} className={field} />
        </div>
      </div>

      <details className="text-xs text-ink-soft" open={mode === 'service_account' || undefined} data-testid="drive-advanced">
        <summary className="cursor-pointer font-semibold text-ink min-h-11 flex items-center">Advanced (Google Workspace)</summary>
        <fieldset className="space-y-1.5 mt-1">
          <legend className={label}>How to connect</legend>
          <label className="flex items-start gap-2 text-sm text-ink min-h-11">
            <input type="radio" name="drive-mode" className="mt-1 w-4 h-4" checked={mode === 'oauth'} onChange={() => setMode('oauth')} />
            <span><strong>Connect my Google Drive</strong> (recommended: any Google account, a Gmail too)</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-ink min-h-11">
            <input type="radio" name="drive-mode" className="mt-1 w-4 h-4" checked={mode === 'service_account'} onChange={() => setMode('service_account')} />
            <span>A service account and a shared drive (Google Workspace only: a service account can&rsquo;t store files in a personal Drive)</span>
          </label>
        </fieldset>
      </details>

      {message && (
        <p role={message.ok ? 'status' : 'alert'} data-testid="drive-message" className={`text-xs break-words ${message.ok ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void save()} disabled={Boolean(busy)} className={darkButton}>
          {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Save
        </button>
        <button type="button" onClick={() => void test()} disabled={Boolean(busy) || !canTest} className={lightButton}>
          {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Test connection
        </button>
        {mode === 'service_account' && status.keySaved && (
          <button type="button" onClick={() => void save({ serviceAccountKey: null, enabled: false })} disabled={Boolean(busy)} className={lightButton}>
            {busy === 'remove' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            Remove the key
          </button>
        )}
      </div>
    </div>
  );
}
