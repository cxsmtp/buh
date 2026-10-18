'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, Download } from 'lucide-react';
import { getJson, sendJson } from '@/lib/apiClient';
import { dubaiToday, financialYear, financialYearOf, MONTH_NAMES, periodContaining, quarterPeriod, type ReportPeriod } from '@/lib/reportPeriods';
import { aed, Card, inputClass, labelClass, Line, niceDate, primaryButton } from './moneyUi';

interface Totals {
  orders: number;
  fils: number;
  paidOrders: number;
  paidFils: number;
}
interface Vat {
  from: string;
  to: string;
  salesFils: number;
  ratio: number;
  level: 'ok' | 'near' | 'over';
  text: string;
}
interface Report {
  from: string;
  to: string;
  sales: { orders: number; itemsFils: number; deliveryFils: number; codFeeFils: number; discountFils: number; grossFils: number; paidFils: number; unpaidFils: number };
  refunds: { count: number; fils: number };
  netSalesFils: number;
  byMethod: Record<string, Totals>;
  card: { paidCount: number; paidFils: number; refundedFils: number };
  expenses: { count: number; fils: number; byCategory: Array<{ id: string; name: string; count: number; fils: number }> };
  profitFils: number;
  excluded: { cancelled: number; awaitingCard: number; testMode: number };
  notes: string[];
  vat: Vat;
}

type Kind = 'month' | 'quarter' | 'year' | 'custom';
const METHOD_NAMES: Record<string, string> = { cod: 'Cash on delivery', bank_transfer: 'Bank transfer', online_card: 'Card' };

export function VatNotice({ vat }: { vat: Vat }) {
  const warn = vat.level !== 'ok';
  return (
    <div role={warn ? 'alert' : 'status'} data-testid="vat-notice" data-level={vat.level} className={`rounded-2xl border px-3.5 py-3 text-xs flex gap-2 ${warn ? 'border-warning-line bg-warning-soft text-ink' : 'border-line bg-surface text-ink-soft'}`}>
      {warn && <AlertTriangle className="w-4 h-4 shrink-0 text-warning" aria-hidden="true" />}
      <div className="min-w-0 space-y-1">
        <p className="break-words">{vat.text}</p>
        <div className="h-2 rounded-full bg-sand overflow-hidden" aria-hidden="true">
          <div className={`h-full ${warn ? 'bg-warning' : 'bg-gold'}`} style={{ width: `${Math.min(100, Math.round(vat.ratio * 100))}%` }} />
        </div>
        <p className="text-[11px]">
          {niceDate(vat.from)} to {niceDate(vat.to)} · AED {aed(vat.salesFils)} of AED 375,000
        </p>
      </div>
    </div>
  );
}

/** Money → Reports: a month, quarter, financial year or any dates; the totals; the ZIP for the accountant. */
export function ReportsPanel() {
  const id = useId();
  const today = dubaiToday();
  const [startMonth, setStartMonth] = useState(1);
  const [kind, setKind] = useState<Kind>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [fy, setFy] = useState(() => financialYearOf(today, 1));
  const [quarter, setQuarter] = useState(() => Number(periodContaining('quarter', today, 1).label.slice(1, 2)));
  const [custom, setCustom] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const [report, setReport] = useState<Report | null>(null);
  const [vat, setVat] = useState<Vat | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void getJson<{ settings: { yearStartMonth: number }; vat: Vat }>('/api/admin/reports').then(({ ok, data }) => {
      if (!ok) return;
      setStartMonth(data.settings.yearStartMonth);
      setFy(financialYearOf(today, data.settings.yearStartMonth));
      setQuarter(Number(periodContaining('quarter', today, data.settings.yearStartMonth).label.slice(1, 2)));
      setVat(data.vat);
    });
  }, [today]);

  const period: ReportPeriod | null = (() => {
    if (kind === 'month') {
      const [y, m] = month.split('-').map(Number);
      return y && m ? periodContaining('month', `${month}-01`, startMonth) : null;
    }
    if (kind === 'quarter') return quarterPeriod(fy, quarter, startMonth);
    if (kind === 'year') return financialYear(fy, startMonth);
    return custom.from && custom.to && custom.from <= custom.to ? { ...custom, label: `${niceDate(custom.from)} to ${niceDate(custom.to)}` } : null;
  })();

  const load = useCallback(async (p: ReportPeriod) => {
    setError('');
    const { ok, data } = await getJson<{ report?: Report; message?: string }>(`/api/admin/reports?from=${p.from}&to=${p.to}`);
    if (!ok || !data.report) {
      setReport(null);
      return setError(data.message || 'Could not make the report.');
    }
    setReport(data.report);
    setVat(data.report.vat);
  }, []);

  const from = period?.from;
  const to = period?.to;
  useEffect(() => {
    if (from && to) void Promise.resolve().then(() => load({ from, to, label: '' }));
  }, [from, to, load]);

  const saveStart = async (m: number) => {
    setStartMonth(m);
    setFy(financialYearOf(today, m));
    await sendJson('PUT', '/api/admin/reports/settings', { yearStartMonth: m });
  };

  const years = Array.from({ length: 6 }, (_, i) => financialYearOf(today, startMonth) - i);

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3">
      <h2 id={`${id}-h`} className="font-serif text-xl text-ink">Reports</h2>
      {vat && <VatNotice vat={vat} />}
      <Card className="space-y-3">
        <div role="group" aria-label="Report period" className="grid grid-cols-4 gap-1 rounded-xl border border-line-strong p-0.5">
          {(
            [
              ['month', 'Month'],
              ['quarter', 'Quarter'],
              ['year', 'Year'],
              ['custom', 'Dates'],
            ] as Array<[Kind, string]>
          ).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`min-h-10 rounded-lg text-xs font-semibold ${kind === k ? 'bg-ink text-white' : 'text-ink-soft'}`}>
              {label}
            </button>
          ))}
        </div>
        {kind === 'month' && (
          <div>
            <label htmlFor={`${id}-month`} className={labelClass}>Month</label>
            <input id={`${id}-month`} type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} className={inputClass} />
          </div>
        )}
        {(kind === 'quarter' || kind === 'year') && (
          <div className="grid grid-cols-2 gap-3">
            <div className={kind === 'year' ? 'col-span-2' : ''}>
              <label htmlFor={`${id}-fy`} className={labelClass}>Financial year</label>
              <select id={`${id}-fy`} value={fy} onChange={(e) => setFy(Number(e.target.value))} className={inputClass}>
                {years.map((y) => (
                  <option key={y} value={y}>{financialYear(y, startMonth).label}</option>
                ))}
              </select>
            </div>
            {kind === 'quarter' && (
              <div>
                <label htmlFor={`${id}-q`} className={labelClass}>Quarter</label>
                <select id={`${id}-q`} value={quarter} onChange={(e) => setQuarter(Number(e.target.value))} className={inputClass}>
                  {[1, 2, 3, 4].map((q) => (
                    <option key={q} value={q}>Q{q}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
        {kind === 'custom' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-from`} className={labelClass}>From</label>
              <input id={`${id}-from`} type="date" value={custom.from} max={today} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label htmlFor={`${id}-to`} className={labelClass}>To</label>
              <input id={`${id}-to`} type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className={inputClass} />
            </div>
          </div>
        )}
        <div>
          <label htmlFor={`${id}-start`} className={labelClass}>Your financial year starts in</label>
          <select id={`${id}-start`} value={startMonth} onChange={(e) => void saveStart(Number(e.target.value))} className={inputClass}>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>{name}{i === 0 ? ' (calendar year)' : ''}</option>
            ))}
          </select>
        </div>
        {period && <p className="text-xs text-ink-soft" data-testid="report-period">{period.label}: {niceDate(period.from)} to {niceDate(period.to)} (UAE time)</p>}
      </Card>

      {error && <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{error}</p>}

      {report && period && (
        <>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['Net sales', report.netSalesFils, 'report-net-sales'],
                ['Expenses', report.expenses.fils, 'report-expenses'],
                ['Profit', report.profitFils, 'report-profit'],
              ] as const
            ).map(([label, fils, testId]) => (
              <Card key={label} className="p-2.5 text-center min-w-0">
                <p className="text-[11px] text-ink-soft">{label}</p>
                <p className="text-sm font-bold text-ink tabular-nums break-all" data-testid={testId}>{aed(fils)}</p>
              </Card>
            ))}
          </div>
          <a href={`/api/admin/reports/export?from=${report.from}&to=${report.to}`} download className={`${primaryButton} w-full`} data-testid="export-zip">
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>Export for my accountant (ZIP)</span>
          </a>
          <p className="text-[11px] text-ink-soft">Sales, order items, expenses with every bill, a printable summary and the audit log of the period, in one file. Each export is recorded in the audit log.</p>
          <Card>
            <h3 className="text-sm font-bold text-ink mb-1">Sales (AED)</h3>
            <Line label={`Orders (${report.sales.orders})`} value={aed(report.sales.itemsFils)} />
            <Line label="Delivery charges" value={aed(report.sales.deliveryFils)} />
            {report.sales.codFeeFils > 0 && <Line label="Cash-on-delivery fees" value={aed(report.sales.codFeeFils)} />}
            {report.sales.discountFils > 0 && <Line label="Discounts" value={aed(-report.sales.discountFils)} />}
            <Line label="Gross sales" value={aed(report.sales.grossFils)} strong testId="report-gross" />
            <Line label={`Refunds (${report.refunds.count})`} value={aed(-report.refunds.fils)} testId="report-refunds" />
            <Line label="Net sales" value={aed(report.netSalesFils)} strong />
            {report.sales.unpaidFils > 0 && <Line label="of which not marked paid yet" value={aed(report.sales.unpaidFils)} />}
          </Card>
          <Card>
            <h3 className="text-sm font-bold text-ink mb-1">By payment method</h3>
            {Object.entries(report.byMethod).map(([m, t]) => (
              <Line key={m} label={`${METHOD_NAMES[m] ?? m}: ${t.orders} order${t.orders === 1 ? '' : 's'} (${t.paidOrders} paid)`} value={aed(t.fils)} testId={`report-method-${m}`} />
            ))}
            {report.card.paidCount > 0 && <p className="text-[11px] text-ink-soft mt-1">Card payments taken: {report.card.paidCount}, AED {aed(report.card.paidFils)}. Stripe’s fees and payouts are in your Stripe dashboard (Balance → Payouts).</p>}
          </Card>
          <Card>
            <h3 className="text-sm font-bold text-ink mb-1">Expenses by category</h3>
            {report.expenses.byCategory.length ? report.expenses.byCategory.map((c) => <Line key={c.id} label={`${c.name} (${c.count})`} value={aed(c.fils)} />) : <p className="text-xs text-ink-soft">No expenses in this period.</p>}
            <Line label="Total expenses" value={aed(report.expenses.fils)} strong />
          </Card>
          {(report.excluded.cancelled > 0 || report.excluded.awaitingCard > 0 || report.excluded.testMode > 0 || report.notes.length > 0) && (
            <Card className="text-xs text-ink-soft space-y-1">
              {report.excluded.cancelled > 0 && <p>{report.excluded.cancelled} cancelled order{report.excluded.cancelled === 1 ? ' is' : 's are'} not counted.</p>}
              {report.excluded.awaitingCard > 0 && <p>{report.excluded.awaitingCard} order{report.excluded.awaitingCard === 1 ? ' is' : 's are'} still waiting for the card payment (not counted).</p>}
              {report.excluded.testMode > 0 && <p>{report.excluded.testMode} Stripe test payment{report.excluded.testMode === 1 ? ' is' : 's are'} not counted.</p>}
              {report.notes.map((n) => (
                <p key={n} className="break-words">{n}</p>
              ))}
            </Card>
          )}
        </>
      )}
    </section>
  );
}
