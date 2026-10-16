'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Product } from '@/types';
import { postJson } from '@/lib/apiClient';
import { newKey } from '@/lib/client/stock';

/**
 * Stock changes from the Admin Hub, one tap at a time, saved at once and safely:
 *
 *  - Optimistic: the number changes on the screen straight away; taps made within
 *    a moment are sent together (one change, one Undo).
 *  - One request at a time per product, each with what this device last saw
 *    (`expected`): if another phone or a sale changed it meanwhile the server
 *    refuses (409) and we say "Changed on another device: refresh" instead of
 *    overwriting anything.
 *  - Every request has its own idempotency key and a lost connection retries
 *    with the same key, so a retry can never move stock twice.
 *  - A saved change shows a toast with Undo (also checked, also once).
 */

export type StockReason = 'received' | 'sold_offline' | 'damaged' | 'correction';

export const REASONS: Array<{ id: StockReason; label: string }> = [
  { id: 'correction', label: 'Correction' },
  { id: 'sold_offline', label: 'Sold offline' },
  { id: 'damaged', label: 'Damaged' },
  { id: 'received', label: 'Received' },
];

type Op =
  | { kind: 'delta'; sizeId: string; delta: number }
  | { kind: 'set'; changes: Array<{ sizeId: string; value: number }> }
  | { kind: 'add'; changes: Array<{ sizeId: string; delta: number }> }
  | { kind: 'undo'; moveId: number };

interface Queued {
  key: string;
  op: Op;
  reason: StockReason;
  inFlight: boolean;
  note?: string;
}

export interface StockToast {
  id: number;
  kind: 'saved' | 'conflict' | 'error';
  text: string;
  productId: string;
  moveId?: number;
}

interface Move {
  id: number;
  reason: string;
  changes: Array<{ sizeId: string; from: number; to: number }>;
}

type Listed = Product & { archived?: boolean };

const RETRIES = [800, 2000, 4000];
const COALESCE_MS = 450;

export function useStockMoves({
  products,
  onProduct,
  onRefresh,
}: {
  products: Listed[];
  /** A product as the server now has it (after a saved change). */
  onProduct: (p: Product) => void;
  /** Reload everything (the conflict toast's Refresh). */
  onRefresh: () => void | Promise<void>;
}) {
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((n) => n + 1), []);
  const [toast, setToast] = useState<StockToast | null>(null);
  const queues = useRef(new Map<string, Queued[]>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const productsRef = useRef(products);
  // What the server answered last, until the page's list catches up (see confirmed()).
  const answered = useRef(new Map<string, { stock: Record<string, number>; listed: string }>());
  const cb = useRef({ onProduct, onRefresh });
  useEffect(() => {
    productsRef.current = products;
    cb.current = { onProduct, onRefresh };
  });
  const toastId = useRef(0);
  const show = useCallback((t: Omit<StockToast, 'id'>) => setToast({ ...t, id: ++toastId.current }), []);

  /**
   * The stock the server has confirmed for a product: its last answer, unless the list has moved
   * on since. While rendering, pass the product's stock from the list being rendered (the ref is
   * only brought up to date after the render).
   */
  const confirmed = useCallback((productId: string, listedNow?: Record<string, number>): Record<string, number> => {
    const listedStock = listedNow ?? productsRef.current.find((p) => p.id === productId)?.stockBySize ?? {};
    const a = answered.current.get(productId);
    if (a && a.listed === JSON.stringify(listedStock)) return a.stock;
    return listedStock;
  }, []);

  const label = useCallback((productId: string, sizeId: string) => {
    const p = productsRef.current.find((x) => x.id === productId);
    const s = p?.profiles.find((x) => x.id === sizeId);
    return (s?.badge || s?.name || sizeId).replace(/\s*\(.*\)\s*$/, '');
  }, []);

  const describe = useCallback(
    (productId: string, move: Move) => {
      const p = productsRef.current.find((x) => x.id === productId);
      const parts = move.changes.map((c) => `${label(productId, c.sizeId)} ${c.from} → ${c.to}`).join(', ');
      const title = p?.title ?? 'Product';
      return `${parts} · ${title.length > 28 ? `${title.slice(0, 27)}…` : title}`;
    },
    [label]
  );

  const drop = useCallback((productId: string) => {
    queues.current.set(productId, []);
    clearTimeout(timers.current.get(productId));
  }, []);

  // The next request in the queue (set below; lets send() call itself).
  const sendNext = useRef<(productId: string) => Promise<void>>(async () => {});
  const send = useCallback(
    async (productId: string): Promise<void> => {
      const q = queues.current.get(productId) ?? [];
      const item = q[0];
      if (!item || item.inFlight) return;
      if (item.op.kind === 'delta' && item.op.delta === 0) {
        q.shift();
        rerender();
        return sendNext.current(productId);
      }
      item.inFlight = true;
      const seen = confirmed(productId);
      let body: Record<string, unknown>;
      const op = item.op;
      if (op.kind === 'undo') body = { key: item.key, undo: op.moveId };
      else {
        const changes =
          op.kind === 'delta' ? [{ sizeId: op.sizeId, delta: op.delta }] : op.kind === 'add' ? op.changes.map((c) => ({ sizeId: c.sizeId, delta: c.delta })) : op.changes.map((c) => ({ sizeId: c.sizeId, set: c.value }));
        const expected = Object.fromEntries(changes.map((c) => [c.sizeId, seen[c.sizeId] ?? 0]));
        body = { key: item.key, reason: item.reason, changes, expected, ...(item.note ? { note: item.note } : {}) };
      }
      const url = `/api/admin/products/${encodeURIComponent(productId)}/stock`;
      let res = await postJson<{ move?: Move; product?: Product; message?: string; code?: string }>(url, body);
      // No answer (connection lost, server restarting): the same key again, so it can only happen once.
      for (let i = 0; i < RETRIES.length && (res.status === 0 || res.status >= 502); i++) {
        await new Promise((r) => setTimeout(r, RETRIES[i]));
        res = await postJson(url, body);
      }
      q.shift();
      if (res.ok && res.data.product && res.data.move) {
        answered.current.set(productId, { stock: res.data.product.stockBySize, listed: JSON.stringify(productsRef.current.find((p) => p.id === productId)?.stockBySize ?? {}) });
        cb.current.onProduct(res.data.product);
        const move = res.data.move;
        if (op.kind === 'undo') show({ kind: 'saved', productId, text: `Undone. ${describe(productId, move)}` });
        else show({ kind: 'saved', productId, moveId: move.id, text: `Saved. ${describe(productId, move)}` });
      } else if (res.status === 409 && (res.data.code === 'stock_changed' || res.data.code === 'key_reused' || res.data.code === 'already_undone')) {
        drop(productId);
        show({ kind: 'conflict', productId, text: res.data.code === 'already_undone' ? 'That change was already undone.' : 'Changed on another device: refresh to see the current numbers.' });
      } else {
        drop(productId);
        show({ kind: 'error', productId, text: res.status === 0 ? 'Not saved: no connection. Check it and try again.' : res.data.message || 'Not saved. Please try again.' });
      }
      rerender();
      if ((queues.current.get(productId) ?? []).length) await sendNext.current(productId);
    },
    [confirmed, describe, drop, rerender, show]
  );

  useEffect(() => {
    sendNext.current = send;
  }, [send]);

  const schedule = useCallback(
    (productId: string, delay: number) => {
      clearTimeout(timers.current.get(productId));
      timers.current.set(productId, setTimeout(() => void send(productId), delay));
    },
    [send]
  );

  const enqueue = useCallback(
    (productId: string, op: Op, reason: StockReason, note?: string) => {
      const q = queues.current.get(productId) ?? [];
      queues.current.set(productId, q);
      const last = q[q.length - 1];
      if (op.kind === 'delta' && last && !last.inFlight && last.op.kind === 'delta' && last.op.sizeId === op.sizeId && last.reason === reason) {
        last.op = { ...last.op, delta: last.op.delta + op.delta };
      } else {
        q.push({ key: newKey('s'), op, reason, inFlight: false, note });
      }
      rerender();
      schedule(productId, op.kind === 'delta' ? COALESCE_MS : 0);
    },
    [rerender, schedule]
  );

  /** What to show for one size: the confirmed number with the changes still on their way. */
  const shown = useCallback(
    (productId: string, sizeId: string, listedNow?: Record<string, number>): number => {
      let qty = confirmed(productId, listedNow)[sizeId] ?? 0;
      for (const { op } of queues.current.get(productId) ?? []) {
        if (op.kind === 'delta' && op.sizeId === sizeId) qty += op.delta;
        if (op.kind === 'add') qty += op.changes.find((c) => c.sizeId === sizeId)?.delta ?? 0;
        if (op.kind === 'set') {
          const c = op.changes.find((x) => x.sizeId === sizeId);
          if (c) qty = c.value;
        }
      }
      return Math.max(0, qty);
    },
    [confirmed]
  );

  const saving = (productId: string) => (queues.current.get(productId) ?? []).length > 0;

  // Leaving the page with taps still waiting: send them now rather than after the pause.
  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const [productId, timer] of t) {
        clearTimeout(timer);
        void send(productId);
      }
    };
  }, [send]);

  return {
    toast,
    dismiss: () => setToast(null),
    shown,
    saving,
    step: (productId: string, sizeId: string, delta: number, reason: StockReason) => {
      if (delta < 0 && shown(productId, sizeId) + delta < 0) return;
      enqueue(productId, { kind: 'delta', sizeId, delta }, reason);
    },
    setTo: (productId: string, sizeId: string, value: number, reason: StockReason) => {
      if (value === shown(productId, sizeId)) return;
      enqueue(productId, { kind: 'set', changes: [{ sizeId, value }] }, reason);
    },
    receive: (productId: string, changes: Array<{ sizeId: string; delta: number }>, note?: string) => {
      const real = changes.filter((c) => c.delta > 0);
      if (real.length) enqueue(productId, { kind: 'add', changes: real }, 'received', note);
    },
    soldOut: (productId: string, sizeIds: string[]) => {
      const changes = sizeIds.filter((s) => shown(productId, s) > 0).map((sizeId) => ({ sizeId, value: 0 }));
      if (changes.length) enqueue(productId, { kind: 'set', changes }, 'correction', 'marked sold out');
    },
    undo: (t: StockToast) => {
      if (!t.moveId) return;
      setToast(null);
      enqueue(t.productId, { kind: 'undo', moveId: t.moveId }, 'correction');
    },
    refresh: async () => {
      setToast(null);
      answered.current.clear();
      await cb.current.onRefresh();
    },
  };
}
