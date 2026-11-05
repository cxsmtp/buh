'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { RefreshCw, Upload } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { aed, Card, niceDate, primaryButton, secondaryButton, uaeTime } from './moneyUi';

interface Charge {
  awb: string;
  orderId: string | null;
  amountFils: number;
  source: 'jeebly_reply' | 'statement';
  chargedOn: string;
}
interface View {
  count: number;
  totalFils: number;
  charges: Charge[];
  waiting: number;
  sync: { at: string; checked: number; found: number; waiting: number } | null;
}
interface PreviewRow {
  awb: string;
  amountFils: number;
  chargedOn: string;
  orderId: string | null;
  status: 'new' | 'same' | 'changed' | 'unmatched';
  wasFils?: number;
}
interface Preview {
  rows: PreviewRow[];
  count: number;
  totalFils: number;
  skipped: number;
  columns: { awb: string; charge: string; date?: string };
}

const STATUS: Record<PreviewRow['status'], string> = { new: 'New', same: 'Already in', changed: 'Changed', unmatched: 'Not a shop order' };

/**
 * Money → Courier charges: what Jeebly charged for each shipment, as courier expenses. From Jeebly's
 * own replies (checked by the shop every 15 minutes, past shipments too) and from Jeebly's statement
 * (the CSV from the Jeebly portal): previewed, then saved once per AWB.
 */
export function CourierChargesPanel({ readOnly = false }: { readOnly?: boolean }) {
  const id = useId();
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<'' | 'sync' | 'read' | 'save'>('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await getJson<View & { message?: string }>('/api/admin/money/courier-charges');
    if (ok) setView(data);
    else setError(data.message || 'Could not load the courier charges.');
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of an external list
    void load();
  }, [load]);

  const sync = async () => {
    setBusy('sync');
    setError('');
    setMessage('');
    const { ok, data } = await postJson<View & { checked: number; found: number; message?: string }>('/api/admin/money/courier-charges', {});
    setBusy('');
    if (!ok) return setError(data.message || 'Could not check Jeebly.');
    setView(data);
    setMessage(data.checked ? `Asked Jeebly about ${data.checked} shipment${data.checked === 1 ? '' : 's'}: ${data.found ? `${data.found} charge${data.found === 1 ? '' : 's'} found` : 'Jeebly gave no charges in its replies'}.` : 'Nothing to ask Jeebly (or the live Jeebly keys are not saved in Couriers).');
  };

  const pick = async (file: File | undefined) => {
    setError('');
    setMessage('');
    setPreview(null);
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return setError('That file is over 3 MB: download a shorter period from Jeebly.');
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return setError("Choose a CSV file. In Jeebly's portal, download the statement as CSV (or open it in Excel and Save As CSV).");
    const text = await file.text();
    setCsv(text);
    setBusy('read');
    const { ok, data } = await postJson<{ preview?: Preview; message?: string }>('/api/admin/money/courier-charges/statement', { csv: text });
    setBusy('');
    if (!ok || !data.preview) return setError(data.message || 'Could not read the statement.');
    setPreview(data.preview);
  };

  const save = async () => {
    setBusy('save');
    const { ok, data } = await postJson<{ saved?: { added: number; updated: number; same: number; skipped: number }; message?: string }>('/api/admin/money/courier-charges/statement', { csv, apply: true });
    setBusy('');
    if (!ok || !data.saved) return setError(data.message || 'Could not save the statement.');
    setPreview(null);
    setCsv('');
    setMessage(`Saved: ${data.saved.added} new, ${data.saved.updated} changed, ${data.saved.same} already in.`);
    void load();
  };

  return (
    <div className="space-y-4" data-testid="courier-charges">
      <Card className="space-y-3">
        <h3 className="text-base font-bold text-ink">Courier charges (Jeebly)</h3>
        <p className="text-sm text-ink-soft">
          Each shipment&rsquo;s Jeebly charge is a courier expense here (Courier &amp; delivery, paid to Jeebly), once per AWB. They come from Jeebly: its replies, which the shop checks every 15 minutes (past shipments too), and its statement, which you upload below.
        </p>
        {view && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl bg-sand p-3">
              <dt className="text-ink-soft">Charges recorded</dt>
              <dd className="text-lg font-bold text-ink" data-testid="courier-charges-total">
                AED {aed(view.totalFils)} <span className="text-sm font-normal text-ink-soft">({view.count})</span>
              </dd>
            </div>
            <div className="rounded-xl bg-sand p-3">
              <dt className="text-ink-soft">Shipments without a charge yet</dt>
              <dd className="text-lg font-bold text-ink">{view.waiting}</dd>
            </div>
          </dl>
        )}
        {view?.sync && <p className="text-xs text-ink-soft">Last asked Jeebly: {uaeTime(view.sync.at)}.</p>}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} onClick={() => void sync()} disabled={busy !== ''}>
              <RefreshCw className={`w-4 h-4 ${busy === 'sync' ? 'animate-spin' : ''}`} aria-hidden="true" /> Check Jeebly now
            </button>
            <label htmlFor={`${id}-file`} className={`${secondaryButton} cursor-pointer`}>
              <Upload className="w-4 h-4" aria-hidden="true" /> Upload Jeebly statement (CSV)
            </label>
            <input id={`${id}-file`} type="file" accept=".csv,text/csv" className="sr-only" data-testid="courier-statement-file" onChange={(e) => void pick(e.target.files?.[0])} disabled={busy !== ''} />
          </div>
        )}
        {busy === 'read' && <p className="text-sm text-ink-soft">Reading the statement…</p>}
        {message && (
          <p className="text-sm text-ink" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        )}
      </Card>

      {preview && (
        <Card className="space-y-3" data-testid="courier-statement-preview">
          <h3 className="text-base font-bold text-ink">Check before saving</h3>
          <p className="text-sm text-ink-soft">
            {preview.count} shipment{preview.count === 1 ? '' : 's'}, AED {aed(preview.totalFils)} in all (AWB from &ldquo;{preview.columns.awb}&rdquo;, charge from &ldquo;{preview.columns.charge}&rdquo;{preview.columns.date ? `, date from “${preview.columns.date}”` : ''}).
            {preview.skipped ? ` ${preview.skipped} row${preview.skipped === 1 ? '' : 's'} without an AWB or a charge skipped.` : ''}
          </p>
          <div className="max-h-80 overflow-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-sand text-ink-soft">
                <tr>
                  <th className="text-start p-2">AWB</th>
                  <th className="text-start p-2">Order</th>
                  <th className="text-end p-2">AED</th>
                  <th className="text-start p-2">What happens</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.awb} className="border-t border-line">
                    <td className="p-2 break-all">{r.awb}</td>
                    <td className="p-2">{r.orderId ?? '—'}</td>
                    <td className="p-2 text-end">{aed(r.amountFils)}</td>
                    <td className="p-2">
                      {STATUS[r.status]}
                      {r.wasFils !== undefined ? ` (was ${aed(r.wasFils)})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryButton} onClick={() => void save()} disabled={busy !== '' || preview.count === 0} data-testid="courier-statement-save">
              Save {preview.count} charge{preview.count === 1 ? '' : 's'}
            </button>
            <button type="button" className={secondaryButton} onClick={() => setPreview(null)} disabled={busy !== ''}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {view && view.charges.length > 0 && (
        <Card className="space-y-2">
          <h3 className="text-base font-bold text-ink">Latest charges</h3>
          <ul className="divide-y divide-line text-sm">
            {view.charges.slice(0, 50).map((c) => (
              <li key={c.awb} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-semibold text-ink break-all">{c.awb}</span>
                  <span className="block text-xs text-ink-soft">
                    {niceDate(c.chargedOn)} · {c.orderId ?? 'not a shop order'} · {c.source === 'statement' ? 'statement' : 'Jeebly reply'}
                  </span>
                </span>
                <span className="shrink-0 font-semibold text-ink">AED {aed(c.amountFils)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
