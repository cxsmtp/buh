'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Copy, UserCheck } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';

/**
 * Settings → Security → Accountant access: invite your accountant (read-only: Money only), see who
 * has access, send a new setup link, revoke at once. The server enforces it (src/lib/server/staffAuth.ts).
 */

const field = 'w-full min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const darkButton = 'min-h-11 px-4 py-2 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60';
const lightButton = 'min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold inline-flex items-center gap-1.5 hover:bg-ivory disabled:opacity-60';

interface Account {
  id: string;
  email: string;
  name: string;
  status: 'invited' | 'active' | 'revoked';
  setupExpired: boolean;
  setupExpiresAt: string | null;
  invitedAt: string;
  lastSignInAt: string | null;
  revokedAt: string | null;
  /** 'restore': revoked by a backup restore (the backup may be older than a revoke). */
  revokedBy?: string | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function statusText(a: Account): string {
  if (a.status === 'revoked' && a.revokedBy === 'restore') return `Switched off by a backup restore ${when(a.revokedAt)}: re-invite to give access again`;
  if (a.status === 'revoked') return `Access revoked ${when(a.revokedAt)}`;
  if (a.status === 'invited') return a.setupExpired ? 'Setup link expired: send a new one' : `Invited: setup link valid until ${when(a.setupExpiresAt)}`;
  return a.lastSignInAt ? `Active · last signed in ${when(a.lastSignInAt)}` : 'Active';
}

export function AccountantAccessCard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await getJson<{ accounts: Account[] }>('/api/admin/staff');
    if (ok) setAccounts(data.accounts);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const invite = async (to: string, who = '') => {
    setError('');
    setNotice('');
    setLink(null);
    setCopied(false);
    setBusy(true);
    const { ok, data } = await postJson<{ emailed?: boolean; link?: string; message?: string }>('/api/admin/staff', { email: to, ...(who ? { name: who } : {}) });
    setBusy(false);
    if (!ok) return setError(data.message || 'Could not send the invitation. Please try again.');
    setEmail('');
    setName('');
    if (data.emailed) setNotice(`Setup link emailed to ${to} (valid 72 hours). Send them your Admin Hub link yourself: they sign in there afterwards.`);
    else {
      setNotice('Email is not set up (Settings → Email), so the setup link is below: send it to your accountant yourself, privately. It works once, for 72 hours.');
      setLink(data.link ?? null);
    }
    await load();
  };

  const revoke = async (a: Account) => {
    if (!window.confirm(`Revoke ${a.email}'s access now? They are signed out at once.`)) return;
    setError('');
    const { ok, data } = await sendJson<{ message?: string }>('DELETE', `/api/admin/staff/${a.id}`);
    if (!ok) return setError(data.message || 'Could not revoke. Please try again.');
    setNotice(`${a.email} no longer has access.`);
    await load();
  };

  const shown = accounts.filter((a) => a.status !== 'revoked' || a.revokedBy === 'restore' || accounts.length <= 5);
  const reinvite = accounts.filter((a) => a.status === 'revoked' && a.revokedBy === 'restore');

  return (
    <div className="space-y-4 text-sm border-t border-line pt-4" data-testid="accountant-access">
      <div className="flex gap-3 items-start">
        <UserCheck className="w-5 h-5 text-gold-deep shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1.5 min-w-0">
          <h3 className="font-semibold text-ink">Accountant access (read-only)</h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            Your accountant sees only Money: reports, expenses with their bills, VAT and the audit log, and can download the exports. They can’t change orders, stock, prices or settings, see keys, or read chats. Every sign-in and export is in the audit log.
          </p>
        </div>
      </div>
      <form
        className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void invite(email.trim(), name.trim());
        }}
      >
        <div>
          <label htmlFor="acc-email" className="block text-xs font-semibold text-ink-soft mb-1">Accountant’s email</label>
          <input id="acc-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="acc-name" className="block text-xs font-semibold text-ink-soft mb-1">Name (optional)</label>
          <input id="acc-name" type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={field} autoComplete="off" />
        </div>
        <button type="submit" disabled={busy || !email.trim()} className={darkButton}>{busy ? 'Sending…' : 'Invite'}</button>
      </form>
      {reinvite.length > 0 && (
        <p role="status" className="text-xs text-ink bg-warning-soft border border-warning-line rounded-xl px-3 py-2 break-words" data-testid="accountant-reinvite">
          Re-invite your accountant: the shop was restored from a backup, so accountant access from it was switched off ({reinvite.map((a) => a.email).join(', ')}). Use “Send a new setup link” below.
        </p>
      )}
      {error && <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{error}</p>}
      {notice && <p role="status" className="text-xs text-ink bg-success-soft border border-success-line rounded-xl px-3 py-2 break-words">{notice}</p>}
      {link && (
        <div className="rounded-xl border border-gold/50 bg-surface p-3 space-y-2">
          <p className="text-xs font-mono break-all text-ink" data-testid="accountant-setup-link">{link}</p>
          <button
            type="button"
            className={lightButton}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Copy className="w-4 h-4" aria-hidden="true" />
            {copied ? 'Copied' : 'Copy setup link'}
          </button>
        </div>
      )}
      {shown.length > 0 && (
        <ul className="space-y-2" aria-label="Accountant accounts">
          {shown.map((a) => (
            <li key={a.id} className="rounded-xl border border-line bg-surface p-3 flex flex-wrap items-center justify-between gap-2" data-testid="accountant-row" data-status={a.status}>
              <div className="min-w-0">
                <p className="font-semibold text-ink break-all">{a.name ? `${a.name} · ` : ''}{a.email}</p>
                <p className="text-xs text-ink-soft">{statusText(a)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {a.status !== 'active' && (
                  <button type="button" className={lightButton} disabled={busy} onClick={() => void invite(a.email)}>
                    Send a new setup link
                  </button>
                )}
                {a.status !== 'revoked' && (
                  <button type="button" className={lightButton} onClick={() => void revoke(a)}>
                    Revoke access
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
