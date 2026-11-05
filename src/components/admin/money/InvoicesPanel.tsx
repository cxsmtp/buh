'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';
import type { BulkPaidWith, Order } from '@/types';
import { getJson, postJson } from '@/lib/apiClient';
import { dubaiToday } from '@/lib/reportPeriods';
import { EMIRATES_LIST } from '@/lib/delivery';
import { OrderInvoice } from '../OrderInvoice';
import { aed, Card, inputClass, labelClass, niceDate, primaryButton, secondaryButton } from './moneyUi';

interface Row {
  orderId: string;
  number: string | null;
  date: string;
  customer: string;
  company?: string;
  total: number;
  paidWith: BulkPaidWith;
  status: Order['status'];
  order: Order;
}
interface Line {
  description: string;
  quantity: string;
  unitPrice: string;
}

const PAID: Array<[BulkPaidWith, string]> = [
  ['bank_transfer', 'Bank transfer'],
  ['cash', 'Cash'],
  ['card', 'Card'],
  ['cheque', 'Cheque'],
  ['unpaid', 'Not paid yet'],
];
const PAID_LABEL = Object.fromEntries(PAID) as Record<BulkPaidWith, string>;
/** One key per invoice being made (a retry returns the same invoice); random from the browser's crypto. */
const newKey = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
const blankLine = (): Line => ({ description: '', quantity: '1', unitPrice: '' });

/** "1,250.50" → fils, or null (the server checks it again). */
function filsOf(v: string): number | null {
  const t = v.replace(/,/g, '').trim();
  if (!t) return 0;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  const [w, d = ''] = t.split('.');
  return Number(w) * 100 + Number(d.padEnd(2, '0'));
}

/**
 * Money → Invoices: a bulk order received outside the shop (a hotel, a company, a reseller) is typed
 * in here (the customer, the lines, delivery and a discount, the date, how it was paid) and becomes
 * an invoice from exactly that data, counted in the sales (Reports and the hub's Sales). The list:
 * every bulk order with its invoice (open, email, WhatsApp, regenerate).
 */
export function InvoicesPanel({ readOnly = false }: { readOnly?: boolean }) {
  const id = useId();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  // One key per invoice being made: a retry or a double tap returns the same one.
  const key = useRef('');
  const [today] = useState(() => dubaiToday(Date.now()));
  const [c, setC] = useState({ fullName: '', company: '', trn: '', phone: '', email: '', emirate: 'Dubai', area: '', address: '' });
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [deliveryFee, setDeliveryFee] = useState('');
  const [discount, setDiscount] = useState('');
  const [date, setDate] = useState(today);
  const [paidWith, setPaidWith] = useState<BulkPaidWith>('bank_transfer');
  const [reference, setReference] = useState('');
  const [delivered, setDelivered] = useState(true);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    const { ok, data } = await getJson<{ invoices?: Row[]; message?: string }>('/api/admin/invoices');
    if (ok && data.invoices) setRows(data.invoices);
    else setError(data.message || 'Could not load the invoices.');
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load of an external list
    void load();
  }, [load]);

  // A preview of the total (the server works it out again, in fils).
  const totals = useMemo(() => {
    let sub = 0;
    let bad = false;
    for (const l of lines) {
      const u = filsOf(l.unitPrice);
      const q = Number(l.quantity);
      if (u === null || !Number.isInteger(q)) bad = true;
      else sub += u * Math.max(0, q);
    }
    const d = filsOf(deliveryFee);
    const x = filsOf(discount);
    if (d === null || x === null) bad = true;
    return { sub, total: sub + (d ?? 0) - (x ?? 0), bad };
  }, [lines, deliveryFee, discount]);

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    setError('');
    setSaved('');
    setBusy(true);
    if (!key.current) key.current = newKey();
    const { ok, data } = await postJson<{ order?: Order; invoice?: { number: string }; message?: string }>('/api/admin/invoices', {
      key: key.current,
      customer: c,
      lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: l.unitPrice })),
      deliveryFee,
      discount,
      date,
      paidWith,
      reference,
      delivered,
      note,
    });
    setBusy(false);
    if (!ok || !data.invoice) return setError(data.message || 'Not saved. Please check the fields and try again.');
    setSaved(`Invoice ${data.invoice.number} made: open, email or send it below.`);
    key.current = '';
    setC({ fullName: '', company: '', trn: '', phone: '', email: '', emirate: 'Dubai', area: '', address: '' });
    setLines([blankLine()]);
    setDeliveryFee('');
    setDiscount('');
    setDate(today);
    setReference('');
    setNote('');
    setOpen(false);
    void load();
  };

  const field = (k: keyof typeof c, label: string, opts: { type?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']; max?: number; required?: boolean; placeholder?: string } = {}) => (
    <div>
      <label className={labelClass} htmlFor={`${id}-${k}`}>
        {label}
        {opts.required ? '' : ' (optional)'}
      </label>
      <input id={`${id}-${k}`} className={inputClass} type={opts.type ?? 'text'} inputMode={opts.inputMode} maxLength={opts.max ?? 120} placeholder={opts.placeholder} value={c[k]} onChange={(e) => setC((x) => ({ ...x, [k]: e.target.value }))} />
    </div>
  );

  return (
    <div className="space-y-4" data-testid="invoices-panel">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold text-ink flex items-center gap-2">
            <FileText className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Bulk orders &amp; invoices
          </h3>
          {!readOnly && !open && (
            <button type="button" className={primaryButton} onClick={() => setOpen(true)} data-testid="bulk-new">
              <Plus className="w-4 h-4" aria-hidden="true" /> New bulk invoice
            </button>
          )}
        </div>
        <p className="text-sm text-ink-soft">For orders you take outside the shop (a hotel, a company, a reseller): type in the customer and the lines, and the invoice is made from exactly that. It counts in your sales (Reports). Stock doesn&rsquo;t change: if it left your stock, use Inventory → &ldquo;Sold offline&rdquo;.</p>
        {saved && (
          <p className="text-sm font-semibold text-success" role="status">
            {saved}
          </p>
        )}
      </Card>

      {open && !readOnly && (
        <Card className="space-y-4" data-testid="bulk-form">
          <fieldset className="space-y-3">
            <legend className="text-sm font-bold text-ink">Customer</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {field('fullName', 'Contact name', { required: true })}
              {field('company', 'Company')}
              {field('phone', 'Phone', { type: 'tel', inputMode: 'tel', max: 32, required: true, placeholder: '050 123 4567 or 04 123 4567' })}
              {field('email', 'Email', { type: 'email', inputMode: 'email', max: 254 })}
              {field('trn', 'Customer TRN', { inputMode: 'numeric', max: 20, placeholder: '15 digits' })}
              <div>
                <label className={labelClass} htmlFor={`${id}-emirate`}>
                  Emirate
                </label>
                <select id={`${id}-emirate`} className={inputClass} value={c.emirate} onChange={(e) => setC((x) => ({ ...x, emirate: e.target.value }))}>
                  {EMIRATES_LIST.map((e) => (
                    <option key={e}>{e}</option>
                  ))}
                </select>
              </div>
              {field('area', 'Area', { max: 100 })}
              {field('address', 'Address', { max: 300 })}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-bold text-ink">Items</legend>
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_5.5rem_7.5rem_auto] gap-2 items-end rounded-xl border border-line p-2 sm:border-0 sm:p-0" data-testid="bulk-line">
                <div className="col-span-2 sm:col-span-1">
                  <label className={labelClass} htmlFor={`${id}-d${i}`}>
                    Item {i + 1}
                  </label>
                  <input id={`${id}-d${i}`} className={inputClass} maxLength={160} placeholder="e.g. King fitted sheet, white percale" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:contents">
                  <div>
                    <label className={labelClass} htmlFor={`${id}-q${i}`}>
                      Qty
                    </label>
                    <input id={`${id}-q${i}`} className={inputClass} type="number" inputMode="numeric" min={1} step={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor={`${id}-u${i}`}>
                      Unit price (AED)
                    </label>
                    <input id={`${id}-u${i}`} className={inputClass} inputMode="decimal" placeholder="85.50" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                  </div>
                </div>
                <button type="button" className={`${secondaryButton} self-end`} aria-label={`Remove item ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            ))}
            <button type="button" className={secondaryButton} onClick={() => setLines((ls) => [...ls, blankLine()])} disabled={lines.length >= 50}>
              <Plus className="w-4 h-4" aria-hidden="true" /> Add item
            </button>
          </fieldset>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <label className={labelClass} htmlFor={`${id}-delivery`}>
                Delivery (AED)
              </label>
              <input id={`${id}-delivery`} className={inputClass} inputMode="decimal" placeholder="0" value={deliveryFee} onChange={(e) => setDeliveryFee(e.target.value)} />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${id}-discount`}>
                Discount (AED)
              </label>
              <input id={`${id}-discount`} className={inputClass} inputMode="decimal" placeholder="0" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${id}-date`}>
                Date of sale
              </label>
              <input id={`${id}-date`} className={inputClass} type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${id}-paid`}>
                Paid with
              </label>
              <select id={`${id}-paid`} className={inputClass} value={paidWith} onChange={(e) => setPaidWith(e.target.value as BulkPaidWith)}>
                {PAID.map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {paidWith !== 'unpaid' && (
              <div>
                <label className={labelClass} htmlFor={`${id}-ref`}>
                  Payment reference (optional)
                </label>
                <input id={`${id}-ref`} className={inputClass} maxLength={80} placeholder="Transfer or cheque number" value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
            )}
            <div>
              <label className={labelClass} htmlFor={`${id}-note`}>
                Note for you (optional, not on the invoice)
              </label>
              <input id={`${id}-note`} className={inputClass} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={delivered} onChange={(e) => setDelivered(e.target.checked)} className="w-5 h-5 accent-ink" /> Already delivered (otherwise it waits in Orders to be delivered)
          </label>

          <div className="rounded-xl bg-sand p-3 flex flex-wrap items-center justify-between gap-2" data-testid="bulk-total">
            <span className="text-sm text-ink-soft">{totals.bad ? 'Check the amounts (AED, at most 2 decimals).' : `Items AED ${aed(totals.sub)}`}</span>
            <strong className="text-lg text-ink">Total AED {aed(Math.max(0, totals.total))}</strong>
          </div>
          {error && (
            <p className="text-sm font-semibold text-danger" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryButton} onClick={() => void save()} disabled={busy || totals.bad} data-testid="bulk-save">
              {busy ? 'Making the invoice…' : 'Make invoice'}
            </button>
            <button type="button" className={secondaryButton} onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {rows && rows.length > 0 && (
        <div className="space-y-2" data-testid="bulk-list">
          {rows.map((r) => (
            <Card key={r.orderId} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0">
                  <strong className="text-ink">{r.company || r.customer}</strong>
                  <span className="block text-xs text-ink-soft">
                    {niceDate(dubaiToday(Date.parse(r.date)))} · {r.orderId} · {PAID_LABEL[r.paidWith]}
                    {r.status === 'cancelled' ? ' · cancelled' : ''}
                  </span>
                </span>
                <strong className="text-ink shrink-0">AED {aed(Math.round(r.total * 100))}</strong>
              </div>
              {readOnly ? (
                r.number && (
                  <a href={`/api/admin/orders/${encodeURIComponent(r.orderId)}/invoice-pdf`} target="_blank" rel="noopener noreferrer" className={`${secondaryButton} inline-flex`}>
                    Open {r.number} (PDF)
                  </a>
                )
              ) : (
                <OrderInvoice order={r.order} shopName="" />
              )}
            </Card>
          ))}
        </div>
      )}
      {rows && rows.length === 0 && !open && <p className="text-sm text-ink-soft">No bulk invoices yet.</p>}
      {!open && error && (
        <p className="text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
