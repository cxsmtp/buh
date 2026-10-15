'use client';

import React, { useState } from 'react';
import { BankTransferDetails } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './settings/useAutoSave';
import { AlertCircle, Building2, CheckCircle2 } from 'lucide-react';

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
  { key: 'instructions', label: 'Instructions shown at checkout', placeholder: 'Include your order number in the transfer remarks…', long: true },
];

/** The bank account customers pay into by transfer. Shown at checkout, so it must be right before going live. */
export const BankDetailsCard: React.FC<BankDetailsCardProps> = ({ bank, onSave, auto }) => {
  const [form, setForm] = useState<BankTransferDetails>(bank);
  const autosave = useAutoSave({ settingsKey: 'bank', value: form, enabled: Boolean(auto), ...auto });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const save = async () => {
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
    <div className="bg-white p-4 rounded-2xl border border-stone-200 shadow-xs space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <Building2 className="w-5 h-5 text-[#c5a059]" />
        <div>
          <h3 className="font-serif text-base font-bold text-[#0f1c2e]">Bank transfer details</h3>
          <p className="text-[11px] text-stone-500">Shown to customers who pay by bank transfer. Check every digit before going live.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <label key={f.key} className={f.long ? 'sm:col-span-2' : ''}>
            <span className="block text-stone-700 font-semibold mb-1">{f.label}</span>
            {f.long ? (
              <textarea
                rows={2}
                maxLength={500}
                value={form[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs"
              />
            ) : (
              <input
                value={form[f.key]}
                maxLength={120}
                placeholder={f.placeholder}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className={`w-full px-3 py-2 rounded-xl border border-stone-300 text-xs ${f.mono ? 'font-mono' : ''}`}
              />
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {saved && (
          <span className="text-emerald-700 font-semibold flex items-center gap-1">
            <CheckCircle2 className="w-4 h-4" /> Saved: checkout shows these details now.
          </span>
        )}
        {error && (
          <span role="alert" className="text-red-700 font-semibold flex items-center gap-1">
            <AlertCircle className="w-4 h-4" /> {error}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="ml-auto bg-[#0f1c2e] hover:bg-stone-800 disabled:opacity-60 text-white font-bold px-5 py-2.5 rounded-xl"
        >
          {saving ? 'Saving…' : 'Save bank details'}
        </button>
          {auto && autosave.bar}
      </div>
    </div>
  );
};
