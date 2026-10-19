'use client';

import React, { useEffect, useState } from 'react';
import { getJson } from '@/lib/apiClient';
import { ExpensesPanel } from './ExpensesPanel';
import { ReportsPanel } from './ReportsPanel';
import { AuditPanel } from './AuditPanel';
import { VatPanel } from './VatPanel';

type Section = 'expenses' | 'reports' | 'vat' | 'audit';

/**
 * Money: the shop's expenses (with photos of the bills), the reports for the accountant (and their
 * ZIP), the VAT return (only once VAT is on) and the audit log. Phone first: one column, big targets;
 * the laptop view keeps the same column at a readable width. readOnly: the accountant's view (the
 * server refuses every change anyway).
 */
export function AdminMoneyTab({ phone, readOnly = false }: { phone: boolean; readOnly?: boolean }) {
  const [section, setSection] = useState<Section>(readOnly ? 'reports' : 'expenses');
  const [vat, setVat] = useState<{ on: boolean; inUse: boolean }>({ on: false, inUse: false });
  useEffect(() => {
    let cancelled = false;
    void getJson<{ settings?: { enabled?: boolean }; inUse?: boolean }>('/api/admin/vat').then(({ ok, data }) => {
      if (!cancelled && ok) setVat({ on: data.settings?.enabled === true, inUse: data.inUse === true });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const sections: Array<[Section, string]> = [
    ['expenses', 'Expenses'],
    ['reports', 'Reports'],
    ...(vat.inUse ? ([['vat', 'VAT']] as Array<[Section, string]>) : []),
    ['audit', 'Audit log'],
  ];
  return (
    <div className={`space-y-4 ${phone ? '' : 'max-w-3xl'}`}>
      <div role="group" aria-label="Money sections" className={`grid ${sections.length === 4 ? 'grid-cols-4' : 'grid-cols-3'} gap-1 rounded-2xl border border-line-strong bg-surface p-1`}>
        {sections.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)} className={`min-h-11 rounded-xl text-sm font-semibold ${section === id ? 'bg-ink text-paper' : 'text-ink-soft hover:bg-sand'}`}>
            {label}
          </button>
        ))}
      </div>
      {section === 'expenses' && <ExpensesPanel readOnly={readOnly} vatOn={vat.on} />}
      {section === 'reports' && <ReportsPanel readOnly={readOnly} />}
      {section === 'vat' && vat.inUse && <VatPanel />}
      {section === 'audit' && <AuditPanel />}
    </div>
  );
}
