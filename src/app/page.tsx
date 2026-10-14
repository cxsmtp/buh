'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Product, Order, Customer, CourierSettings, CartItem, BedProfileMeasurement, BrandSettings, SmsGatewaySettings, BankTransferDetails } from '@/types';
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
}

/** Catalogue + public settings from the server (no React state here). */
async function fetchCatalog() {
  const [products, settings] = await Promise.all([
    getJson<{ products: Product[] }>('/api/products'),
    getJson<{ brand: BrandSettings; bank: BankTransferDetails }>('/api/settings/public'),
  ]);
  return { products, settings };
}

/** Everything the admin hub shows (no React state here). */
async function fetchAdminData() {
  const [orders, customers, products, settings] = await Promise.all([
    getJson<{ orders: Order[] }>('/api/admin/orders'),
    getJson<{ customers: Customer[] }>('/api/admin/customers'),
    getJson<{ products: Product[] }>('/api/admin/products'),
    getJson<AdminSettings>('/api/admin/settings'),
  ]);
  return { orders, customers, products, settings };
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

function loadCart(products: Product[]): CartItem[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || '[]') as Array<{ productId: string; profileId: string; color?: string; quantity: number }>;
    return saved.flatMap((s) => {
      const product = products.find((p) => p.id === s.productId);
      const profile = product?.profiles.find((p) => p.id === s.profileId);
      if (!product || !profile || !Number.isInteger(s.quantity) || s.quantity < 1) return [];
      return [{ product, selectedProfile: profile, selectedColor: s.color, quantity: Math.min(s.quantity, 20) }];
    });
  } catch {
    return [];
  }
}

// Store Components
import { Header } from '@/components/common/Header';
import { BottomNav } from '@/components/common/BottomNav';
import { HeroBanner } from '@/components/store/HeroBanner';
import { CategoryFilter, CategoryOption } from '@/components/store/CategoryFilter';
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

import { Sparkles, Palette, ShieldCheck, Heart, Search, X } from 'lucide-react';

export default function HomePage() {
  // Theme state based on device settings
  const [isDarkMode, setIsDarkMode] = useState(false);

  // App Navigation & Modes
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [isAdminAuthenticated, setIsAdminAuthenticated] = useState(false);
  const [isAdminLoginOpen, setIsAdminLoginOpen] = useState(false);

  const [storeTab, setStoreTab] = useState<'home' | 'catalog'>('home');
  const [adminTab, setAdminTab] = useState<'orders' | 'add-product' | 'inventory' | 'crm' | 'couriers' | 'branding' | 'sms'>('orders');
  const [selectedCategory, setSelectedCategory] = useState<CategoryOption>('all');

  // Core Data (all from the server)
  const [products, setProducts] = useState<Product[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const [brandSettings, setBrandSettings] = useState<BrandSettings>(INITIAL_BRAND_SETTINGS);
  const [bankDetails, setBankDetails] = useState<BankTransferDetails>(INITIAL_BANK_DETAILS);
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
  });
  const [adminLoadError, setAdminLoadError] = useState('');
  // Settings forms copy their values once; they are re-created when the server's values first arrive
  // (not after the owner's own save, which would wipe the "Saved" message, nor on every refresh).
  const [publicSettingsLoaded, setPublicSettingsLoaded] = useState(false);
  const [adminSettingsLoaded, setAdminSettingsLoaded] = useState(false);

  // Modals & Drawers
  const [cart, setCart] = useState<CartItem[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [isTrackerOpen, setIsTrackerOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // 1. Device Theme Detection (Listen to OS preference)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      setIsDarkMode(mediaQuery.matches);

      const handler = (e: MediaQueryListEvent) => {
        setIsDarkMode(e.matches);
      };
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, []);

  // 2. Load the catalogue and branding, and check the admin session, on mount
  const applyCatalog = useCallback(({ products: res, settings }: Awaited<ReturnType<typeof fetchCatalog>>) => {
    if (res.ok) {
      setProducts(res.data.products);
      setCatalogError('');
    } else {
      setCatalogError('The shop could not be loaded. Please check your connection and refresh.');
    }
    if (settings.ok) {
      setBrandSettings(settings.data.brand);
      setBankDetails(settings.data.bank);
      setPublicSettingsLoaded(true);
    }
    return res.ok ? res.data.products : null;
  }, []);

  const loadCatalog = useCallback(async () => applyCatalog(await fetchCatalog()), [applyCatalog]);

  useEffect(() => {
    void fetchCatalog().then((result) => {
      const list = applyCatalog(result);
      if (list) setCart(loadCart(list));
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
  }, [applyCatalog]);

  // The bag survives a reload.
  useEffect(() => {
    if (products.length) saveCart(cart);
  }, [cart, products.length]);

  // 3. Admin hub data, loaded once signed in and refreshed every minute while open.
  const applyAdminData = useCallback(({ orders: o, customers: c, products: p, settings: st }: Awaited<ReturnType<typeof fetchAdminData>>) => {
    if (o.ok) setOrders(o.data.orders);
    if (c.ok) setCustomers(c.data.customers);
    if (p.ok) setAdminProducts(p.data.products);
    if (st.ok) {
      setAdminSettings({ courier: st.data.courier, sms: st.data.sms });
      setAdminSettingsLoaded(true);
    }
    setAdminLoadError(o.ok && c.ok && p.ok && st.ok ? '' : 'Some admin data could not be loaded. Check your connection and refresh.');
  }, []);

  const loadAdminData = useCallback(async () => applyAdminData(await fetchAdminData()), [applyAdminData]);

  useEffect(() => {
    if (!isAdminAuthenticated) return;
    void fetchAdminData().then(applyAdminData);
    if (!isAdminMode) return;
    const t = setInterval(() => void fetchAdminData().then(applyAdminData), 60_000);
    return () => clearInterval(t);
  }, [isAdminAuthenticated, isAdminMode, applyAdminData]);

  /** Save one settings group on the server; resolves to an error message or null. */
  const saveSettings = async (key: 'brand' | 'bank' | 'courier' | 'sms', settings: unknown): Promise<string | null> => {
    const { ok, data } = await sendJson<{ message?: string }>('PUT', `/api/admin/settings/${key}`, { settings });
    if (!ok) return data.message || 'Could not save. Please try again.';
    await Promise.all([loadAdminData(), key === 'brand' || key === 'bank' ? loadCatalog() : Promise.resolve(null)]);
    return null;
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
      const existingIdx = prev.findIndex(
        (i) => i.product.id === product.id && i.selectedProfile.id === profile.id && i.selectedColor === color
      );
      if (existingIdx >= 0) {
        const copy = [...prev];
        copy[existingIdx].quantity += quantity;
        return copy;
      }
      return [...prev, { product, selectedProfile: profile, selectedColor: color, quantity }];
    });
    setIsCartOpen(true);
  };

  const handleUpdateQuantity = (idx: number, newQty: number) => {
    if (newQty <= 0) {
      handleRemoveFromCart(idx);
      return;
    }
    setCart((prev) => {
      const copy = [...prev];
      copy[idx].quantity = newQty;
      return copy;
    });
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

  // Product Handlers
  const handleAddProduct = async (newProd: Product): Promise<string | null> => {
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/products', { product: newProd });
    if (!ok) return data.message || 'Could not save the product.';
    await Promise.all([loadAdminData(), loadCatalog()]);
    return null;
  };

  const handleUpdateProduct = async (id: string, changes: Partial<Product>): Promise<string | null> => {
    const { ok, data } = await sendJson<{ message?: string }>('PATCH', `/api/admin/products/${encodeURIComponent(id)}`, { product: changes });
    if (!ok) return data.message || 'Could not save the product.';
    await Promise.all([loadAdminData(), loadCatalog()]);
    return null;
  };

  // Filtered Products for Storefront
  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const matchesCategory = selectedCategory === 'all' || p.category === selectedCategory;
      const matchesSearch = searchQuery
        ? p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          p.material.toLowerCase().includes(searchQuery.toLowerCase())
        : true;
      return matchesCategory && matchesSearch;
    });
  }, [products, selectedCategory, searchQuery]);

  const totalCartCount = cart.reduce((sum, i) => sum + i.quantity, 0);
  const pendingOrdersCount = orders.filter((o) => o.status === 'pending_confirmation').length;

  return (
    <div className={`min-h-screen flex flex-col font-sans transition-colors duration-300 ${isDarkMode ? 'dark' : ''}`}>
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
        <Header
          cartCount={totalCartCount}
          onOpenCart={() => setIsCartOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenTrack={() => setIsTrackerOpen(true)}
          isAdminMode={isAdminMode}
          onToggleAdminMode={handleToggleAdminMode}
          pendingOrdersCount={pendingOrdersCount}
          brandSettings={brandSettings}
        />
      )}

      {/* Main Content Area */}
      <main className="flex-1 pb-20 max-w-7xl mx-auto w-full px-3 sm:px-6">
        {isAdminMode ? (
          /* ================= ADMIN MOBILE HUB ================= */
          <div className="py-4 space-y-4">
            {/* Admin Desktop/Tablet Navigation Tabs */}
            <div className="hidden sm:flex items-center gap-2 border-b border-stone-200 pb-2 overflow-x-auto no-scrollbar">
              {[
                { id: 'orders', label: 'Orders & Dispatches', badge: pendingOrdersCount },
                { id: 'add-product', label: '+ Add Bedding Set (AI Studio)' },
                { id: 'inventory', label: 'Inventory Stock' },
                { id: 'crm', label: 'Customers & CRM' },
                { id: 'couriers', label: 'Jeebly & Eco Couriers' },
                { id: 'branding', label: '🎨 Logo & Marquee' },
                { id: 'sms', label: '📱 SMS & Real OTP' },
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

            <BackupStatus />
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
                products={adminProducts}
                onAddProduct={handleAddProduct}
                onUpdateProduct={handleUpdateProduct}
              />
            )}

            {adminTab === 'crm' && (
              <AdminCrmTab customers={customers} orders={orders} />
            )}

            {adminTab === 'couriers' && (
              <AdminCouriersTab
                key={`couriers-${adminSettingsLoaded}`}
                settings={adminSettings.courier.value}
                secretsSet={adminSettings.courier.secretsSet}
                onUpdateSettings={handleUpdateSettings}
              />
            )}

            {adminTab === 'branding' && (
              <AdminBrandingTab
                key={`branding-${publicSettingsLoaded}`}
                brandSettings={brandSettings}
                onUpdateBrandSettings={handleUpdateBrandSettings}
                bank={bankDetails}
                onUpdateBank={handleUpdateBank}
              />
            )}

            {adminTab === 'sms' && (
              <AdminSmsTab
                key={`sms-${adminSettingsLoaded}`}
                smsSettings={adminSettings.sms.value}
                secretsSet={adminSettings.sms.secretsSet}
                onUpdateSmsSettings={handleUpdateSmsSettings}
              />
            )}
          </div>
        ) : (
          /* ================= CUSTOMER STOREFRONT ================= */
          <div className="space-y-2 sm:space-y-3">
            {/* Hero Banner with Artisan Heritage */}
            <HeroBanner onExploreClick={() => setStoreTab('catalog')} />

            {/* Category Filter Pills */}
            <CategoryFilter
              selectedCategory={selectedCategory}
              onSelectCategory={setSelectedCategory}
            />

            {/* Search Filter Active Notice */}
            {searchQuery && (
              <div className="flex items-center justify-between bg-amber-50 px-3.5 py-1.5 rounded-xl border border-amber-200 text-xs text-amber-900 mx-1">
                <span>Showing results for &quot;<strong>{searchQuery}</strong>&quot; ({filteredProducts.length} items)</span>
                <button
                  onClick={() => setSearchQuery('')}
                  className="font-bold text-amber-800 hover:underline"
                >
                  Clear Search
                </button>
              </div>
            )}

            {/* Products Grid (2 columns on mobile, 4 columns on laptop/desktop) */}
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 sm:gap-4 md:gap-5">
              {filteredProducts.map((prod) => (
                <ProductCard
                  key={prod.id}
                  product={prod}
                  onSelect={(p) => setSelectedProduct(p)}
                />
              ))}
            </div>

            {/* Artisan Craftsmanship Trust Banner */}
            <div className="bg-stone-50 rounded-3xl p-6 sm:p-8 border border-stone-200 text-center my-8 space-y-3">
              <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center mx-auto shadow-inner">
                <Palette className="w-6 h-6 text-[#c5a059]" />
              </div>
              <h3 className="font-serif text-xl sm:text-2xl font-bold text-[#0f1c2e]">
                The Beautiful UAE Home Promise
              </h3>
              <p className="text-stone-600 text-xs sm:text-sm max-w-xl mx-auto leading-relaxed">
                Every bedsheet set in our atelier is a tribute to slow handcraft and mindful luxury. Tested and fitted for deep Gulf mattresses, washed in natural mineral dyes, and delivered to your doorstep in Dubai, Abu Dhabi, and all seven Emirates with flexible Cash on Delivery or Bank Transfer.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* Search Modal */}
      {searchOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 pt-16">
          <div className="bg-white rounded-2xl max-w-lg w-full p-4 shadow-2xl space-y-3 animate-in slide-in-from-top-4">
            <div className="flex items-center justify-between pb-2 border-b border-stone-200">
              <span className="font-serif font-bold text-sm text-[#0f1c2e]">
                Search Handprinted & Machine Printed Bed Linens
              </span>
              <button
                onClick={() => setSearchOpen(false)}
                className="p-1 text-stone-400 hover:text-stone-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative">
              <input
                type="text"
                autoFocus
                placeholder="Search botanical prints, linen, king size, Egyptian cotton..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059] focus:outline-none"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setSearchOpen(false)}
                className="bg-[#0f1c2e] text-white font-semibold text-xs px-4 py-2 rounded-xl"
              >
                View Results ({filteredProducts.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product Detail Modal */}
      <ProductDetailModal
        product={selectedProduct}
        onClose={() => setSelectedProduct(null)}
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
        onOrderPlaced={handleOrderPlaced}
      />}

      {/* Order Tracking Modal */}
      {isTrackerOpen && (
        <OrderTrackerModal isOpen={isTrackerOpen} onClose={() => setIsTrackerOpen(false)} lastOrderId={lastOrderId} />
      )}

      {/* Mobile Bottom Navigation */}
      <BottomNav
        isAdminMode={isAdminMode}
        storeTab={storeTab}
        onSetStoreTab={setStoreTab}
        adminTab={adminTab}
        onSetAdminTab={setAdminTab}
        cartCount={totalCartCount}
        onOpenCart={() => setIsCartOpen(true)}
        onOpenTrack={() => setIsTrackerOpen(true)}
        onToggleAdminMode={handleToggleAdminMode}
        pendingOrdersCount={pendingOrdersCount}
      />

      {/* Admin Login Modal */}
      <AdminLoginModal
        isOpen={isAdminLoginOpen}
        onClose={() => setIsAdminLoginOpen(false)}
        onLoginSuccess={() => {
          setIsAdminAuthenticated(true);
          setIsAdminMode(true);
        }}
      />
    </div>
  );
}
