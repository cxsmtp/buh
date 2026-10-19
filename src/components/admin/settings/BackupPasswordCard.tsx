'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { CheckCircle2, Copy, Download, KeyRound, Loader2, ShieldAlert, Sparkles } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { passphraseStrength } from '@/lib/passphraseStrength';

/**
 * Settings → System & backups → "Protect backups with a password": every backup (emailed, kept on
 * the server, copied to Google Drive) is encrypted with it.
 * - "Make one for me": the server makes a strong one, shown once, with Copy and Download, and a
 *   tick ("I saved it…") before it is used.
 * - Or type your own (twice, at least 12 characters), with a strength hint.
 * - Changing it asks for the hub password again; older backups still need the old password.
 * - Set on the server (BACKUP_PASSPHRASE): shown as such, nothing to edit.
 * The password is never shown again (the server keeps it; the hub sees its fingerprint and day).
 */

export interface PassphraseStatus {
  source: 'env' | 'hub' | 'none';
  encrypted: boolean;
  short: boolean;
  setAt?: string;
  setBy?: string;
  how?: 'generated' | 'typed' | '';
  fingerprint?: string;
  earlier: Array<{ fingerprint: string; setAt: string; replacedAt: string }>;
  minLength: number;
}

/** Fired after the backup password is set or changed (detail: the new status), so the other cards refresh. */
export const BACKUP_PASSWORD_EVENT = 'buh:backup-password';

const field = 'w-full min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const darkButton = 'min-h-11 px-4 py-2 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-60';
const lightButton = 'min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold inline-flex items-center justify-center gap-1.5 hover:bg-ivory disabled:opacity-60';
const label = 'block text-xs font-semibold text-ink-soft mb-1';

export function day(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The text file "Download as a text file" saves. */
export function passwordFileText(passphrase: string, now = new Date()): string {
  return [
    'Beautiful UAE Home: backup password',
    '',
    passphrase,
    '',
    `Made on ${now.toUTCString()}.`,
    'Keep it in your password manager, then delete this file. Without it, backups can’t be opened.',
    '',
  ].join('\n');
}

interface SaveReply {
  status?: PassphraseStatus;
  drive?: unknown;
  driveSwitchedOn?: boolean;
  message?: string;
}

/**
 * Choosing a password: "Make one for me", or type your own. `replacing`: a password is set
 * already, so the hub password is asked for too. Used by the card and inline by the Google Drive card.
 */
export function PasswordMaker({ replacing, minLength = 12, onSaved, compact = false }: { replacing: boolean; minLength?: number; onSaved: (reply: SaveReply) => void; compact?: boolean }) {
  const id = useId();
  const [way, setWay] = useState<'make' | 'type'>('make');
  const [made, setMade] = useState('');
  const [savedTick, setSavedTick] = useState(false);
  const [copied, setCopied] = useState(false);
  const [typed, setTyped] = useState('');
  const [repeat, setRepeat] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState<'' | 'make' | 'save'>('');
  const [error, setError] = useState('');

  const make = async () => {
    setError('');
    setBusy('make');
    const { ok, data } = await postJson<{ passphrase?: string; message?: string }>('/api/admin/backup/passphrase', { action: 'generate' });
    setBusy('');
    if (!ok || !data.passphrase) {
      setError(data.message || 'Could not make a password. Please try again.');
      return;
    }
    setMade(data.passphrase);
    setSavedTick(false);
    setCopied(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(made);
      setCopied(true);
    } catch {
      setCopied(false);
      setError('Could not copy: select the password and copy it by hand.');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([passwordFileText(made)], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'beautiful-uae-home-backup-password.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const finish = (data: SaveReply) => {
    setMade('');
    setTyped('');
    setRepeat('');
    setCurrent('');
    window.dispatchEvent(new CustomEvent(BACKUP_PASSWORD_EVENT, { detail: data.status }));
    onSaved(data);
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!savedTick) return;
    setError('');
    setBusy('save');
    const { ok, data } = await postJson<SaveReply>('/api/admin/backup/passphrase', { action: 'confirm', ...(replacing ? { currentPassword: current } : {}) });
    setBusy('');
    if (!ok) {
      setError(data.message || 'Could not save the password. Please try again.');
      return;
    }
    finish(data);
  };

  const saveTyped = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (typed !== repeat) {
      setError('The two passwords are not the same: type it again in both boxes.');
      return;
    }
    setBusy('save');
    const { ok, data } = await postJson<SaveReply>('/api/admin/backup/passphrase', { action: replacing ? 'change' : 'set', passphrase: typed, repeat, ...(replacing ? { currentPassword: current } : {}) });
    setBusy('');
    if (!ok) {
      setError(data.message || 'Could not save the password. Please try again.');
      return;
    }
    finish(data);
  };

  const strength = passphraseStrength(typed, minLength);
  const strengthTone = strength.level === 'strong' ? 'text-success' : strength.level === 'fair' ? 'text-ink-soft' : 'text-warning';
  const currentField = replacing ? (
    <div className="min-w-0">
      <label htmlFor={`${id}-current`} className={label}>Your hub password (to change it)</label>
      <input id={`${id}-current`} type="password" autoComplete="current-password" maxLength={256} value={current} onChange={(e) => setCurrent(e.target.value)} className={field} />
    </div>
  ) : null;

  return (
    <div className="space-y-3" data-testid="password-maker">
      {way === 'make' ? (
        !made ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void make()} disabled={Boolean(busy)} className={darkButton}>
              {busy === 'make' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Sparkles className="w-4 h-4" aria-hidden="true" />}
              Make one for me
            </button>
            <button type="button" onClick={() => { setWay('type'); setError(''); }} className={lightButton}>
              Or type your own
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void confirm(e)} className="rounded-2xl border border-gold bg-ivory p-3.5 space-y-3" data-testid="password-made">
            <p className="text-xs text-ink-soft">Your new backup password. It is shown <strong className="text-ink">only now</strong>: save it in your password manager.</p>
            <p className="font-mono text-base sm:text-lg font-bold text-ink bg-surface border border-line rounded-xl px-3 py-2.5 select-all [overflow-wrap:anywhere]" data-testid="password-made-text">{made}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void copy()} className={lightButton}>
                <Copy className="w-4 h-4" aria-hidden="true" />
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" onClick={download} className={lightButton}>
                <Download className="w-4 h-4" aria-hidden="true" />
                Download as a text file
              </button>
            </div>
            <label className="flex items-start gap-2 text-sm text-ink min-h-11">
              <input type="checkbox" className="mt-0.5 w-5 h-5 shrink-0" checked={savedTick} onChange={(e) => setSavedTick(e.target.checked)} required />
              <span>I saved it in my password manager. Without it, backups can&rsquo;t be opened.</span>
            </label>
            {currentField}
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={!savedTick || Boolean(busy) || (replacing && !current)} className={darkButton}>
                {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                Use this password
              </button>
              <button type="button" onClick={() => void make()} disabled={Boolean(busy)} className={lightButton}>
                Make another
              </button>
            </div>
          </form>
        )
      ) : (
        <form onSubmit={(e) => void saveTyped(e)} className="space-y-3" data-testid="password-typed">
          <div className={`grid gap-3 ${compact ? '' : 'sm:grid-cols-2'}`}>
            <div className="min-w-0">
              <label htmlFor={`${id}-new`} className={label}>New backup password</label>
              <input id={`${id}-new`} type="password" autoComplete="new-password" maxLength={256} value={typed} onChange={(e) => setTyped(e.target.value)} aria-describedby={`${id}-hint`} className={field} />
            </div>
            <div className="min-w-0">
              <label htmlFor={`${id}-again`} className={label}>Type it again</label>
              <input id={`${id}-again`} type="password" autoComplete="new-password" maxLength={256} value={repeat} onChange={(e) => setRepeat(e.target.value)} className={field} />
            </div>
          </div>
          <p id={`${id}-hint`} aria-live="polite" data-testid="password-strength" className={`text-xs ${strengthTone}`}>
            {typed ? strength.text : `At least ${minLength} characters. A few words with dashes are easy to type and hard to guess.`}
            {typed && repeat && typed !== repeat ? ' The two boxes are not the same yet.' : ''}
          </p>
          {currentField}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={Boolean(busy) || strength.level === 'too-short' || !repeat || (replacing && !current)} className={darkButton}>
              {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              Save the password
            </button>
            <button type="button" onClick={() => { setWay('make'); setError(''); }} className={lightButton}>
              Make one for me instead
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" data-testid="password-error" className="text-xs text-danger break-words">
          {error}
        </p>
      )}
    </div>
  );
}

export function BackupPasswordCard() {
  const [status, setStatus] = useState<PassphraseStatus | null>(null);
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(() => {
    void getJson<PassphraseStatus>('/api/admin/backup/passphrase').then(({ ok, data }) => ok && setStatus(data));
  }, []);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener(BACKUP_PASSWORD_EVENT, on);
    return () => window.removeEventListener(BACKUP_PASSWORD_EVENT, on);
  }, [load]);

  if (!status) return null;
  const onServer = status.source === 'env';

  return (
    <section className="space-y-3 text-sm rounded-2xl border border-line p-3.5" data-testid="backup-password-card" aria-labelledby="backup-password-title">
      <div className="flex gap-3 items-start">
        <KeyRound className="w-5 h-5 text-gold-deep shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1 min-w-0">
          <h3 id="backup-password-title" className="font-semibold text-ink">Protect backups with a password</h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            Backups hold customers&rsquo; names, phones and addresses. With a password, every backup (emailed, on the server and in Google Drive) is encrypted, and only this password opens it.
          </p>
        </div>
      </div>

      {status.encrypted ? (
        <p data-testid="backup-password-status" className="text-xs flex items-start gap-1.5 rounded-xl border border-success-line bg-success-soft text-success px-3 py-2 break-words">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            Backups are encrypted ✓{' '}
            {onServer ? <>Set on the server{status.short ? `: it is short, use at least ${status.minLength} characters.` : '.'}</> : <>Password set on {day(status.setAt)}{status.how === 'generated' ? ' (made for you)' : ''}.</>}
          </span>
        </p>
      ) : (
        <p role="alert" data-testid="backup-password-status" className="text-xs flex items-start gap-1.5 rounded-xl border border-danger-line bg-danger-soft text-danger px-3 py-2 break-words">
          <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">Not protected: anyone with a backup email can read customers&rsquo; details.</span>
        </p>
      )}

      {message && (
        <p role="status" data-testid="backup-password-message" className="text-xs text-success break-words">
          {message}
        </p>
      )}

      {onServer ? (
        <p className="text-xs text-ink-soft">This password is set on the server, so it can&rsquo;t be changed here.</p>
      ) : status.source === 'none' ? (
        <PasswordMaker replacing={false} minLength={status.minLength} onSaved={(r) => { if (r.status) setStatus(r.status); setMessage('Saved. From now on every backup is encrypted with this password.'); }} />
      ) : changing ? (
        <div className="space-y-3 rounded-2xl border border-line p-3.5" data-testid="backup-password-change">
          <p role="note" className="text-xs rounded-xl border border-warning-line bg-warning-soft text-warning px-3 py-2">
            Backups made before today still need the old password. Keep it too, until those backups are no longer needed.
          </p>
          <PasswordMaker replacing minLength={status.minLength} onSaved={(r) => { if (r.status) setStatus(r.status); setChanging(false); setMessage('Changed. New backups use the new password; older ones still need the old one.'); }} />
          <button type="button" onClick={() => setChanging(false)} className={lightButton}>Cancel</button>
        </div>
      ) : (
        <button type="button" onClick={() => { setChanging(true); setMessage(''); }} className={lightButton}>
          Change the password
        </button>
      )}

      {status.earlier.length > 0 && (
        <details className="text-xs text-ink-soft" data-testid="backup-password-earlier">
          <summary className="cursor-pointer font-semibold text-ink min-h-11 flex items-center">Earlier passwords ({status.earlier.length})</summary>
          <ul className="mt-1 space-y-1">
            {status.earlier.map((e) => (
              <li key={e.fingerprint + e.replacedAt}>
                Set {day(e.setAt) || 'earlier'}, replaced {day(e.replacedAt)}: backups from then still need it. <span className="font-mono">({e.fingerprint.slice(0, 8)})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
