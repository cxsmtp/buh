'use client';

import React, { useEffect, useState } from 'react';
import { Copy, Link2, Loader2 } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';

/**
 * Settings → Security → the private admin link. The Admin Hub is only at this
 * link (never on the shop's pages). Changing it needs the current password (or a
 * passkey sign-in in the last 10 minutes); the old link and every browser let in
 * through it stop working at once. The new link is shown here once.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const darkButton = 'min-h-11 px-4 py-2 rounded-xl bg-ink text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60';
const lightButton = 'min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold inline-flex items-center gap-1.5 hover:bg-ivory disabled:opacity-60';

interface LinkStatus {
  createdAt: string | null;
  via: string | null;
  freshPasskey: boolean;
  emailConfigured: boolean;
}

function when(iso: string | null): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function AdminLinkCard() {
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<{ link: string; path: string; emailing: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getJson<LinkStatus>('/api/admin/link').then(({ ok, data }) => {
      if (!cancelled && ok) setStatus(data);
    });
    return () => {
      cancelled = true;
    };
  }, [made]);

  const change = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { ok, data } = await postJson<{ link?: string; path?: string; emailing?: boolean; message?: string }>('/api/admin/link', { currentPassword: password });
    setBusy(false);
    if (!ok || !data.link || !data.path) {
      setError(data.message || 'Could not change the link. Please try again.');
      return;
    }
    setPassword('');
    setOpen(false);
    setCopied(false);
    setMade({ link: data.link, path: data.path, emailing: Boolean(data.emailing) });
  };

  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="space-y-4 text-sm" data-testid="admin-link-card">
      <div className="flex gap-3 items-start">
        <Link2 className="w-5 h-5 text-gold-deep shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1.5 min-w-0">
          <h3 className="font-semibold text-ink">Your private admin link</h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            The Admin Hub is only at your private link: the shop&rsquo;s pages have no way in, and every other address answers &ldquo;not found&rdquo;. Keep it bookmarked on your phone and laptop.
            The server keeps only a fingerprint of it, so it can&rsquo;t be shown again. Lost it? On the server run <code className="break-all">podman exec beautifuluaehome node scripts/admin-link.mjs --new</code>.
          </p>
          {status && <p className="text-xs text-ink-muted">Made {when(status.createdAt)}.</p>}
        </div>
      </div>

      {made && (
        <div role="status" className="rounded-2xl border border-success-line bg-success-soft p-3.5 space-y-2.5">
          <p className="text-xs font-semibold text-success">The link was changed. The old link no longer works. This is the only time the new one is shown:</p>
          <p className="font-mono text-xs break-all bg-surface border border-line rounded-lg px-2.5 py-2 text-ink" data-testid="new-admin-link">{made.link}</p>
          <p className="text-xs text-ink-soft">
            Bookmark it now on this device, then open it on your other phone or laptop and bookmark it there.{made.emailing ? ' It was also emailed to your admin email.' : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copy()} className={lightButton}>
              <Copy className="w-4 h-4" aria-hidden="true" />
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <a href={made.path} className={darkButton}>Open the new link</a>
          </div>
        </div>
      )}

      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className={lightButton}>
          Change the admin link
        </button>
      ) : (
        <form onSubmit={change} className="rounded-2xl border border-line p-3.5 space-y-3 bg-ivory">
          <p className="text-xs text-ink-soft leading-relaxed">
            A new random link replaces this one. The old link, and every phone or laptop that used it, stop working at once (this one moves to the new link).
          </p>
          {status?.freshPasskey ? (
            <p className="text-xs text-ink-soft">You signed in with a passkey a few minutes ago: no password needed.</p>
          ) : (
            <div>
              <label htmlFor="admin-link-password" className="block text-xs font-semibold text-ink-soft mb-1">Current password</label>
              <input id="admin-link-password" type="password" required autoComplete="current-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
            </div>
          )}
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={darkButton}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              Change the link now
            </button>
            <button type="button" onClick={() => { setOpen(false); setError(''); setPassword(''); }} className={lightButton}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
