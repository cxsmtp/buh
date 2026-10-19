'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Product, Order, CartItem, BedProfileMeasurement, BrandSettings, CatalogSettings, StoreSettings, DeliverySettings, PhoneVerificationConfig } from '@/types';
import { DEFAULT_CATALOG, DEFAULT_DELIVERY, DEFAULT_STORE } from '@/data/catalogDefaults';
import { askWhatsAppLink, piecesLeft, refreshCart, ShopProvider, type FestivalView, type ShopInfo } from '@/lib/client/shop';
import { captureLanding, decodeBag, type BagLine, type Landing } from '@/lib/client/landing';
import { useLiveUpdates } from '@/lib/client/live';
import { INITIAL_BRAND_SETTINGS } from '@/data/initialData';
import { getJson } from '@/lib/apiClient';
import { applyUpdate, checkForUpdate, registerServiceWorker, useUpdateWaiting } from '@/lib/client/pwa';

/** Catalogue + public settings from the server (no React state here). */
async function fetchCatalog() {
  const [products, settings] = await Promise.all([
    getJson<{ products: Product[] }>('/api/products'),
    getJson<{ brand: BrandSettings; bankTransfer?: boolean; bankTransferMode?: 'send_details' | 'ask_whatsapp' | null; supportEmail?: string; store?: StoreSettings; catalog?: { categories: CatalogSettings['categories']; lowStockThreshold: number }; festival?: FestivalView | null; phoneVerification?: PhoneVerificationConfig; chat?: { name: string; greeting: string } | null; delivery?: DeliverySettings; vat?: { addedPercent?: number }; payments?: { card: boolean; publishableKey?: string; phoneCheck?: boolean; cardFeePercent?: number } }>('/api/settings/public'),
  ]);
  return { products, settings };
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
      // A product without colours has no colour choice (an older bag may still name one).
      return [{ product, selectedProfile: profile, selectedColor: product.colors.length ? s.color : undefined, quantity: Math.max(1, Math.min(s.quantity, 20, left || 1)) }];
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

import { HelpLauncher } from '@/components/store/HelpLauncher';
import { InstallPrompt } from '@/components/store/InstallPrompt';
import { THEME_COLOR } from '@/lib/design/tokens';
import { VersionBadge } from '@/components/common/VersionBadge';

import { SlidersHorizontal, X } from 'lucide-react';
import { festiveVars } from '@/components/store/FestiveGreeting';
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
 * The storefront, one client app. Rendered at / and at /p/<product id>, which
 * opens that product straight away: the links shared on WhatsApp and Instagram
 * (they preview with the product photo). The Admin Hub is not here: it is its
 * own page at the owner's private link (src/lib/server/frontGate.ts), so nothing in the shop's
 * pages or scripts leads to it.
 */
export function ShopApp({ initialProductId }: { initialProductId?: string } = {}) {
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
  // Checkout offers bank transfer (the account itself is never sent to the website).
  const [bankTransfer, setBankTransfer] = useState(false);
  // How: our details sent automatically, or the customer asks for them on WhatsApp (no account saved).
  const [bankAskWhatsApp, setBankAskWhatsApp] = useState(false);
  const [supportEmail, setSupportEmail] = useState<string | undefined>(undefined);
  // How checkout verifies phones (the shop's own SMS, or Firebase).
  const [phoneVerification, setPhoneVerification] = useState<PhoneVerificationConfig>({ method: 'server' });
  const [storeSettings, setStoreSettings] = useState<StoreSettings>(DEFAULT_STORE);
  const [lowStockThreshold, setLowStockThreshold] = useState(DEFAULT_CATALOG.lowStockThreshold);
  const [categories, setCategories] = useState(DEFAULT_CATALOG.categories);
  const [festival, setFestival] = useState<FestivalView | null>(null);
  const [chatInfo, setChatInfo] = useState<{ name: string; greeting: string } | null>(null);
  const [delivery, setDelivery] = useState<DeliverySettings>(DEFAULT_DELIVERY);
  const [vatAddedPercent, setVatAddedPercent] = useState(0);
  // Card payments (Settings → Payments): Stripe's publishable key when switched on.
  const [cardPayments, setCardPayments] = useState<{ publishableKey: string; phoneCheck?: boolean; cardFeePercent?: number } | null>(null);
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
  // Modals & Drawers
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isTrackerOpen, setIsTrackerOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  // Load the catalogue and branding on mount
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
      setBankTransfer(settings.data.bankTransfer === true);
      setBankAskWhatsApp(settings.data.bankTransferMode === 'ask_whatsapp');
      if (settings.data.supportEmail) setSupportEmail(settings.data.supportEmail);
      if (settings.data.phoneVerification) setPhoneVerification(settings.data.phoneVerification);
      if (settings.data.store) setStoreSettings(settings.data.store);
      setFestival(settings.data.festival ?? null);
      setChatInfo(settings.data.chat ?? null);
      if (settings.data.delivery) setDelivery(settings.data.delivery);
      setVatAddedPercent(Number(settings.data.vat?.addedPercent) || 0);
      const pay = settings.data.payments;
      setCardPayments(pay?.card && pay.publishableKey ? { publishableKey: pay.publishableKey, cardFeePercent: Number(pay.cardFeePercent) || 0, ...(pay.phoneCheck ? { phoneCheck: true } : {}) } : null);
      if (settings.data.catalog) {
        setLowStockThreshold(settings.data.catalog.lowStockThreshold);
        setCategories(settings.data.catalog.categories);
      }
    }
    return res.ok ? res.data.products : null;
  }, []);

  const loadCatalog = useCallback(async () => applyCatalog(await fetchCatalog()), [applyCatalog]);

  useEffect(() => {
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
      // The installed app's shortcuts (long-press the icon): Bag and Track Order.
      const shortcut = params.get('open');
      if (shortcut === 'bag') setIsCartOpen(true);
      else if (shortcut === 'track') setIsTrackerOpen(true);
      if (params.has('bag') || shortcut) {
        params.delete('bag');
        params.delete('open');
        const rest = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
      }
    });
    try {
      // Old builds kept data in the browser: clear it.
      for (const key of ['buh_products_v1', 'buh_orders_v1', 'buh_customers_v1', 'buh_courier_settings_v1', 'buh_bank_details_v1', 'buh_brand_settings_v1', 'buh_sms_settings_v1']) {
        localStorage.removeItem(key);
      }
    } catch {
      // storage unavailable (private mode): nothing to clean up
    }

    // The service worker: fast repeat opens, an offline page, installable as an app (src/lib/serviceWorker.ts).
    registerServiceWorker();
  }, [applyCatalog, initialProductId]);

  // The bag survives a reload.
  useEffect(() => {
    if (products.length) saveCart(cart);
  }, [cart, products.length]);

  // Live updates: changes made anywhere (a sale, a price, a setting) show on open pages within seconds,
  // reloading only the data: the bag, an open product and half-filled forms stay as they are.
  const [updateReady, setUpdateReady] = useState(false);
  // Several changes in a row (e.g. tapping + on stock) give one reload.
  const reloadTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debounced = useCallback((key: string, fn: () => void) => {
    clearTimeout(reloadTimers.current[key]);
    reloadTimers.current[key] = setTimeout(fn, 400);
  }, []);
  useLiveUpdates('/api/events', {
    onCatalog: () => debounced('catalog', () => void loadCatalog()),
    onSettings: () => debounced('catalog', () => void loadCatalog()),
    onNewVersion: () => {
      setUpdateReady(true);
      checkForUpdate();
    },
  });
  // The service worker of a new version has arrived and waits for the go-ahead.
  const workerWaiting = useUpdateWaiting();
  const newVersion = updateReady || workerWaiting;
  // A new version of the shop was installed: switch over unnoticed when the page is in the
  // background (the bag is saved), never in the middle of a checkout.
  useEffect(() => {
    if (!newVersion) return;
    // Only with nothing open: never in the middle of a checkout, an open product or the bag.
    const busy = isCheckoutOpen || isCartOpen || isTrackerOpen || selectedProduct !== null;
    if (busy) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden') applyUpdate();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [newVersion, isCheckoutOpen, isCartOpen, isTrackerOpen, selectedProduct]);

  // The phone's status bar (and the installed app's title bar) takes the festival's colour while
  // a festival's look is on, else the shop's ink.
  useEffect(() => {
    const color = festival?.festivalId ? festival.theme.bar : THEME_COLOR;
    let metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (!metas.length) {
      const m = document.createElement('meta');
      m.name = 'theme-color';
      document.head.appendChild(m);
      metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    }
    metas.forEach((m) => {
      m.content = color;
    });
  }, [festival]);

  // Cart Handlers
  const handleAddToCart = (product: Product, profile: BedProfileMeasurement, colorName: string, quantity: number) => {
    const color = colorName || undefined; // no colour choice on this product
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
  };

  const shopInfo = useMemo<ShopInfo>(
    () => ({ store: storeSettings, lowStockThreshold, supportEmail: supportEmail || 'orders@beautifuluaehome.com', festival, chat: chatInfo, delivery, ...(vatAddedPercent ? { vatAddedPercent } : {}) }),
    [storeSettings, lowStockThreshold, supportEmail, festival, chatInfo, delivery, vatAddedPercent]
  );

  // The storefront: what the search, filters and sort leave, and the round "story" chips.
  const filteredProducts = useMemo(() => applyFilters(products, filters, categories), [products, filters, categories]);
  const stories = useMemo(() => buildStories(products, categories), [products, categories]);
  const activeStory = stories.find((s) => s.isActive(filters))?.id ?? null;
  const chips = useMemo(() => activeChips(filters, products, categories), [filters, products, categories]);
  const filterCount = activeCount(filters);
  // Phones: always one large photo per row, edge to edge, like a boutique's feed (a cramped two-up
  // grid read as "cheap"); wider screens a roomy grid.
  const feedLayout = 'one' as const;
  const feedGrid = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-y-10 sm:gap-y-10 sm:gap-x-6';
  const feedKey = filtersToSearch(filters, '');

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

  return (
    <ShopProvider value={shopInfo}>
    <div className="min-h-screen flex flex-col font-sans px-safe" data-festive={festival?.festivalId ? '' : undefined} style={festival?.festivalId ? festiveVars(festival.theme) : undefined}>
      {newVersion && (
        <div role="status" className="bg-ink text-paper text-xs px-3 py-1.5 flex items-center justify-center gap-3">
          <span>New version ready</span>
          <button type="button" className="font-bold underline min-h-8" onClick={() => applyUpdate()}>Refresh</button>
          <span className="opacity-60 hidden sm:inline">(your bag is kept)</span>
        </div>
      )}
      {/* The announcement bar and the header stay at the top together while the page scrolls. */}
      <div data-testid="shop-top" className="sticky top-0 z-40 pt-safe bg-ink">
        <MarqueeBar brandSettings={brandSettings} />
        <Header
          cartCount={totalCartCount}
          onHome={goHome}
          onOpenCart={() => setIsCartOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenTrack={() => setIsTrackerOpen(true)}
          brandSettings={brandSettings}
        />
      </div>

      {/* Main Content Area (on phones, room at the bottom for the tab bar and the Help button) */}
      <main className="flex-1 max-w-7xl mx-auto w-full pb-[calc(5rem+env(safe-area-inset-bottom,0px))] md:pb-16 px-4 sm:px-6">
        <div className="pt-3 sm:pt-4 space-y-4">
          <HeroBanner brand={brandSettings} pieces={catalogLoaded ? products.length : null} />

          <StoryChips
            stories={stories}
            activeId={activeStory}
            onPick={(story) => showFilters(story.apply(filters))}
            logo={<BrandLogo brand={brandSettings} className="w-16 h-16 text-xl" />}
            motif={festival?.festivalId && festival.showBanner ? festival.theme.motif : null}
          />

          <div ref={resultsRef} className="scroll-mt-28 space-y-3">
            {/* Count, and Filter (a bottom sheet) only when wanted */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
              <p className="label-caps text-ink-muted" aria-live="polite">
                {catalogLoaded ? `${filteredProducts.length} ${filteredProducts.length === 1 ? 'piece' : 'pieces'}` : ''}
              </p>
              <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setFilterOpen(true)}
                aria-haspopup="dialog"
                aria-label={filterCount ? `Filter and sort, ${filterCount} on` : 'Filter and sort'}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-full border border-line-strong bg-transparent text-[13px] tracking-[0.04em] text-ink hover:border-ink-muted min-w-0"
              >
                <SlidersHorizontal className="w-4 h-4 shrink-0" aria-hidden="true" strokeWidth={1.5} />
                <span>Filter</span>
                {filterCount > 0 && (
                  <span className="min-w-5 h-5 px-1 rounded-full bg-ink text-paper text-[11px] font-bold flex items-center justify-center" aria-hidden="true">
                    {filterCount}
                  </span>
                )}
              </button>
              </div>
            </div>

            {(chips.length > 0 || filters.sort !== 'featured') && (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters on">
                {chips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => showFilters(chip.without)}
                    aria-label={`Remove filter: ${chip.label}`}
                    className="inline-flex items-center gap-1 pl-3 pr-2 h-8 rounded-full bg-sand border border-line text-xs font-medium text-ink hover:border-line-strong max-w-full"
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
                    className="inline-flex items-center gap-1 pl-3 pr-2 h-8 rounded-full bg-surface border border-line-strong text-xs font-medium text-ink hover:border-ink-muted"
                  >
                    <span>{SORTS.find((x) => x.id === filters.sort)?.label}</span>
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
                {chips.length + (filters.sort !== 'featured' ? 1 : 0) > 1 && (
                  <button type="button" onClick={() => showFilters(EMPTY_FILTERS)} className="h-8 px-2 text-xs font-semibold text-ink underline underline-offset-4">
                    Clear all
                  </button>
                )}
              </div>
            )}

            {catalogError && (
              <p role="alert" className="text-sm text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{catalogError}</p>
            )}

            {/* The feed: big photos (on phones one per row, edge to edge, or two across) */}
            {!catalogLoaded && !catalogError ? (
              <div className={feedGrid} aria-hidden="true" data-testid="feed-skeleton">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className={`space-y-2 ${'-mx-4 sm:mx-0'}`}>
                    <div className={`aspect-[4/5] bg-sand-deep motion-safe:animate-pulse ${'sm:rounded-lg'}`} />
                    <div className={`space-y-2 ${'px-4 sm:px-0'}`}>
                      <div className="h-3 rounded bg-sand-deep w-4/5 motion-safe:animate-pulse" />
                      <div className="h-3 rounded bg-sand-deep w-1/3 motion-safe:animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filteredProducts.length > 0 ? (
              <div key={feedKey} className={`${feedGrid} feed-in`} data-testid="feed">
                {filteredProducts.map((prod, i) => (
                  <ProductCard key={prod.id} product={prod} onSelect={openProduct} eager={i < 2} layout={feedLayout} />
                ))}
              </div>
            ) : catalogLoaded ? (
              <div className="rounded-2xl border border-dashed border-line-strong px-4 py-10 text-center space-y-3">
                <p className="text-sm text-ink">{products.length ? 'Nothing matches these filters.' : 'New pieces are on their way. Please check back soon.'}</p>
                {products.length > 0 && (
                  <button type="button" onClick={() => showFilters(EMPTY_FILTERS)} className="rounded-full bg-ink text-paper text-sm font-semibold px-5 py-2.5">
                    Show everything
                  </button>
                )}
              </div>
            ) : null}
          </div>

          {/* The shop's promise */}
          <div className="border-y border-line px-5 py-10 sm:py-12 text-center my-8 space-y-3">
            <p className="label-caps text-gold-deep">Our promise</p>
            <h2 className="font-serif text-2xl sm:text-3xl text-ink">Made slowly, delivered with care</h2>
            <p className="text-ink-soft text-[13px] sm:text-sm max-w-xl mx-auto leading-relaxed">
              Every set is made with slow handcraft, fitted for deep Gulf mattresses, and delivered to your door in all seven emirates, with cash on delivery or bank transfer.
            </p>
          </div>

          {/* The version: in the footer on phones (never over the feed), bottom left on wider screens */}
          <footer className="pb-2">
            <VersionBadge inFooter />
          </footer>
        </div>
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
        bankTransfer={bankTransfer}
        bankAskWhatsApp={bankAskWhatsApp}
        supportEmail={supportEmail}
        phoneVerification={phoneVerification}
        card={cardPayments}
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
        storeTab={searchOpen ? 'search' : 'home'}
        onHome={goHome}
        onOpenSearch={() => setSearchOpen(true)}
        cartCount={totalCartCount}
        onOpenCart={() => setIsCartOpen(true)}
        onOpenTrack={() => setIsTrackerOpen(true)}
        helpSlot={Boolean(chatInfo) || Boolean(storeSettings.showWhatsAppButton && askWhatsAppLink(storeSettings, ''))}
      />

      <HelpLauncher />
      <InstallPrompt
        blocked={isCheckoutOpen || isCartOpen || isTrackerOpen || selectedProduct !== null || searchOpen || filterOpen}
        logo={<BrandLogo brand={brandSettings} className="w-11 h-11 text-base" />}
      />
    </div>
    </ShopProvider>
  );
}
