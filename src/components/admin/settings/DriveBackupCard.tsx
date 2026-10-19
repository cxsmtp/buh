'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudUpload, Loader2, XCircle } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';

/**
 * Settings → System & backups → "Copy each backup to Google Drive": a service account's JSON key
 * (write-only: only its email is shown once saved), the shared folder, how many copies to keep, the
 * switch, Test connection, and the last copy.
 */

export interface DriveStatus {
  enabled: boolean;
  folderId: string;
  keep: number;
  clientEmail: string;
  keySaved: boolean;
  passphraseSet: boolean;
  copies: number;
  level: 'off' | 'ok' | 'failing';
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastError?: string;
}

const field = 'w-full min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const darkButton = 'min-h-11 px-4 py-2 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60';
const lightButton = 'min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold inline-flex items-center gap-1.5 hover:bg-ivory disabled:opacity-60';

export function mb(n?: number): string {
  if (n === undefined) return '';
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function when(iso?: string): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function DriveBackupCard() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [folder, setFolder] = useState('');
  const [keep, setKeep] = useState('30');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'remove'>('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const apply = (s: DriveStatus) => {
    setStatus(s);
    setEnabled(s.enabled);
    setFolder(s.folderId);
    setKeep(String(s.keep));
  };

  useEffect(() => {
    let cancelled = false;
    void getJson<DriveStatus>('/api/admin/backup/drive').then(({ ok, data }) => {
      if (!cancelled && ok) apply(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (e?: React.FormEvent, overrides: Record<string, unknown> = {}) => {
    e?.preventDefault();
    setMessage(null);
    setBusy(overrides.serviceAccountKey === null ? 'remove' : 'save');
    const body: Record<string, unknown> = { enabled, folderId: folder, keep: Number(keep), ...(key.trim() ? { serviceAccountKey: key } : {}), ...overrides };
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

  const test = async () => {
    setMessage(null);
    setBusy('test');
    const { ok, data } = await postJson<{ message?: string; clientEmail?: string }>('/api/admin/backup/drive/test', { folderId: folder, ...(key.trim() ? { serviceAccountKey: key } : {}) });
    setBusy('');
    setMessage(ok ? { ok: true, text: `Connected: a test file was uploaded to the folder and deleted again, as ${data.clientEmail}.` } : { ok: false, text: data.message || 'The test failed. Please try again.' });
  };

  if (!status) return null;
  const Icon = status.level === 'failing' ? XCircle : status.lastSuccessAt ? CheckCircle2 : AlertTriangle;

  return (
    <form onSubmit={(e) => void save(e)} className="space-y-3 text-sm rounded-2xl border border-line p-3.5" data-testid="drive-backup-card">
      <div className="flex gap-3 items-start">
        <CloudUpload className="w-5 h-5 text-gold-deep shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <h3 className="font-semibold text-ink">Copy each backup to Google Drive</h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            An off-server copy, so a lost server never means lost orders. Copies are always encrypted with your <code>BACKUP_PASSPHRASE</code>; the newest ones are kept and older copies this shop made are deleted (nothing else in the folder is touched).
          </p>
        </div>
      </div>

      {!status.passphraseSet && (
        <p role="alert" className="text-xs rounded-xl border border-warning-line bg-warning-soft text-warning px-3 py-2">
          Set <code>BACKUP_PASSPHRASE</code> first (see the deployment guide): an unencrypted copy of the shop never goes to Google Drive, so this can&rsquo;t be switched on without it.
        </p>
      )}

      {status.enabled && (
        <p data-testid="drive-last-copy" className={`text-xs flex items-start gap-1.5 rounded-xl border px-3 py-2 break-words ${status.level === 'failing' ? 'border-danger-line bg-danger-soft text-danger' : status.lastSuccessAt ? 'border-success-line bg-success-soft text-success' : 'border-warning-line bg-warning-soft text-warning'}`}>
          <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            {status.level === 'failing' && status.lastError ? <>Last copy failed: {status.lastError} </> : null}
            {status.lastSuccessAt ? <>{status.level === 'failing' ? 'Last good copy' : 'Last copy'} {when(status.lastSuccessAt)}, {mb(status.lastSize)} ({status.copies} in Drive).</> : status.level !== 'failing' ? <>No copy yet: press Back up now above, or wait for the next backup.</> : null}
          </span>
        </p>
      )}

      <label className="flex items-center gap-2 text-sm font-semibold text-ink min-h-11">
        <input type="checkbox" className="w-5 h-5 accent-current" checked={enabled} disabled={!status.passphraseSet && !enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Copy each backup to Google Drive
      </label>

      <div>
        <label htmlFor="drive-key" className="block text-xs font-semibold text-ink-soft mb-1">Service account key (JSON)</label>
        {status.keySaved && (
          <p className="text-xs text-ink-muted mb-1 [overflow-wrap:anywhere]" data-testid="drive-key-saved">
            Saved: <strong className="text-ink">{status.clientEmail}</strong>. Paste a new key only to replace it.
          </p>
        )}
        <textarea id="drive-key" rows={3} spellCheck={false} autoComplete="off" maxLength={12000} value={key} onChange={(e) => setKey(e.target.value)} placeholder={status.keySaved ? 'Saved (hidden)' : '{ "type": "service_account", … }'} className={`${field} font-mono text-xs`} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <div className="min-w-0">
          <label htmlFor="drive-folder" className="block text-xs font-semibold text-ink-soft mb-1">Drive folder link or id</label>
          <input id="drive-folder" type="text" inputMode="url" autoComplete="off" maxLength={500} value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" className={field} />
        </div>
        <div>
          <label htmlFor="drive-keep" className="block text-xs font-semibold text-ink-soft mb-1">Copies to keep</label>
          <input id="drive-keep" type="number" min={1} max={365} step={1} value={keep} onChange={(e) => setKeep(e.target.value)} className={field} />
        </div>
      </div>

      <details className="text-xs text-ink-soft">
        <summary className="cursor-pointer font-semibold text-ink">How to set it up (10 minutes)</summary>
        <ol className="list-decimal pl-5 mt-2 space-y-1 leading-relaxed">
          <li>In console.cloud.google.com, make a project and switch on the Google Drive API.</li>
          <li>IAM &amp; Admin → Service accounts → Create (no roles needed) → Keys → Add key → JSON: a file downloads.</li>
          <li>In Google Drive, make a folder (in a shared drive with Google Workspace) and share it with the service account&rsquo;s email as Editor (Content manager in a shared drive).</li>
          <li>Paste the whole JSON file and the folder&rsquo;s link here, press Test connection, then switch this on and Save.</li>
        </ol>
      </details>

      {message && (
        <p role={message.ok ? 'status' : 'alert'} data-testid="drive-message" className={`text-xs break-words ${message.ok ? 'text-success' : 'text-danger'}`}>
          {message.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={Boolean(busy)} className={darkButton}>
          {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Save
        </button>
        <button type="button" onClick={() => void test()} disabled={Boolean(busy)} className={lightButton}>
          {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Test connection
        </button>
        {status.keySaved && (
          <button type="button" onClick={() => void save(undefined, { serviceAccountKey: null, enabled: false })} disabled={Boolean(busy)} className={lightButton}>
            {busy === 'remove' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            Remove the key
          </button>
        )}
      </div>
    </form>
  );
}
