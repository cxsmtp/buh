'use client';

import React, { useEffect, useState } from 'react';
import { Building2, Check, Copy, CreditCard, Globe, Loader2, PlugZap } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import type { BankTransferMode, PaymentSettings } from '@/types';
import { cardFeeFils, formatAed, MAX_CARD_FEE_PERCENT, percentText } from '@/lib/money';
import { waMeLink } from '@/lib/whatsappConfirm';
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

/** What checkout offers for bank transfer with this choice (like the server's bankTransferMode()). */
export function effectiveBankMode(mode: BankTransferMode, accountSaved: boolean, whatsapp: boolean): 'send_details' | 'ask_whatsapp' | null {
  if (mode === 'off') return null;
  if (mode === 'send_details') return accountSaved ? 'send_details' : whatsapp ? 'ask_whatsapp' : null;
  if (mode === 'ask_whatsapp') return whatsapp ? 'ask_whatsapp' : null;
  return accountSaved ? 'send_details' : whatsapp ? 'ask_whatsapp' : null;
}

/** "3.5" → 3.5; anything else (empty, letters, over 10, 3 decimals) → null. */
function parsePercent(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  const v = Number(t);
  return v >= 0 && v <= MAX_CARD_FEE_PERCENT ? v : null;
}

export function PaymentsSettingsCard({
  value,
  secretsSet,
  bankAccountSaved = false,
  shopWhatsApp = '',
  onSave,
  auto,
}: {
  value: PaymentSettings;
  secretsSet: Record<string, boolean>;
  /** The bank account is saved (Settings → Branding & bank): its details can be sent automatically. */
  bankAccountSaved?: boolean;
  /** The shop's WhatsApp number (Settings → Store & contact): customers can ask there. */
  shopWhatsApp?: string;
  /** Saves; a warning from the server (keys of another mode while card orders are open) is passed on. */
  onSave: (v: PaymentSettings, onWarning: (warning: string) => void) => Promise<string | null>;
  auto?: AutoSaveHooks;
}) {
  const [d, setD] = useState<PaymentSettings>(value);
  // Keys are never autosaved (a half-typed one would replace a working one): Save sends them.
  const autosave = useAutoSave({ settingsKey: 'payments', value: { ...d, stripeSecretKey: '', stripeWebhookSecret: '' }, enabled: Boolean(auto), ...auto });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [warning, setWarning] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [account, setAccount] = useState<{ ok: boolean; text: string; account?: Account } | null>(null);
  const [checking, setChecking] = useState(false);
  const [domain, setDomain] = useState<{ ok: boolean; text: string; status?: DomainStatus } | null>(null);
  const [registering, setRegistering] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = <K extends keyof PaymentSettings>(k: K, v: PaymentSettings[K]) => setD((x) => ({ ...x, [k]: v }));
  const [feeText, setFeeText] = useState(() => percentText(value.cardFeePercent ?? 0));
  const feeTyped = parsePercent(feeText);
  const feeProblem = feeTyped === null;
  const commitFee = () => {
    if (feeTyped !== null && feeTyped !== d.cardFeePercent) set('cardFeePercent', feeTyped);
  };
  const whatsappSet = Boolean(waMeLink(shopWhatsApp, ''));
  const bankShown = effectiveBankMode(d.bankTransferMode ?? 'default', bankAccountSaved, whatsappSet);

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
    setWarning('');
    if (feeTyped === null) {
      setSaving(false);
      return setStatus({ ok: false, text: `Card payment fee: a percent from 0 to ${MAX_CARD_FEE_PERCENT}, with up to 2 decimals.` });
    }
    const problem = await onSave({ ...d, cardFeePercent: feeTyped }, setWarning);
    setSaving(false);
    if (!problem) setD((x) => ({ ...x, cardFeePercent: feeTyped, stripeSecretKey: '', stripeWebhookSecret: '' }));
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

      <section className="space-y-1.5 rounded-2xl border border-line bg-surface p-3">
        <label className={label} htmlFor="pay-card-fee">Card payment fee (%)</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="pay-card-fee"
            data-testid="card-fee-input"
            className={`${field} w-28`}
            inputMode="decimal"
            autoComplete="off"
            maxLength={5}
            value={feeText}
            aria-invalid={feeProblem}
            aria-describedby="pay-card-fee-help"
            onChange={(e) => setFeeText(e.target.value)}
            // Goes live (and is audited) when the owner leaves the field, never half-typed ("3" on the way to "3.7").
            onBlur={commitFee}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitFee();
            }}
          />
          <span className="text-xs text-ink-soft">{feeTyped === null ? '' : feeTyped > 0 ? `On AED 100: AED ${formatAed(cardFeeFils(10000, feeTyped))}` : 'No card fee'}</span>
        </div>
        <p id="pay-card-fee-help" className={`text-[11px] ${feeProblem ? 'text-danger font-semibold' : 'text-ink-muted'}`}>
          {feeProblem
            ? `A percent from 0 to ${MAX_CARD_FEE_PERCENT}, with up to 2 decimals.`
            : 'Added at the end of card orders (items + delivery), shown to the customer before they pay. 0 turns it off. Cash on delivery and bank transfer have no fee.'}
        </p>
      </section>

      <section className="space-y-2 rounded-2xl border border-line bg-surface p-3" aria-labelledby="pay-bank-title">
        <h4 id="pay-bank-title" className="text-xs font-bold text-ink flex items-center gap-1.5">
          <Building2 className="w-4 h-4 text-gold" aria-hidden="true" /> Bank transfer
        </h4>
        <label className="flex items-center gap-2 text-xs font-semibold">
          <input
            type="checkbox"
            data-testid="bank-show"
            checked={d.bankTransferMode !== 'off'}
            onChange={(e) => set('bankTransferMode', e.target.checked ? 'default' : 'off')}
          />
          Show bank transfer at checkout
        </label>
        {d.bankTransferMode !== 'off' && (
          <fieldset className="space-y-1.5 pl-1">
            <legend className="sr-only">How customers get the bank details</legend>
            <label className={`flex items-start gap-2 text-xs ${bankAccountSaved ? '' : 'opacity-60'}`}>
              <input type="radio" name="bank-mode" className="mt-0.5" disabled={!bankAccountSaved} checked={bankShown === 'send_details'} onChange={() => set('bankTransferMode', 'send_details')} />
              <span>
                <strong className="block text-ink">Send our bank details automatically</strong>
                <span className="text-ink-muted">{bankAccountSaved ? 'By email and on the order’s private page.' : 'Needs the account saved first (Settings → Branding & bank).'}</span>
              </span>
            </label>
            <label className={`flex items-start gap-2 text-xs ${whatsappSet ? '' : 'opacity-60'}`}>
              <input type="radio" name="bank-mode" className="mt-0.5" disabled={!whatsappSet} checked={bankShown === 'ask_whatsapp'} onChange={() => set('bankTransferMode', 'ask_whatsapp')} />
              <span>
                <strong className="block text-ink">Customer asks us on WhatsApp for the details</strong>
                <span className="text-ink-muted">{whatsappSet ? 'No account needs to be saved: you reply from the order with one tap.' : 'Needs the shop’s WhatsApp number (Settings → Store & contact).'}</span>
              </span>
            </label>
          </fieldset>
        )}
        <p data-testid="bank-mode-status" role="status" className="text-[11px] text-ink-soft">
          {bankShown === 'send_details'
            ? 'Checkout offers bank transfer; the details are sent automatically.'
            : bankShown === 'ask_whatsapp'
              ? 'Checkout offers bank transfer; customers message you on WhatsApp for the details.'
              : d.bankTransferMode === 'off'
                ? 'Bank transfer is not offered at checkout.'
                : 'Bank transfer is not offered: save the bank account, or the shop’s WhatsApp number.'}
        </p>
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
        <ul className="text-[11px] text-ink-soft font-mono flex flex-wrap gap-x-3 gap-y-0.5 min-w-0">
          {(info?.events ?? []).map((e) => (
            <li key={e} className="min-w-0 max-w-full break-all">{e}</li>
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
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-ink text-paper text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save payment settings
        </button>
        {auto && autosave.bar}
        {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}
        {warning && <p data-testid="payments-warning" role="alert" className="basis-full text-xs font-semibold text-warning break-anywhere">{warning}</p>}
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
