'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  CheckSquare,
  ChevronDown,
  Link2,
  Copy,
  Edit3,
  ImagePlus,
  Eye,
  EyeOff,
  History,
  Minus,
  Package,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Undo2,
  X,
  XCircle,
} from 'lucide-react';
import type { CatalogSettings, Product } from '@/types';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { DEFAULT_LOW_STOCK, isLow, isSoldOut, newKey, shortSizeName, stockAlerts, stockLevel, type StockLevel } from '@/lib/client/stock';
import { Sheet } from '@/components/common/Sheet';
import { ProductEditor } from './inventory/ProductEditor';
import { CollectionsSheet, ShareSelectionSheet } from './inventory/Collections';
import { PictureStudioSheet } from './inventory/PictureStudioSheet';
import { REASONS, useStockMoves, type StockReason } from './inventory/useStockMoves';
import { FillSkusNotice } from './inventory/FillSkusNotice';
import { AutoJobsList, QuickAdd, useAutoJobs } from './inventory/QuickAdd';
import { visibleJobs } from '@/lib/client/autoJobs';

/**
 * Inventory, made for the owner's phone: find a product (name or SKU, filters for
 * low, sold out, hidden, category), see every size's stock as coloured chips, and
 * change it with big − / + buttons or by typing the number. Each change is saved
 * at once (with Undo), checked against what the server has (another phone, a sale)
 * and recorded with who, why and old → new. "Received stock" adds to several sizes
 * at once. Quick actions: hide or show, sold out, duplicate (a colour variant),
 * share the link, edit, history, move, remove.
 */

type AdminProduct = Product & { archived?: boolean };
type Filter = 'all' | 'low' | 'sold-out' | 'hidden' | 'archived';

interface AdminInventoryTabProps {
  products: AdminProduct[];
  catalog: CatalogSettings;
  /** Reload products (after any change). */
  onChanged: () => Promise<void> | void;
  /** One product as the server now has it (a saved stock change): shown at once. */
  onProductUpdated?: (p: Product) => void;
  /** Open the editor for a new product straight away (the "+ Add" tab). */
  startAdding?: boolean;
  /** Opens a Settings section (the Picture studio's setup steps link to Settings → AI pictures). */
  onOpenSettings?: (id: string) => void;
}

const CHIP: Record<StockLevel, string> = {
  out: 'bg-danger-soft text-danger border-danger-line',
  low: 'bg-warning-soft text-warning border-warning-line',
  ok: 'bg-success-soft text-success border-success-line',
};
const LEVEL_WORD: Record<StockLevel, string> = { out: 'sold out', low: 'low', ok: 'in stock' };

const actionBtn = 'min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40';
const actionDanger = 'min-h-11 px-3 rounded-xl border border-danger-line bg-surface text-danger text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40';
const actionIcon = 'min-h-11 w-11 rounded-xl border border-line-strong bg-surface text-ink inline-flex items-center justify-center disabled:opacity-40';
const actionPrimary = 'min-h-11 px-3 rounded-xl border border-ink bg-ink text-paper text-xs font-semibold inline-flex items-center justify-center gap-1.5';

export const AdminInventoryTab: React.FC<AdminInventoryTabProps> = ({ products, catalog, onChanged, onProductUpdated, startAdding = false, onOpenSettings }) => {
  const [editing, setEditing] = useState<AdminProduct | 'new' | null>(null);
  // Add product: the basics only, the AI does the rest (the full editor is one tap away).
  const [quick, setQuick] = useState(startAdding);
  // Products the AI is still writing or picturing: shown at the top while there are any.
  const auto = useAutoJobs(!quick && !editing, () => void onChanged());
  const openProduct = (id: string) => {
    const p = products.find((x) => x.id === id);
    if (p) {
      setQuick(false);
      setEditing(p);
    }
  };
  // Inventory → Make pictures: the Picture studio for one product.
  const [studio, setStudio] = useState<AdminProduct | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [category, setCategory] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [reason, setReason] = useState<StockReason>('correction');
  const [receiving, setReceiving] = useState<AdminProduct | null>(null);
  const [history, setHistory] = useState<AdminProduct | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  // Several products on one shareable page: Select (on a phone; checkboxes show on wider screens), then Share these.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [sharing, setSharing] = useState<AdminProduct[] | null>(null);
  const [links, setLinks] = useState(false);
  const pick = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : list.length >= 60 ? list : [...list, id]));
  const low = Number.isInteger(catalog.lowStockThreshold) ? catalog.lowStockThreshold : DEFAULT_LOW_STOCK;

  const stock = useStockMoves({
    products,
    onProduct: (p) => (onProductUpdated ? onProductUpdated(p) : void onChanged()),
    onRefresh: onChanged,
  });

  // What the owner sees: the confirmed stock plus taps still on their way.
  const view = useMemo(
    () => products.map((p) => ({ ...p, stockBySize: Object.fromEntries(p.profiles.map((s) => [s.id, stock.shown(p.id, s.id, p.stockBySize)])) })),
    // stock.shown changes with every tap (re-render); products with every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [products, stock.shown, stock.toast, stock.saving]
  );
  const live = view.filter((p) => !p.archived);
  const alerts = stockAlerts(view, low);
  const counts: Record<Filter, number> = {
    all: live.length,
    low: alerts.low.length,
    'sold-out': alerts.soldOut.length,
    hidden: live.filter((p) => p.active === false).length,
    archived: view.filter((p) => p.archived).length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return view
      .filter((p) => (filter === 'archived' ? p.archived : !p.archived))
      .filter((p) => (filter === 'low' ? p.active !== false && isLow(p, low) : filter === 'sold-out' ? p.active !== false && isSoldOut(p) : filter === 'hidden' ? p.active === false : true))
      .filter((p) => !category || p.category === category)
      .filter((p) => !q || [p.title, p.sku ?? '', p.id, p.material].some((x) => x.toLowerCase().includes(q)));
  }, [view, filter, query, category, low]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (id: string, call: () => Promise<{ ok: boolean; data: { message?: string } }>, done?: string) => {
    setBusy(id);
    setNotice(null);
    const { ok, data } = await call();
    setBusy(null);
    setNotice(ok ? (done ? { text: done } : null) : { text: data.message || 'Could not save that change.', error: true });
    await onChanged();
    return ok;
  };

  const toggleVisible = (p: AdminProduct) =>
    run(p.id, () => sendJson('PATCH', `/api/admin/products/${encodeURIComponent(p.id)}`, { product: { active: p.active === false } }), p.active === false ? `${p.title} is shown in the shop.` : `${p.title} is hidden from the shop.`);
  const archive = (p: AdminProduct, archived: boolean) => {
    if (archived && !window.confirm(`Remove "${p.title}" from the shop? It stays in past orders, and you can restore it under "Removed".`)) return;
    return run(p.id, () => postJson(`/api/admin/products/${encodeURIComponent(p.id)}/archive`, { archived }));
  };
  const duplicate = async (p: AdminProduct) => {
    const key = newKey('d');
    setBusy(p.id);
    const res = await postJson<{ product?: AdminProduct; message?: string }>(`/api/admin/products/${encodeURIComponent(p.id)}/duplicate`, { key });
    setBusy(null);
    await onChanged();
    if (!res.ok || !res.data.product) return setNotice({ text: res.data.message || 'Could not copy the product.', error: true });
    setNotice({ text: `Copied as “${res.data.product.title}” (hidden, no stock). Change its photos and colour, then show it.` });
    setEditing(res.data.product);
  };
  const share = async (p: AdminProduct) => {
    const url = `${window.location.origin}/p/${encodeURIComponent(p.id)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: p.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setNotice({ text: `Link copied: ${url}` });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // the owner closed the share sheet
      setNotice({ text: `Copy this link: ${url}` });
    }
  };
  const move = (p: AdminProduct, dir: -1 | 1) => {
    const ids = products.map((x) => x.id);
    const i = ids.indexOf(p.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return run(p.id, () => sendJson('PUT', '/api/admin/products/order', { ids }));
  };

  const categoryLabel = (id: string) => catalog.categories.find((c) => c.id === id)?.label ?? id;
  const filters: Array<[Filter, string]> = [
    ['all', 'All'],
    ['low', 'Low'],
    ['sold-out', 'Sold out'],
    ['hidden', 'Hidden'],
    ['archived', 'Removed'],
  ];

  return (
    <div className="space-y-3 pb-24 sm:pb-6">
      <div className="flex items-center gap-2">
        <h2 className="font-serif font-bold text-lg text-ink flex items-center gap-2">
          <Package className="w-5 h-5 text-gold-deep" aria-hidden="true" /> Inventory
        </h2>
        <button type="button" onClick={() => setQuick(true)} className="ml-auto min-h-11 px-4 rounded-xl bg-ink text-paper text-sm font-bold flex items-center gap-1.5">
          <Plus className="w-4 h-4" aria-hidden="true" /> Add product
        </button>
      </div>
      {auto.status && visibleJobs(auto.status.jobs, 'inventory').length > 0 && (
        <section className="space-y-2 rounded-2xl border border-line bg-sand p-3" aria-label="Being made by AI">
          <h3 className="text-sm font-bold text-ink">Being made by AI</h3>
          <AutoJobsList jobs={visibleJobs(auto.status.jobs, 'inventory').slice(0, 6)} onOpen={openProduct} onDismiss={(id) => void auto.dismiss(id).then(() => onChanged())} />
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setSelecting((x) => !x);
            if (selecting) setPicked([]);
          }}
          aria-pressed={selecting}
          className={`min-h-11 px-3 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 ${selecting ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink border-line-strong'}`}
        >
          <CheckSquare className="w-4 h-4" aria-hidden="true" /> {selecting ? 'Done selecting' : 'Select to share'}
        </button>
        <button type="button" onClick={() => setLinks(true)} className={actionBtn}>
          <Link2 className="w-4 h-4" aria-hidden="true" /> Shared links
        </button>
      </div>

      {(alerts.soldOut.length > 0 || alerts.low.length > 0) && (
        <div className="grid grid-cols-2 gap-2" aria-label="Stock alerts" role="group">
          <button type="button" onClick={() => setFilter('sold-out')} className="min-h-14 rounded-2xl border border-danger-line bg-danger-soft text-danger px-3 py-2 text-left">
            <span className="block text-xl font-bold leading-tight">{alerts.soldOut.length}</span>
            <span className="text-xs font-semibold">sold out</span>
          </button>
          <button type="button" onClick={() => setFilter('low')} className="min-h-14 rounded-2xl border border-warning-line bg-warning-soft text-warning px-3 py-2 text-left">
            <span className="block text-xl font-bold leading-tight">{alerts.low.length}</span>
            <span className="text-xs font-semibold">running low (≤ {low} left)</span>
          </button>
        </div>
      )}

      <FillSkusNotice products={products} onFilled={onChanged} />

      {/* Search and filters stay at the top while the list scrolls. */}
      <div className="sticky top-0 z-20 -mx-3 px-3 sm:mx-0 sm:px-0 py-2 bg-ivory space-y-2">
        <label className="relative block">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or SKU"
            aria-label="Search name or SKU"
            className="w-full min-h-11 pl-9 pr-3 rounded-xl border border-line-strong bg-surface text-sm"
          />
        </label>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar sm:flex-wrap" role="group" aria-label="Show">
          {filters.map(([id, name]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              aria-pressed={filter === id}
              className={`shrink-0 min-h-11 px-3.5 rounded-full border text-xs font-semibold ${filter === id ? 'bg-ink text-paper border-ink' : 'bg-surface border-line-strong text-ink'}`}
            >
              {name} <span className={filter === id ? 'text-paper' : 'text-ink-soft'}>{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <label className="min-w-0 text-[11px] font-semibold text-ink-soft sm:w-60">
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-0.5 w-full min-h-11 px-2 rounded-xl border border-line-strong bg-surface text-sm font-normal text-ink">
              <option value="">All categories</option>
              {catalog.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-[11px] font-semibold text-ink-soft sm:w-60" title="Recorded with each − / + change and typed number">
            Reason for − / +
            <select value={reason} onChange={(e) => setReason(e.target.value as StockReason)} className="mt-0.5 w-full min-h-11 px-2 rounded-xl border border-line-strong bg-surface text-sm font-normal text-ink">
              {REASONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {shown.length === 0 && <p className="text-center text-sm text-ink-soft py-10 bg-surface rounded-2xl border border-line">Nothing here.</p>}

      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 lg:items-start">
        {shown.map((p) => {
          const isOpen = open.has(p.id);
          const panelId = `inv-${p.id}`;
          return (
            <li key={p.id} className={`bg-surface rounded-2xl border ${p.archived ? 'border-line opacity-80' : picked.includes(p.id) ? 'border-ink ring-1 ring-ink' : 'border-line'} overflow-hidden`}>
              <div className="flex">
              {!p.archived && (
                <label className={`${selecting ? 'flex' : 'hidden sm:flex'} items-center pl-2.5 shrink-0 cursor-pointer`}>
                  <input type="checkbox" className="w-5 h-5" checked={picked.includes(p.id)} onChange={() => pick(p.id)} aria-label={`Select ${p.title} to share`} />
                </label>
              )}
              <button
                type="button"
                onClick={() => (selecting && !p.archived ? pick(p.id) : toggle(p.id))}
                aria-expanded={selecting ? undefined : isOpen}
                aria-controls={selecting ? undefined : panelId}
                aria-label={selecting && !p.archived ? `${picked.includes(p.id) ? 'Unselect' : 'Select'} ${p.title}` : `Stock and actions for ${p.title}`}
                className="w-full min-w-0 flex gap-3 p-2.5 text-left"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.featuredImage} alt="" className="w-14 h-14 rounded-xl object-cover bg-sand shrink-0" loading="lazy" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-start gap-1">
                    <span className="font-bold text-sm text-ink truncate flex-1">{p.title}</span>
                    <ChevronDown className={`w-4 h-4 shrink-0 text-ink-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  </span>
                  <span className="block text-[11px] text-ink-soft truncate">
                    AED {p.price} · {categoryLabel(p.category)}
                    {p.sku && <> · {p.sku}</>}
                    {p.active === false && !p.archived && <strong className="ml-1 text-ink">· hidden</strong>}
                    {!p.archived && isSoldOut(p) && <strong className="ml-1 text-danger">· sold out</strong>}
                  </span>
                  {p.measurementsReview && !p.archived && (
                    <span className="mt-1 inline-block px-1.5 py-0.5 rounded-md border border-warning-line bg-warning-soft text-[11px] font-semibold text-ink" title="Measurements carried over from the standard sizes: open Edit → Sizes, keep only what this set includes, and save.">
                      Check measurements
                    </span>
                  )}
                  {!p.archived && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {p.profiles.map((s) => {
                        const qty = p.stockBySize[s.id] ?? 0;
                        const level = stockLevel(qty, low);
                        return (
                          <span key={s.id} className={`px-1.5 py-0.5 rounded-md border text-[11px] font-semibold whitespace-nowrap ${CHIP[level]}`} title={`${s.name}: ${qty} (${LEVEL_WORD[level]})`}>
                            {shortSizeName(s)} {qty}
                          </span>
                        );
                      })}
                      {stock.saving(p.id) && <span className="text-[11px] text-ink-soft">saving…</span>}
                    </span>
                  )}
                </span>
              </button>
              </div>

              {isOpen && (
                <div id={panelId} className="border-t border-line px-2.5 pb-3 pt-2 space-y-3">
                  {!p.archived && (
                    <ul className="space-y-1.5" aria-label={`Stock of ${p.title} per size`}>
                      {p.profiles.map((s) => (
                        <SizeStepper
                          key={s.id}
                          name={s.name}
                          short={shortSizeName(s)}
                          qty={p.stockBySize[s.id] ?? 0}
                          level={stockLevel(p.stockBySize[s.id] ?? 0, low)}
                          onStep={(d) => stock.step(p.id, s.id, d, reason)}
                          onSet={(v) => stock.setTo(p.id, s.id, v, reason)}
                        />
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {p.archived ? (
                      <button type="button" onClick={() => void archive(p, false)} disabled={busy === p.id} className={actionBtn}>
                        <ArchiveRestore className="w-4 h-4" aria-hidden="true" /> Restore (hidden)
                      </button>
                    ) : (
                      <>
                        <button type="button" onClick={() => setReceiving(p)} className={actionPrimary} aria-label={`Received stock for ${p.title}`}>
                          <PackagePlus className="w-4 h-4" aria-hidden="true" /> Received stock
                        </button>
                        <button type="button" onClick={() => setEditing(p)} className={actionBtn} aria-label={`Edit ${p.title}`}>
                          <Edit3 className="w-4 h-4" aria-hidden="true" /> Edit
                        </button>
                        <button type="button" onClick={() => setStudio(p)} className={actionBtn} aria-label={`Make pictures of ${p.title}`}>
                          <ImagePlus className="w-4 h-4" aria-hidden="true" /> Make pictures
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleVisible(p)}
                          disabled={busy === p.id}
                          className={actionBtn}
                          title={p.active === false ? 'Hidden from the shop: click to show' : 'Shown in the shop: click to hide'}
                        >
                          {p.active === false ? (
                            <>
                              <Eye className="w-4 h-4" aria-hidden="true" /> Show in shop
                            </>
                          ) : (
                            <>
                              <EyeOff className="w-4 h-4" aria-hidden="true" /> Hide
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => stock.soldOut(p.id, p.profiles.map((s) => s.id))}
                          disabled={isSoldOut(p)}
                          className={actionBtn}
                          aria-label={`Sold out: set every size of ${p.title} to 0`}
                        >
                          <XCircle className="w-4 h-4" aria-hidden="true" /> Sold out
                        </button>
                        <button type="button" onClick={() => void duplicate(p)} disabled={busy === p.id} className={actionBtn} aria-label={`Duplicate ${p.title} (for another colour)`}>
                          <Copy className="w-4 h-4" aria-hidden="true" /> Duplicate
                        </button>
                        <button type="button" onClick={() => void share(p)} className={actionBtn} aria-label={`Share the link to ${p.title}`}>
                          <Share2 className="w-4 h-4" aria-hidden="true" /> Share
                        </button>
                        <button type="button" onClick={() => setHistory(p)} className={actionBtn} aria-label={`Stock history of ${p.title}`}>
                          <History className="w-4 h-4" aria-hidden="true" /> History
                        </button>
                        <button type="button" onClick={() => void move(p, -1)} disabled={busy === p.id} className={actionIcon} aria-label={`Move ${p.title} up`}>
                          <ArrowUp className="w-4 h-4" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => void move(p, 1)} disabled={busy === p.id} className={actionIcon} aria-label={`Move ${p.title} down`}>
                          <ArrowDown className="w-4 h-4" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => void archive(p, true)} disabled={busy === p.id} className={actionDanger}>
                          <Archive className="w-4 h-4" aria-hidden="true" /> Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* Saved / Undo / conflict messages, above the bottom bar. */}
      <div className="fixed inset-x-0 bottom-[4.75rem] sm:bottom-20 z-[45] px-3 pointer-events-none flex flex-col items-center gap-2" role="status" aria-live="polite">
        {picked.length > 0 && (
          <div className="pointer-events-auto w-full max-w-md rounded-2xl shadow-lg px-3 py-2 flex items-center gap-2 text-sm bg-ink text-paper" data-testid="selection-bar">
            <span className="flex-1 min-w-0 truncate">
              {picked.length} selected
            </span>
            <button type="button" onClick={() => setPicked([])} className="min-h-11 px-3 rounded-xl font-semibold">
              Clear
            </button>
            <button type="button" onClick={() => setSharing(picked.map((id) => products.find((p) => p.id === id)).filter((p): p is AdminProduct => Boolean(p)))} className="min-h-11 px-3 rounded-xl bg-paper text-ink font-bold flex items-center gap-1">
              <Share2 className="w-4 h-4" aria-hidden="true" /> Share these
            </button>
          </div>
        )}
        {stock.toast && (
          <div
            key={stock.toast.id}
            className={`pointer-events-auto w-full max-w-md rounded-2xl shadow-lg px-3 py-2 flex items-center gap-2 text-sm ${
              stock.toast.kind === 'saved' ? 'bg-ink text-paper' : stock.toast.kind === 'conflict' ? 'bg-warning-soft text-warning border border-warning-line' : 'bg-danger-soft text-danger border border-danger-line'
            }`}
          >
            <span className="flex-1 min-w-0 line-clamp-2">{stock.toast.text}</span>
            {stock.toast.kind === 'saved' && stock.toast.moveId && (
              <button type="button" onClick={() => stock.undo(stock.toast!)} className="min-h-11 px-3 rounded-xl bg-surface/15 font-bold flex items-center gap-1">
                <Undo2 className="w-4 h-4" aria-hidden="true" /> Undo
              </button>
            )}
            {stock.toast.kind === 'conflict' && (
              <button type="button" onClick={() => void stock.refresh()} className="min-h-11 px-3 rounded-xl bg-surface font-bold flex items-center gap-1 border border-warning-line">
                <RefreshCw className="w-4 h-4" aria-hidden="true" /> Refresh
              </button>
            )}
            <button type="button" onClick={stock.dismiss} className="min-h-11 min-w-11 flex items-center justify-center rounded-xl" aria-label="Dismiss">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {notice && (
          <div className={`pointer-events-auto w-full max-w-md rounded-2xl shadow-lg px-3 py-2 flex items-center gap-2 text-sm ${notice.error ? 'bg-danger-soft text-danger border border-danger-line' : 'bg-surface text-ink border border-line-strong'}`}>
            <span className="flex-1 min-w-0 break-words">{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} className="min-h-11 min-w-11 flex items-center justify-center rounded-xl" aria-label="Dismiss message">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {receiving && (
        <ReceiveSheet
          product={receiving}
          shown={(sizeId) => stock.shown(receiving.id, sizeId, products.find((x) => x.id === receiving.id)?.stockBySize)}
          onClose={() => setReceiving(null)}
          onReceive={(changes, note) => {
            stock.receive(receiving.id, changes, note);
            setReceiving(null);
          }}
        />
      )}
      {history && <HistorySheet product={history} onClose={() => setHistory(null)} />}
      {sharing && (
        <ShareSelectionSheet
          products={sharing}
          onClose={() => setSharing(null)}
          onCreated={() => {
            setPicked([]);
            setSelecting(false);
          }}
        />
      )}
      {links && <CollectionsSheet products={products} onClose={() => setLinks(false)} />}
      {studio && (
        <PictureStudioSheet
          product={studio}
          onClose={() => {
            setStudio(null);
            void onChanged();
          }}
          onSaved={(p) => (onProductUpdated ? onProductUpdated(p) : void onChanged())}
          onOpenSettings={onOpenSettings ? () => onOpenSettings('ai-pictures') : undefined}
        />
      )}

      {quick && (
        <QuickAdd
          catalog={catalog}
          onClose={() => {
            setQuick(false);
            void onChanged();
          }}
          onAdded={() => void onChanged()}
          onFullEditor={() => {
            setQuick(false);
            setEditing('new');
          }}
          onOpenProduct={openProduct}
          onSettled={() => void onChanged()}
        />
      )}
      {editing && (
        <ProductEditor
          product={editing === 'new' ? null : editing}
          catalog={catalog}
          onOpenSettings={onOpenSettings}
          onClose={() => {
            setEditing(null);
            void onChanged();
          }}
          onSaved={(saved) => {
            setEditing(null);
            setNotice({ text: `${saved.title} is saved${saved.active === false ? ' (hidden)' : ' and in the shop'}.` });
            void onChanged();
          }}
        />
      )}
    </div>
  );
};

/** One size: big − / + and the number, which can be tapped to type. */
function SizeStepper({ name, short, qty, level, onStep, onSet }: { name: string; short: string; qty: number; level: StockLevel; onStep: (d: number) => void; onSet: (v: number) => void }) {
  const [typing, setTyping] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const commit = () => {
    if (typing === null) return;
    const v = Number(typing);
    setTyping(null);
    if (typing.trim() !== '' && Number.isInteger(v) && v >= 0 && v <= 100_000) onSet(v);
  };
  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-ink truncate">{short}</span>
        <span className={`text-[11px] font-semibold ${level === 'out' ? 'text-danger' : level === 'low' ? 'text-warning' : 'text-success'}`}>{LEVEL_WORD[level]}</span>
      </span>
      <button type="button" onClick={() => onStep(-1)} disabled={qty <= 0} className="w-12 h-12 rounded-xl border border-line-strong bg-surface flex items-center justify-center disabled:opacity-30 active:bg-sand" aria-label={`One fewer ${name}`}>
        <Minus className="w-5 h-5" aria-hidden="true" />
      </button>
      {typing === null ? (
        <button
          type="button"
          onClick={() => {
            setTyping(String(qty));
            setTimeout(() => input.current?.select(), 0);
          }}
          className={`w-16 h-12 rounded-xl border-2 text-lg font-bold tabular-nums ${CHIP[level]}`}
          aria-label={`${name}: ${qty} in stock. Tap to type the number`}
        >
          {qty}
        </button>
      ) : (
        <input
          ref={input}
          autoFocus
          type="number"
          inputMode="numeric"
          min={0}
          max={100000}
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setTyping(null);
            }
          }}
          className="w-16 h-12 rounded-xl border-2 border-ink text-lg font-bold text-center tabular-nums bg-surface"
          aria-label={`Pieces of ${name} in stock`}
        />
      )}
      <button type="button" onClick={() => onStep(1)} className="w-12 h-12 rounded-xl border border-line-strong bg-surface flex items-center justify-center active:bg-sand" aria-label={`One more ${name}`}>
        <Plus className="w-5 h-5" aria-hidden="true" />
      </button>
    </li>
  );
}

/** "Received stock": how many arrived of each size, added in one go. */
function ReceiveSheet({ product, shown, onClose, onReceive }: { product: AdminProduct; shown: (sizeId: string) => number; onClose: () => void; onReceive: (changes: Array<{ sizeId: string; delta: number }>, note?: string) => void }) {
  const titleId = useId();
  const [add, setAdd] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const total = Object.values(add).reduce((a, b) => a + b, 0);
  const bump = (id: string, d: number) => setAdd((a) => ({ ...a, [id]: Math.max(0, Math.min(1000, (a[id] ?? 0) + d)) }));
  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="bottom">
      <div className="px-4 pt-4 pb-2 flex items-start gap-2 border-b border-line">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-serif font-bold text-base text-ink">
            Received stock
          </h3>
          <p className="text-xs text-ink-soft truncate">{product.title}</p>
        </div>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-y-auto px-4 py-3 space-y-2">
        <p className="text-xs text-ink-soft">How many pieces arrived of each size? They are added to what is in stock.</p>
        <ul className="space-y-1.5">
          {product.profiles.map((s) => {
            const n = add[s.id] ?? 0;
            return (
              <li key={s.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink truncate">{shortSizeName(s)}</span>
                  <span className="text-[11px] text-ink-soft">
                    {shown(s.id)} now{n > 0 && <> → {shown(s.id) + n}</>}
                  </span>
                </span>
                <button type="button" onClick={() => bump(s.id, -1)} disabled={n === 0} className="w-12 h-12 rounded-xl border border-line-strong bg-surface flex items-center justify-center disabled:opacity-30" aria-label={`Receive one fewer ${s.name}`}>
                  <Minus className="w-5 h-5" aria-hidden="true" />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={1000}
                  value={n}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setAdd((a) => ({ ...a, [s.id]: Math.max(0, Math.min(1000, Math.round(Number(e.target.value)) || 0)) }))}
                  className="w-16 h-12 rounded-xl border-2 border-line-strong text-lg font-bold text-center bg-surface"
                  aria-label={`Pieces of ${s.name} received`}
                />
                <button type="button" onClick={() => bump(s.id, 1)} className="w-12 h-12 rounded-xl border border-line-strong bg-surface flex items-center justify-center" aria-label={`Receive one more ${s.name}`}>
                  <Plus className="w-5 h-5" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
        <label className="block text-xs font-semibold text-ink-soft">
          Note (optional, e.g. supplier or invoice)
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-sm font-normal" />
        </label>
      </div>
      <div className="px-4 py-3 border-t border-line flex gap-2">
        <button type="button" onClick={onClose} className="min-h-12 px-4 rounded-xl border border-line-strong bg-surface text-sm font-semibold">
          Cancel
        </button>
        <button
          type="button"
          disabled={total === 0}
          onClick={() => onReceive(Object.entries(add).map(([sizeId, delta]) => ({ sizeId, delta })), note.trim() || undefined)}
          className="flex-1 min-h-12 rounded-xl bg-ink text-paper text-sm font-bold disabled:opacity-40"
        >
          Add {total} {total === 1 ? 'piece' : 'pieces'}
        </button>
      </div>
    </Sheet>
  );
}

interface MoveView {
  id: number;
  at: string;
  actor: string;
  reason: string;
  changes: Array<{ sizeId: string; from: number; to: number }>;
  note: string;
  undoneBy?: number | null;
}

const REASON_WORD: Record<string, string> = { received: 'Received', sold_offline: 'Sold offline', damaged: 'Damaged', correction: 'Correction', undo: 'Undo' };

/** The product's latest stock changes: when, who, why, old → new. */
function HistorySheet({ product, onClose }: { product: AdminProduct; onClose: () => void }) {
  const titleId = useId();
  const [moves, setMoves] = useState<MoveView[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void getJson<{ moves?: MoveView[]; message?: string }>(`/api/admin/products/${encodeURIComponent(product.id)}/stock`).then(({ ok, data }) => {
      if (!live) return;
      if (ok) setMoves(data.moves ?? []);
      else setError(data.message || 'Could not load the history.');
    });
    return () => {
      live = false;
    };
  }, [product.id]);
  const size = (id: string) => {
    const s = product.profiles.find((x) => x.id === id);
    return s ? shortSizeName(s) : id;
  };
  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="bottom">
      <div className="px-4 pt-4 pb-2 flex items-start gap-2 border-b border-line">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-serif font-bold text-base text-ink">
            Stock history
          </h3>
          <p className="text-xs text-ink-soft truncate">{product.title}</p>
        </div>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-y-auto px-4 py-3">
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {!error && moves === null && <p className="text-sm text-ink-soft">Loading…</p>}
        {moves?.length === 0 && <p className="text-sm text-ink-soft">No changes recorded yet. Sales show in Orders.</p>}
        <ol className="space-y-2">
          {moves?.map((m) => (
            <li key={m.id} className="rounded-xl border border-line px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <strong className="text-ink">{REASON_WORD[m.reason] ?? m.reason}</strong>
                <span className="text-xs text-ink-soft">{new Date(m.at).toLocaleString()}</span>
                {m.undoneBy && <span className="text-xs font-semibold text-warning">undone</span>}
              </div>
              <div className="text-ink">{m.changes.map((c) => `${size(c.sizeId)} ${c.from} → ${c.to}`).join(', ')}</div>
              <div className="text-xs text-ink-soft break-all">
                by {m.actor}
                {m.note && <> · {m.note}</>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </Sheet>
  );
}
