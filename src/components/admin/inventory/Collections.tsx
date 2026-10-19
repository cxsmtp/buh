'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import { Check, Copy, Edit3, Eye, Link2, Loader2, MessageCircle, Share2, ShoppingBag, Trash2, X } from 'lucide-react';
import type { Product } from '@/types';
import { getJson, postJson, sendJson } from '@/lib/apiClient';
import { newKey } from '@/lib/client/stock';
import { Sheet } from '@/components/common/Sheet';

/**
 * Shared selections ("collections"): several products under one link, /c/<slug>, to send on
 * WhatsApp or post on Instagram. Made from Inventory (Select → Share these); listed, edited and
 * deleted under "Shared links", with how often each was opened and added to bag.
 */

type AdminProduct = Product & { archived?: boolean };

export interface CollectionView {
  id: string;
  slug: string;
  title: string;
  productIds: string[];
  expiresOn: string | null;
  views: number;
  bagAdds: number;
  createdAt: string;
}

const field = 'w-full min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const btn = 'min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40';
const primary = 'min-h-12 px-4 rounded-xl bg-ink text-paper text-sm font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-40';

/** Today in the UAE (YYYY-MM-DD): the earliest last day the date picker offers. */
const uaeToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const ended = (c: Pick<CollectionView, 'expiresOn'>) => Boolean(c.expiresOn) && uaeToday() > (c.expiresOn as string);
const linkOf = (slug: string) => `${window.location.origin}/c/${slug}`;

/** Copy link, WhatsApp, and the phone's own share sheet (when it has one). */
export function ShareButtons({ title, slug }: { title: string; slug: string }) {
  const [note, setNote] = useState('');
  const url = linkOf(slug);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setNote('Link copied.');
    } catch {
      setNote(`Copy this link: ${url}`);
    }
  };
  const native = async () => {
    try {
      await navigator.share({ title, url });
    } catch {
      // closed the share sheet
    }
  };
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void copy()} className={btn}>
          <Copy className="w-4 h-4" aria-hidden="true" /> Copy link
        </button>
        <a href={`https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`} target="_blank" rel="noopener noreferrer" className={btn}>
          <MessageCircle className="w-4 h-4" aria-hidden="true" /> WhatsApp
        </a>
        {canShare && (
          <button type="button" onClick={() => void native()} className={btn}>
            <Share2 className="w-4 h-4" aria-hidden="true" /> Share…
          </button>
        )}
      </div>
      {note && (
        <p role="status" className="text-xs text-ink-soft break-all">
          {note}
        </p>
      )}
    </div>
  );
}

/** Inventory → Share these: a title and an optional last day for the products picked; then the link. */
export function ShareSelectionSheet({ products, onClose, onCreated }: { products: AdminProduct[]; onClose: () => void; onCreated?: (c: CollectionView) => void }) {
  const titleId = useId();
  const [title, setTitle] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<CollectionView | null>(null);
  // One key per sheet: a second tap (or a retry after a lost answer) gives the same selection.
  const [key] = useState(() => newKey('col'));
  const hiddenCount = products.filter((p) => p.active === false).length;

  const create = async () => {
    setError('');
    if (!title.trim()) return setError('Give the selection a short title, e.g. “Eid picks”.');
    setBusy(true);
    const res = await postJson<{ collection?: CollectionView; message?: string }>('/api/admin/collections', { key, title: title.trim(), productIds: products.map((p) => p.id), expiresOn: expiresOn || null });
    setBusy(false);
    if (!res.ok || !res.data.collection) return setError(res.data.message || 'Could not make the link. Please try again.');
    setMade(res.data.collection);
    onCreated?.(res.data.collection);
  };

  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="bottom">
      <div className="px-4 pt-4 pb-2 flex items-start gap-2 border-b border-line">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-serif font-bold text-base text-ink">
            {made ? 'Your link is ready' : 'Share these'}
          </h3>
          <p className="text-xs text-ink-soft">
            {products.length} {products.length === 1 ? 'product' : 'products'} on one page
          </p>
        </div>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-y-auto px-4 py-3 space-y-3 text-sm">
        <ul className="flex gap-2 overflow-x-auto no-scrollbar" aria-label="Products in this selection">
          {products.map((p) => (
            <li key={p.id} className="shrink-0 w-16">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.featuredImage} alt="" className="w-16 h-16 rounded-xl object-cover bg-sand" />
              <span className="block text-[10px] text-ink-soft truncate">{p.title}</span>
            </li>
          ))}
        </ul>
        {made ? (
          <div className="space-y-3" data-testid="collection-made">
            <p className="rounded-xl border border-success-line bg-success-soft px-3 py-2 text-xs text-ink break-all">
              <Link2 className="inline w-4 h-4 mr-1 text-success" aria-hidden="true" />
              <a href={`/c/${made.slug}`} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                {linkOf(made.slug)}
              </a>
            </p>
            <ShareButtons title={made.title} slug={made.slug} />
            <p className="text-xs text-ink-soft">Find it again, change it or see how often it was opened under Inventory → Shared links.</p>
          </div>
        ) : (
          <>
            <label className="block">
              <span className="block text-sm font-semibold text-ink mb-1">Title</span>
              <input className={field} value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Eid picks" data-autofocus />
            </label>
            <label className="block">
              <span className="block text-sm font-semibold text-ink mb-1">Last day (optional)</span>
              <input className={field} type="date" min={uaeToday()} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
              <span className="block text-[11px] text-ink-soft mt-0.5">After this day the link says the selection has ended, with a way into the shop.</span>
            </label>
            {hiddenCount > 0 && (
              <p className="text-xs text-warning">
                {hiddenCount} of these {hiddenCount === 1 ? 'is' : 'are'} hidden from the shop: {hiddenCount === 1 ? 'it shows' : 'they show'} on the page once you show {hiddenCount === 1 ? 'it' : 'them'}.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-lg px-3 py-2 font-medium">
            {error}
          </p>
        )}
      </div>
      <div className="px-4 py-3 border-t border-line flex gap-2">
        <button type="button" onClick={onClose} className="min-h-12 px-4 rounded-xl border border-line-strong bg-surface text-sm font-semibold">
          {made ? 'Done' : 'Cancel'}
        </button>
        {!made && (
          <button type="button" onClick={() => void create()} disabled={busy} className={`flex-1 ${primary}`}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Create link
          </button>
        )}
      </div>
    </Sheet>
  );
}

/** Inventory → Shared links: every selection, its counters, and edit / share / delete. */
export function CollectionsSheet({ products, onClose }: { products: AdminProduct[]; onClose: () => void }) {
  const titleId = useId();
  const [list, setList] = useState<CollectionView[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<CollectionView | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await getJson<{ collections?: CollectionView[]; message?: string }>('/api/admin/collections');
    if (ok) setList(data.collections ?? []);
    else setError(data.message || 'Could not load the shared links.');
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const remove = async (c: CollectionView) => {
    if (!window.confirm(`Delete “${c.title}”? Its link will stop showing these products.`)) return;
    const { ok, data } = await sendJson<{ message?: string }>('DELETE', `/api/admin/collections/${encodeURIComponent(c.id)}`);
    if (!ok) return setError(data.message || 'Could not delete it.');
    await load();
  };

  const name = (id: string) => products.find((p) => p.id === id)?.title ?? 'A product no longer in the shop';

  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="bottom" wide>
      <div className="px-4 pt-4 pb-2 flex items-start gap-2 border-b border-line">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-serif font-bold text-base text-ink">
            Shared links
          </h3>
          <p className="text-xs text-ink-soft">Selections of products on one page. Make one in Inventory: Select, then Share these.</p>
        </div>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-y-auto px-4 py-3 space-y-2 text-sm">
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        {list === null && !error && <p className="text-ink-soft">Loading…</p>}
        {list?.length === 0 && <p className="text-ink-soft">No shared links yet.</p>}
        <ul className="space-y-2">
          {list?.map((c) => (
            <li key={c.id} className="rounded-2xl border border-line bg-surface p-3 space-y-2" data-testid="collection-row">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <strong className="text-ink break-anywhere">{c.title}</strong>
                {ended(c) ? <span className="text-[11px] font-semibold text-danger">ended</span> : c.expiresOn ? <span className="text-[11px] text-ink-soft">until {c.expiresOn}</span> : null}
              </div>
              <a href={`/c/${c.slug}`} target="_blank" rel="noopener noreferrer" className="block text-xs text-ink-soft underline break-all">
                /c/{c.slug}
              </a>
              <p className="text-xs text-ink flex flex-wrap gap-x-3 gap-y-1">
                <span>
                  {c.productIds.length} {c.productIds.length === 1 ? 'product' : 'products'}
                </span>
                <span className="inline-flex items-center gap-1" title="Times the link was opened (once per visit)">
                  <Eye className="w-3.5 h-3.5" aria-hidden="true" /> {c.views} {c.views === 1 ? 'view' : 'views'}
                </span>
                <span className="inline-flex items-center gap-1" title="Times a piece was added to bag from this page">
                  <ShoppingBag className="w-3.5 h-3.5" aria-hidden="true" /> {c.bagAdds} added to bag
                </span>
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setSharing(sharing === c.id ? null : c.id)} aria-expanded={sharing === c.id} className={btn} aria-label={`Share ${c.title}`}>
                  <Share2 className="w-4 h-4" aria-hidden="true" /> Share
                </button>
                <button type="button" onClick={() => setEditing(c)} className={btn} aria-label={`Edit ${c.title}`}>
                  <Edit3 className="w-4 h-4" aria-hidden="true" /> Edit
                </button>
                <button type="button" onClick={() => void remove(c)} className={`${btn} text-danger border-danger-line`} aria-label={`Delete ${c.title}`}>
                  <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete
                </button>
              </div>
              {sharing === c.id && <ShareButtons title={c.title} slug={c.slug} />}
              <p className="text-[11px] text-ink-soft line-clamp-2">{c.productIds.map(name).join(' · ')}</p>
            </li>
          ))}
        </ul>
      </div>
      {editing && (
        <EditCollectionSheet
          collection={editing}
          products={products}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </Sheet>
  );
}

/** Rename, change the last day, add or take off products (the link stays the same). */
function EditCollectionSheet({ collection, products, onClose, onSaved }: { collection: CollectionView; products: AdminProduct[]; onClose: () => void; onSaved: () => void }) {
  const titleId = useId();
  const [title, setTitle] = useState(collection.title);
  const [expiresOn, setExpiresOn] = useState(collection.expiresOn ?? '');
  const [ids, setIds] = useState<string[]>(collection.productIds);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choosable = products.filter((p) => !p.archived || ids.includes(p.id));
  const q = query.trim().toLowerCase();
  const shown = choosable.filter((p) => !q || [p.title, p.sku ?? ''].some((x) => x.toLowerCase().includes(q)));
  const toggle = (id: string) => setIds((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const save = async () => {
    setError('');
    if (!title.trim()) return setError('Give it a title.');
    if (!ids.length) return setError('Keep at least one product (or delete the link).');
    setBusy(true);
    const { ok, data } = await sendJson<{ message?: string }>('PATCH', `/api/admin/collections/${encodeURIComponent(collection.id)}`, { title: title.trim(), productIds: ids, expiresOn: expiresOn || null });
    setBusy(false);
    if (!ok) return setError(data.message || 'Could not save.');
    onSaved();
  };

  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="full">
      <div className="px-4 pt-4 pb-2 flex items-start gap-2 border-b border-line">
        <h3 id={titleId} className="font-serif font-bold text-base text-ink flex-1 min-w-0 truncate">
          Edit {collection.title}
        </h3>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        <label className="block">
          <span className="block text-sm font-semibold text-ink mb-1">Title</span>
          <input className={field} value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold text-ink mb-1">Last day (optional)</span>
          <input className={field} type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </label>
        <fieldset className="space-y-2">
          <legend className="block text-sm font-semibold text-ink mb-1">
            Products ({ids.length})
          </legend>
          <input type="search" className={field} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or SKU" aria-label="Search products" />
          <ul className="space-y-1">
            {shown.map((p) => (
              <li key={p.id}>
                <label className="flex items-center gap-3 min-h-12 rounded-xl border border-line bg-surface px-2">
                  <input type="checkbox" className="w-5 h-5 shrink-0" checked={ids.includes(p.id)} onChange={() => toggle(p.id)} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.featuredImage} alt="" className="w-9 h-9 rounded-lg object-cover bg-sand shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  {p.active === false && <span className="text-[11px] text-ink-soft shrink-0">hidden</span>}
                  {ids.includes(p.id) && <Check className="w-4 h-4 text-success shrink-0" aria-hidden="true" />}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>
      <div className="px-4 py-3 border-t border-line space-y-2">
        {error && (
          <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-lg px-3 py-2 font-medium">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="min-h-12 px-4 rounded-xl border border-line-strong bg-surface text-sm font-semibold">
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={busy} className={`flex-1 ${primary}`}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Save changes
          </button>
        </div>
      </div>
    </Sheet>
  );
}
