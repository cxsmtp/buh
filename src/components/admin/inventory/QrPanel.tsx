'use client';

import React, { useCallback, useState } from 'react';
import { FileText, QrCode, ScanLine } from 'lucide-react';
import { getJson } from '@/lib/apiClient';
import type { CatalogSettings } from '@/types';
import { QrScanner } from '../QrScanner';

export interface ScannedItem {
  productId: string;
  title: string;
  image: string;
  active: boolean;
  archived: boolean;
  code: string;
  sizeId?: string;
  sizeName?: string;
  stock?: number;
  sizes: Array<{ id: string; name: string; stock: number; code: string }>;
}
export interface Waiting {
  orderId: string;
  customer: string;
  status: string;
  quantity: number;
  sizeName: string;
}

/** Ask the server what a scanned sticker (or typed code) is. */
export async function lookUp(text: string): Promise<{ item?: ScannedItem; waiting?: Waiting[]; message?: string }> {
  const { ok, data } = await getJson<{ item?: ScannedItem; waiting?: Waiting[]; message?: string }>(`/api/admin/scan?code=${encodeURIComponent(text)}`);
  return ok ? data : { message: data.message || 'Not found.' };
}

/**
 * Inventory → QR stickers and Scan (asked by the owner): print a sticker for every piece in stock
 * (40 to an A4 sheet), or one per size; scan one with the phone to see the item, its stock and the
 * orders waiting for it.
 */
export function QrPanel({ catalog }: { catalog: CatalogSettings }) {
  const [open, setOpen] = useState<'' | 'print' | 'scan'>('');
  const [category, setCategory] = useState('');
  const [copies, setCopies] = useState<'stock' | 'one'>('stock');
  const [start, setStart] = useState('1');
  const [found, setFound] = useState<{ item?: ScannedItem; waiting?: Waiting[]; message?: string } | null>(null);
  const startN = Math.max(1, Math.min(40, Math.floor(Number(start) || 1)));
  const href = `/api/admin/qr-stickers?${new URLSearchParams({ ...(category ? { category } : {}), copies, start: String(startN) }).toString()}`;
  const onScan = useCallback((text: string) => {
    void lookUp(text).then(setFound);
  }, []);
  const btn = 'min-h-11 px-3 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold';
  const field = 'min-h-10 px-2 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold';

  return (
    <section aria-label="QR stickers" className="space-y-2" data-testid="qr-panel">
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-expanded={open === 'print'} onClick={() => setOpen(open === 'print' ? '' : 'print')} className={`${btn} ${open === 'print' ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink border-line-strong'}`}>
          <QrCode className="w-4 h-4" aria-hidden="true" /> QR stickers
        </button>
        <button
          type="button"
          aria-expanded={open === 'scan'}
          onClick={() => {
            setFound(null);
            setOpen(open === 'scan' ? '' : 'scan');
          }}
          className={`${btn} ${open === 'scan' ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink border-line-strong'}`}
        >
          <ScanLine className="w-4 h-4" aria-hidden="true" /> Scan an item
        </button>
      </div>

      {open === 'print' && (
        <div className="rounded-2xl border border-line bg-surface p-3 space-y-2 text-xs" data-testid="qr-print">
          <p className="text-ink-soft">
            A4, 40 stickers a sheet (4 across, 10 down, 52.5 × 29.7 mm: the common ready-made sticker sheet). Each has a QR code and the stock code; any phone camera opens the item in the shop, and <strong>Scan an item</strong> here shows it with its stock. Print at 100% (actual size).
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="font-semibold text-ink">Which items</span>
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={field} data-testid="qr-category">
                <option value="">The whole inventory</option>
                {catalog.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-semibold text-ink">How many</span>
              <select value={copies} onChange={(e) => setCopies(e.target.value === 'one' ? 'one' : 'stock')} className={field} data-testid="qr-copies">
                <option value="stock">One per piece in stock</option>
                <option value="one">One per design and size</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-semibold text-ink">Start at sticker</span>
              <input type="number" inputMode="numeric" min={1} max={40} value={start} onChange={(e) => setStart(e.target.value)} className={`${field} w-20`} data-testid="qr-start" />
            </label>
            <a href={href} target="_blank" rel="noopener" data-testid="qr-pdf" className={`${btn} bg-ink text-paper border-ink`}>
              <FileText className="w-4 h-4" aria-hidden="true" /> Sticker sheets (PDF)
            </a>
          </div>
          <p className="text-ink-muted">Start at sticker: on a sheet already partly used, the number of the first free sticker (counted across, 1 to 40).</p>
        </div>
      )}

      {open === 'scan' && (
        <div className="space-y-2">
          <QrScanner onScan={onScan} onClose={() => setOpen('')} title="Scan an item" />
          {found && <ScanResult found={found} />}
        </div>
      )}
    </section>
  );
}

export function ScanResult({ found }: { found: { item?: ScannedItem; waiting?: Waiting[]; message?: string } }) {
  if (!found.item) {
    return (
      <p role="alert" className="rounded-xl border border-danger-line bg-danger-soft p-2.5 text-xs font-semibold text-danger">
        {found.message}
      </p>
    );
  }
  const it = found.item;
  return (
    <div role="status" data-testid="scan-result" className="rounded-xl border border-line bg-ivory p-2.5 text-xs flex gap-3 min-w-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {it.image ? <img src={it.image} alt="" className="w-16 h-16 rounded-lg object-cover shrink-0 border border-line" /> : <span className="w-16 h-16 rounded-lg bg-sand shrink-0" aria-hidden="true" />}
      <div className="min-w-0 space-y-1">
        <p className="font-bold text-ink break-anywhere">{it.title}</p>
        <p className="font-mono text-ink-soft break-anywhere">{it.code}</p>
        {it.sizeName ? (
          <p>
            <strong className="text-ink">{it.sizeName}</strong> · {it.stock} in stock
          </p>
        ) : (
          <p className="text-ink-soft">{it.sizes.map((s) => `${s.name}: ${s.stock}`).join(' · ')}</p>
        )}
        {(it.archived || !it.active) && <p className="text-warning font-semibold">{it.archived ? 'Removed from the shop' : 'Hidden from the shop'}</p>}
        {found.waiting && found.waiting.length > 0 ? (
          <p className="text-ink">
            Waiting for it: {found.waiting.map((w) => `${w.orderId} (${w.customer}, ${w.quantity}× ${w.sizeName})`).join('; ')}
          </p>
        ) : (
          <p className="text-ink-muted">No open order is waiting for it.</p>
        )}
      </div>
    </div>
  );
}
