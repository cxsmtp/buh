import type { AssistantSettings, DeliverySettings, CatalogSettings, EmailSettings, StoreSettings, ThemeSettings } from '@/types';
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
  askOnWhatsApp: true,
  askOnInstagram: true,
};

/** Settings → Themes before the owner changes anything: festivals picked automatically. */
export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: 'auto',
  themeId: 'default',
  disabledFestivals: [],
  showBanner: true,
  showMarquee: true,
};

/** Settings → Email before the owner fills it in (then .env.production applies). */
export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  smtpHost: '',
  smtpPort: 587,
  smtpSecurity: 'starttls',
  smtpUser: '',
  smtpPass: '',
  fromAddress: '',
  imapHost: '',
  imapPort: 993,
  imapUser: '',
  imapPass: '',
  sendTo: '',
};

/** The chat's starting "memory": the owner edits, adds and removes entries in Settings → Chat assistant. */
export const DEFAULT_ASSISTANT: AssistantSettings = {
  enabled: true,
  name: 'Shop assistant',
  greeting: 'Hello! I can help with sizes, delivery, payment and care. Ask me anything, or tap "Talk to a person".',
  answerSizes: true,
  waitSeconds: 150,
  entries: [
    {
      id: 'delivery',
      question: 'How long does delivery take?',
      keywords: ['delivery', 'deliver', 'shipping', 'ship', 'courier', 'how long'],
      answer: 'We deliver across all seven emirates, usually within 24 to 48 hours of confirming your order. You get a tracking number as soon as the courier collects it.',
    },
    {
      id: 'payment',
      question: 'How can I pay?',
      keywords: ['pay', 'payment', 'cash', 'cod', 'card', 'transfer', 'bank'],
      answer: 'You can pay cash on delivery, or by bank transfer when the bank details show at checkout.',
    },
    {
      id: 'discounts',
      question: 'Do you have a discount or offer?',
      keywords: ['discount', 'offer', 'sale', 'coupon', 'code', 'promo', 'deal', 'cheaper'],
      answer: 'Our prices are already as low as we can make them for these handmade pieces. Festival offers are announced on the shop banner and on Instagram. For a bulk order, tap "Talk to a person".',
    },
    {
      id: 'care',
      question: 'How do I wash it?',
      keywords: ['wash', 'care', 'clean', 'iron', 'shrink', 'fade', 'laundry'],
      answer: 'Hand-block-printed cotton: wash cold, gently, with mild detergent, apart from other colours for the first few washes, and dry in the shade. Iron on medium heat.',
    },
    {
      id: 'returns',
      question: 'Can I return or exchange?',
      keywords: ['return', 'exchange', 'swap'],
      answer: 'If something arrives damaged or wrong, message us within 48 hours with a photo and we will make it right. Tap "Talk to a person" and we will take it from there.',
    },
  ],
};

/** Delivery before the owner changes anything: all seven emirates, 1–2 days, no same-day service. */
export const DEFAULT_DELIVERY: DeliverySettings = {
  emirates: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'],
  notServed: [],
  standardDays: '1–2 days',
  sameDayEnabled: false,
  sameDayFee: 25,
  sameDayCutoff: '13:00',
  sameDayEmirates: ['Dubai'],
};
