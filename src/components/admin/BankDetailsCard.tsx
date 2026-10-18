'use client';

import React, { useState } from 'react';
import { BankTransferDetails } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './settings/useAutoSave';
import { AlertCircle, Building2, CheckCircle2, EyeOff } from 'lucide-react';
import { bankDetailsEmail, bankDetailsWhatsApp } from '@/lib/bankMessages';

interface BankDetailsCardProps {
  bank: BankTransferDetails;
  /** Saves on the server; resolves to an error message, or null when saved. */
  onSave: (bank: BankTransferDetails) => Promise<string | null>;
  auto?: AutoSaveHooks;
}

const FIELDS: Array<{ key: keyof BankTransferDetails; label: string; placeholder: string; mono?: boolean; long?: boolean }> = [
  { key: 'bankName', label: 'Bank name', placeholder: 'Emirates NBD' },
  { key: 'accountName', label: 'Account name', placeholder: 'BEAUTIFUL UAE HOME TEXTILES LLC' },
  { key: 'iban', label: 'IBAN', placeholder: 'AE07 0331 2345 6789 0123 456', mono: true },
  { key: 'accountNumber', label: 'Account number', placeholder: '1012345678901', mono: true },
  { key: 'swiftCode', label: 'SWIFT / BIC', placeholder: 'EBILAEAD', mono: true },
  { key: 'branch', label: 'Branch', placeholder: 'Al Wasl Road Branch, Dubai' },
  { key: 'instructions', label: 'Note sent with the details', placeholder: 'Include your order number in the transfer remarks…', long: true },
];

/** An example order for the preview. */
const SAMPLE = { orderId: 'BUH-261018-ABC234', total: 490, firstName: 'Fatima', link: 'https://your-shop/pay/…' };

/**
 * The bank account customers pay into by transfer. Never shown on the website: it is sent privately
 * to each customer who chooses bank transfer (email, WhatsApp, the order's private page), so it must
 * be right before going live. The preview shows exactly what they get.
 */
export const BankDetailsCard: React.FC<BankDetailsCardProps> = ({ bank, onSave, auto }) => {
  const [form, setForm] = useState<BankTransferDetails>(bank);
  const autosave = useAutoSave({ settingsKey: 'bank', value: form, enabled: Boolean(auto), ...auto });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<'email' | 'whatsapp'>('email');
  const email = bankDetailsEmail({ ...SAMPLE, bank: form });
  const whatsapp = bankDetailsWhatsApp({ ...SAMPLE, bank: form });

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setError('');
    const problem = await onSave(form);
    setSaving(false);
    if (problem) setError(problem);
    else {
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    }
  };

  return (
    <div className="bg-surface p-4 rounded-2xl border border-line shadow-xs space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <Building2 className="w-5 h-5 text-gold" />
        <div>
          <h3 className="font-serif text-base font-bold text-ink">Bank transfer details</h3>
          <p className="text-[11px] text-ink-muted">Sent to customers who choose bank transfer. Check every digit before going live.</p>
        </div>
      </div>
      <p className="flex items-start gap-1.5 rounded-xl border border-line bg-ivory px-3 py-2 text-ink-soft leading-relaxed">
        <EyeOff className="w-4 h-4 shrink-0 text-gold-deep mt-px" aria-hidden="true" />
        <span>
          These details are never shown on the website. Each customer who chooses bank transfer gets them privately: by email (when they give one and email is set up), on WhatsApp with one tap from the order, and on their order&apos;s private page, where they upload the transfer screenshot.
        </span>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <label key={f.key} className={f.long ? 'sm:col-span-2' : ''}>
            <span className="block text-ink-soft font-semibold mb-1">{f.label}</span>
            {f.long ? (
              <textarea
                rows={2}
                maxLength={500}
                value={form[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className="w-full px-3 py-2 rounded-xl border border-line-strong text-xs"
              />
            ) : (
              <input
                value={form[f.key]}
                maxLength={120}
                placeholder={f.placeholder}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className={`w-full px-3 py-2 rounded-xl border border-line-strong text-xs ${f.mono ? 'font-mono' : ''}`}
              />
            )}
          </label>
        ))}
      </div>
      <details className="rounded-xl border border-line bg-surface">
        <summary className="min-h-10 px-3 py-2 cursor-pointer font-semibold text-ink">Preview what customers receive</summary>
        <div className="px-3 pb-3 space-y-2">
          <div role="radiogroup" aria-label="Preview" className="flex gap-2">
            {(['email', 'whatsapp'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={preview === p}
                onClick={() => setPreview(p)}
                className={`min-h-9 px-3 rounded-lg border font-semibold ${preview === p ? 'bg-ink text-white border-ink' : 'bg-surface text-ink-soft border-line'}`}
              >
                {p === 'email' ? 'Email' : 'WhatsApp'}
              </button>
            ))}
          </div>
          {preview === 'email' && <p className="text-ink-soft"><span className="text-ink-muted">Subject:</span> {email.subject}</p>}
          <pre data-testid="bank-preview" className="whitespace-pre-wrap break-anywhere font-sans text-[11px] leading-relaxed text-ink bg-ivory rounded-lg border border-line p-3">
            {preview === 'email' ? email.text : whatsapp}
          </pre>
        </div>
      </details>
      <div className="flex items-center gap-2">
        {saved && (
          <span className="text-success font-semibold flex items-center gap-1">
            <CheckCircle2 className="w-4 h-4" /> Saved: new bank-transfer orders get these details.
          </span>
        )}
        {error && (
          <span role="alert" className="text-danger font-semibold flex items-center gap-1">
            <AlertCircle className="w-4 h-4" /> {error}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="ml-auto bg-ink hover:bg-ink disabled:opacity-60 text-white font-bold px-5 py-2.5 rounded-xl"
        >
          {saving ? 'Saving…' : 'Save bank details'}
        </button>
          {auto && autosave.bar}
      </div>
    </div>
  );
};
