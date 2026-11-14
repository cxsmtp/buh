'use client';

import React, { useEffect, useRef, useState } from 'react';
import { MapPin, MessageCircle, Phone, X } from 'lucide-react';
import type { Customer, Order } from '@/types';
import { getJson } from '@/lib/apiClient';
import { formatAed } from '@/lib/money';
import { paymentName } from '@/lib/hubToday';
import { Sheet } from '@/components/common/Sheet';

/**
 * Admin Hub → Customers: one card per phone number, worked out by the server from the orders
 * (a page at a time, searched there too). Tapping a customer opens their order history in a
 * sheet (every order they placed, fetched for that customer, however old).
 */

interface AdminCrmTabProps {
  /** Changes when an order changed: the pages in view are loaded again. */
  refreshKey: number;
  /** The shop's name (Settings → Branding), for the WhatsApp greeting. */
  shopName?: string;
}

const PAGE = 60;
const aed = (n: number) => `AED ${formatAed(Math.round(n * 100))}`;
const STATUS_WORDS: Record<Order['status'], string> = {
  pending_payment: 'Waiting for payment',
  pending_confirmation: 'To confirm',
  confirmed: 'Confirmed',
  dispatched: 'Dispatched',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

interface Page {
  customers: Customer[];
  total: number;
  next: number | null;
}

export const AdminCrmTab: React.FC<AdminCrmTabProps> = ({ refreshKey, shopName }) => {
  const [searchTerm, setSearchTerm] = useState('');
  // What the list was last asked for (the typed text, after a pause).
  const [q, setQ] = useState('');
  const [list, setList] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Customer | null>(null);
  const asked = useRef(0);

  /** Load the list for a search: `count` customers from the top (as many as are in view after "Show more"). */
  const load = async (search: string, count: number, offset = 0) => {
    const mine = ++asked.current;
    setBusy(true);
    const params = new URLSearchParams({ limit: String(Math.min(200, count)), offset: String(offset) });
    if (search) params.set('q', search);
    const { ok, data } = await getJson<Partial<Page> & { message?: string }>(`/api/admin/customers?${params.toString()}`);
    if (mine !== asked.current) return; // a newer search is on its way
    setBusy(false);
    if (!ok || !data.customers) return setError(data.message || 'The customers could not be loaded. Check your connection and try again.');
    const page = { customers: data.customers, total: data.total ?? 0, next: data.next ?? null };
    setError('');
    setList((old) => (offset && old ? { ...page, customers: [...old.customers, ...page.customers.filter((c) => !old.customers.some((o) => o.id === c.id))] } : page));
  };

  // First load, a new search, or an order changed: the customers in view again (never the whole list).
  const inView = useRef(PAGE);
  useEffect(() => {
    void Promise.resolve().then(() => load(q, inView.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, refreshKey]);
  useEffect(() => {
    const t = setTimeout(() => {
      inView.current = PAGE;
      setQ(searchTerm.trim().slice(0, 60));
    }, 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  const customers = list?.customers ?? [];
  const more = () => {
    if (!list || list.next === null) return;
    inView.current = Math.min(200, customers.length + PAGE);
    void load(q, PAGE, list.next);
  };
  const name = shopName?.trim() || 'our shop';

  return (
    <div className="space-y-4">
      <div role="search">
        <label htmlFor="customer-search" className="sr-only">Search customers</label>
        <input
          id="customer-search"
          type="search"
          autoComplete="off"
          maxLength={60}
          placeholder="Search customers: name, phone, emirate or area"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          data-testid="customer-search"
          className="w-full min-h-11 px-3.5 rounded-xl border border-line-strong bg-surface text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold"
        />
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      {list === null && !error && <p className="text-xs text-ink-muted" role="status">Loading…</p>}
      {list !== null && customers.length === 0 && (
        <p role="status" className="bg-surface rounded-2xl p-8 text-center border border-line text-ink-muted text-xs" data-testid="customers-empty">
          {q ? `No customer matches “${q}”.` : 'No customers yet: they appear here with their first order.'}
        </p>
      )}

      <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="customer-list">
        {customers.map((customer) => {
          const a = customer.defaultAddress;
          const address = [a.buildingVilla, a.flatVillaNo, customer.area, customer.emirate].filter(Boolean).join(', ');
          return (
            <li key={customer.id} className="rounded-2xl border border-line bg-surface text-xs shadow-sm hover:border-line-strong flex flex-col min-w-0" data-testid="customer-card">
              {/* The whole card opens the history: a real button (keyboard, screen readers) */}
              <button
                type="button"
                onClick={() => setSelected(customer)}
                aria-haspopup="dialog"
                data-testid="customer-open"
                className="flex-1 w-full min-w-0 text-left p-4 pb-2.5 space-y-2.5 rounded-t-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-serif font-bold text-sm text-ink break-anywhere">{customer.fullName}</span>
                    <span className="flex items-center gap-1 text-[11px] text-ink-muted mt-0.5">
                      <Phone className="w-3 h-3 text-gold" aria-hidden="true" />
                      <span>{customer.phone}</span>
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full bg-sand text-ink-soft border border-line">{customer.emirate}</span>
                </span>
                <span className="text-[11px] text-ink-soft flex items-start gap-1.5 bg-ivory p-2 rounded-xl border border-line">
                  <MapPin className="w-3.5 h-3.5 text-gold shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="line-clamp-2 break-anywhere">
                    {address}
                    {a.landmark ? ` (near ${a.landmark})` : ''}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-x-2 text-[11px]">
                  <span className="font-bold text-ink">
                    {customer.totalOrders} {customer.totalOrders === 1 ? 'order' : 'orders'}
                  </span>
                  <span aria-hidden="true">•</span>
                  <span className="font-bold text-warning">{aed(customer.totalSpent)}</span>
                  <span className="ml-auto font-semibold text-ink-soft underline">See orders</span>
                </span>
              </button>
              <div className="px-4 pb-3 pt-2 border-t border-line">
                <a
                  href={`https://wa.me/${customer.phone.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(`Hello ${customer.fullName}, greetings from ${name}! How can we help you?`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="customer-whatsapp"
                  className="min-h-11 inline-flex items-center gap-1.5 text-xs text-success bg-success-soft px-3 rounded-xl border border-success-line font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                >
                  <MessageCircle className="w-4 h-4" aria-hidden="true" />
                  <span>WhatsApp</span>
                </a>
              </div>
            </li>
          );
        })}
      </ul>

      {list !== null && customers.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-soft" data-testid="customers-paging">
          <span role="status">
            Showing {customers.length}
            {q ? '' : ` of ${Math.max(list.total, customers.length)}`}
          </span>
          {list.next !== null && (
            <button type="button" onClick={more} disabled={busy} data-testid="customers-more" className="min-h-11 px-4 rounded-xl border border-line-strong bg-surface text-ink font-semibold hover:bg-sand disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
              {busy ? 'Loading…' : 'Show more customers'}
            </button>
          )}
        </div>
      )}

      {selected && <CustomerHistory key={selected.id} customer={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};

/** One customer's orders, every one of them, from the server (30 at a time), in a sheet over the page. */
function CustomerHistory({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closeButton = useRef<HTMLButtonElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const load = async (before?: string) => {
    setBusy(true);
    const params = new URLSearchParams({ phone: customer.phone });
    if (before) params.set('before', before);
    const { ok, data } = await getJson<{ orders?: Order[]; next?: string | null; message?: string }>(`/api/admin/customers/orders?${params.toString()}`);
    setBusy(false);
    if (!ok || !data.orders) return setError(data.message || 'The orders could not be loaded. Please try again.');
    const more = data.orders;
    setError('');
    setOrders((old) => (before && old ? [...old, ...more] : more));
    setNext(data.next ?? null);
    // "Show older orders" may now be gone: keep the keyboard inside the dialog (on the list, which scrolls).
    if (before) scroller.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    void Promise.resolve().then(() => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Sheet labelledBy="customer-history-title" onClose={onClose} wide initialFocus={closeButton}>
      <div className="flex items-start justify-between gap-2 px-4 pt-4 pb-3 border-b border-line">
        <div className="min-w-0">
          <h3 id="customer-history-title" className="font-serif font-bold text-base text-ink break-anywhere">
            Orders of {customer.fullName}
          </h3>
          <p className="text-xs text-ink-muted">
            {customer.phone} • {customer.emirate} • {customer.totalOrders} {customer.totalOrders === 1 ? 'order' : 'orders'}, {aed(customer.totalSpent)}
          </p>
        </div>
        <button ref={closeButton} type="button" onClick={onClose} aria-label="Close" className="shrink-0 w-11 h-11 flex items-center justify-center text-ink rounded-full hover:bg-sand focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
          <X className="w-5 h-5" strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <div ref={scroller} tabIndex={0} role="group" aria-label="Their orders, newest first" className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-2 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gold" data-testid="customer-history">
        {orders === null && !error && <p className="text-ink-muted" role="status">Loading…</p>}
        {error && <p role="alert" className="text-danger">{error}</p>}
        {orders?.length === 0 && <p className="text-ink-muted">No orders yet.</p>}
        <ul className="space-y-2">
          {(orders ?? []).map((ord) => (
            <li key={ord.id} className="bg-ivory p-3 rounded-xl border border-line flex flex-col sm:flex-row sm:items-center justify-between gap-2" data-testid="customer-order">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-bold text-xs text-ink">{ord.id}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-sand text-ink-soft font-semibold">{STATUS_WORDS[ord.status] ?? ord.status}</span>
                  <span className="text-[11px] text-ink-muted">{new Date(ord.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                </div>
                <div className="text-[11px] text-ink-muted mt-0.5 break-anywhere">
                  {ord.items.map((i) => `${i.quantity}x ${i.title} (${i.mattressSize ? i.profileName.split(' ')[0] : i.profileName})`).join(', ')}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="sm:text-right">
                  <span className="font-bold text-sm text-ink">{aed(ord.total)}</span>
                  <span className="text-[10px] text-ink-muted block" data-testid="customer-order-payment">{paymentName(ord.paymentMethod)}</span>
                </div>
                {ord.courier?.awbNumber && !ord.courier.simulated && (
                  <span className="text-[10px] font-mono font-semibold bg-warning-soft text-warning border border-warning-line px-2 py-1 rounded break-anywhere">AWB: {ord.courier.awbNumber}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
        {next && (
          <button type="button" onClick={() => void load(next)} disabled={busy} data-testid="customer-orders-more" className="min-h-11 px-4 rounded-xl border border-line-strong bg-surface text-ink font-semibold hover:bg-sand disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
            {busy ? 'Loading…' : 'Show older orders'}
          </button>
        )}
      </div>
    </Sheet>
  );
}
