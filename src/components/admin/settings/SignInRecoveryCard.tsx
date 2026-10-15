'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Download, KeyRound, LifeBuoy, Loader2, Printer, Trash2 } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { passkeyErrorMessage, passkeysSupported, webauthnBrowser } from '@/lib/client/passkeys';

/**
 * Settings → Passkeys & recovery codes: the owner's ways back into the Admin
 * Hub when the password is forgotten. Passkeys (the phone's or computer's
 * fingerprint, face or screen lock) and a set of 10 one-time recovery codes,
 * shown once to copy, download or print.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-sm placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-[#c5a059]';
const label = 'block text-xs font-semibold text-stone-700 mb-1';
const darkButton = 'px-4 py-2 rounded-xl bg-[#0f1c2e] text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-60';
const lightButton = 'px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-800 text-xs font-bold flex items-center gap-1.5 hover:bg-stone-50 disabled:opacity-60';

interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  synced: boolean;
  otherAddress: boolean;
}

interface CodeStatus {
  total: number;
  remaining: number;
  createdAt: string | null;
  freshPasskey: boolean;
  managedByEnv: boolean;
}

type Status = { ok: boolean; text: string } | null;

function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function SignInRecoveryCard() {
  return (
    <div className="space-y-6 text-sm">
      <p className="text-xs text-stone-600 leading-relaxed">
        If you forget your password, these get you back into the Admin Hub. Set up at least one: a passkey on your phone, and recovery codes kept somewhere safe (printed, or in a password manager).
      </p>
      <PasskeysSection />
      <RecoveryCodesSection />
    </div>
  );
}

function PasskeysSection() {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const supported = passkeysSupported();

  const load = useCallback(async () => {
    const { ok, data } = await getJson<{ passkeys: Passkey[]; available: boolean; problem?: string }>('/api/admin/passkeys');
    if (!ok) return;
    setList(data.passkeys);
    setProblem(data.available ? null : data.problem || 'Passkeys are not available at this address.');
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setBusy(true);
    try {
      const start = await postJson<{ options?: unknown; message?: string }>('/api/admin/passkeys/options', { currentPassword: password });
      setPassword('');
      if (!start.ok || !start.data.options) {
        setStatus({ ok: false, text: start.data.message || 'Could not start adding a passkey.' });
        return;
      }
      const { startRegistration } = await webauthnBrowser();
      let response: unknown;
      try {
        response = await startRegistration({ optionsJSON: start.data.options as Parameters<typeof startRegistration>[0]['optionsJSON'] });
      } catch (err) {
        setStatus({ ok: false, text: passkeyErrorMessage(err, 'add') });
        return;
      }
      const { ok, data } = await postJson<{ message?: string; passkeys?: Passkey[]; passkey?: Passkey }>('/api/admin/passkeys', { name: name.trim(), response });
      if (!ok) {
        setStatus({ ok: false, text: data.message || 'The passkey could not be added.' });
        return;
      }
      if (data.passkeys) setList(data.passkeys);
      setName('');
      setStatus({ ok: true, text: `Passkey “${data.passkey?.name ?? 'Passkey'}” added. Next time, choose “Sign in with a passkey”.` });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (passkey: Passkey) => {
    setStatus(null);
    setBusy(true);
    const { ok, data } = await sendJson<{ message?: string; passkeys?: Passkey[] }>('DELETE', `/api/admin/passkeys/${encodeURIComponent(passkey.id)}`);
    setBusy(false);
    setConfirming(null);
    if (ok && data.passkeys) setList(data.passkeys);
    setStatus(ok ? { ok: true, text: `Passkey “${passkey.name}” removed: it no longer opens the Admin Hub.` } : { ok: false, text: data.message || 'Could not remove it.' });
  };

  return (
    <section className="space-y-3" aria-labelledby="passkeys-title">
      <h3 id="passkeys-title" className="font-bold text-[#0f1c2e] flex items-center gap-2"><KeyRound className="w-4 h-4 text-[#9a7a35]" /> Passkeys</h3>
      <p className="text-xs text-stone-600 leading-relaxed">
        A passkey lets you sign in with your phone&apos;s or computer&apos;s fingerprint, face or screen lock, with no password to remember.
        Add one on each phone or computer you use (passkeys saved in iCloud Keychain or Google Password Manager follow you to your other devices).
      </p>

      {list === null ? (
        <p className="text-xs text-stone-600 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-xl p-3">No passkeys yet.</p>
      ) : (
        <ul className="divide-y divide-stone-200 border border-stone-200 rounded-xl" aria-label="Your passkeys">
          {list.map((p) => (
            <li key={p.id} className="p-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-stone-900 break-words">{p.name}</p>
                <p className="text-xs text-stone-600">
                  Added {when(p.createdAt)} · Last used {when(p.lastUsedAt)}
                  {p.synced ? ' · Synced to your other devices' : ''}
                </p>
                {p.otherAddress && <p className="text-xs text-amber-800">Made for another address of the shop: it won&apos;t work here.</p>}
              </div>
              {confirming === p.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-stone-800">Remove “{p.name}”?</span>
                  <button type="button" disabled={busy} onClick={() => void remove(p)} className="px-3 py-1.5 rounded-lg bg-red-700 text-white text-xs font-bold disabled:opacity-60">Yes, remove</button>
                  <button type="button" onClick={() => setConfirming(null)} className="px-3 py-1.5 rounded-lg border border-stone-300 text-stone-800 text-xs font-bold">Keep it</button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirming(p.id)} aria-label={`Remove passkey ${p.name}`} className="px-3 py-1.5 rounded-lg border border-stone-300 text-stone-800 text-xs font-bold flex items-center gap-1 hover:bg-stone-50">
                  <Trash2 className="w-3.5 h-3.5" /> Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {problem ? (
        <p className="text-xs bg-amber-50 border border-amber-300 text-amber-900 rounded-xl p-3">{problem}</p>
      ) : !supported ? (
        <p className="text-xs bg-amber-50 border border-amber-300 text-amber-900 rounded-xl p-3">This browser can&apos;t make passkeys. Open the Admin Hub in an up-to-date Chrome, Safari, Edge or Firefox to add one.</p>
      ) : (
        <form onSubmit={(e) => void add(e)} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="passkey-name">Name for this passkey</label>
            <input id="passkey-name" className={field} placeholder="e.g. My iPhone" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="passkey-password">Current password</label>
            <input id="passkey-password" className={field} type="password" required autoComplete="current-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy} className={darkButton}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />} Add a passkey
            </button>
          </div>
        </form>
      )}
      {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-emerald-800' : 'text-red-700'}`}>{status.text}</p>}
    </section>
  );
}

function RecoveryCodesSection() {
  const [info, setInfo] = useState<CodeStatus | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    void getJson<CodeStatus>('/api/admin/recovery-codes').then(({ ok, data }) => {
      if (ok) setInfo(data);
    });
  }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string; codes?: string[]; total?: number; remaining?: number; createdAt?: string }>('/api/admin/recovery-codes', { currentPassword: password });
    setBusy(false);
    setPassword('');
    if (!ok || !data.codes) {
      setStatus({ ok: false, text: data.message || 'Could not create the codes.' });
      return;
    }
    setCodes(data.codes);
    setCopied(false);
    setInfo((x) => (x ? { ...x, total: data.total ?? data.codes!.length, remaining: data.remaining ?? data.codes!.length, createdAt: data.createdAt ?? new Date().toISOString() } : x));
  };

  const asText = (list: string[]) =>
    [
      'Beautiful UAE Home — Admin Hub recovery codes',
      `Created ${new Date().toLocaleString('en-GB')}`,
      '',
      'Each code works once. On the sign-in screen choose "Use a recovery code",',
      'type your admin email and one code. Keep this somewhere safe.',
      '',
      ...list.map((c, i) => `${String(i + 1).padStart(2, ' ')}. ${c}`),
      '',
    ].join('\n');

  const copy = async () => {
    if (!codes) return;
    try {
      await navigator.clipboard.writeText(asText(codes));
      setCopied(true);
    } catch {
      setStatus({ ok: false, text: 'Copying is blocked in this browser: use Download or Print instead.' });
    }
  };

  const download = () => {
    if (!codes) return;
    const url = URL.createObjectURL(new Blob([asText(codes)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'admin-hub-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const print = () => {
    if (!codes) return;
    const w = window.open('', '_blank', 'width=600,height=700');
    if (!w) {
      setStatus({ ok: false, text: 'The print window was blocked: use Download instead, then print the file.' });
      return;
    }
    const pre = w.document.createElement('pre');
    pre.style.font = '16px/1.6 monospace';
    pre.textContent = asText(codes);
    w.document.title = 'Admin Hub recovery codes';
    w.document.body.appendChild(pre);
    w.focus();
    w.print();
  };

  const remaining = info?.remaining ?? 0;
  const hasSet = Boolean(info && info.total > 0);
  const low = hasSet && remaining <= 2;

  return (
    <section className="space-y-3 border-t border-stone-200 pt-5" aria-labelledby="recovery-title">
      <h3 id="recovery-title" className="font-bold text-[#0f1c2e] flex items-center gap-2"><LifeBuoy className="w-4 h-4 text-[#9a7a35]" /> Recovery codes</h3>
      <p className="text-xs text-stone-600 leading-relaxed">
        Ten one-time codes. If you forget your password, choose &ldquo;Use a recovery code&rdquo; on the sign-in screen, type your admin email and one code, then choose a new password.
        Each code works once. Creating a new set makes the old codes stop working.
      </p>

      {info && (
        <p className={`text-xs rounded-xl border p-3 ${low ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-stone-50 border-stone-200 text-stone-800'}`} role={low ? 'alert' : undefined}>
          {!hasSet
            ? 'You have no recovery codes yet.'
            : `${remaining} of ${info.total} codes left (created ${when(info.createdAt)}).${remaining === 0 ? ' None left: create a new set now.' : low ? ' Running low: create a new set soon.' : ''}`}
        </p>
      )}
      {info?.managedByEnv && (
        <p className="text-xs text-stone-700">
          Your password is set on the server (ADMIN_PASSWORD_HASH), so a recovery code signs you in but can&apos;t change the password: that is still done in .env.production.
        </p>
      )}

      {codes && (
        <div className="rounded-xl border-2 border-[#c5a059] bg-amber-50/60 p-3 space-y-3" aria-live="polite">
          <p className="text-xs font-bold text-stone-900">Save these codes now: this is the only time they are shown.</p>
          <ol className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-stone-900" aria-label="Your new recovery codes">
            {codes.map((c, i) => (
              <li key={c} className="flex gap-2"><span className="text-stone-600 w-7 shrink-0 text-right">{i + 1}.</span><span className="tracking-wider">{c}</span></li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copy()} className={lightButton}><Copy className="w-3.5 h-3.5" /> {copied ? 'Copied' : 'Copy'}</button>
            <button type="button" onClick={download} className={lightButton}><Download className="w-3.5 h-3.5" /> Download</button>
            <button type="button" onClick={print} className={lightButton}><Printer className="w-3.5 h-3.5" /> Print</button>
            <button type="button" onClick={() => setCodes(null)} className={darkButton}>I&apos;ve saved them</button>
          </div>
        </div>
      )}

      {!codes && info && (
        <form onSubmit={(e) => void create(e)} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {info.freshPasskey ? (
            <p className="sm:col-span-2 text-xs text-stone-700">You signed in with a passkey a moment ago, so your password isn&apos;t needed.</p>
          ) : (
            <div>
              <label className={label} htmlFor="recovery-password">Current password</label>
              <input id="recovery-password" className={field} type="password" required autoComplete="current-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          )}
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy} className={darkButton}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LifeBuoy className="w-3.5 h-3.5" />}
              {hasSet ? 'Create a new set (the old codes stop working)' : 'Create recovery codes'}
            </button>
          </div>
        </form>
      )}
      {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-emerald-800' : 'text-red-700'}`}>{status.text}</p>}
    </section>
  );
}
