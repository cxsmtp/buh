'use client';

import React, { useState } from 'react';
import { Loader2, Truck } from 'lucide-react';
import type { DeliverySettings, Emirate } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';
import { EMIRATES_LIST } from '@/lib/delivery';

/**
 * Settings → Delivery: where you deliver, the time customers see, and the
 * optional same-day service with its charge. Customers see a green tick for
 * their area and the delivery time; the courier is chosen behind the scenes
 * and never shown to them.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-[#c5a059]';
const label = 'block text-xs font-semibold text-stone-700 mb-1';

export function DeliverySettingsCard({ value, onSave, auto }: { value: DeliverySettings; onSave: (v: DeliverySettings) => Promise<string | null>; auto?: AutoSaveHooks }) {
  const [d, setD] = useState<DeliverySettings>(value);
  const [notServed, setNotServed] = useState(value.notServed.join('\n'));
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof DeliverySettings>(k: K, v: DeliverySettings[K]) => setD((x) => ({ ...x, [k]: v }));
  const autosave = useAutoSave({ settingsKey: 'delivery', value: { ...d, notServed: notServed.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) }, enabled: Boolean(auto), ...auto });
  const toggle = (k: 'emirates' | 'sameDayEmirates', e: Emirate) => set(k, d[k].includes(e) ? d[k].filter((x) => x !== e) : [...d[k], e]);

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave({ ...d, notServed: notServed.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) });
    setSaving(false);
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. Checkout shows it straight away.' });
  };

  return (
    <div className="space-y-5 text-sm">
      <section className="space-y-2">
        <h3 className="font-bold text-[#0f1c2e] flex items-center gap-2"><Truck className="w-4 h-4 text-[#c5a059]" /> Where and how fast</h3>
        <fieldset>
          <legend className={label}>Emirates you deliver to</legend>
          <div className="flex flex-wrap gap-2 text-xs">
            {EMIRATES_LIST.map((e) => (
              <label key={e} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-stone-200 bg-white">
                <input type="checkbox" checked={d.emirates.includes(e)} onChange={() => toggle('emirates', e)} /> {e}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="dl-days">Delivery time shown to customers</label>
            <input id="dl-days" className={field} value={d.standardDays} maxLength={40} onChange={(e) => set('standardDays', e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="dl-not">Areas you don’t deliver to (one per line)</label>
            <textarea id="dl-not" className={field} rows={2} value={notServed} placeholder="e.g. Sir Bani Yas Island" onChange={(e) => setNotServed(e.target.value)} />
          </div>
        </div>
      </section>

      <section className="space-y-2 rounded-2xl border border-stone-200 bg-white p-3">
        <label className="flex items-center gap-2 text-xs font-semibold">
          <input type="checkbox" checked={d.sameDayEnabled} onChange={(e) => set('sameDayEnabled', e.target.checked)} />
          Offer same-day delivery for an extra charge
        </label>
        {d.sameDayEnabled && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="dl-fee">Extra charge (AED)</label>
                <input id="dl-fee" className={field} type="number" min={0} max={500} step="0.5" inputMode="decimal" value={d.sameDayFee} onChange={(e) => set('sameDayFee', Number(e.target.value))} />
              </div>
              <div>
                <label className={label} htmlFor="dl-cut">Order before (UAE time)</label>
                <input id="dl-cut" className={field} type="time" value={d.sameDayCutoff} onChange={(e) => set('sameDayCutoff', e.target.value)} />
              </div>
            </div>
            <fieldset>
              <legend className={label}>Where same-day is offered</legend>
              <div className="flex flex-wrap gap-2 text-xs">
                {EMIRATES_LIST.map((e) => (
                  <label key={e} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-stone-200">
                    <input type="checkbox" checked={d.sameDayEmirates.includes(e)} onChange={() => toggle('sameDayEmirates', e)} /> {e}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-[11px] text-stone-500">Customers choose it at checkout; the charge is added to their total (and to the cash collected on delivery). Book these with the courier&apos;s same-day service.</p>
          </>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-[#0f1c2e] text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save delivery settings
        </button>
        {auto && autosave.bar}
        {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</p>}
      </div>
    </div>
  );
}
