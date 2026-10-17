'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Box, Copy, Feather, KeyRound, LayoutGrid, Laptop, Link2, Mail, MessageSquare, Palette, ShieldCheck, Smartphone, Store, Truck } from 'lucide-react';
import type { AssistantSettings, BankTransferDetails, BrandSettings, CatalogSettings, CourierSettings, Customer, DeliverySettings, EmailSettings, Order, Product, SmsGatewaySettings, StoreSettings, ThemeSettings } from '@/types';
import { DEFAULT_ASSISTANT, DEFAULT_CATALOG, DEFAULT_DELIVERY, DEFAULT_EMAIL_SETTINGS, DEFAULT_STORE, DEFAULT_THEME_SETTINGS } from '@/data/catalogDefaults';
import { INITIAL_BANK_DETAILS, INITIAL_BRAND_SETTINGS, INITIAL_COURIER_SETTINGS, INITIAL_SMS_SETTINGS } from '@/data/initialData';
import { getJson, postJson, sendJson, UNAUTHORIZED_EVENT } from '@/lib/apiClient';
import { useLiveUpdates } from '@/lib/client/live';
import { stockAlerts } from '@/lib/client/stock';
import { VersionBadge } from '@/components/common/VersionBadge';
import { AdminHeader } from './AdminHeader';
import { AdminBar } from './AdminBar';
import { AdminOrdersTab } from './AdminOrdersTab';
import { AdminInventoryTab } from './AdminInventoryTab';
import { AdminCrmTab } from './AdminCrmTab';
import { AdminCouriersTab } from './AdminCouriersTab';
import { AdminBrandingTab, type BrandDraft } from './AdminBrandingTab';
import { AdminSmsTab } from './AdminSmsTab';
import { AdminChatsTab } from './AdminChatsTab';
import { AdminLoginModal } from './AdminLoginModal';
import { BackupStatus } from './BackupStatus';
import { RestoreNotice } from './RestoreNotice';
import { AdminLinkCard } from './settings/AdminLinkCard';
import { AssistantSettingsCard } from './settings/AssistantSettingsCard';
import { CatalogSettingsCard } from './settings/CatalogSettingsCard';
import { DeliverySettingsCard } from './settings/DeliverySettingsCard';
import { EmailSettingsCard } from './settings/EmailSettingsCard';
import { MarqueeSettingsCard } from './settings/MarqueeSettingsCard';
import { SettingsConsole } from './settings/SettingsConsole';
import { SettingsHistoryCard } from './settings/SettingsHistoryCard';
import { SignInRecoveryCard } from './settings/SignInRecoveryCard';
import { StoreSettingsCard } from './settings/StoreSettingsCard';
import { SystemHealthCard } from './settings/SystemHealthCard';
import { ThemeSettingsCard } from './settings/ThemeSettingsCard';
import { VersionsCard } from './settings/VersionsCard';

/** Settings as the admin hub receives them: secrets blank, with which are saved. */
interface AdminSetting<T> {
  value: T;
  secretsSet: Record<string, boolean>;
}
interface AdminSettings {
  courier: AdminSetting<CourierSettings>;
  sms: AdminSetting<SmsGatewaySettings>;
  catalog: AdminSetting<CatalogSettings>;
  store: AdminSetting<StoreSettings>;
  theme: AdminSetting<ThemeSettings>;
  email: AdminSetting<EmailSettings>;
  assistant: AdminSetting<AssistantSettings>;
  delivery: AdminSetting<DeliverySettings>;
}

type AdminTab = 'orders' | 'add-product' | 'inventory' | 'crm' | 'settings' | 'chats';
export type HubView = 'phone' | 'laptop';

const VIEW_KEY = 'buh_hub_view';

/** The view this device last chose; else phones (narrow screens) get the phone view and laptops the full one. */
function initialView(): HubView {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'phone' || saved === 'laptop') return saved;
  } catch {
    // storage blocked: decide by the screen
  }
  return window.matchMedia?.('(min-width: 768px)').matches ? 'laptop' : 'phone';
}

/** Everything the admin hub shows (no React state here). */
async function fetchAdminData() {
  const [orders, customers, products, settings, chats] = await Promise.all([
    getJson<{ orders: Order[] }>('/api/admin/orders'),
    getJson<{ customers: Customer[] }>('/api/admin/customers'),
    getJson<{ products: Product[] }>('/api/admin/products'),
    getJson<AdminSettings>('/api/admin/settings'),
    getJson<{ waiting: number }>('/api/admin/chats'),
  ]);
  return { orders, customers, products, settings, chats };
}

/** The shop's public settings the hub edits in place (brand and bank details). */
async function fetchPublic() {
  return getJson<{ brand: BrandSettings; bank: BankTransferDetails }>('/api/settings/public');
}

/** Is this page the admin link itself (not a password-reset email's one-time path)? */
const onAdminLink = () => /^\/[A-Za-z0-9_-]{32}$/.test(window.location.pathname);

/**
 * The Admin Hub: its own page, only at the private admin link (src/lib/server/frontGate.ts). One link
 * for every device: the phone view (one column, the tab bar at the bottom) on phones,
 * the full view (tabs at the top) on laptops, and a switch between them that this
 * device remembers.
 */
export function AdminApp() {
  const [auth, setAuth] = useState<'checking' | 'out' | 'in'>('checking');
  const [view, setViewState] = useState<HubView>(initialView);
  // From a password-reset email link (#reset=…), read once and taken out of the address bar.
  const [resetToken, setResetToken] = useState<string | null>(() => new URLSearchParams(window.location.hash.slice(1)).get('reset'));
  const [adminTab, setAdminTab] = useState<AdminTab>('orders');
  // The version badge opens Settings → Versions (re-creating the console on that section).
  const [settingsOpen, setSettingsOpen] = useState<{ id?: string; n: number }>({ n: 0 });

  const [brandSettings, setBrandSettings] = useState<BrandSettings>(INITIAL_BRAND_SETTINGS);
  const [bankDetails, setBankDetails] = useState<BankTransferDetails>(INITIAL_BANK_DETAILS);
  const [publicSettingsLoaded, setPublicSettingsLoaded] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [adminProducts, setAdminProducts] = useState<Product[]>([]);
  const [adminSettings, setAdminSettings] = useState<AdminSettings>({
    courier: { value: INITIAL_COURIER_SETTINGS, secretsSet: {} },
    sms: { value: INITIAL_SMS_SETTINGS, secretsSet: {} },
    catalog: { value: DEFAULT_CATALOG, secretsSet: {} },
    store: { value: DEFAULT_STORE, secretsSet: {} },
    theme: { value: DEFAULT_THEME_SETTINGS, secretsSet: {} },
    email: { value: DEFAULT_EMAIL_SETTINGS, secretsSet: {} },
    assistant: { value: DEFAULT_ASSISTANT, secretsSet: {} },
    delivery: { value: DEFAULT_DELIVERY, secretsSet: {} },
  });
  const [adminLoadError, setAdminLoadError] = useState('');
  const [adminSettingsLoaded, setAdminSettingsLoaded] = useState(false);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [undone, setUndone] = useState<Record<string, number>>({});
  const [chatsWaiting, setChatsWaiting] = useState(0);
  const [chatsKey, setChatsKey] = useState(0);
  const [newOrderNotice, setNewOrderNotice] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  // "This is your private link: bookmark it" (after the link was made or moved here).
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const setView = (next: HubView) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // not remembered: this visit only
    }
  };

  const checkSession = useCallback(async () => {
    const { ok, data } = await getJson<{ authenticated?: boolean; mustChangePassword?: boolean }>('/api/admin/session');
    setAuth(ok && data.authenticated === true && !data.mustChangePassword ? 'in' : 'out');
  }, []);

  useEffect(() => {
    if (resetToken) window.history.replaceState(null, '', window.location.pathname);
    void Promise.resolve().then(checkSession);
    const onUnauthorized = (e: Event) => {
      const url = String((e as CustomEvent<{ url?: string }>).detail?.url || '');
      if (!url.startsWith('/api/admin/login')) setAuth('out');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPublic = useCallback(async () => {
    const { ok, data } = await fetchPublic();
    if (!ok) return;
    setBrandSettings(data.brand);
    setBankDetails(data.bank);
    setPublicSettingsLoaded(true);
  }, []);

  const applyAdminData = useCallback(({ orders: o, customers: c, products: p, settings: st, chats: ch }: Awaited<ReturnType<typeof fetchAdminData>>) => {
    if (ch.ok) setChatsWaiting(ch.data.waiting);
    if (o.ok) setOrders(o.data.orders);
    if (c.ok) setCustomers(c.data.customers);
    if (p.ok) setAdminProducts(p.data.products);
    if (st.ok) {
      setAdminSettings({ courier: st.data.courier, sms: st.data.sms, catalog: st.data.catalog, store: st.data.store, theme: st.data.theme, email: st.data.email, assistant: st.data.assistant, delivery: st.data.delivery });
      setAdminSettingsLoaded(true);
    }
    setAdminLoadError(o.ok && c.ok && p.ok && st.ok ? '' : 'Some admin data could not be loaded. Check your connection and refresh.');
  }, []);
  const loadAdminData = useCallback(async () => applyAdminData(await fetchAdminData()), [applyAdminData]);
  const reloadAll = useCallback(async () => {
    await Promise.all([loadAdminData(), loadPublic()]);
  }, [loadAdminData, loadPublic]);

  // Signed in: the data, refreshed every minute, and the link notice.
  useEffect(() => {
    if (auth !== 'in') return;
    void Promise.resolve().then(reloadAll);
    void getJson<{ notice?: string | null }>('/api/admin/link').then(({ ok, data }) => {
      if (ok && data.notice && onAdminLink()) setLinkNotice(data.notice);
    });
    const t = setInterval(() => void fetchAdminData().then(applyAdminData), 60_000);
    return () => clearInterval(t);
  }, [auth, reloadAll, applyAdminData]);

  // Several changes in a row (e.g. tapping + on stock) give one reload.
  const reloadTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debounced = useCallback((key: string, fn: () => void) => {
    clearTimeout(reloadTimers.current[key]);
    reloadTimers.current[key] = setTimeout(fn, 400);
  }, []);
  useLiveUpdates(auth === 'in' ? '/api/admin/events' : null, {
    onCatalog: () => debounced('admin', () => void reloadAll()),
    onSettings: () => debounced('admin', () => void reloadAll()),
    onOrders: () => {
      setNewOrderNotice(true);
      debounced('admin', () => void loadAdminData());
    },
    onChats: () => {
      setChatsKey((n) => n + 1);
      debounced('chats', () =>
        void getJson<{ waiting: number }>('/api/admin/chats').then(({ ok, data }) => {
          if (ok) setChatsWaiting(data.waiting);
        })
      );
    },
    onNewVersion: () => setUpdateReady(true),
  });

  /** Save one settings group on the server; resolves to an error message or null. */
  const saveSettings = async (key: 'brand' | 'bank' | 'courier' | 'sms' | 'catalog' | 'store' | 'theme' | 'email' | 'assistant' | 'delivery', settings: unknown): Promise<string | null> => {
    const { ok, data } = await sendJson<{ message?: string }>('PUT', `/api/admin/settings/${key}`, { settings });
    if (!ok) return data.message || 'Could not save. Please try again.';
    await reloadAll();
    return null;
  };
  const autoSaveHooks = {
    onSaved: async () => {
      await reloadAll();
    },
    // Only the section whose settings were restored is re-created (others may hold unsaved typing).
    onUndone: (key: string) => setUndone((u) => ({ ...u, [key]: (u[key] ?? 0) + 1 })),
  };

  const toShop = () => window.location.assign('/');
  const handleLogout = () => {
    void postJson('/api/admin/logout', {});
    setAuth('out');
  };
  const dismissLinkNotice = () => {
    setLinkNotice(null);
    void sendJson('DELETE', '/api/admin/link/notice');
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href.split('#')[0]);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const pendingOrdersCount = orders.filter((o) => o.status === 'pending_confirmation').length;
  const stockAlertCount = useMemo(() => (auth === 'in' ? stockAlerts(adminProducts, adminSettings.catalog.value.lowStockThreshold).count : 0), [auth, adminProducts, adminSettings.catalog.value.lowStockThreshold]);
  const phone = view === 'phone';

  if (auth !== 'in') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4 bg-ivory" data-hub-view={view}>
        <p className="font-serif text-xl text-ink-soft">{brandSettings.storeName || 'Beautiful UAE Home'}</p>
        {auth === 'out' && (
          <AdminLoginModal
            isOpen
            onClose={toShop}
            onLoginSuccess={() => void checkSession()}
            resetToken={resetToken}
            onResetDone={() => setResetToken(null)}
          />
        )}
      </div>
    );
  }

  const tabs: Array<{ id: AdminTab; label: string; badge?: number; badgeLabel?: string }> = [
    { id: 'orders', label: 'Orders & Dispatches', badge: pendingOrdersCount, badgeLabel: `${pendingOrdersCount} to confirm` },
    { id: 'chats', label: 'Chats', badge: chatsWaiting, badgeLabel: `${chatsWaiting} waiting` },
    { id: 'add-product', label: 'Add product' },
    { id: 'inventory', label: 'Inventory', badge: stockAlertCount, badgeLabel: `${stockAlertCount} sold out or low` },
    { id: 'crm', label: 'Customers' },
    { id: 'settings', label: 'Settings' },
  ];

  const viewSwitch = (
    <div role="group" aria-label="Layout" className="inline-flex rounded-full border border-line-strong bg-surface p-0.5 shrink-0">
      {(
        [
          ['phone', 'Phone view', Smartphone],
          ['laptop', 'Laptop view', Laptop],
        ] as Array<[HubView, string, typeof Smartphone]>
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          onClick={() => setView(id)}
          className={`inline-flex items-center gap-1.5 min-h-9 px-3 rounded-full text-xs font-semibold ${view === id ? 'bg-ink text-white' : 'text-ink-soft hover:text-ink'}`}
        >
          <Icon className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className={`min-h-screen flex flex-col font-sans px-safe ${phone ? 'max-w-[480px] w-full mx-auto sm:border-x sm:border-line bg-ivory' : ''}`} data-hub-view={view}>
      {updateReady && (
        <div role="status" className="bg-ink text-white text-xs px-3 py-1.5 flex items-center justify-center gap-3">
          <span>New version ready</span>
          <button type="button" className="font-bold underline min-h-8" onClick={() => window.location.reload()}>Refresh</button>
        </div>
      )}
      <AdminHeader orders={orders} products={adminProducts} customers={customers} onExitAdmin={toShop} onLogoutAdmin={handleLogout} brandSettings={brandSettings} />

      <main className={`flex-1 mx-auto w-full px-3 sm:px-6 ${phone ? 'pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))]' : 'max-w-7xl pb-16'}`}>
        <div className="py-4 space-y-4">
          <div className="flex justify-end">{viewSwitch}</div>

          {!phone && (
            <nav aria-label="Admin sections" className="flex items-center gap-2 border-b border-line pb-2 overflow-x-auto no-scrollbar">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setAdminTab(tab.id)}
                  aria-current={adminTab === tab.id ? 'page' : undefined}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                    adminTab === tab.id ? 'bg-ink text-white shadow-sm' : 'bg-surface text-ink-soft hover:bg-sand border border-line'
                  }`}
                >
                  <span>{tab.label}</span>
                  {tab.badge && tab.badge > 0 ? (
                    <span className="min-w-4 h-4 px-1 rounded-full bg-gold text-ink text-[10px] font-bold flex items-center justify-center" aria-label={tab.badgeLabel}>{tab.badge}</span>
                  ) : null}
                </button>
              ))}
              <button type="button" onClick={toShop} className="ml-auto px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 bg-surface text-ink-soft hover:bg-sand border border-line">
                <Store className="w-4 h-4" aria-hidden="true" />
                <span>View shop</span>
              </button>
            </nav>
          )}

          {linkNotice && (
            <div role="status" className="rounded-2xl border border-gold/50 bg-surface px-3.5 py-3 space-y-2" data-testid="admin-link-notice">
              <p className="text-xs font-semibold text-ink flex items-center gap-1.5">
                <Link2 className="w-4 h-4 text-gold-deep" aria-hidden="true" />
                {linkNotice === 'moved' ? 'The Admin Hub has moved to this private link' : 'This is your private Admin Hub link'}
              </p>
              <p className="text-xs text-ink-soft leading-relaxed">
                The shop&rsquo;s pages no longer have a way in. Bookmark this page now on this device (on a phone: Share → Add to Home Screen, or the browser&rsquo;s bookmark star), and open it on your other phone or laptop to bookmark it there.
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void copyLink()} className="min-h-10 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold inline-flex items-center gap-1.5">
                  <Copy className="w-4 h-4" aria-hidden="true" />
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <button type="button" onClick={dismissLinkNotice} className="min-h-10 px-3 rounded-xl bg-ink text-white text-xs font-bold">
                  I&rsquo;ve bookmarked it
                </button>
              </div>
            </div>
          )}

          {newOrderNotice && (
            <div role="status" className="rounded-2xl border border-success-line bg-success-soft text-success px-3.5 py-2.5 text-xs flex items-center gap-2">
              <strong>Orders updated</strong>
              <span className="opacity-80">A new or changed order just came in.</span>
              <button type="button" className="ml-auto font-semibold underline" onClick={() => { setAdminTab('orders'); setNewOrderNotice(false); }}>View orders</button>
              <button type="button" className="font-semibold" aria-label="Dismiss" onClick={() => setNewOrderNotice(false)}>✕</button>
            </div>
          )}
          <BackupStatus />
          <RestoreNotice
            onReview={() => {
              setSettingsOpen((x) => ({ id: 'signin', n: x.n + 1 }));
              setAdminTab('settings');
            }}
          />
          {adminLoadError && <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{adminLoadError}</p>}

          {adminTab === 'orders' && <AdminOrdersTab orders={orders} onOrderChanged={(changed) => { setOrders((prev) => prev.map((o) => (o.id === changed.id ? changed : o))); void loadAdminData(); }} courierSettings={adminSettings.courier.value} />}

          {(adminTab === 'add-product' || adminTab === 'inventory') && (
            <AdminInventoryTab
              key={adminTab}
              startAdding={adminTab === 'add-product'}
              products={adminProducts}
              catalog={adminSettings.catalog.value}
              onProductUpdated={(updated) => setAdminProducts((list) => list.map((x) => (x.id === updated.id ? { ...x, ...updated } : x)))}
              onChanged={reloadAll}
            />
          )}

          {adminTab === 'chats' && <AdminChatsTab refreshKey={chatsKey} />}

          {adminTab === 'crm' && <AdminCrmTab customers={customers} orders={orders} />}

          {adminTab === 'settings' && (
            <SettingsConsole
              key={settingsOpen.n}
              openId={settingsOpen.id}
              sections={[
                {
                  id: 'store',
                  label: 'Store & contact',
                  icon: <Store />,
                  hint: 'WhatsApp, email, social accounts, address, currency display and the announcement bar.',
                  content: (
                    <>
                      <StoreSettingsCard key={`store-${adminSettingsLoaded}-${settingsEpoch}-${undone['store'] ?? 0}`} value={adminSettings.store.value} onSave={(v) => saveSettings('store', v)} auto={autoSaveHooks} />
                      <MarqueeSettingsCard key={`marquee-${publicSettingsLoaded}-${settingsEpoch}-${undone['brand'] ?? 0}`} brand={brandSettings} onSave={(v) => saveSettings('brand', v)} />
                    </>
                  ),
                },
                {
                  id: 'catalog',
                  label: 'Catalogue',
                  icon: <LayoutGrid />,
                  hint: 'Size presets, categories and the low-stock warning.',
                  content: <CatalogSettingsCard key={`catalog-${adminSettingsLoaded}-${settingsEpoch}-${undone['catalog'] ?? 0}`} value={adminSettings.catalog.value} onSave={(v) => saveSettings('catalog', v)} auto={autoSaveHooks} />,
                },
                {
                  id: 'branding',
                  label: 'Branding & bank',
                  icon: <Palette />,
                  hint: 'Logo, name, tagline and bank-transfer details.',
                  content: (
                    <AdminBrandingTab
                      key={`branding-${publicSettingsLoaded}-${settingsEpoch}-${undone['brand'] ?? 0}-${undone['bank'] ?? 0}`}
                      brandSettings={brandSettings}
                      onUpdateBrandSettings={(s: BrandDraft) => saveSettings('brand', s)}
                      bank={bankDetails}
                      onUpdateBank={(b: BankTransferDetails) => saveSettings('bank', b)}
                      auto={autoSaveHooks}
                    />
                  ),
                },
                {
                  id: 'themes',
                  label: 'Festival themes',
                  icon: <Feather />,
                  hint: 'Eid, Diwali, Christmas, Lunar New Year and 30 more: picked automatically, or chosen by you.',
                  content: <ThemeSettingsCard key={`theme-${adminSettingsLoaded}-${settingsEpoch}`} value={adminSettings.theme.value} onSave={(v) => saveSettings('theme', v)} />,
                },
                {
                  id: 'sms',
                  label: 'Phone verification',
                  icon: <Smartphone />,
                  hint: 'The SMS gateway that sends checkout codes.',
                  content: (
                    <AdminSmsTab
                      key={`sms-${adminSettingsLoaded}-${settingsEpoch}-${undone['sms'] ?? 0}`}
                      smsSettings={adminSettings.sms.value}
                      secretsSet={adminSettings.sms.secretsSet}
                      onUpdateSmsSettings={(s: SmsGatewaySettings) => saveSettings('sms', s)}
                      auto={autoSaveHooks}
                    />
                  ),
                },
                {
                  id: 'couriers',
                  label: 'Couriers',
                  icon: <Truck />,
                  hint: 'Jeebly and Eco Express keys, pickup details and routing.',
                  content: (
                    <AdminCouriersTab
                      key={`couriers-${adminSettingsLoaded}-${settingsEpoch}-${undone['courier'] ?? 0}`}
                      settings={adminSettings.courier.value}
                      secretsSet={adminSettings.courier.secretsSet}
                      onUpdateSettings={(s: CourierSettings) => saveSettings('courier', s)}
                      auto={autoSaveHooks}
                    />
                  ),
                },
                {
                  id: 'delivery',
                  label: 'Delivery',
                  icon: <Box />,
                  hint: 'Where you deliver, the time customers see, and same-day delivery with its charge.',
                  content: <DeliverySettingsCard key={`delivery-${adminSettingsLoaded}-${settingsEpoch}-${undone['delivery'] ?? 0}`} value={adminSettings.delivery.value} onSave={(v) => saveSettings('delivery', v)} auto={autoSaveHooks} />,
                },
                {
                  id: 'assistant',
                  label: 'Chat assistant',
                  icon: <MessageSquare />,
                  hint: 'What the shop’s chat answers by itself (its memory), and when it hands over to you.',
                  content: (
                    <AssistantSettingsCard
                      key={`assistant-${adminSettingsLoaded}-${settingsEpoch}-${undone['assistant'] ?? 0}`}
                      value={adminSettings.assistant.value}
                      sizes={adminSettings.catalog.value.sizes}
                      onSave={(v) => saveSettings('assistant', v)}
                      auto={autoSaveHooks}
                    />
                  ),
                },
                {
                  id: 'email',
                  label: 'Email & admin account',
                  icon: <Mail />,
                  hint: 'The mail server for backups, alerts and password resets; your sign-in email.',
                  content: (
                    <EmailSettingsCard
                      key={`email-${adminSettingsLoaded}-${settingsEpoch}-${undone['email'] ?? 0}`}
                      value={adminSettings.email.value}
                      passwordSaved={Boolean(adminSettings.email.secretsSet.smtpPass)}
                      imapPasswordSaved={Boolean(adminSettings.email.secretsSet.imapPass)}
                      onSave={(v) => saveSettings('email', v)}
                      auto={autoSaveHooks}
                    />
                  ),
                },
                {
                  id: 'security',
                  label: 'Security',
                  icon: <Link2 />,
                  hint: 'Your private admin link: change it if it may have been seen by someone else.',
                  content: <AdminLinkCard />,
                },
                {
                  id: 'signin',
                  label: 'Passkeys & recovery codes',
                  icon: <KeyRound />,
                  hint: 'Ways back in if you forget your password: a passkey on your phone, and one-time recovery codes.',
                  content: <SignInRecoveryCard />,
                },
                {
                  id: 'versions',
                  label: 'Versions',
                  icon: <Archive />,
                  hint: 'Every release and what changed; switch to any of them without closing the shop.',
                  content: <VersionsCard />,
                },
                {
                  id: 'system',
                  label: 'System & backups',
                  icon: <ShieldCheck />,
                  hint: 'Backups, earlier versions of the settings, version and health.',
                  content: (
                    <div className="space-y-3 text-xs text-ink-soft">
                      <SystemHealthCard />
                      <BackupStatus />
                      <SettingsHistoryCard onRestored={() => void reloadAll().then(() => setSettingsEpoch((n) => n + 1))} />
                      <p>
                        Version <strong>{process.env.NEXT_PUBLIC_APP_VERSION}</strong>. Health check:{' '}
                        <a className="underline" href="/api/health" target="_blank" rel="noopener noreferrer">/api/health</a>
                      </p>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </div>
      </main>

      {phone && <AdminBar adminTab={adminTab} onSetAdminTab={setAdminTab} pendingOrdersCount={pendingOrdersCount} chatsWaiting={chatsWaiting} stockAlerts={stockAlertCount} onToggleAdminMode={toShop} />}
      <VersionBadge
        raised={phone}
        onOpen={() => {
          setSettingsOpen((x) => ({ id: 'versions', n: x.n + 1 }));
          setAdminTab('settings');
        }}
      />
    </div>
  );
}
