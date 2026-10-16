'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Product, Order, Customer, CourierSettings, CartItem, BedProfileMeasurement, BrandSettings, SmsGatewaySettings, BankTransferDetails, CatalogSettings, StoreSettings, ThemeSettings, EmailSettings, AssistantSettings, DeliverySettings, PhoneVerificationConfig } from '@/types';
import { DEFAULT_ASSISTANT, DEFAULT_CATALOG, DEFAULT_DELIVERY, DEFAULT_EMAIL_SETTINGS, DEFAULT_STORE, DEFAULT_THEME_SETTINGS } from '@/data/catalogDefaults';
import { askWhatsAppLink, piecesLeft, refreshCart, ShopProvider, type FestivalView, type ShopInfo } from '@/lib/client/shop';
import { captureLanding, decodeBag, type BagLine, type Landing } from '@/lib/client/landing';
import { useLiveUpdates } from '@/lib/client/live';
import { INITIAL_BANK_DETAILS, INITIAL_BRAND_SETTINGS, INITIAL_COURIER_SETTINGS, INITIAL_SMS_SETTINGS } from '@/data/initialData';
import { ADMIN_SIGNED_OUT_EVENT, getJson, postJson, sendJson } from '@/lib/apiClient';

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

/** Catalogue + public settings from the server (no React state here). */
async function fetchCatalog() {
  const [products, settings] = await Promise.all([
    getJson<{ products: Product[] }>('/api/products'),
    getJson<{ brand: BrandSettings; bank: BankTransferDetails; supportEmail?: string; store?: StoreSettings; catalog?: { categories: CatalogSettings['categories']; lowStockThreshold: number }; festival?: FestivalView | null; phoneVerification?: PhoneVerificationConfig; chat?: { name: string; greeting: string } | null; delivery?: DeliverySettings }>('/api/settings/public'),
  ]);
  return { products, settings };
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

const CART_KEY = 'buh_cart_v2';
const LAST_ORDER_KEY = 'buh_last_order';

/** The bag survives a reload: kept as ids, re-matched to the live catalogue (prices always from the server). */
function saveCart(cart: CartItem[]) {
  try {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify(cart.map((i) => ({ productId: i.product.id, profileId: i.selectedProfile.id, color: i.selectedColor, quantity: i.quantity })))
    );
  } catch {
    // storage blocked: the bag just won't survive a reload
  }
}

function loadCart(products: Product[], lines?: BagLine[]): CartItem[] {
  try {
    const saved = lines ?? (JSON.parse(localStorage.getItem(CART_KEY) || '[]') as BagLine[]);
    return saved.flatMap((s) => {
      const product = products.find((p) => p.id === s.productId);
      const profile = product?.profiles.find((p) => p.id === s.profileId);
      if (!product || !profile || !Number.isInteger(s.quantity) || s.quantity < 1) return [];
      const left = piecesLeft(product, profile.id);
      return [{ product, selectedProfile: profile, selectedColor: s.color, quantity: Math.max(1, Math.min(s.quantity, 20, left || 1)) }];
    });
  } catch {
    return [];
  }
}

// Store Components
import { BrandLogo, Header } from '@/components/common/Header';
import { MarqueeBar } from '@/components/common/MarqueeBar';
import { BottomNav } from '@/components/common/BottomNav';
import { HeroBanner } from '@/components/store/HeroBanner';
import { StoryChips } from '@/components/store/StoryChips';
import { FilterSheet } from '@/components/store/FilterSheet';
import { SearchSheet } from '@/components/store/SearchSheet';
import { ProductCard } from '@/components/store/ProductCard';
import { ProductDetailModal } from '@/components/store/ProductDetailModal';
import { CartDrawer } from '@/components/store/CartDrawer';
import { CheckoutModal } from '@/components/store/CheckoutModal';
import { OrderTrackerModal } from '@/components/store/OrderTrackerModal';

// Admin Components
import { AdminHeader } from '@/components/admin/AdminHeader';
import { AdminOrdersTab } from '@/components/admin/AdminOrdersTab';
import { AdminInventoryTab } from '@/components/admin/AdminInventoryTab';
import { AdminCrmTab } from '@/components/admin/AdminCrmTab';
import { AdminCouriersTab } from '@/components/admin/AdminCouriersTab';
import { AdminBrandingTab } from '@/components/admin/AdminBrandingTab';
import { AdminSmsTab } from '@/components/admin/AdminSmsTab';
import { AdminLoginModal } from '@/components/admin/AdminLoginModal';
import { BackupStatus } from '@/components/admin/BackupStatus';
import { RestoreNotice } from '@/components/admin/RestoreNotice';
import { CatalogSettingsCard } from '@/components/admin/settings/CatalogSettingsCard';
import { SettingsConsole } from '@/components/admin/settings/SettingsConsole';
import { StoreSettingsCard } from '@/components/admin/settings/StoreSettingsCard';
import { ThemeSettingsCard } from '@/components/admin/settings/ThemeSettingsCard';
import { SettingsHistoryCard } from '@/components/admin/settings/SettingsHistoryCard';
import { EmailSettingsCard } from '@/components/admin/settings/EmailSettingsCard';
import { SignInRecoveryCard } from '@/components/admin/settings/SignInRecoveryCard';
import { VersionsCard } from '@/components/admin/settings/VersionsCard';
import { AssistantSettingsCard } from '@/components/admin/settings/AssistantSettingsCard';
import { DeliverySettingsCard } from '@/components/admin/settings/DeliverySettingsCard';
import { AdminChatsTab } from '@/components/admin/AdminChatsTab';
import { HelpLauncher } from '@/components/store/HelpLauncher';
import { VersionBadge } from '@/components/common/VersionBadge';
import { SystemHealthCard } from '@/components/admin/settings/SystemHealthCard';

import { SlidersHorizontal, X } from 'lucide-react';
import { EMPTY_FILTERS, SORTS, activeChips, activeCount, applyFilters, buildStories, filtersToSearch, parseFilters, type Filters } from '@/lib/catalogFilter';

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Put new query keys in the address bar: push (Back returns to the view before) or replace. */
function writeSearch(search: string, mode: 'push' | 'replace') {
  const { pathname, hash } = window.location;
  const url = `${pathname}${search}${hash}`;
  if (url === `${pathname}${window.location.search}${hash}`) return;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

/**
 * The whole shop (storefront and admin hub) in one client app. Rendered at /
 * and at /p/<product id>, which opens that product straight away: the links
 * shared on WhatsApp and Instagram (they preview with the product photo).
 */
export function ShopApp({ initialProductId }: { initialProductId?: string } = {}) {
  // Theme state based on device settings

  // App Navigation & Modes
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [isAdminLoginOpen, setIsAdminLoginOpen] = useState(false);
  // From a password-reset email link (#reset=…).
  const [resetToken, setResetToken] = useState<string | null>(null);

  const [adminTab, setAdminTab] = useState<AdminTab>('orders');
  // The version badge opens Settings → Versions (re-creating the console on that section).
  const [settingsOpen, setSettingsOpen] = useState<{ id?: string; n: number }>({ n: 0 });
  // What the shop shows (search, filters, sort): mirrored in the address bar so it can be shared and Back works.
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  // The product sheet added a history entry (?p=…): closing it goes back, so the phone's Back button closes it too.
  const sheetPushed = useRef(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Core Data (all from the server)
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const productsRef = useRef<Product[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [brandSettings, setBrandSettings] = useState<BrandSettings>(INITIAL_BRAND_SETTINGS);
  const [bankDetails, setBankDetails] = useState<BankTransferDetails>(INITIAL_BANK_DETAILS);
  const [supportEmail, setSupportEmail] = useState<string | undefined>(undefined);
  // How checkout verifies phones (the shop's own SMS, or Firebase).
  const [phoneVerification, setPhoneVerification] = useState<PhoneVerificationConfig>({ method: 'server' });
  const [storeSettings, setStoreSettings] = useState<StoreSettings>(DEFAULT_STORE);
  const [lowStockThreshold, setLowStockThreshold] = useState(DEFAULT_CATALOG.lowStockThreshold);
  const [categories, setCategories] = useState(DEFAULT_CATALOG.categories);
  const [festival, setFestival] = useState<FestivalView | null>(null);
  const [chatInfo, setChatInfo] = useState<{ name: string; greeting: string } | null>(null);
  const [delivery, setDelivery] = useState<DeliverySettings>(DEFAULT_DELIVERY);
  // Admin Hub → Chats: conversations waiting for a person (badge), and a counter that reloads the tab.
  const [chatsWaiting, setChatsWaiting] = useState(0);
  const [chatsKey, setChatsKey] = useState(0);
  // Where this visitor first came from (Instagram, WhatsApp…), sent with the order.
  const [landing] = useState<Landing | null>(() => (typeof window === 'undefined' ? null : captureLanding()));
  // Pre-fills Track Order (only rendered once opened, so no server/client mismatch).
  const [lastOrderId, setLastOrderId] = useState(() => {
    try {
      return typeof window === 'undefined' ? '' : localStorage.getItem(LAST_ORDER_KEY) || '';
    } catch {
      return '';
    }
  });
  // Admin hub only
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
  // Settings forms copy their values once; they are re-created when the server's values first arrive
  // (not after the owner's own save, which would wipe the "Saved" message, nor on every refresh).
  const [publicSettingsLoaded, setPublicSettingsLoaded] = useState(false);
  const [adminSettingsLoaded, setAdminSettingsLoaded] = useState(false);
  // Bumped after a settings version is restored, so the forms show the restored values.
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  // Bumped per settings group by Undo, so only that form shows the restored values.
  const [undone, setUndone] = useState<Record<string, number>>({});

  // Modals & Drawers
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isTrackerOpen, setIsTrackerOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  // 2. Load the catalogue and branding, and check the admin session, on mount
  const applyCatalog = useCallback(({ products: res, settings }: Awaited<ReturnType<typeof fetchCatalog>>) => {
    if (res.ok) {
      productsRef.current = res.data.products;
      setProducts(res.data.products);
      setCatalogLoaded(true);
      // Latest prices and stock in the bag too (quantities capped to what is left).
      setCart((prev) => refreshCart(prev, res.data.products));
      setCatalogError('');
    } else {
      setCatalogError('The shop could not be loaded. Please check your connection and refresh.');
    }
    if (settings.ok) {
      setBrandSettings(settings.data.brand);
      setBankDetails(settings.data.bank);
      if (settings.data.supportEmail) setSupportEmail(settings.data.supportEmail);
      if (settings.data.phoneVerification) setPhoneVerification(settings.data.phoneVerification);
      if (settings.data.store) setStoreSettings(settings.data.store);
      setFestival(settings.data.festival ?? null);
      setChatInfo(settings.data.chat ?? null);
      if (settings.data.delivery) setDelivery(settings.data.delivery);
      if (settings.data.catalog) {
        setLowStockThreshold(settings.data.catalog.lowStockThreshold);
        setCategories(settings.data.catalog.categories);
      }
      setPublicSettingsLoaded(true);
    }
    return res.ok ? res.data.products : null;
  }, []);

  const loadCatalog = useCallback(async () => applyCatalog(await fetchCatalog()), [applyCatalog]);

  useEffect(() => {
    // A password-reset link: take the token out of the address bar at once, then ask for the new password.
    const reset = new URLSearchParams(window.location.hash.slice(1)).get('reset') || new URLSearchParams(window.location.search).get('reset');
    if (reset) {
      window.history.replaceState(null, '', window.location.pathname);
      void Promise.resolve().then(() => {
        setResetToken(reset);
        setIsAdminLoginOpen(true);
      });
    }
    void fetchCatalog().then((result) => {
      const list = applyCatalog(result);
      if (!list) return;
      const params = new URLSearchParams(window.location.search);
      // A shared view (?cat=…&size=…) opens as it was shared.
      setFilters(parseFilters(params));
      // A bag carried in a link (?bag=…) joins this browser's bag.
      const fromLink = loadCart(list, decodeBag(params.get('bag')));
      const saved = loadCart(list);
      const merged = [...saved];
      for (const line of fromLink) {
        if (!merged.some((m) => m.product.id === line.product.id && m.selectedProfile.id === line.selectedProfile.id && m.selectedColor === line.selectedColor)) merged.push(line);
      }
      setCart(refreshCart(merged, list));
      if (fromLink.length) setIsCartOpen(true);
      // A product link (/p/<id> or ?p=<id>) opens that product.
      const wanted = params.get('p') || initialProductId;
      const product = wanted ? list.find((p) => p.id === wanted) : undefined;
      if (product) setSelectedProduct(product);
      if (params.has('bag')) {
        params.delete('bag');
        const rest = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
      }
    });
    try {
      // Old builds kept data and a forgeable admin flag in the browser: clear them.
      for (const key of ['buh_admin_auth', 'buh_admin_creds', 'buh_products_v1', 'buh_orders_v1', 'buh_customers_v1', 'buh_courier_settings_v1', 'buh_bank_details_v1', 'buh_brand_settings_v1', 'buh_sms_settings_v1']) {
        localStorage.removeItem(key);
      }
    } catch {
      // storage unavailable (private mode): nothing to clean up
    }

    // Admin sign-in lives in an HttpOnly cookie the server checks; ask it.
    let cancelled = false;
    fetch('/api/admin/session', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setIsAdminAuthenticated(data.authenticated === true && !data.mustChangePassword);
      })
      .catch(() => {});

    const onSignedOut = () => {
      setIsAdminAuthenticated(false);
      setIsAdminMode(false);
      setIsAdminLoginOpen(true);
    };
    window.addEventListener(ADMIN_SIGNED_OUT_EVENT, onSignedOut);
    return () => {
      cancelled = true;
      window.removeEventListener(ADMIN_SIGNED_OUT_EVENT, onSignedOut);
    };
  }, [applyCatalog, initialProductId]);

  // The bag survives a reload.
  useEffect(() => {
    if (products.length) saveCart(cart);
  }, [cart, products.length]);

  // 3. Admin hub data, loaded once signed in and refreshed every minute while open.
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

  // Live updates: changes made anywhere (a sale, a price, a setting) show on open pages within seconds,
  // reloading only the data: the bag, an open product and half-filled forms stay as they are.
  const [updateReady, setUpdateReady] = useState(false);
  const [newOrderNotice, setNewOrderNotice] = useState(false);
  // Several changes in a row (e.g. tapping + on stock) give one reload.
  const reloadTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debounced = useCallback((key: string, fn: () => void) => {
    clearTimeout(reloadTimers.current[key]);
    reloadTimers.current[key] = setTimeout(fn, 400);
  }, []);
  useLiveUpdates(isAdminMode && isAdminAuthenticated ? null : '/api/events', {
    onCatalog: () => debounced('catalog', () => void loadCatalog()),
    onSettings: () => debounced('catalog', () => void loadCatalog()),
    onNewVersion: () => setUpdateReady(true),
  });
  useLiveUpdates(isAdminMode && isAdminAuthenticated ? '/api/admin/events' : null, {
    onCatalog: () => debounced('admin', () => void Promise.all([loadAdminData(), loadCatalog()])),
    onSettings: () => debounced('admin', () => void Promise.all([loadAdminData(), loadCatalog()])),
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
  // A new version of the shop was installed: switch over unnoticed when the page is in the
  // background (the bag is saved), never in the middle of a checkout.
  useEffect(() => {
    if (!updateReady) return;
    // Only a shopper's page with nothing open: never the admin hub (unsaved edits) or an open product or bag.
    const busy = isAdminMode || isCheckoutOpen || isCartOpen || isTrackerOpen || selectedProduct !== null;
    if (busy) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden') window.location.reload();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [updateReady, isAdminMode, isCheckoutOpen, isCartOpen, isTrackerOpen, selectedProduct]);

  useEffect(() => {
    if (!isAdminAuthenticated) return;
    void fetchAdminData().then(applyAdminData);
    if (!isAdminMode) return;
    const t = setInterval(() => void fetchAdminData().then(applyAdminData), 60_000);
    return () => clearInterval(t);
  }, [isAdminAuthenticated, isAdminMode, applyAdminData]);

  /** Save one settings group on the server; resolves to an error message or null. */
  const saveSettings = async (key: 'brand' | 'bank' | 'courier' | 'sms' | 'catalog' | 'store' | 'theme' | 'email' | 'assistant' | 'delivery', settings: unknown): Promise<string | null> => {
    const { ok, data } = await sendJson<{ message?: string }>('PUT', `/api/admin/settings/${key}`, { settings });
    if (!ok) return data.message || 'Could not save. Please try again.';
    await Promise.all([loadAdminData(), key === 'brand' || key === 'bank' || key === 'catalog' || key === 'store' || key === 'theme' || key === 'assistant' || key === 'delivery' ? loadCatalog() : Promise.resolve(null)]);
    return null;
  };

  // Settings save themselves (autosave): reload what the hub and the shop show; after Undo, re-create the forms.
  const autoSaveHooks = {
    onSaved: async () => {
      await Promise.all([loadAdminData(), loadCatalog()]);
    },
    // Only the section whose settings were restored is re-created (others may hold unsaved typing).
    onUndone: (key: string) => setUndone((u) => ({ ...u, [key]: (u[key] ?? 0) + 1 })),
  };

  const handleUpdateBrandSettings = (newSettings: BrandSettings) => saveSettings('brand', newSettings);
  const handleUpdateBank = (bank: BankTransferDetails) => saveSettings('bank', bank);
  const handleUpdateSmsSettings = (newSettings: SmsGatewaySettings) => saveSettings('sms', newSettings);
  const handleUpdateSettings = (newSettings: CourierSettings) => saveSettings('courier', newSettings);

  const handleToggleAdminMode = () => {
    if (isAdminMode) {
      setIsAdminMode(false);
    } else {
      if (isAdminAuthenticated) {
        setIsAdminMode(true);
      } else {
        setIsAdminLoginOpen(true);
      }
    }
  };

  const handleLogoutAdmin = () => {
    void postJson('/api/admin/logout', {});
    setIsAdminAuthenticated(false);
    setIsAdminMode(false);
  };

  // Cart Handlers
  const handleAddToCart = (product: Product, profile: BedProfileMeasurement, color: string, quantity: number) => {
    setCart((prev) => {
      // Never more in the bag than there are pieces of this size (across colours).
      const left = piecesLeft(product, profile.id);
      const inBag = prev.filter((i) => i.product.id === product.id && i.selectedProfile.id === profile.id).reduce((n, i) => n + i.quantity, 0);
      const add = Math.min(quantity, Math.max(0, left - inBag));
      if (add === 0) return prev;
      const existingIdx = prev.findIndex(
        (i) => i.product.id === product.id && i.selectedProfile.id === profile.id && i.selectedColor === color
      );
      if (existingIdx >= 0) {
        return prev.map((i, n) => (n === existingIdx ? { ...i, quantity: i.quantity + add } : i));
      }
      return [...prev, { product, selectedProfile: profile, selectedColor: color, quantity: add }];
    });
    setIsCartOpen(true);
  };

  const handleUpdateQuantity = (idx: number, newQty: number) => {
    if (newQty <= 0) {
      handleRemoveFromCart(idx);
      return;
    }
    setCart((prev) =>
      prev.map((item, n) => {
        if (n !== idx) return item;
        const others = prev.filter((i, m) => m !== idx && i.product.id === item.product.id && i.selectedProfile.id === item.selectedProfile.id).reduce((t, i) => t + i.quantity, 0);
        return { ...item, quantity: Math.max(1, Math.min(newQty, piecesLeft(item.product, item.selectedProfile.id) - others)) };
      })
    );
  };

  const handleRemoveFromCart = (idx: number) => {
    setCart((prev) => prev.filter((_, i) => i !== idx));
  };

  // Order Handlers
  const handleOrderPlaced = (newOrder: Order) => {
    setCart([]);
    setLastOrderId(newOrder.id);
    try {
      localStorage.setItem(LAST_ORDER_KEY, newOrder.id);
    } catch {
      // not essential
    }
    // Stock changed: refresh the catalogue.
    void loadCatalog();
    if (isAdminAuthenticated) void loadAdminData();
  };

  const handleOrderChanged = (changed: Order) => {
    setOrders((prev) => prev.map((o) => (o.id === changed.id ? changed : o)));
    void loadAdminData(); // customers and stock may have changed too
  };

  const shopInfo = useMemo<ShopInfo>(
    () => ({ store: storeSettings, lowStockThreshold, supportEmail: supportEmail || 'orders@beautifuluaehome.com', festival, chat: chatInfo, delivery }),
    [storeSettings, lowStockThreshold, supportEmail, festival, chatInfo, delivery]
  );

  // The storefront: what the search, filters and sort leave, and the round "story" chips.
  const filteredProducts = useMemo(() => applyFilters(products, filters, categories), [products, filters, categories]);
  const stories = useMemo(() => buildStories(products, categories), [products, categories]);
  const activeStory = stories.find((s) => s.isActive(filters))?.id ?? null;
  const chips = useMemo(() => activeChips(filters, products, categories), [filters, products, categories]);
  const filterCount = activeCount(filters);

  /** Show other products: a new step in the browser's history (Back returns to this view). */
  const showFilters = useCallback((next: Filters, mode: 'push' | 'replace' = 'push') => {
    setFilters(next);
    writeSearch(filtersToSearch(next, window.location.search), mode);
    // If the shopper had scrolled past the top of the products, start them at the top of the new list.
    const top = resultsRef.current?.getBoundingClientRect().top;
    if (top !== undefined && top < 0) resultsRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }, []);

  const openProduct = useCallback((product: Product) => {
    setSelectedProduct(product);
    const params = new URLSearchParams(window.location.search);
    if (params.get('p') === product.id) return;
    params.set('p', product.id);
    writeSearch(`?${params}`, 'push');
    sheetPushed.current = true;
  }, []);

  const closeProduct = useCallback(() => {
    setSelectedProduct(null);
    if (sheetPushed.current) {
      sheetPushed.current = false;
      window.history.back();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    if (!params.has('p')) return;
    params.delete('p');
    const rest = params.toString();
    writeSearch(rest ? `?${rest}` : '', 'replace');
  }, []);

  // Back and Forward: the view and the open product follow the address bar.
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      setFilters(parseFilters(params));
      const id = params.get('p');
      const product = id ? productsRef.current.find((p) => p.id === id) ?? null : null;
      sheetPushed.current = Boolean(product);
      setSelectedProduct(product);
      setFilterOpen(false);
      setSearchOpen(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const goHome = useCallback(() => {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const totalCartCount = cart.reduce((sum, i) => sum + i.quantity, 0);
  const pendingOrdersCount = orders.filter((o) => o.status === 'pending_confirmation').length;

  return (
    <ShopProvider value={shopInfo}>
    <div className="min-h-screen flex flex-col font-sans">
      {updateReady && (
        <div role="status" className="bg-[#0f1c2e] text-white text-xs px-3 py-1.5 flex items-center justify-center gap-3">
          <span>The shop has been updated.</span>
          <button type="button" className="font-bold underline" onClick={() => window.location.reload()}>Refresh</button>
          <span className="opacity-60 hidden sm:inline">(your bag is kept)</span>
        </div>
      )}
      {/* Header */}
      {isAdminMode ? (
        <AdminHeader
          orders={orders}
          products={products}
          customers={customers}
          onExitAdmin={() => setIsAdminMode(false)}
          onLogoutAdmin={handleLogoutAdmin}
          brandSettings={brandSettings}
        />
      ) : (
        <>
        <MarqueeBar brandSettings={brandSettings} />
        <Header
          cartCount={totalCartCount}
          onHome={goHome}
          onOpenCart={() => setIsCartOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenTrack={() => setIsTrackerOpen(true)}
          isAdminMode={isAdminMode}
          onToggleAdminMode={handleToggleAdminMode}
          pendingOrdersCount={pendingOrdersCount}
          brandSettings={brandSettings}
        />
        </>
      )}

      {/* Main Content Area (on phones, room at the bottom for the tab bar and the Help button) */}
      <main className={`flex-1 max-w-7xl mx-auto w-full ${isAdminMode ? 'pb-20 px-3 sm:px-6' : 'pb-20 md:pb-16 px-4 sm:px-6'}`}>
        {isAdminMode ? (
          /* ================= ADMIN MOBILE HUB ================= */
          <div className="py-4 space-y-4">
            {/* Admin Desktop/Tablet Navigation Tabs */}
            <div className="hidden sm:flex items-center gap-2 border-b border-stone-200 pb-2 overflow-x-auto no-scrollbar">
              {[
                { id: 'orders', label: 'Orders & Dispatches', badge: pendingOrdersCount },
                { id: 'chats', label: 'Chats', badge: chatsWaiting },
                { id: 'add-product', label: '+ Add Product' },
                { id: 'inventory', label: 'Inventory Stock' },
                { id: 'crm', label: 'Customers & CRM' },
                { id: 'settings', label: '⚙️ Settings' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setAdminTab(tab.id as typeof adminTab)}
                  className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 ${
                    adminTab === tab.id
                      ? 'bg-[#0f1c2e] text-white shadow-sm'
                      : 'bg-white text-stone-700 hover:bg-stone-100 border border-stone-200'
                  }`}
                >
                  <span>{tab.label}</span>
                  {tab.badge && tab.badge > 0 ? (
                    <span className="w-4 h-4 rounded-full bg-amber-400 text-stone-900 text-[10px] font-bold flex items-center justify-center">
                      {tab.badge}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>

            {newOrderNotice && (
              <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-3.5 py-2.5 text-xs flex items-center gap-2">
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
            {adminLoadError && (
              <p role="alert" className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{adminLoadError}</p>
            )}

            {/* Active Admin Tab Content */}
            {adminTab === 'orders' && (
              <AdminOrdersTab
                orders={orders}
                onOrderChanged={handleOrderChanged}
                courierSettings={adminSettings.courier.value}
              />
            )}

            {(adminTab === 'add-product' || adminTab === 'inventory') && (
              <AdminInventoryTab
                key={adminTab}
                startAdding={adminTab === 'add-product'}
                products={adminProducts}
                catalog={adminSettings.catalog.value}
                onChanged={async () => {
                  await Promise.all([loadAdminData(), loadCatalog()]);
                }}
              />
            )}

            {adminTab === 'chats' && <AdminChatsTab refreshKey={chatsKey} />}

            {adminTab === 'crm' && (
              <AdminCrmTab customers={customers} orders={orders} />
            )}

            {adminTab === 'settings' && (
              <SettingsConsole
                key={settingsOpen.n}
                openId={settingsOpen.id}
                sections={[
                  {
                    id: 'store',
                    label: 'Store & contact',
                    icon: '🏬',
                    hint: 'WhatsApp, email, social accounts, address and currency display.',
                    content: <StoreSettingsCard key={`store-${adminSettingsLoaded}-${settingsEpoch}-${undone['store'] ?? 0}`} value={adminSettings.store.value} onSave={(v) => saveSettings('store', v)} auto={autoSaveHooks} />,
                  },
                  {
                    id: 'catalog',
                    label: 'Catalogue',
                    icon: '📐',
                    hint: 'Size presets, categories and the low-stock warning.',
                    content: <CatalogSettingsCard key={`catalog-${adminSettingsLoaded}-${settingsEpoch}-${undone['catalog'] ?? 0}`} value={adminSettings.catalog.value} onSave={(v) => saveSettings('catalog', v)} auto={autoSaveHooks} />,
                  },
                  {
                    id: 'branding',
                    label: 'Branding & bank',
                    icon: '🎨',
                    hint: 'Logo, colours, the marquee and bank-transfer details.',
                    content: (
                      <AdminBrandingTab
                        key={`branding-${publicSettingsLoaded}-${settingsEpoch}-${undone['brand'] ?? 0}-${undone['bank'] ?? 0}`}
                        brandSettings={brandSettings}
                        onUpdateBrandSettings={handleUpdateBrandSettings}
                        bank={bankDetails}
                        onUpdateBank={handleUpdateBank}
                        auto={autoSaveHooks}
                      />
                    ),
                  },
                  {
                    id: 'themes',
                    label: 'Festival themes',
                    icon: '🎉',
                    hint: 'Eid, Diwali, Christmas, Lunar New Year and 30 more: picked automatically, or chosen by you.',
                    content: <ThemeSettingsCard key={`theme-${adminSettingsLoaded}-${settingsEpoch}`} value={adminSettings.theme.value} onSave={(v) => saveSettings('theme', v)} />,
                  },
                  {
                    id: 'sms',
                    label: 'Phone verification',
                    icon: '📱',
                    hint: 'The SMS gateway that sends checkout codes.',
                    content: (
                      <AdminSmsTab
                        key={`sms-${adminSettingsLoaded}-${settingsEpoch}-${undone['sms'] ?? 0}`}
                        smsSettings={adminSettings.sms.value}
                        secretsSet={adminSettings.sms.secretsSet}
                        onUpdateSmsSettings={handleUpdateSmsSettings}
                        auto={autoSaveHooks}
                      />
                    ),
                  },
                  {
                    id: 'couriers',
                    label: 'Couriers',
                    icon: '🚚',
                    hint: 'Jeebly and Eco Express keys, pickup details and routing.',
                    content: (
                      <AdminCouriersTab
                        key={`couriers-${adminSettingsLoaded}-${settingsEpoch}-${undone['courier'] ?? 0}`}
                        settings={adminSettings.courier.value}
                        secretsSet={adminSettings.courier.secretsSet}
                        onUpdateSettings={handleUpdateSettings}
                        auto={autoSaveHooks}
                      />
                    ),
                  },
                  {
                    id: 'delivery',
                    label: 'Delivery',
                    icon: '📦',
                    hint: 'Where you deliver, the time customers see, and same-day delivery with its charge.',
                    content: <DeliverySettingsCard key={`delivery-${adminSettingsLoaded}-${settingsEpoch}-${undone['delivery'] ?? 0}`} value={adminSettings.delivery.value} onSave={(v) => saveSettings('delivery', v)} auto={autoSaveHooks} />,
                  },
                  {
                    id: 'assistant',
                    label: 'Chat assistant',
                    icon: '💬',
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
                    icon: '✉️',
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
                    id: 'signin',
                    label: 'Passkeys & recovery codes',
                    icon: '🔑',
                    hint: 'Ways back in if you forget your password: a passkey on your phone, and one-time recovery codes.',
                    content: <SignInRecoveryCard />,
                  },
                  {
                    id: 'versions',
                    label: 'Versions',
                    icon: '🕘',
                    hint: 'Every release and what changed; switch to any of them without closing the shop.',
                    content: <VersionsCard />,
                  },
                  {
                    id: 'system',
                    label: 'System & backups',
                    icon: '🛡️',
                    hint: 'Backups, earlier versions of the settings, version and health.',
                    content: (
                      <div className="space-y-3 text-xs text-stone-700">
                        <SystemHealthCard />
                        <BackupStatus />
                        <SettingsHistoryCard
                          onRestored={() =>
                            void Promise.all([loadAdminData(), loadCatalog()]).then(() => setSettingsEpoch((n) => n + 1))
                          }
                        />
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
        ) : (
          /* ================= CUSTOMER STOREFRONT ================= */
          <div className="pt-4 sm:pt-6 space-y-5">
            <HeroBanner brand={brandSettings} pieces={catalogLoaded ? products.length : null} />

            <StoryChips
              stories={stories}
              activeId={activeStory}
              onPick={(story) => showFilters(story.apply(filters))}
              logo={<BrandLogo brand={brandSettings} className="w-16 h-16 text-xl" />}
            />

            <div ref={resultsRef} className="scroll-mt-16 space-y-3">
              {/* Count, and Filter (a bottom sheet) only when wanted */}
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-stone-700" aria-live="polite">
                  {catalogLoaded ? `${filteredProducts.length} ${filteredProducts.length === 1 ? 'piece' : 'pieces'}` : ''}
                </p>
                <button
                  type="button"
                  onClick={() => setFilterOpen(true)}
                  aria-haspopup="dialog"
                  aria-label={filterCount ? `Filter and sort, ${filterCount} on` : 'Filter and sort'}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-stone-300 bg-white text-sm font-medium text-stone-900 hover:border-stone-500"
                >
                  <SlidersHorizontal className="w-4 h-4" aria-hidden="true" />
                  <span>Filter</span>
                  {filterCount > 0 && (
                    <span className="min-w-5 h-5 px-1 rounded-full bg-[#0f1c2e] text-white text-[11px] font-bold flex items-center justify-center" aria-hidden="true">
                      {filterCount}
                    </span>
                  )}
                </button>
              </div>

              {(chips.length > 0 || filters.sort !== 'featured') && (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters on">
                  {chips.map((chip) => (
                    <button
                      key={chip.key}
                      type="button"
                      onClick={() => showFilters(chip.without)}
                      aria-label={`Remove filter: ${chip.label}`}
                      className="inline-flex items-center gap-1 pl-3 pr-2 h-8 rounded-full bg-[#f4eee3] border border-[#e4dccd] text-xs font-medium text-stone-900 hover:border-stone-400 max-w-full"
                    >
                      <span className="truncate">{chip.label}</span>
                      <X className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    </button>
                  ))}
                  {filters.sort !== 'featured' && (
                    <button
                      type="button"
                      onClick={() => showFilters({ ...filters, sort: 'featured' })}
                      aria-label={`Remove sort: ${SORTS.find((x) => x.id === filters.sort)?.label}`}
                      className="inline-flex items-center gap-1 pl-3 pr-2 h-8 rounded-full bg-white border border-stone-300 text-xs font-medium text-stone-900 hover:border-stone-500"
                    >
                      <span>{SORTS.find((x) => x.id === filters.sort)?.label}</span>
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                  {chips.length + (filters.sort !== 'featured' ? 1 : 0) > 1 && (
                    <button type="button" onClick={() => showFilters(EMPTY_FILTERS)} className="h-8 px-2 text-xs font-semibold text-stone-900 underline underline-offset-4">
                      Clear all
                    </button>
                  )}
                </div>
              )}

              {catalogError && (
                <p role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{catalogError}</p>
              )}

              {/* The feed: big photos, two across on phones */}
              {!catalogLoaded && !catalogError ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-6 sm:gap-x-5" aria-hidden="true">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="space-y-2">
                      <div className="aspect-[4/5] rounded-2xl bg-[#efe8dc] motion-safe:animate-pulse" />
                      <div className="h-3 rounded bg-[#efe8dc] w-4/5" />
                      <div className="h-3 rounded bg-[#efe8dc] w-1/3" />
                    </div>
                  ))}
                </div>
              ) : filteredProducts.length > 0 ? (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-6 sm:gap-x-5">
                  {filteredProducts.map((prod, i) => (
                    <ProductCard key={prod.id} product={prod} onSelect={openProduct} eager={i < 4} />
                  ))}
                </div>
              ) : catalogLoaded ? (
                <div className="rounded-2xl border border-dashed border-stone-300 px-4 py-10 text-center space-y-3">
                  <p className="text-sm text-stone-800">{products.length ? 'Nothing matches these filters.' : 'New pieces are on their way. Please check back soon.'}</p>
                  {products.length > 0 && (
                    <button type="button" onClick={() => showFilters(EMPTY_FILTERS)} className="rounded-full bg-[#0f1c2e] text-white text-sm font-semibold px-5 py-2.5">
                      Show everything
                    </button>
                  )}
                </div>
              ) : null}
            </div>

            {/* The shop's promise */}
            <div className="rounded-3xl bg-[#f4eee3] px-5 py-7 sm:p-8 text-center my-6 space-y-2">
              <h2 className="font-serif text-lg sm:text-xl font-bold text-[#0f1c2e]">The {brandSettings.storeName || 'Beautiful UAE Home'} promise</h2>
              <p className="text-stone-700 text-[13px] sm:text-sm max-w-xl mx-auto leading-relaxed">
                Every set is made with slow handcraft, fitted for deep Gulf mattresses, and delivered to your door in all seven emirates, with cash on delivery or bank transfer.
              </p>
            </div>

            {/* The version: in the footer on phones (never over the feed), bottom left on wider screens */}
            <footer className="pb-2">
              <VersionBadge inFooter />
            </footer>
          </div>
        )}
      </main>

      {/* Search: matches as you type */}
      {searchOpen && (
        <SearchSheet
          products={products}
          categories={categories}
          initial={filters.q}
          onClose={() => setSearchOpen(false)}
          onSubmit={(q) => {
            setSearchOpen(false);
            showFilters({ ...filters, q });
          }}
          onOpenProduct={(p) => {
            setSearchOpen(false);
            openProduct(p);
          }}
        />
      )}

      {/* Filter & sort */}
      {filterOpen && (
        <FilterSheet products={products} categories={categories} filters={filters} onApply={(next) => showFilters(next)} onClose={() => setFilterOpen(false)} />
      )}

      {/* Product Detail Modal */}
      <ProductDetailModal
        product={selectedProduct ? products.find((p) => p.id === selectedProduct.id) ?? selectedProduct : null}
        onClose={closeProduct}
        onAddToCart={handleAddToCart}
      />

      {/* Cart Drawer */}
      <CartDrawer
        isOpen={isCartOpen}
        onClose={() => setIsCartOpen(false)}
        items={cart}
        onUpdateQuantity={handleUpdateQuantity}
        onRemoveItem={handleRemoveFromCart}
        onCheckout={() => setIsCheckoutOpen(true)}
      />

      {/* Checkout Modal */}
      {/* Mounted only while open, so every checkout starts fresh (a second order is not stuck on the first's confirmation). */}
      {isCheckoutOpen && <CheckoutModal
        isOpen={isCheckoutOpen}
        onClose={() => setIsCheckoutOpen(false)}
        items={cart}
        bank={bankDetails}
        supportEmail={supportEmail}
        phoneVerification={phoneVerification}
        landing={landing}
        onOrderPlaced={handleOrderPlaced}
        onPricesChanged={async () => {
          const list = await loadCatalog();
          if (list) setCart(refreshCart(loadCart(list), list));
        }}
      />}

      {/* Order Tracking Modal */}
      {isTrackerOpen && (
        <OrderTrackerModal isOpen={isTrackerOpen} onClose={() => setIsTrackerOpen(false)} lastOrderId={lastOrderId} />
      )}

      {/* Mobile Bottom Navigation */}
      <BottomNav
        isAdminMode={isAdminMode}
        storeTab={searchOpen ? 'search' : 'home'}
        onHome={goHome}
        onOpenSearch={() => setSearchOpen(true)}
        adminTab={adminTab}
        onSetAdminTab={setAdminTab}
        cartCount={totalCartCount}
        onOpenCart={() => setIsCartOpen(true)}
        onOpenTrack={() => setIsTrackerOpen(true)}
        onToggleAdminMode={handleToggleAdminMode}
        pendingOrdersCount={pendingOrdersCount}
        chatsWaiting={chatsWaiting}
        helpSlot={Boolean(chatInfo) || Boolean(storeSettings.showWhatsAppButton && askWhatsAppLink(storeSettings, ''))}
      />

      {/* Admin Login Modal */}
      <AdminLoginModal
        isOpen={isAdminLoginOpen}
        onClose={() => setIsAdminLoginOpen(false)}
        onLoginSuccess={() => {
          setIsAdminAuthenticated(true);
          setIsAdminMode(true);
        }}
        resetToken={resetToken}
        onResetDone={() => setResetToken(null)}
      />
      {!isAdminMode && <HelpLauncher />}
      {isAdminMode && (
        <VersionBadge
          raised
          onOpen={() => {
            setSettingsOpen((x) => ({ id: 'versions', n: x.n + 1 }));
            setAdminTab('settings');
          }}
        />
      )}
    </div>
    </ShopProvider>
  );
}
