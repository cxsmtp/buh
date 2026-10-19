'use client';

import React, { useState } from 'react';
import { Eye, EyeOff, LogOut, ShieldCheck } from 'lucide-react';
import type { BrandSettings } from '@/types';
import { postJson } from '@/lib/apiClient';
import { AdminMoneyTab } from './money/AdminMoneyTab';
import { inputClass, labelClass, primaryButton } from './money/moneyUi';

/**
 * The Admin Hub for an accountant the owner invited: the Money area only, read-only (the reports,
 * expenses with their bills, VAT and the audit log, and their exports). The server decides what the
 * session may do (requireAdmin in src/lib/server/guard.ts); this only leaves out what it can't.
 */
export function AccountantHub({ email, brand, phone, onLogout }: { email: string; brand: BrandSettings; phone: boolean; onLogout: () => void }) {
  return (
    <div className="min-h-screen flex flex-col font-sans bg-ivory" data-testid="accountant-hub">
      <header className="bg-ink text-paper px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top,0px))] border-b border-gold/25">
        <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-serif text-lg leading-tight truncate">{brand.storeName || 'Beautiful UAE Home'} · Accounts</p>
            <p className="text-[11px] text-sand flex items-center gap-1 min-w-0">
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">Read-only access for {email}</span>
            </p>
          </div>
          <button type="button" onClick={onLogout} className="min-h-11 px-3 rounded-xl border border-gold/40 text-xs font-bold inline-flex items-center gap-1.5">
            <LogOut className="w-4 h-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 w-full max-w-3xl mx-auto px-3 sm:px-6 py-4 pb-16">
        <AdminMoneyTab phone={phone} readOnly />
      </main>
    </div>
  );
}

/** The accountant's setup link (#setup=…): choose a password, then straight into the read-only hub. */
export function AccountantSetupForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('The two passwords are not the same.');
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/staff/setup', { token, password });
    setBusy(false);
    if (!ok) return setError(data.message || 'Could not set the password. Please try again.');
    onDone();
  };

  return (
    <form onSubmit={submit} className="mt-6 w-full max-w-sm rounded-2xl border border-line bg-surface p-5 space-y-3" data-testid="accountant-setup" aria-labelledby="acc-setup-title">
      <h1 id="acc-setup-title" className="font-serif text-xl text-ink">Set up your accountant access</h1>
      <p className="text-xs text-ink-soft">Choose a password (at least 12 characters). Your access is read-only: the shop’s money, reports and audit log. Afterwards, sign in at the Admin Hub link the shop owner sends you.</p>
      <div>
        <label htmlFor="acc-pw" className={labelClass}>New password</label>
        <div className="relative">
          <input id="acc-pw" type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={12} required className={`${inputClass} pr-12`} />
          <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-1 top-0 min-h-11 min-w-11 inline-flex items-center justify-center text-ink-soft" aria-label={show ? 'Hide password' : 'Show password'}>
            {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
          </button>
        </div>
      </div>
      <div>
        <label htmlFor="acc-pw2" className={labelClass}>Type it again</label>
        <input id="acc-pw2" type={show ? 'text' : 'password'} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={12} required className={inputClass} />
      </div>
      {error && <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{error}</p>}
      <button type="submit" disabled={busy} className={`${primaryButton} w-full`}>{busy ? 'Saving…' : 'Save and open the accounts'}</button>
    </form>
  );
}
