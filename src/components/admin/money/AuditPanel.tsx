'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import { getJson } from '@/lib/apiClient';
import { Card, inputClass, labelClass, secondaryButton, uaeTime } from './moneyUi';

interface Entry {
  seq: number;
  id: string;
  at: string;
  action: string;
  who: string;
  details: Record<string, unknown>;
  file: string;
  line: number;
}
interface Page {
  entries: Entry[];
  total: number;
  page: number;
  pages: number;
  actions: string[];
  verification: { ok: boolean; status?: 'intact' | 'other_key' | 'unverified' | 'broken' };
  verificationText: string[];
}
interface Filters {
  from: string;
  to: string;
  action: string;
  who: string;
  order: string;
}
const EMPTY: Filters = { from: '', to: '', action: '', who: '', order: '' };

const query = (f: Filters) => Object.entries(f).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

/**
 * The chain check's colour: intact green; restored from another server's backup neutral (in order,
 * only that server can check the signatures); unverified amber; broken (tampered) red.
 */
const STATUS_CLASS: Record<string, string> = {
  intact: 'border-success-line bg-success-soft text-success',
  other_key: 'border-line bg-surface text-ink-soft',
  unverified: 'border-warning-line bg-warning-soft text-warning',
  broken: 'border-danger-line bg-danger-soft text-danger',
};

/** What an entry says, without the fields already shown (who, order). */
function detailText(d: Record<string, unknown>): string {
  const { by: _by, orderId: _o, ...rest } = d;
  void _by;
  void _o;
  const s = JSON.stringify(rest);
  return s === '{}' ? '' : s;
}

/**
 * Money → Audit log: read-only. Every change to orders, payments, refunds, stock, prices, settings,
 * sign-ins, backups, expenses and exports, newest first; filters; the chain check; CSV and JSONL
 * downloads of what is shown (each download is itself recorded).
 */
export function AuditPanel() {
  const id = useId();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { ok, data: d } = await getJson<Page & { message?: string }>(`/api/admin/audit?${query(filters)}&page=${page}`);
    if (!ok) return setError(d.message || 'Could not read the audit log.');
    setError('');
    setData(d);
  }, [filters, page]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((f) => ({ ...f, [k]: e.target.value }));
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setFilters(draft);
  };
  const prefixes = data ? [...new Set(data.actions.map((a) => `${a.split('.')[0]}.`))] : [];
  const status = data?.verification.status ?? (data?.verification.ok ? 'intact' : 'broken');

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3">
      <h2 id={`${id}-h`} className="font-serif text-xl text-ink">Audit log</h2>
      {data && (
        <div role="status" data-testid="audit-status" data-ok={data.verification.ok ? 'yes' : 'no'} data-status={status} className={`rounded-2xl border px-3.5 py-3 text-xs flex gap-2 ${STATUS_CLASS[status]}`}>
          {status === 'intact' || status === 'other_key' ? <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" /> : <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />}
          <div className="min-w-0 space-y-0.5">
            {data.verificationText.map((t) => (
              <p key={t} className="break-words">{t}</p>
            ))}
          </div>
        </div>
      )}
      <Card>
        <form onSubmit={apply} className="space-y-3" aria-label="Filter the audit log">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-from`} className={labelClass}>From</label>
              <input id={`${id}-from`} type="date" value={draft.from} onChange={set('from')} className={inputClass} />
            </div>
            <div>
              <label htmlFor={`${id}-to`} className={labelClass}>To</label>
              <input id={`${id}-to`} type="date" value={draft.to} onChange={set('to')} className={inputClass} />
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-action`} className={labelClass}>What</label>
            <select id={`${id}-action`} value={draft.action} onChange={set('action')} className={inputClass}>
              <option value="">Everything</option>
              {prefixes.map((p) => (
                <option key={p} value={p}>All {p.slice(0, -1)}</option>
              ))}
              {data?.actions.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${id}-who`} className={labelClass}>Who</label>
              <input id={`${id}-who`} type="text" value={draft.who} onChange={set('who')} placeholder="email, stripe…" className={inputClass} />
            </div>
            <div>
              <label htmlFor={`${id}-order`} className={labelClass}>Order or expense</label>
              <input id={`${id}-order`} type="text" value={draft.order} onChange={set('order')} placeholder="BUH-… or EXP-…" className={inputClass} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={secondaryButton}>Show</button>
            <a href={`/api/admin/audit/export?format=csv&${query(filters)}`} download className={secondaryButton}>
              <Download className="w-4 h-4" aria-hidden="true" />
              <span>CSV</span>
            </a>
            <a href={`/api/admin/audit/export?format=jsonl&${query(filters)}`} download className={secondaryButton}>
              <Download className="w-4 h-4" aria-hidden="true" />
              <span>JSONL</span>
            </a>
          </div>
        </form>
      </Card>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {data && (
        <>
          <p className="text-xs text-ink-soft" data-testid="audit-count">{data.total} entr{data.total === 1 ? 'y' : 'ies'}</p>
          <ol className="space-y-2" aria-label="Audit entries">
            {data.entries.map((e) => (
              <li key={`${e.file}:${e.line}`} data-testid="audit-entry">
                <Card className="p-3 text-xs space-y-0.5">
                  <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <strong className="text-ink break-all">{e.action}</strong>
                    <span className="text-ink-soft">{uaeTime(e.at)}</span>
                  </p>
                  {(e.who || typeof e.details.orderId === 'string') && (
                    <p className="text-ink-soft break-all">
                      {e.who}
                      {typeof e.details.orderId === 'string' ? ` · ${e.details.orderId}` : ''}
                    </p>
                  )}
                  {detailText(e.details) && <p className="text-ink-muted font-mono text-[11px] break-all whitespace-pre-wrap">{detailText(e.details).slice(0, 600)}</p>}
                </Card>
              </li>
            ))}
          </ol>
          {data.pages > 1 && (
            <nav aria-label="Audit pages" className="flex items-center justify-between gap-2">
              <button type="button" disabled={data.page <= 1} onClick={() => setPage((p) => p - 1)} className={secondaryButton}>
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                <span>Newer</span>
              </button>
              <span className="text-xs text-ink-soft">Page {data.page} of {data.pages}</span>
              <button type="button" disabled={data.page >= data.pages} onClick={() => setPage((p) => p + 1)} className={secondaryButton}>
                <span>Older</span>
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}
