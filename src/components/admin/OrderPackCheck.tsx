'use client';

import React, { useCallback, useRef, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { Order } from '@/types';
import { QrScanner } from './QrScanner';
import { lookUp } from './inventory/QrPanel';

/**
 * "Scan to check" on an order (asked by the owner: scan the sticker, "you will see you already have
 * the pictures of that article… and I ship it"): each sticker scanned is matched to the order's
 * lines, design and size; anything not in the order is flagged at once. Stock is not touched: the
 * order took it when it was placed. Checked here, on this phone.
 */
export function OrderPackCheck({ order, onClose }: { order: Order; onClose: () => void }) {
  const lines = order.items.filter((i) => i.productId);
  const [got, setGot] = useState<number[]>(() => lines.map(() => 0));
  const gotRef = useRef<number[]>(got);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const onScan = useCallback(
    (text: string) => {
      void lookUp(text).then((found) => {
        const it = found.item;
        if (!it) return setNote({ ok: false, text: found.message || 'Not a shop sticker.' });
        const counts = gotRef.current;
        const i = lines.findIndex((l, n) => l.productId === it.productId && (!it.sizeId || l.profileId === it.sizeId) && counts[n] < l.quantity);
        const name = `${it.title}${it.sizeName ? ` (${it.sizeName})` : ''}`;
        if (i < 0) {
          const inOrder = lines.some((l) => l.productId === it.productId && (!it.sizeId || l.profileId === it.sizeId));
          return setNote({ ok: false, text: inOrder ? `${name}: already checked, the order has no more of it.` : `Not in this order: ${name}. Put it back.` });
        }
        const next = counts.slice();
        next[i]++;
        gotRef.current = next;
        setGot(next);
        setNote({ ok: true, text: `${name}: matches.` });
      });
    },
    [lines]
  );
  const total = lines.reduce((n, l) => n + l.quantity, 0);
  const done = got.reduce((n, g) => n + g, 0);

  return (
    <div className="space-y-2" data-testid="pack-check">
      <QrScanner onScan={onScan} onClose={onClose} title={`Scan to check ${order.id}`} />
      {note && (
        <p role="status" data-testid="pack-note" className={`rounded-xl border p-2 text-xs font-semibold flex items-center gap-1.5 ${note.ok ? 'border-success-line bg-success-soft text-success' : 'border-danger-line bg-danger-soft text-danger'}`}>
          {note.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> : <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />} {note.text}
        </p>
      )}
      <ul className="text-xs space-y-1" data-testid="pack-lines">
        {lines.map((l, i) => (
          <li key={i} className={`flex items-center gap-2 ${got[i] >= l.quantity ? 'text-success font-semibold' : 'text-ink'}`}>
            {got[i] >= l.quantity ? <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> : <span className="w-4 h-4 shrink-0 rounded-full border border-line-strong" aria-hidden="true" />}
            <span className="min-w-0 break-anywhere">
              {got[i]} of {l.quantity} · {l.title} ({l.profileName})
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs font-bold" data-testid="pack-total">
        {lines.length === 0 ? 'This order has no shop items to check (an order from a photo).' : done === total ? `All ${total} ${total === 1 ? 'piece' : 'pieces'} checked: ready to pack.` : `${done} of ${total} checked.`}
      </p>
    </div>
  );
}
