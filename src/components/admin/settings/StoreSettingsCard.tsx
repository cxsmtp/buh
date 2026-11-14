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

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';

export function StoreSettingsCard({ value, onSave, auto }: { value: StoreSettings; onSave: (v: StoreSettings) => Promise<string | null>; auto?: AutoSaveHooks }) {
  const [d, setD] = useState<StoreSettings>(value);
  const autosave = useAutoSave({ settingsKey: 'store', value: d, enabled: Boolean(auto), ...auto });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => setD((x) => ({ ...x, [k]: v }));

  const save = async () => {
    // With autosave on, the Save button goes through it too: the same check that the settings were not changed elsewhere.
    if (!auto) autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = auto ? await autosave.save(d) : await onSave(d);
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
          <p className="text-[11px] text-ink-muted mt-1">Used by the WhatsApp button, &ldquo;Ask on WhatsApp&rdquo; on products and order messages. Leave empty to hide them.</p>
        </div>
        <div>
          <label className={label} htmlFor="st-email">Support email</label>
          <input id="st-email" className={field} type="email" placeholder="orders@yourdomain.ae" value={d.supportEmail} maxLength={254} onChange={(e) => set('supportEmail', e.target.value)} />
          <p className="text-[11px] text-ink-muted mt-1">Shown to customers with a non-UAE number. Empty uses the address in .env.production.</p>
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
          <a href={testLink} target="_blank" rel="noopener noreferrer" className="sm:col-span-2 inline-flex items-center gap-1.5 text-xs font-semibold text-success">
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
          &ldquo;Ask on WhatsApp&rdquo; on products and in Help {!d.whatsappNumber && <span className="text-ink-muted">(add the number above)</span>}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={d.askOnInstagram} onChange={(e) => set('askOnInstagram', e.target.checked)} />
          &ldquo;Ask on Instagram&rdquo; (opens a direct message to your account) {!d.instagramHandle && <span className="text-ink-muted">(add the account above)</span>}
        </label>
        <p className="text-ink-muted">The chat assistant has its own section (Settings → Chat assistant).</p>
      </fieldset>

      <fieldset className="space-y-1.5 text-xs">
        <legend className={label}>Confirm orders on WhatsApp (free: no WhatsApp API or other service)</legend>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={d.confirmOrdersOnWhatsApp} onChange={(e) => set('confirmOrdersOnWhatsApp', e.target.checked)} />
          <span>
            Ask customers to confirm their order on WhatsApp {!d.whatsappNumber && <span className="text-ink-muted">(add the number above)</span>}
            <span className="block text-ink-muted">After checkout they tap one button and send you &ldquo;Confirm my order BUH-… · code 1234&rdquo; from their own WhatsApp. In Orders, check the sender is the number on the order and tap &ldquo;Confirmed on WhatsApp&rdquo;. With Settings → Phone check &ldquo;WhatsApp (free)&rdquo; every order is asked, whatever this says.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 pl-5">
          <input type="checkbox" className="mt-0.5" checked={d.holdUntilWhatsAppConfirmed} disabled={!d.confirmOrdersOnWhatsApp} onChange={(e) => set('holdUntilWhatsAppConfirmed', e.target.checked)} />
          <span>
            Hold orders until confirmed on WhatsApp
            <span className="block text-ink-muted">Off: orders go through as usual and simply show &ldquo;not yet confirmed&rdquo;. On: an order can&apos;t be confirmed or booked with a courier until you mark the message received (you can still cancel it).</span>
          </span>
        </label>
      </fieldset>

      <PhotoOrdersFields d={d} set={set} />

      <section>
        <label className={label} htmlFor="st-addr">Store address (footer)</label>
        <input id="st-addr" className={field} placeholder="Dubai, United Arab Emirates" value={d.storeAddress} maxLength={300} onChange={(e) => set('storeAddress', e.target.value)} />
      </section>

      <fieldset className="space-y-2" data-testid="invoice-details">
        <legend className={label}>On invoices <span className="font-normal text-ink-muted">(all optional)</span></legend>
        <p className="text-xs text-ink-muted">Printed on the PDF invoices you send customers, with the address above. Empty: the legal name is the pickup name in Couriers (else the shop&rsquo;s name), and the trade licence lines are left out.</p>
        <div>
          <label className="block text-xs font-semibold text-ink mb-1" htmlFor="st-legal">Legal name</label>
          <input id="st-legal" className={field} placeholder="e.g. Beautiful Home Trading L.L.C" value={d.legalName ?? ''} maxLength={120} onChange={(e) => set('legalName', e.target.value)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className="block text-xs font-semibold text-ink mb-1" htmlFor="st-tl">Trade licence number</label>
            <input id="st-tl" className={field} placeholder="e.g. 1234567" value={d.tradeLicenceNumber ?? ''} maxLength={40} onChange={(e) => set('tradeLicenceNumber', e.target.value)} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-ink mb-1" htmlFor="st-tla">Issuing authority</label>
            <input id="st-tla" className={field} placeholder="e.g. Dubai DET" value={d.tradeLicenceAuthority ?? ''} maxLength={80} onChange={(e) => set('tradeLicenceAuthority', e.target.value)} />
          </div>
        </div>
      </fieldset>

      <section>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={d.showLocalCurrency} onChange={(e) => set('showLocalCurrency', e.target.checked)} />
          <span>
            Show visitors outside the UAE an approximate price in their own currency next to AED (from their device&apos;s region, rates updated daily). Customers always pay in AED.
          </span>
        </label>
      </section>

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-ink text-paper font-bold text-xs disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save store settings
        </button>
        {auto && autosave.bar}
        {status && <span role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</span>}
      </div>
    </div>
  );
}

/**
 * "Order from your photo": a link for pieces agreed on WhatsApp that are not in the shop (photos,
 * the agreed amount, address, payment, then the WhatsApp confirmation), and its home-page banner.
 */
function PhotoOrdersFields({ d, set }: { d: StoreSettings; set: <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => void }) {
  const [copied, setCopied] = useState(false);
  const link = typeof window === 'undefined' ? '/order-by-photo' : `${window.location.origin}/order-by-photo`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <fieldset className="space-y-1.5 text-xs" data-testid="photo-orders-settings">
      <legend className={label}>Order from your photo (pieces agreed on WhatsApp)</legend>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={d.photoOrders} onChange={(e) => set('photoOrders', e.target.checked)} data-testid="photo-orders-on" />
        <span>
          Take orders from a photo {!d.whatsappNumber && <span className="text-ink-muted">(set the shop’s WhatsApp above first, so customers can confirm)</span>}
          <span className="block text-ink-muted">
            For a piece you agreed on WhatsApp that is not in the shop: the customer uploads its photos, types the amount you agreed, their address and how they pay, then confirms on WhatsApp. In Orders, check the photos and tap &ldquo;Confirm amount&rdquo; (correct it if needed): only then can it be booked with the courier, and the label printed. They follow the courier in Track Order.
          </span>
        </span>
      </label>
      {d.photoOrders && (
        <div className="pl-5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded-lg bg-sand px-2 py-1 text-ink" data-testid="photo-orders-link">{link}</code>
            <button type="button" onClick={() => void copy()} className="min-h-9 px-3 rounded-lg border border-line-strong bg-surface text-ink font-semibold">
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <p className="text-ink-muted">Share this link on WhatsApp. These switches are also in Orders → Orders from a photo, next to your own deal links.</p>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={d.photoOrdersOnHome} onChange={(e) => set('photoOrdersOnHome', e.target.checked)} data-testid="photo-orders-home" />
            <span>
              Show it on the home page
              <span className="block text-ink-muted">A banner under the top picture: &ldquo;Have a photo of one of our pieces? Order it here&rdquo;. The catalogue stays as it is.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={d.photoOrdersCard !== false} onChange={(e) => set('photoOrdersCard', e.target.checked)} data-testid="photo-orders-card" />
            <span>
              Card payment on this page
              <span className="block text-ink-muted">Off: customers ordering here choose cash on delivery or bank transfer, so you can check the amount they typed before any money is taken. To fix the price yourself, use Orders &rarr; &ldquo;New photo deal&rdquo;.</span>
            </span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
