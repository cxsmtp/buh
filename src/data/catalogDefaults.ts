import type { CatalogSettings, StoreSettings, ThemeSettings } from '@/types';
import { ALL_BED_PROFILES_LIST } from './bedProfiles';

/** Settings → Catalogue before the owner changes anything. */
export const DEFAULT_CATALOG: CatalogSettings = {
  sizes: ALL_BED_PROFILES_LIST,
  categories: [
    { id: 'bedsheets', label: 'Hand Block Sets', icon: '🛏️' },
    { id: 'hotel-luxury', label: 'Mughal & Hotel 1000TC', icon: '👑' },
    { id: 'silk-collection', label: 'Indigo Mud-Resist', icon: '💎' },
    { id: 'fitted-sheets', label: '40cm Deep Fitted', icon: '📐' },
    { id: 'duvet-covers', label: 'Duvet Covers', icon: '☁️' },
  ],
  lowStockThreshold: 2,
};

/** Settings → Store & contact before the owner fills it in. */
export const DEFAULT_STORE: StoreSettings = {
  whatsappNumber: '',
  whatsappGreeting: 'Hello Beautiful UAE Home! I have a question about your bed linen.',
  showWhatsAppButton: true,
  supportEmail: '',
  instagramHandle: '',
  facebookUrl: '',
  tiktokHandle: '',
  storeAddress: '',
  showLocalCurrency: true,
};

/** Settings → Themes before the owner changes anything: festivals picked automatically. */
export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: 'auto',
  themeId: 'default',
  disabledFestivals: [],
  showBanner: true,
  showMarquee: true,
};
