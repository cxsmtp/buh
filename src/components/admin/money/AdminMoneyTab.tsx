'use client';

import React, { useState } from 'react';
import { ExpensesPanel } from './ExpensesPanel';
import { ReportsPanel } from './ReportsPanel';
import { AuditPanel } from './AuditPanel';

type Section = 'expenses' | 'reports' | 'audit';

/**
 * Money: the shop's expenses (with photos of the bills), the reports for the accountant (and their
 * ZIP), and the audit log. Phone first: one column, big targets; the laptop view keeps the same
 * column at a readable width.
 */
export function AdminMoneyTab({ phone }: { phone: boolean }) {
  const [section, setSection] = useState<Section>('expenses');
  return (
    <div className={`space-y-4 ${phone ? '' : 'max-w-3xl'}`}>
      <div role="group" aria-label="Money sections" className="grid grid-cols-3 gap-1 rounded-2xl border border-line-strong bg-surface p-1">
        {(
          [
            ['expenses', 'Expenses'],
            ['reports', 'Reports'],
            ['audit', 'Audit log'],
          ] as Array<[Section, string]>
        ).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)} className={`min-h-11 rounded-xl text-sm font-semibold ${section === id ? 'bg-ink text-white' : 'text-ink-soft hover:bg-sand'}`}>
            {label}
          </button>
        ))}
      </div>
      {section === 'expenses' && <ExpensesPanel />}
      {section === 'reports' && <ReportsPanel />}
      {section === 'audit' && <AuditPanel />}
    </div>
  );
}
