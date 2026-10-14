'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Product, Order, Customer, CourierSettings, CartItem, BedProfileMeasurement, BrandSettings, SmsGatewaySettings } from '@/types';
import { 
  getStoredProducts, 
  saveStoredProducts, 
  addProduct, 
  getStoredOrders, 
  addOrder, 
  updateOrder, 
  getStoredCustomers, 
  getCourierSettings, 
  saveCourierSettings,
  getBrandSettings,
  saveBrandSettings,
  getSmsSettings,
  saveSmsSettings
} from '@/lib/storage';
import { ADMIN_SIGNED_OUT_EVENT, postJson } from '@/lib/apiClient';

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

  // Core Data
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [courierSettings, setCourierSettings] = useState<CourierSettings>(getCourierSettings());
  const [brandSettings, setBrandSettings] = useState<BrandSettings>(getBrandSettings());
  const [smsSettings, setSmsSettings] = useState<SmsGatewaySettings>(getSmsSettings());

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

  // 2. Load stored data and admin auth on mount
  useEffect(() => {
    setProducts(getStoredProducts());
    setOrders(getStoredOrders());
    setCustomers(getStoredCustomers());
    setCourierSettings(getCourierSettings());
    setBrandSettings(getBrandSettings());
    setSmsSettings(getSmsSettings());

    // Admin sign-in lives in an HttpOnly cookie the server checks; ask it.
    // (Old builds kept a forgeable flag and plain-text credentials here.)
    try {
      localStorage.removeItem('buh_admin_auth');
      localStorage.removeItem('buh_admin_creds');
    } catch {
      // storage unavailable (private mode): nothing to clean up
    }
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
  }, []);

  const handleUpdateBrandSettings = (newSettings: BrandSettings) => {
    saveBrandSettings(newSettings);
    setBrandSettings(newSettings);
  };

  const handleUpdateSmsSettings = (newSettings: SmsGatewaySettings) => {
    saveSmsSettings(newSettings);
    setSmsSettings(newSettings);
  };

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
  /** Returns false when the order could not be saved, so checkout can say so instead of confirming. */
  const handleOrderPlaced = (newOrder: Order): boolean => {
    try {
      setOrders(addOrder(newOrder));
    } catch (err) {
      console.error(err);
      return false;
    }
    setCustomers(getStoredCustomers());
    setCart([]);
    return true;
  };

  const handleUpdateOrder = (orderId: string, updates: Partial<Order>) => {
    const updated = updateOrder(orderId, updates);
    setOrders(updated);
    setCustomers(getStoredCustomers());
  };

  // Product Handlers
  const handleAddProduct = (newProd: Product) => {
    const updated = addProduct(newProd);
    setProducts(updated);
  };

  const handleUpdateSettings = (newSettings: CourierSettings) => {
    saveCourierSettings(newSettings);
    setCourierSettings(newSettings);
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

            {/* Active Admin Tab Content */}
            {adminTab === 'orders' && (
              <AdminOrdersTab
                orders={orders}
                onUpdateOrder={handleUpdateOrder}
                courierSettings={courierSettings}
              />
            )}

            {(adminTab === 'add-product' || adminTab === 'inventory') && (
              <AdminInventoryTab
                products={products}
                onAddProduct={handleAddProduct}
                onUpdateProduct={(p) => {
                  const updated = products.map((item) => (item.id === p.id ? p : item));
                  saveStoredProducts(updated);
                  setProducts(updated);
                }}
              />
            )}

            {adminTab === 'crm' && (
              <AdminCrmTab customers={customers} orders={orders} />
            )}

            {adminTab === 'couriers' && (
              <AdminCouriersTab
                settings={courierSettings}
                onUpdateSettings={handleUpdateSettings}
              />
            )}

            {adminTab === 'branding' && (
              <AdminBrandingTab
                brandSettings={brandSettings}
                onUpdateBrandSettings={handleUpdateBrandSettings}
              />
            )}

            {adminTab === 'sms' && (
              <AdminSmsTab
                smsSettings={smsSettings}
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
        onOrderPlaced={handleOrderPlaced}
      />}

      {/* Order Tracking Modal */}
      <OrderTrackerModal
        isOpen={isTrackerOpen}
        onClose={() => setIsTrackerOpen(false)}
        orders={orders}
      />

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
