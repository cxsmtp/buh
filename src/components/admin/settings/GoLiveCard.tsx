'use client';

import React, { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Rocket } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';

/**
 * Settings → System & backups → "Go live: remove the test orders" (src/lib/server/goLive.ts). Shows what
 * would be removed (the orders, the pieces back to stock, transfer screenshots, chats when ticked) and
 * what stops it (an order with real money or a real shipment). Needs the hub password and the phrase
 * GO LIVE; a backup is made first, so the orders can be brought back.
 */

const PHRASE = 'GO LIVE';

interface Preview {
  orders: number;
  pieces: number;
  screenshots: number;
  chats: number;
  blockers: string[];
  wentLive: { at: string; by: string; backup: string } | null;
}

interface Result {
  orders: number;
  pieces: number;
  screenshots: number;
  chats: number;
  backup: string;
}

const field = 'w-full min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';

export function GoLiveCard() {
  const id = useId();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [chats, setChats] = useState(true);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Result | null>(null);

  /** Bumped to read the preview again (after Go live). */
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let on = true;
    void getJson<Preview & { message?: string }>('/api/admin/go-live').then(({ ok, data }) => {
      if (on && ok) setPreview(data);
    });
    return () => {
      on = false;
    };
  }, [reads]);

  const run = async () => {
    setError('');
    setBusy(true);
    const { ok, data } = await postJson<Result & { message?: string }>('/api/admin/go-live', { confirm: phrase, currentPassword: password, chats });
    setBusy(false);
    if (!ok) return setError(data.message || 'Go live did not work. Nothing was removed.');
    setDone(data);
    setPhrase('');
    setPassword('');
    setReads((n) => n + 1);
  };

  const blocked = Boolean(preview?.blockers.length);
  const ready = phrase === PHRASE && password.length > 0 && !busy && !blocked;

  return (
    <section className="rounded-xl border border-danger-line bg-surface p-3 space-y-3" aria-labelledby={`${id}-title`} data-testid="go-live">
      <h3 id={`${id}-title`} className="text-sm font-bold text-ink flex items-center gap-1.5">
        <Rocket className="w-4 h-4 text-danger" aria-hidden="true" /> Go live: remove the test orders
      </h3>
      <p className="text-xs text-ink-soft">
        Before the shop takes real orders: every order placed so far is removed for good, with its history, card and VAT records and transfer screenshots, so sales and money figures start from zero. The pieces those orders held go back to stock. Products, photos, settings and the audit log stay. A backup is made first, so the orders can be brought back with a restore.
      </p>
      {preview?.wentLive && (
        <p className="text-xs text-ink-soft" data-testid="go-live-last">
          Last done on {new Date(preview.wentLive.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (backup {preview.wentLive.backup}).
        </p>
      )}
      {preview && (
        <ul className="text-xs text-ink list-disc pl-5 space-y-0.5" data-testid="go-live-preview">
          <li>
            {preview.orders} {preview.orders === 1 ? 'order' : 'orders'} removed
          </li>
          <li>{preview.pieces} {preview.pieces === 1 ? 'piece goes' : 'pieces go'} back to stock</li>
          <li>{preview.screenshots} uploaded {preview.screenshots === 1 ? 'file' : 'files'} removed (transfer screenshots, order photos)</li>
          <li>{chats ? `${preview.chats} customer ${preview.chats === 1 ? 'chat' : 'chats'} removed` : `${preview.chats} customer ${preview.chats === 1 ? 'chat stays' : 'chats stay'}`}</li>
        </ul>
      )}
      {blocked && (
        <div role="alert" className="rounded-xl border border-danger-line bg-danger-soft p-2.5 text-xs text-danger space-y-1" data-testid="go-live-blockers">
          <p className="font-semibold flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" /> Not possible while an order carries real money or a real shipment:
          </p>
          <ul className="list-disc pl-5">
            {preview!.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm text-ink min-h-11">
        <input type="checkbox" className="mt-0.5 w-5 h-5 shrink-0" checked={chats} onChange={(e) => setChats(e.target.checked)} />
        <span>Also remove the customer chats so far</span>
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor={`${id}-phrase`}>
            Type {PHRASE} to confirm
          </label>
          <input id={`${id}-phrase`} className={field} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div>
          <label className={label} htmlFor={`${id}-password`}>
            Your hub password
          </label>
          <input id={`${id}-password`} className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </div>
      </div>
      <button type="button" onClick={() => void run()} disabled={!ready} className="min-h-11 px-4 py-2 rounded-xl bg-danger text-paper text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Rocket className="w-4 h-4" aria-hidden="true" />}
        {busy ? 'Making a backup, then removing…' : 'Go live: remove the test orders'}
      </button>
      {error && (
        <p role="alert" className="text-xs font-semibold text-danger">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-xs font-semibold text-success flex items-start gap-1.5">
          <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>
            Done: {done.orders} {done.orders === 1 ? 'order' : 'orders'} removed, {done.pieces} {done.pieces === 1 ? 'piece' : 'pieces'} back in stock
            {done.chats ? `, ${done.chats} ${done.chats === 1 ? 'chat' : 'chats'} removed` : ''}. Backup made first: {done.backup}. The shop is ready for real orders.
          </span>
        </p>
      )}
    </section>
  );
}
