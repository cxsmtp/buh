'use client';

import React, { useEffect, useId, useState } from 'react';
import { Download } from 'lucide-react';
import { getJson } from '@/lib/apiClient';
import { dubaiToday, financialYearOf, periodContaining, quarterPeriod } from '@/lib/reportPeriods';
import { aed, Card, inputClass, labelClass, Line, niceDate, primaryButton } from './moneyUi';

interface Totals {
  count: number;
  netFils: number;
  vatFils: number;
  totalFils: number;
}
interface VatReturn {
  from: string;
  to: string;
  registered: boolean;
  trn: string;
  sales: Totals;
  credits: Totals;
  output: { netFils: number; vatFils: number };
  input: { count: number; amountFils: number; vatFils: number; withoutTrn: number; withoutTrnVatFils: number };
  netVatFils: number;
  missingVat?: { count: number; orderIds: string[] };
  notes: string[];
}

/**
 * Money → VAT return: a quarter (calendar quarters, or any dates for the FTA's own tax period): the
 * standard-rated sales and output VAT, the credit notes, the input VAT from expenses, and the CSV for
 * the accountant. Shown only once VAT is on (or tax invoices exist).
 */
export function VatPanel() {
  const id = useId();
  const today = dubaiToday();
  const [kind, setKind] = useState<'quarter' | 'custom'>('quarter');
  const [year, setYear] = useState(() => financialYearOf(today, 1));
  const [quarter, setQuarter] = useState(() => Number(periodContaining('quarter', today, 1).label.slice(1, 2)));
  const [custom, setCustom] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const [data, setData] = useState<VatReturn | null>(null);
  const [error, setError] = useState('');

  const period = kind === 'quarter' ? quarterPeriod(year, quarter, 1) : custom.from && custom.to && custom.from <= custom.to ? custom : null;
  const from = period?.from;
  const to = period?.to;
  useEffect(() => {
    if (!from || !to) return;
    let cancelled = false;
    void getJson<{ vatReturn?: VatReturn; message?: string }>(`/api/admin/vat/return?from=${from}&to=${to}`).then(({ ok, data: d }) => {
      if (cancelled) return;
      if (!ok || !d.vatReturn) {
        setData(null);
        setError(d.message || 'Could not work out the VAT return.');
        return;
      }
      setError('');
      setData(d.vatReturn);
    });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const years = Array.from({ length: 4 }, (_, i) => financialYearOf(today, 1) - i);
  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3" data-testid="vat-panel">
      <h2 id={`${id}-h`} className="font-serif text-xl text-ink">VAT return</h2>
      <Card className="space-y-3">
        <div role="group" aria-label="VAT period" className="grid grid-cols-2 gap-1 rounded-xl border border-line-strong p-0.5">
          {(
            [
              ['quarter', 'Quarter'],
              ['custom', 'Tax period dates'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`min-h-10 rounded-lg text-xs font-semibold ${kind === k ? 'bg-ink text-paper' : 'text-ink-soft'}`}>
              {label}
            </button>
          ))}
        </div>
        {kind === 'quarter' ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-y`} className={labelClass}>Year</label>
              <select id={`${id}-y`} value={year} onChange={(e) => setYear(Number(e.target.value))} className={inputClass}>
                {years.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-q`} className={labelClass}>Quarter</label>
              <select id={`${id}-q`} value={quarter} onChange={(e) => setQuarter(Number(e.target.value))} className={inputClass}>
                {[1, 2, 3, 4].map((q) => (
                  <option key={q} value={q}>Q{q}</option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-from`} className={labelClass}>From</label>
              <input id={`${id}-from`} type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label htmlFor={`${id}-to`} className={labelClass}>To</label>
              <input id={`${id}-to`} type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={inputClass} />
            </div>
          </div>
        )}
        {period && <p className="text-xs text-ink-soft">{niceDate(period.from)} to {niceDate(period.to)} (UAE dates)</p>}
      </Card>
      {error && <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{error}</p>}
      {data && (
        <>
          {(data.missingVat?.count ?? 0) > 0 && (
            <p role="alert" className="text-xs text-ink bg-warning-soft border border-warning-line rounded-xl px-3 py-2 break-words" data-testid="vat-missing">
              {data.missingVat!.count} order{data.missingVat!.count === 1 ? ' has' : 's have'} no VAT worked out although placed after VAT started (an older version of the shop was running, or VAT was off then): {data.missingVat!.orderIds.slice(0, 10).join(', ')}{data.missingVat!.count > 10 ? ', …' : ''}. They have no tax invoice and are not in these totals: check them with your accountant.
            </p>
          )}
          <Card>
            <h3 className="text-sm font-bold text-ink mb-1">Output VAT (sales)</h3>
            <Line label={`Tax invoices (${data.sales.count}), excluding VAT`} value={aed(data.sales.netFils)} />
            <Line label="VAT on them" value={aed(data.sales.vatFils)} testId="vat-sales-vat" />
            <Line label={`Credit notes (${data.credits.count}): refunds and cancellations`} value={aed(-data.credits.vatFils)} testId="vat-credits-vat" />
            <Line label="Standard-rated supplies after adjustments" value={aed(data.output.netFils)} strong testId="vat-output-net" />
            <Line label="Output VAT" value={aed(data.output.vatFils)} strong testId="vat-output-vat" />
          </Card>
          <Card>
            <h3 className="text-sm font-bold text-ink mb-1">Input VAT (expenses)</h3>
            <Line label={`Expenses with VAT (${data.input.count})`} value={aed(data.input.amountFils)} />
            <Line label="VAT on them" value={aed(data.input.vatFils)} strong testId="vat-input-vat" />
          </Card>
          <Card>
            <Line label={data.netVatFils >= 0 ? 'Net VAT payable' : 'Net VAT refundable'} value={aed(Math.abs(data.netVatFils))} strong testId="vat-net" />
          </Card>
          <a href={`/api/admin/vat/return?from=${data.from}&to=${data.to}&format=csv`} download className={`${primaryButton} w-full`} data-testid="vat-csv">
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Download for my accountant (CSV)</span>
          </a>
          <div className="text-[11px] text-ink-soft space-y-1">
            {data.notes.map((n) => (
              <p key={n} className="break-words">{n}</p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
