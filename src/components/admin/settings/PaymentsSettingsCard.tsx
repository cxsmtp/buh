'use client';

import React, { useEffect, useState } from 'react';
import { Check, Copy, CreditCard, Globe, Loader2, PlugZap } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import type { PaymentSettings } from '@/types';
import { secretPlaceholder } from '../AdminCouriersTab';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';

/**
 * Settings → Payments: card payments, with Apple Pay and Google Pay, through the owner's own
 * Stripe account. Off until the three keys are in and the switch is on. The two secret keys are
 * write-only (never shown again, never in backups); the page shows the webhook address and events
 * to paste into Stripe, checks the connection, and registers the shop's domain for Apple Pay.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';

interface Info {
  mode: 'test' | 'live' | null;
  webhookUrl: string;
  events: string[];
  domain: string | null;
}
interface Account {
  mode: 'test' | 'live' | null;
  name: string;
  chargesEnabled: boolean;
  country: string;
}
interface DomainStatus {
  domain: string;
  registered: boolean;
  applePay?: string;
  googlePay?: string;
  message?: string;
}

const modeOf = (key: string) => (/^(?:pk|sk|rk)_live_/.test(key) ? 'live' : /^(?:pk|sk|rk)_test_/.test(key) ? 'test' : null);

export function PaymentsSettingsCard({
  value,
  secretsSet,
  onSave,
  auto,
}: {
  value: PaymentSettings;
  secretsSet: Record<string, boolean>;
  onSave: (v: PaymentSettings) => Promise<string | null>;
  auto?: AutoSaveHooks;
}) {
  const [d, setD] = useState<PaymentSettings>(value);
  // Keys are never autosaved (a half-typed one would replace a working one): Save sends them.
  const autosave = useAutoSave({ settingsKey: 'payments', value: { ...d, stripeSecretKey: '', stripeWebhookSecret: '' }, enabled: Boolean(auto), ...auto });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [account, setAccount] = useState<{ ok: boolean; text: string; account?: Account } | null>(null);
  const [checking, setChecking] = useState(false);
  const [domain, setDomain] = useState<{ ok: boolean; text: string; status?: DomainStatus } | null>(null);
  const [registering, setRegistering] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = <K extends keyof PaymentSettings>(k: K, v: PaymentSettings[K]) => setD((x) => ({ ...x, [k]: v }));

  const secretSaved = Boolean(secretsSet.stripeSecretKey);
  useEffect(() => {
    void getJson<Info>('/api/admin/payments').then(({ ok, data }) => ok && setInfo(data));
    if (secretSaved) {
      void postJson<{ domain?: DomainStatus; message?: string }>('/api/admin/payments', { action: 'domain_status' }).then(({ ok, data }) => {
        if (ok && data.domain) setDomain({ ok: data.domain.registered, text: domainText(data.domain), status: data.domain });
      });
    }
  }, [secretSaved]);

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave(d);
    setSaving(false);
    if (!problem) setD((x) => ({ ...x, stripeSecretKey: '', stripeWebhookSecret: '' }));
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: d.cardEnabled ? 'Saved. Checkout now offers card, Apple Pay and Google Pay.' : 'Saved. Card payments are off.' });
  };

  const check = async () => {
    setChecking(true);
    setAccount(null);
    const { ok, data } = await postJson<{ account?: Account; message?: string }>('/api/admin/payments', { action: 'check', ...(d.stripeSecretKey.trim() ? { secretKey: d.stripeSecretKey.trim() } : {}) });
    setChecking(false);
    if (!ok || !data.account) return setAccount({ ok: false, text: data.message || 'Could not check the connection.' });
    const a = data.account;
    setAccount({
      ok: a.chargesEnabled,
      account: a,
      text: `Connected to ${a.name || 'your Stripe account'} (${a.mode === 'live' ? 'live' : 'test'} mode). ${a.chargesEnabled ? 'It can take payments.' : 'It cannot take payments yet: finish activating the account in Stripe.'}`,
    });
  };

  const register = async () => {
    setRegistering(true);
    const { ok, data } = await postJson<{ domain?: DomainStatus; message?: string }>('/api/admin/payments', { action: 'domain' });
    setRegistering(false);
    if (!ok || !data.domain) return setDomain({ ok: false, text: data.message || 'Could not register the domain.' });
    setDomain({ ok: data.domain.registered && data.domain.applePay === 'active', text: domainText(data.domain), status: data.domain });
  };

  const copyWebhook = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const mode = modeOf(d.stripePublishableKey) ?? modeOf(d.stripeSecretKey) ?? info?.mode ?? null;

  return (
    <div className="space-y-5 text-sm">
      <section className="space-y-2">
        <h3 className="font-bold text-ink flex flex-wrap items-center gap-2">
          <CreditCard className="w-4 h-4 text-gold" /> Card, Apple Pay and Google Pay (Stripe)
          {mode && (
            <span data-testid="stripe-mode" className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${mode === 'live' ? 'bg-success-soft text-success border-success-line' : 'bg-warning-soft text-warning border-warning-line'}`}>
              {mode === 'live' ? 'Live mode: real payments' : 'Test mode: no real money'}
            </span>
          )}
        </h3>
        <p className="text-[11px] text-ink-muted">
          Customers pay by card, or with Apple Pay and Google Pay (which also fill in their name, phone and address). The money goes to your Stripe account. Card numbers go straight to Stripe, never to the shop. Cash on delivery and bank transfer stay as they are.
        </p>
        <label className="flex items-center gap-2 text-xs font-semibold">
          <input type="checkbox" checked={d.cardEnabled} onChange={(e) => set('cardEnabled', e.target.checked)} />
          Take card payments at checkout
        </label>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="pay-pk">Publishable key</label>
          <input id="pay-pk" className={`${field} font-mono`} placeholder="pk_test_… or pk_live_…" autoComplete="off" spellCheck={false} value={d.stripePublishableKey} maxLength={250} onChange={(e) => set('stripePublishableKey', e.target.value.trim())} />
        </div>
        <div>
          <label className={label} htmlFor="pay-sk">Secret key</label>
          <input id="pay-sk" type="password" className={`${field} font-mono`} placeholder={secretPlaceholder(secretsSet.stripeSecretKey)} autoComplete="off" spellCheck={false} value={d.stripeSecretKey} maxLength={250} onChange={(e) => set('stripeSecretKey', e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="pay-wh">Webhook signing secret</label>
          <input id="pay-wh" type="password" className={`${field} font-mono`} placeholder={secretPlaceholder(secretsSet.stripeWebhookSecret)} autoComplete="off" spellCheck={false} value={d.stripeWebhookSecret} maxLength={250} onChange={(e) => set('stripeWebhookSecret', e.target.value)} />
        </div>
        <p className="sm:col-span-2 text-[11px] text-ink-muted">Stripe → Developers → API keys. The secret keys are never shown again, never sent to a browser and never put in backups: after restoring a backup, type them again.</p>
      </section>

      <section className="space-y-2 rounded-2xl border border-line bg-surface p-3">
        <h4 className="text-xs font-bold text-ink">Webhook (Stripe tells the shop when a payment is made)</h4>
        <p className="text-[11px] text-ink-muted">In Stripe → Developers → Webhooks → Add endpoint, paste this address and choose these events. Then copy the endpoint&apos;s signing secret (whsec_…) into the field above.</p>
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <code data-testid="webhook-url" className="text-[11px] bg-ivory border border-line rounded-lg px-2 py-1 break-all min-w-0">{info?.webhookUrl ?? '…'}</code>
          <button type="button" onClick={() => void copyWebhook()} className="text-[11px] font-semibold inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-line-strong bg-surface hover:bg-ivory">
            {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <ul className="text-[11px] text-ink-soft font-mono flex flex-wrap gap-x-3 gap-y-0.5">
          {(info?.events ?? []).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5 rounded-2xl border border-line bg-surface p-3">
          <button type="button" onClick={() => void check()} disabled={checking || (!secretSaved && !d.stripeSecretKey.trim())} className="px-3 py-1.5 rounded-xl border border-line-strong text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
            {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />} Check the connection
          </button>
          {account && <p role="status" className={`text-xs ${account.ok ? 'text-success' : 'text-danger'} font-semibold break-anywhere`}>{account.text}</p>}
        </div>
        <div className="space-y-1.5 rounded-2xl border border-line bg-surface p-3">
          <button type="button" onClick={() => void register()} disabled={registering || !secretSaved || !info?.domain} className="px-3 py-1.5 rounded-xl border border-line-strong text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
            {registering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />} Register this domain for Apple Pay
          </button>
          <p className="text-[11px] text-ink-muted break-anywhere">
            {info?.domain ? `Your shop: ${info.domain}. Needed once (in each mode) for Apple Pay; Google Pay works without it.` : 'Apple Pay needs the shop on its own domain (NEXT_PUBLIC_APP_URL).'}
          </p>
          {domain && <p role="status" className={`text-xs font-semibold break-anywhere ${domain.ok ? 'text-success' : 'text-warning'}`}>{domain.text}</p>}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-ink text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save payment settings
        </button>
        {auto && autosave.bar}
        {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}
      </div>
    </div>
  );
}

function domainText(d: DomainStatus): string {
  if (!d.registered) return `${d.domain} is not registered yet.`;
  const apple = d.applePay === 'active' ? 'Apple Pay ready' : `Apple Pay: ${d.applePay ?? 'not ready'}`;
  const google = d.googlePay === 'active' ? 'Google Pay ready' : `Google Pay: ${d.googlePay ?? 'not ready'}`;
  return `${d.domain}: ${apple} · ${google}${d.message ? ` (${d.message})` : ''}.`;
}
