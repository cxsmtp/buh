'use client';

import React, { useState } from 'react';
import { AlertCircle, Loader2, MessageCircle, Smartphone } from 'lucide-react';
import type { PhoneCheckSettings } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';

/**
 * Settings → Phone check: how checkout makes sure the phone number is the customer's.
 * "WhatsApp (free)" (the default): no code is sent; after ordering, the customer taps one button
 * and sends the shop a WhatsApp message, and an order not confirmed in time is cancelled. "SMS
 * code": the SMS gateway or Firebase below sends a code at checkout (needs a paid gateway).
 * The server checks every value again.
 */

export const DEFAULT_PHONE_CHECK: PhoneCheckSettings = { mode: 'whatsapp', unconfirmedCancelHours: 24, unopenedCancelHours: 6 };

const label = 'block text-xs font-semibold text-ink-soft mb-1';

export function PhoneCheckCard({
  value,
  shopWhatsApp,
  behindProxy = true,
  onSave,
  auto,
}: {
  value: PhoneCheckSettings;
  /** Settings → Store & contact's number (empty: WhatsApp can't confirm anything). */
  shopWhatsApp: string;
  /** TRUST_PROXY is set (the shop sees each customer's connection); false: stricter limits apply. */
  behindProxy?: boolean;
  onSave: (v: PhoneCheckSettings) => Promise<string | null>;
  auto?: AutoSaveHooks;
}) {
  const [d, setD] = useState<PhoneCheckSettings>(value);
  const [hours, setHours] = useState(String(value.unconfirmedCancelHours));
  const [unopened, setUnopened] = useState(String(value.unopenedCancelHours ?? DEFAULT_PHONE_CHECK.unopenedCancelHours));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const hoursNumber = Number(hours);
  const hoursOk = Number.isInteger(hoursNumber) && hoursNumber >= 2 && hoursNumber <= 168;
  const unopenedNumber = Number(unopened);
  const unopenedOk = Number.isInteger(unopenedNumber) && unopenedNumber >= 2 && unopenedNumber <= 48 && (!hoursOk || unopenedNumber <= hoursNumber);
  const draft: PhoneCheckSettings = {
    mode: d.mode,
    unconfirmedCancelHours: hoursOk ? hoursNumber : value.unconfirmedCancelHours,
    unopenedCancelHours: unopenedOk ? unopenedNumber : Math.min(value.unopenedCancelHours ?? 6, hoursOk ? hoursNumber : value.unconfirmedCancelHours),
  };
  const autosave = useAutoSave({ settingsKey: 'phoneCheck', value: draft, enabled: Boolean(auto) && hoursOk && unopenedOk, ...auto });

  const save = async () => {
    if (!hoursOk) {
      setStatus({ ok: false, text: 'Cancel after: a whole number of hours from 2 to 168.' });
      return;
    }
    if (!unopenedOk) {
      setStatus({ ok: false, text: `If WhatsApp is never opened: a whole number of hours from 2 to ${Math.min(48, hoursNumber)}.` });
      return;
    }
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave(draft);
    setSaving(false);
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. Checkout uses it straight away.' });
  };

  const option = (mode: PhoneCheckSettings['mode'], title: string, text: string, icon: React.ReactNode) => (
    <label className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer ${d.mode === mode ? 'border-gold bg-ivory' : 'border-line bg-surface'}`}>
      <input type="radio" name="phone-check-mode" className="mt-1" checked={d.mode === mode} onChange={() => setD((x) => ({ ...x, mode }))} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 font-semibold text-ink text-xs">{icon} {title}</span>
        <span className="block text-[11px] text-ink-muted mt-0.5">{text}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-4 text-sm" data-testid="phone-check-card">
      <fieldset className="space-y-2">
        <legend className={label}>How checkout checks the phone number</legend>
        {option('whatsapp', 'WhatsApp (free)', 'No code and no subscription. After ordering, the customer taps one button and sends you “Confirm my order BUH-… · code 1234” from their own WhatsApp. In Orders, check the sender is the number on the order and tap “Confirmed on WhatsApp”.', <MessageCircle className="w-4 h-4 text-whatsapp" aria-hidden="true" />)}
        {option('sms_code', 'SMS code', 'Checkout texts a 6-digit code through the SMS gateway or Firebase below (a paid service). Confirm on WhatsApp stays optional (Store & contact).', <Smartphone className="w-4 h-4 text-gold" aria-hidden="true" />)}
      </fieldset>

      {d.mode === 'whatsapp' && !shopWhatsApp && (
        <p role="alert" className="flex items-start gap-2 text-xs text-danger bg-danger-soft border border-danger-line rounded-xl p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            No WhatsApp number is set in Settings → Store &amp; contact, so customers can&apos;t confirm on WhatsApp. Orders still come in, marked &ldquo;no WhatsApp number set — call the customer&rdquo;, and are never treated as confirmed. Add the number to switch it on.
          </span>
        </p>
      )}

      {d.mode === 'whatsapp' && !behindProxy && (
        <p role="alert" data-testid="phone-check-no-proxy" className="flex items-start gap-2 text-xs text-ink bg-warning-soft border border-warning-line rounded-xl p-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
          <span>Behind no proxy, the shop can&apos;t tell customers apart: limits are stricter (at most 15 orders waiting for WhatsApp across the shop). Set TRUST_PROXY=1 when the shop runs behind its proxy.</span>
        </p>
      )}

      <div className={d.mode === 'whatsapp' ? '' : 'opacity-60'}>
        <label className={label} htmlFor="pc-hours">Cancel orders not confirmed after (hours)</label>
        <input
          id="pc-hours"
          type="number"
          inputMode="numeric"
          min={2}
          max={168}
          step={1}
          value={hours}
          disabled={d.mode !== 'whatsapp'}
          onChange={(e) => setHours(e.target.value)}
          aria-invalid={!hoursOk}
          className="w-28 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <p className="text-[11px] text-ink-muted mt-1">
          2 to 168 (a week). The pieces go back on sale and the cancellation is in the order&apos;s history. Not cancelled: orders confirmed on WhatsApp or by phone call (or shipped anyway), paid card orders, and bank transfers. Customers are told at checkout. Changing it applies to new orders.
        </p>
        {!hoursOk && <p role="alert" className="text-[11px] text-danger font-semibold mt-1">A whole number of hours from 2 to 168.</p>}
      </div>

      <div className={d.mode === 'whatsapp' ? '' : 'opacity-60'}>
        <label className={label} htmlFor="pc-unopened">If the customer never opens WhatsApp, cancel after (hours)</label>
        <input
          id="pc-unopened"
          type="number"
          inputMode="numeric"
          min={2}
          max={Math.min(48, hoursOk ? hoursNumber : 48)}
          step={1}
          value={unopened}
          disabled={d.mode !== 'whatsapp'}
          onChange={(e) => setUnopened(e.target.value)}
          aria-invalid={!unopenedOk}
          className="w-28 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold"
        />
        <p className="text-[11px] text-ink-muted mt-1">
          2 to 48, never later than the hours above. An order whose customer never even tapped &ldquo;Confirm on WhatsApp&rdquo; goes back on sale sooner. Bank transfers are never cancelled: after the hours above they are flagged for you to check your bank.
        </p>
        {!unopenedOk && <p role="alert" className="text-[11px] text-danger font-semibold mt-1">A whole number of hours from 2 to {Math.min(48, hoursOk ? hoursNumber : 48)}.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-ink text-white font-bold text-xs disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save phone check
        </button>
        {auto && autosave.bar}
        {status && <span role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</span>}
      </div>
    </div>
  );
}
