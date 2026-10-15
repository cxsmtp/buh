'use client';

import React, { useState } from 'react';
import { Loader2, MessageCircle } from 'lucide-react';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';
import type { StoreSettings } from '@/types';

/**
 * Settings → Store & contact: the WhatsApp number customers message (change it
 * any time), the greeting their chat opens with, the support email, social
 * accounts, the address, and whether visitors abroad see prices in their own
 * currency as well.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-[#c5a059]';
const label = 'block text-xs font-semibold text-stone-700 mb-1';

export function StoreSettingsCard({ value, onSave, auto }: { value: StoreSettings; onSave: (v: StoreSettings) => Promise<string | null>; auto?: AutoSaveHooks }) {
  const [d, setD] = useState<StoreSettings>(value);
  const autosave = useAutoSave({ settingsKey: 'store', value: d, enabled: Boolean(auto), ...auto });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => setD((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setSaving(true);
    setStatus(null);
    const problem = await onSave(d);
    setSaving(false);
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. Customers see it straight away.' });
  };

  const digits = d.whatsappNumber.replace(/\D/g, '');
  const testLink = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(d.whatsappGreeting)}` : '';

  return (
    <div className="space-y-5 text-sm">
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={label} htmlFor="st-wa">WhatsApp number</label>
          <input id="st-wa" className={field} inputMode="tel" placeholder="+971 50 123 4567" value={d.whatsappNumber} maxLength={20} onChange={(e) => set('whatsappNumber', e.target.value)} />
          <p className="text-[11px] text-stone-500 mt-1">Used by the WhatsApp button, &ldquo;Ask on WhatsApp&rdquo; on products and order messages. Leave empty to hide them.</p>
        </div>
        <div>
          <label className={label} htmlFor="st-email">Support email</label>
          <input id="st-email" className={field} type="email" placeholder="orders@yourdomain.ae" value={d.supportEmail} maxLength={254} onChange={(e) => set('supportEmail', e.target.value)} />
          <p className="text-[11px] text-stone-500 mt-1">Shown to customers with a non-UAE number. Empty uses the address in .env.production.</p>
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="st-greet">WhatsApp opening message</label>
          <input id="st-greet" className={field} value={d.whatsappGreeting} maxLength={300} onChange={(e) => set('whatsappGreeting', e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-xs sm:col-span-2">
          <input type="checkbox" checked={d.showWhatsAppButton} onChange={(e) => set('showWhatsAppButton', e.target.checked)} />
          Show the floating WhatsApp button on every page
        </label>
        {testLink && (
          <a href={testLink} target="_blank" rel="noopener noreferrer" className="sm:col-span-2 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
            <MessageCircle className="w-4 h-4" /> Test: open a chat with this number
          </a>
        )}
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={label} htmlFor="st-ig">Instagram account</label>
          <input id="st-ig" className={field} placeholder="beautifuluaehome" value={d.instagramHandle} maxLength={40} onChange={(e) => set('instagramHandle', e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="st-tt">TikTok account</label>
          <input id="st-tt" className={field} placeholder="beautifuluaehome" value={d.tiktokHandle} maxLength={40} onChange={(e) => set('tiktokHandle', e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="st-fb">Facebook page</label>
          <input id="st-fb" className={field} placeholder="https://facebook.com/…" value={d.facebookUrl} maxLength={200} onChange={(e) => set('facebookUrl', e.target.value)} />
        </div>
      </section>

      <fieldset className="space-y-1.5 text-xs">
        <legend className={label}>Where customers can ask (only the ones ticked show on the shop)</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={d.askOnWhatsApp} onChange={(e) => set('askOnWhatsApp', e.target.checked)} />
          &ldquo;Ask on WhatsApp&rdquo; on products and in Help {!d.whatsappNumber && <span className="text-stone-400">(add the number above)</span>}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={d.askOnInstagram} onChange={(e) => set('askOnInstagram', e.target.checked)} />
          &ldquo;Ask on Instagram&rdquo; (opens a direct message to your account) {!d.instagramHandle && <span className="text-stone-400">(add the account above)</span>}
        </label>
        <p className="text-stone-500">The chat assistant has its own section (Settings → Chat assistant).</p>
      </fieldset>

      <section>
        <label className={label} htmlFor="st-addr">Store address (footer)</label>
        <input id="st-addr" className={field} placeholder="Dubai, United Arab Emirates" value={d.storeAddress} maxLength={300} onChange={(e) => set('storeAddress', e.target.value)} />
      </section>

      <section>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={d.showLocalCurrency} onChange={(e) => set('showLocalCurrency', e.target.checked)} />
          <span>
            Show visitors outside the UAE an approximate price in their own currency next to AED (from their device&apos;s region, rates updated daily). Customers always pay in AED.
          </span>
        </label>
      </section>

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-[#0f1c2e] text-white font-bold text-xs disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save store settings
        </button>
        {auto && autosave.bar}
        {status && <span role="status" className={`text-xs font-semibold ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</span>}
      </div>
    </div>
  );
}
