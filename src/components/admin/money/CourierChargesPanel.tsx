'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { AlertTriangle, RefreshCw, Upload } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { aed, Card, niceDate, primaryButton, secondaryButton, uaeTime } from './moneyUi';

interface Shipment {
  awb: string;
  orderId: string | null;
  status: string | null;
  deliveredOn: string | null;
  chargeFils: number | null;
  chargeSource: 'jeebly_reply' | 'statement' | null;
  chargedOn: string | null;
  codFils: number | null;
  remittedFils: number | null;
  remittedOn: string | null;
  remittanceRef: string | null;
  expectedCodFils: number | null;
  codMismatch: boolean;
}
interface View {
  count: number;
  charged: number;
  totalFils: number;
  codFils: number;
  remittedFils: number;
  pendingFils: number;
  shipments: Shipment[];
  waiting: number;
  sync: { at: string; checked: number; waiting: number } | null;
}
interface PreviewRow {
  awb: string;
  orderId: string | null;
  chargeFils?: number;
  codFils?: number;
  remittedFils?: number;
  remittedOn?: string;
  status?: string;
  what: 'new' | 'same' | 'changed' | 'unmatched';
  wasChargeFils?: number;
}
interface Preview {
  rows: PreviewRow[];
  count: number;
  chargeFils: number;
  codFils: number;
  remittedFils: number;
  skipped: number;
  columns: Record<string, string>;
}

const WHAT: Record<PreviewRow['what'], string> = { new: 'New', same: 'Already in', changed: 'Updates it', unmatched: 'Not a shop order' };
const money = (f: number | null | undefined) => (f === null || f === undefined ? '—' : aed(f));
const COLUMN_NAMES: Record<string, string> = { awb: 'AWB', charge: 'charge', cod: 'COD', remitted: 'payout', remitDate: 'payout date', remitRef: 'payout reference', status: 'status', delivered: 'delivered date', date: 'date' };

/**
 * Money → Courier: what Jeebly says about each shipment: its status, the cash it collected on
 * delivery (COD), what it paid out to the shop, and what it charged (each charge also a courier
 * expense). From Jeebly's replies (checked by the shop every 15 minutes, past shipments too) and its
 * statement (the CSV from the Jeebly portal), previewed before saving.
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
    else setError(data.message || 'Could not load the courier details.');
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of an external list
    void load();
  }, [load]);

  const sync = async () => {
    setBusy('sync');
    setError('');
    setMessage('');
    const { ok, data } = await postJson<View & { checked: number; message?: string }>('/api/admin/money/courier-charges', {});
    setBusy('');
    if (!ok) return setError(data.message || 'Could not check Jeebly.');
    setView(data);
    setMessage(data.checked ? `Asked Jeebly about ${data.checked} shipment${data.checked === 1 ? '' : 's'}.` : 'Nothing to ask Jeebly (or the live Jeebly keys are not saved in Couriers).');
  };

  const pick = async (file: File | undefined) => {
    setError('');
    setMessage('');
    setPreview(null);
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return setError('That file is over 3 MB: download a shorter period from Jeebly.');
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') return setError("Choose a CSV file. In Jeebly's portal, download the report as CSV (or open it in Excel and Save As CSV).");
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
    const { ok, data } = await postJson<{ saved?: { added: number; updated: number; same: number }; message?: string }>('/api/admin/money/courier-charges/statement', { csv, apply: true });
    setBusy('');
    if (!ok || !data.saved) return setError(data.message || 'Could not save the statement.');
    setPreview(null);
    setCsv('');
    setMessage(`Saved: ${data.saved.added} new, ${data.saved.updated} updated, ${data.saved.same} already in.`);
    void load();
  };

  const mismatches = view?.shipments.filter((s) => s.codMismatch) ?? [];

  return (
    <div className="space-y-4" data-testid="courier-charges">
      <Card className="space-y-3">
        <h3 className="text-base font-bold text-ink">Jeebly: COD, payouts and charges</h3>
        <p className="text-sm text-ink-soft">
          What Jeebly says about each shipment: the cash it collected on delivery, what it paid out to you, and what it charged (each charge is a courier expense here, Courier &amp; delivery, once per AWB). From Jeebly&rsquo;s replies, which the shop checks every 15 minutes (past shipments too), and from the statement or COD report you upload below.
        </p>
        {view && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl bg-sand p-3">
              <dt className="text-ink-soft">COD collected by Jeebly</dt>
              <dd className="text-lg font-bold text-ink" data-testid="courier-cod-total">AED {aed(view.codFils)}</dd>
            </div>
            <div className="rounded-xl bg-sand p-3">
              <dt className="text-ink-soft">Paid out to you</dt>
              <dd className="text-lg font-bold text-ink" data-testid="courier-remitted-total">AED {aed(view.remittedFils)}</dd>
            </div>
            <div className="rounded-xl bg-sand p-3">
              <dt className="text-ink-soft">Still with Jeebly</dt>
              <dd className="text-lg font-bold text-ink" data-testid="courier-pending-total">AED {aed(view.pendingFils)}</dd>
            </div>
            <div className="rounded-xl bg-sand p-3">
              <dt className="text-ink-soft">Courier charges</dt>
              <dd className="text-lg font-bold text-ink" data-testid="courier-charges-total">
                AED {aed(view.totalFils)} <span className="text-sm font-normal text-ink-soft">({view.charged})</span>
              </dd>
            </div>
          </dl>
        )}
        {view && (
          <p className="text-xs text-ink-soft">
            {view.count} shipment{view.count === 1 ? '' : 's'} known; {view.waiting} still followed with Jeebly.{view.sync ? ` Last asked Jeebly: ${uaeTime(view.sync.at)}.` : ''}
          </p>
        )}
        {mismatches.length > 0 && (
          <p className="text-sm font-semibold text-danger flex items-start gap-1.5" role="alert" data-testid="courier-cod-mismatch">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              {mismatches.length} delivered shipment{mismatches.length === 1 ? '' : 's'} where Jeebly&rsquo;s COD differs from what the order should collect: {mismatches.slice(0, 5).map((m) => m.orderId ?? m.awb).join(', ')}. Check them with Jeebly.
            </span>
          </p>
        )}
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
            {preview.count} shipment{preview.count === 1 ? '' : 's'}: COD AED {aed(preview.codFils)}, paid out AED {aed(preview.remittedFils)}, charges AED {aed(preview.chargeFils)}. Read from the columns{' '}
            {Object.entries(preview.columns)
              .map(([k, v]) => `“${v}” (${COLUMN_NAMES[k] ?? k})`)
              .join(', ')}
            .{preview.skipped ? ` ${preview.skipped} row${preview.skipped === 1 ? '' : 's'} without an AWB or anything to read skipped.` : ''}
          </p>
          <div className="max-h-80 overflow-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-sand text-ink-soft">
                <tr>
                  <th className="text-start p-2">AWB</th>
                  <th className="text-start p-2">Order</th>
                  <th className="text-end p-2">COD</th>
                  <th className="text-end p-2">Paid out</th>
                  <th className="text-end p-2">Charge</th>
                  <th className="text-start p-2">Status</th>
                  <th className="text-start p-2">Saving it</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.awb} className="border-t border-line">
                    <td className="p-2 break-all">{r.awb}</td>
                    <td className="p-2">{r.orderId ?? '—'}</td>
                    <td className="p-2 text-end">{money(r.codFils)}</td>
                    <td className="p-2 text-end">{money(r.remittedFils)}</td>
                    <td className="p-2 text-end">{money(r.chargeFils)}</td>
                    <td className="p-2">{r.status ?? '—'}</td>
                    <td className="p-2">
                      {WHAT[r.what]}
                      {r.wasChargeFils !== undefined ? ` (charge was ${aed(r.wasChargeFils)})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryButton} onClick={() => void save()} disabled={busy !== '' || preview.count === 0} data-testid="courier-statement-save">
              Save {preview.count} shipment{preview.count === 1 ? '' : 's'}
            </button>
            <button type="button" className={secondaryButton} onClick={() => setPreview(null)} disabled={busy !== ''}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {view && view.shipments.length > 0 && (
        <Card className="space-y-2">
          <h3 className="text-base font-bold text-ink">Shipments</h3>
          <ul className="divide-y divide-line text-sm" data-testid="courier-shipments">
            {view.shipments.slice(0, 100).map((s) => (
              <li key={s.awb} className="py-2 space-y-0.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-ink break-all">{s.awb}</span>
                  <span className="shrink-0 text-xs text-ink-soft">{s.status ?? 'status not known yet'}</span>
                </div>
                <p className="text-xs text-ink-soft">
                  {s.orderId ?? 'not a shop order'}
                  {s.deliveredOn ? ` · delivered ${niceDate(s.deliveredOn)}` : ''}
                  {s.codFils !== null ? ` · COD AED ${aed(s.codFils)}` : ''}
                  {s.remittedFils !== null ? ` · paid out AED ${aed(s.remittedFils)}${s.remittedOn ? ` on ${niceDate(s.remittedOn)}` : ''}${s.remittanceRef ? ` (${s.remittanceRef})` : ''}` : s.codFils ? ' · not paid out yet' : ''}
                  {s.chargeFils !== null ? ` · charge AED ${aed(s.chargeFils)}` : ''}
                </p>
                {s.codMismatch && (
                  <p className="text-xs font-semibold text-danger">
                    The order should collect AED {money(s.expectedCodFils)}; Jeebly says AED {money(s.codFils)}.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
