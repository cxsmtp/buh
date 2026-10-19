'use client';

import React, { useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { getJson, sendJson } from '@/lib/apiClient';

/**
 * Settings → Payments → VAT: off by default (the shop is not VAT-registered). Turning it on needs
 * the TRN, the date it starts and the typed confirmation; the server checks all of it, audits it,
 * and from that date each order carries its VAT and gets a tax invoice (src/lib/server/vat.ts).
 */

const field = 'w-full min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';
const darkButton = 'min-h-11 px-4 py-2 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60';
const lightButton = 'min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold inline-flex items-center gap-1.5 hover:bg-ivory disabled:opacity-60';

interface VatSettings {
  enabled: boolean;
  trn: string;
  ratePercent: number;
  pricesIncludeVat: boolean;
  effectiveFrom: string;
  legalName: string;
  address: string;
  changedAt?: string;
  changedBy?: string;
}

const uaeToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

export function VatSettingsCard({ storeAddress }: { storeAddress: string }) {
  const [saved, setSaved] = useState<VatSettings | null>(null);
  const [phrase, setPhrase] = useState('TURN ON VAT');
  const [draft, setDraft] = useState<VatSettings | null>(null);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getJson<{ settings: VatSettings; confirmPhrase: string }>('/api/admin/vat').then(({ ok, data }) => {
      if (cancelled || !ok) return;
      setSaved(data.settings);
      setDraft({ ...data.settings, effectiveFrom: data.settings.effectiveFrom || uaeToday() });
      setPhrase(data.confirmPhrase);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!saved || !draft) return <p className="text-xs text-ink-soft">Loading VAT…</p>;

  const set = <K extends keyof VatSettings>(k: K, v: VatSettings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const save = async (enabled: boolean) => {
    setError('');
    setNotice('');
    setBusy(true);
    const body = enabled
      ? { enabled: true, trn: draft.trn, effectiveFrom: draft.effectiveFrom, pricesIncludeVat: draft.pricesIncludeVat, legalName: draft.legalName, address: draft.address, ...(saved.enabled ? {} : { confirm }) }
      : { enabled: false };
    const { ok, data } = await sendJson<{ settings?: VatSettings; message?: string }>('PUT', '/api/admin/vat', body);
    setBusy(false);
    if (!ok || !data.settings) return setError(data.message || 'Could not save. Please try again.');
    setSaved(data.settings);
    setDraft({ ...data.settings, effectiveFrom: data.settings.effectiveFrom || uaeToday() });
    setConfirm('');
    setNotice(enabled ? (saved.enabled ? 'Saved.' : `VAT is on from ${data.settings.effectiveFrom}.`) : 'VAT is off. Orders placed from now carry no VAT; tax invoices already issued stay as they are.');
  };

  const on = saved.enabled;
  return (
    <section className="space-y-4 text-sm border-t border-line pt-4" data-testid="vat-settings" aria-labelledby="vat-h">
      <div className="flex gap-3 items-start">
        <Receipt className="w-5 h-5 text-gold-deep shrink-0 mt-0.5" aria-hidden="true" />
        <div className="space-y-1.5 min-w-0">
          <h3 id="vat-h" className="font-semibold text-ink">VAT {on ? <span className="text-success">· on</span> : <span className="text-ink-muted">· off</span>}</h3>
          <p className="text-xs text-ink-soft leading-relaxed">
            Only for a VAT-registered shop. <strong>Talk to your accountant before turning this on.</strong> From the date you choose, every order carries 5% VAT and gets a tax invoice with your TRN; orders before it never change. Off: nothing about VAT shows anywhere.
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="vat-trn" className={label}>TRN (15 digits)</label>
          <input id="vat-trn" inputMode="numeric" autoComplete="off" value={draft.trn} disabled={on} onChange={(e) => set('trn', e.target.value)} className={field} placeholder="100xxxxxxxxxxxx" />
        </div>
        <div>
          <label htmlFor="vat-from" className={label}>VAT starts on (UAE date)</label>
          <input id="vat-from" type="date" value={draft.effectiveFrom} min={on ? undefined : uaeToday()} disabled={on} onChange={(e) => set('effectiveFrom', e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="vat-name" className={label}>Name on tax invoices</label>
          <input id="vat-name" value={draft.legalName} maxLength={120} onChange={(e) => set('legalName', e.target.value)} className={field} placeholder="The registered legal name (else the shop’s name)" />
        </div>
        <div>
          <label htmlFor="vat-address" className={label}>Address on tax invoices</label>
          <input id="vat-address" value={draft.address} maxLength={300} onChange={(e) => set('address', e.target.value)} className={field} placeholder={storeAddress || 'The registered address'} />
        </div>
      </div>
      <fieldset className="space-y-1">
        <legend className={label}>Rate</legend>
        <p className="text-sm text-ink">5% (UAE standard rate)</p>
      </fieldset>
      <label className="flex items-start gap-2 text-sm text-ink min-h-11">
        <input type="checkbox" className="mt-1 w-4 h-4" checked={draft.pricesIncludeVat} onChange={(e) => set('pricesIncludeVat', e.target.checked)} />
        <span>
          Prices include VAT <span className="text-xs text-ink-soft">(recommended: UAE prices for consumers are shown with VAT. Untick only if your accountant says so: 5% is then added at checkout.)</span>
        </span>
      </label>
      {!draft.pricesIncludeVat && (
        <p role="alert" className="text-xs text-ink bg-warning-soft border border-warning-line rounded-xl px-3 py-2" data-testid="vat-exclusive-warning">
          Prices exclude VAT: shoppers see every price before VAT, and 5% more is added only at checkout. UAE prices for consumers are normally shown including VAT, so a shopper may feel misled by the higher total. Keep “Prices include VAT” ticked unless your accountant advises otherwise.
        </p>
      )}
      {!on && (
        <div>
          <label htmlFor="vat-confirm" className={label}>To turn VAT on, type {phrase}</label>
          <input id="vat-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} />
        </div>
      )}
      {error && <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{error}</p>}
      {notice && <p role="status" className="text-xs text-ink bg-success-soft border border-success-line rounded-xl px-3 py-2">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        {on ? (
          <>
            <button type="button" className={darkButton} disabled={busy} onClick={() => void save(true)}>Save</button>
            <button type="button" className={lightButton} disabled={busy} onClick={() => window.confirm('Turn VAT off? Orders placed from now carry no VAT.') && void save(false)}>Turn VAT off</button>
          </>
        ) : (
          <button type="button" className={darkButton} disabled={busy || confirm.trim().toUpperCase() !== phrase} onClick={() => void save(true)}>Turn VAT on</button>
        )}
      </div>
      {saved.changedAt && <p className="text-[11px] text-ink-muted">Last changed {new Date(saved.changedAt).toLocaleString('en-GB')} by {saved.changedBy}.</p>}
    </section>
  );
}
