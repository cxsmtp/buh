'use client';

import React, { useState } from 'react';
import { Loader2, Tag } from 'lucide-react';
import type { Product } from '@/types';
import { postJson } from '@/lib/apiClient';

/**
 * Inventory: "N products have no SKU — Fill them in". One press gives each of them an SKU made by
 * the shop (one audited step, src/lib/server/products.ts fillMissingSkus); SKUs already there are
 * never changed. Products without one also get one on their next save.
 */
export function FillSkusNotice({ products, onFilled }: { products: Array<Product & { archived?: boolean }>; onFilled: () => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const missing = products.filter((p) => !p.archived && !p.sku).length;
  // SKUs older data holds twice (ignoring case): both products still save; the owner changes one.
  const groups = new Map<string, Array<{ title: string; sku: string }>>();
  for (const p of products) if (p.sku) groups.set(p.sku.toUpperCase(), [...(groups.get(p.sku.toUpperCase()) ?? []), { title: p.title, sku: p.sku }]);
  const clashes = [...groups.values()].filter((g) => g.length > 1);
  if (!missing && !msg && !clashes.length) return null;
  return (
    <>
    {clashes.length > 0 && (
      <ul className="rounded-2xl border border-warning-line bg-warning-soft px-3 py-2.5 space-y-1 text-sm text-warning" data-testid="sku-clashes">
        {clashes.map((g) => (
          <li key={g[0].sku.toUpperCase()} className="break-words">
            {g.length} products share {g[0].sku}: change one ({g.map((x) => x.title).join(', ')})
          </li>
        ))}
      </ul>
    )}
    {(missing > 0 || msg) && (
    <div className="rounded-2xl border border-line-strong bg-surface px-3 py-2.5 flex flex-wrap items-center gap-2" data-testid="fill-skus">
      {missing > 0 && (
        <>
          <Tag className="w-4 h-4 text-gold-deep shrink-0" aria-hidden="true" />
          <span className="text-sm text-ink flex-1 min-w-0">
            {missing} {missing === 1 ? 'product has' : 'products have'} no SKU
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              const res = await postJson<{ filled?: number; message?: string }>('/api/admin/products/sku-fill', {});
              setBusy(false);
              setMsg(res.ok ? { ok: true, text: `SKUs given to ${res.data.filled ?? 0} ${res.data.filled === 1 ? 'product' : 'products'}.` } : { ok: false, text: res.data.message || 'Could not fill them in.' });
              if (res.ok) await onFilled();
            }}
            className="min-h-11 px-4 rounded-xl bg-ink text-paper text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Fill them in
          </button>
        </>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`w-full text-xs ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</p>}
    </div>
    )}
    </>
  );
}
