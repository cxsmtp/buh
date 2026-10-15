export type Emirate = 
  | 'Dubai'
  | 'Abu Dhabi'
  | 'Sharjah'
  | 'Ajman'
  | 'Ras Al Khaimah'
  | 'Fujairah'
  | 'Umm Al Quwain';

/** A size's id: the built-in ones (single, double, queen, king, super-king, custom) or one the owner adds in Settings. */
export type BedSizeProfileId = string;

export interface BedProfileMeasurement {
  id: BedSizeProfileId;
  name: string;
  badge: string;
  mattressSize: string; // e.g. "180 x 200 cm"
  fittedSheet: string;  // e.g. "180 x 200 + 40 cm pocket"
  flatSheet: string;    // e.g. "260 x 270 cm"
  pillowcases: string;  // e.g. "2 pcs (50 x 80 cm)"
  duvetCover?: string;  // e.g. "240 x 260 cm"
  cushionCovers?: string; // e.g. "2 pcs (45 x 45 cm)"
  piecesIncluded: number;
  priceDelta: number;   // e.g. +0 for Single, +40 for King, +60 for Super King
}

export interface Product {
  id: string;
  title: string;
  slug: string;
  description: string;
  shortDescription: string;
  /** A category id from Settings → Catalogue (built-in: bedsheets, duvet-covers, fitted-sheets, hotel-luxury, silk-collection). */
  category: string;
  price: number; // Base price in AED
  compareAtPrice?: number;
  material: string; // e.g. "100% Giza Egyptian Cotton"
  threadCount: number; // e.g. 600 TC
  weave: 'Sateen' | 'Percale' | 'Linen' | 'Jacquard';
  colors: { name: string; hex: string }[];
  featuredImage: string;
  galleryImages: string[];
  rawOriginalImage?: string; // Original mobile camera snap
  aiTransformedImage?: string; // AI enhanced luxury bedroom mockup
  aiStagingPrompt?: string;
  isAiEnhanced?: boolean;
  /** Total pieces in stock across all sizes (the sum of stockBySize). */
  stockCount: number;
  /** Pieces in stock per size id. Most designs are one or two pieces, so stock is kept per size. */
  stockBySize: Record<string, number>;
  /** Shown in the shop (false = hidden by the owner). Present on admin reads. */
  active?: boolean;
  isFeatured: boolean;
  isNewArrival?: boolean;
  rating: number;
  reviewsCount: number;
  profiles: BedProfileMeasurement[];
  defaultProfileId: BedSizeProfileId;
  createdAt: string;
}

export interface CartItem {
  product: Product;
  selectedProfile: BedProfileMeasurement;
  selectedColor?: string;
  quantity: number;
}

export type PaymentMethod = 'cod' | 'bank_transfer' | 'online_card';

export type OrderStatus = 
  | 'pending_payment'
  | 'pending_confirmation'
  | 'confirmed'
  | 'dispatched'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export type CourierProvider = 'jeebly' | 'echo' | 'manual';

export interface CourierDetails {
  provider: CourierProvider;
  serviceType: 'Scheduled' | 'Express';
  awbNumber: string;
  trackingUrl: string;
  status: string;
  pickupDate: string;
  weightKg: number;
  pieces: number;
  dispatchedAt?: string;
  deliveredAt?: string;
  labelGenerated: boolean;
  /** Live bookings only: booked with the carrier, or sent without an answer (may exist). */
  bookingState?: 'booked' | 'uncertain';
  /** The AWB came from sandbox mode, not a real booking. */
  simulated?: boolean;
  courierNotes?: string;
  codAmountCollected?: number;
}

export interface Order {
  id: string; // e.g. "BUH-78214"
  createdAt: string;
  customer: {
    fullName: string;
    phone: string; // UAE format +971 5x xxx xxxx
    email?: string;
    emirate: Emirate;
    area: string;
    streetAddress: string;
    buildingVilla: string;
    flatVillaNo: string;
    landmark?: string;
    gpsCoordinates?: {
      lat: number;
      lng: number;
    };
    phoneVerified?: boolean;
  };
  items: {
    productId: string;
    title: string;
    image: string;
    profileId: BedSizeProfileId;
    profileName: string;
    mattressSize: string;
    fittedSheet: string;
    flatSheet: string;
    pillowcases: string;
    color?: string;
    unitPrice: number;
    quantity: number;
    totalPrice: number;
  }[];
  subtotal: number;
  deliveryFee: number;
  codFee: number;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  paymentStatus: 'pending' | 'receipt_uploaded' | 'verified' | 'cod_pending' | 'paid';
  paymentReceiptUrl?: string;
  bankTransferRef?: string;
  status: OrderStatus;
  courier: CourierDetails & {
    serviceability?: {
      verified: boolean;
      hub: string;
      deliverySpeed: string;
      zone?: string;
      checkedAt?: string;
    };
  };
  adminNotes?: string;
  /** Where the customer came from (first visit in the last 30 days). */
  source?: { source: string; campaign?: string };
}

export interface Customer {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  emirate: Emirate;
  area: string;
  totalOrders: number;
  totalSpent: number;
  lastOrderDate: string;
  defaultAddress: {
    buildingVilla: string;
    flatVillaNo: string;
    streetAddress: string;
    landmark?: string;
  };
}

export interface BankTransferDetails {
  bankName: string;
  accountName: string;
  accountNumber: string;
  iban: string;
  swiftCode: string;
  branch: string;
  instructions: string;
}

export interface CourierSettings {
  autoAssignRules: {
    codCourier: CourierProvider; // Defaults to 'jeebly'
    prepaidCourier: CourierProvider; // Defaults to 'echo'
  };
  jeebly: {
    apiKey: string;
    clientKey: string;
    serviceType: 'Scheduled' | 'Express';
    isLive: boolean;
    pickupLocationName: string;
    pickupPhone: string;
    pickupAddress: string;
    pickupEmirate: Emirate;
  };
  echo: {
    apiKey: string;
    accountId: string;
    isLive: boolean;
    hubCode: string;
    serviceTier: string;
  };
}

/** Settings → Catalogue: the size presets offered when adding a product, and the categories. */
export interface CatalogSettings {
  sizes: BedProfileMeasurement[];
  categories: Array<{ id: string; label: string; icon: string }>;
  /** Show "Only 1 left" when a size's stock is at or below this. */
  lowStockThreshold: number;
}

/** Settings → Store & contact: how customers reach the shop. */
export interface StoreSettings {
  /** WhatsApp number in +971… form; empty hides WhatsApp buttons. */
  whatsappNumber: string;
  /** The message a customer's WhatsApp opens with. */
  whatsappGreeting: string;
  /** Show the floating WhatsApp button on every page. */
  showWhatsAppButton: boolean;
  /** Overrides NEXT_PUBLIC_SUPPORT_EMAIL when set. */
  supportEmail: string;
  instagramHandle: string;
  facebookUrl: string;
  tiktokHandle: string;
  /** Shown in the footer and on invoices. */
  storeAddress: string;
  /** Show an approximate price in the visitor's own currency next to AED (outside the UAE). */
  showLocalCurrency: boolean;
}

/** Settings → Email: the mail server for backups, alerts, the daily summary and password resets. */
export interface EmailSettings {
  /** Empty: use SMTP_* from .env.production. */
  smtpHost: string;
  smtpPort: number;
  /** starttls (port 587/25/2525, upgrade required) or tls (port 465). */
  smtpSecurity: 'starttls' | 'tls';
  smtpUser: string;
  /** Write-only. */
  smtpPass: string;
  fromAddress: string;
  /** Where backups, alerts and the daily summary go (comma-separated); empty uses BACKUP_EMAIL. */
  sendTo: string;
}

/** Settings → Themes: festival looks, picked automatically or by the admin. */
export interface ThemeSettings {
  /** auto: by the festival calendar; manual: always themeId; off: the everyday look. */
  mode: 'auto' | 'manual' | 'off';
  themeId: string;
  /** Festivals that should never take over the theme (e.g. ones the shop does not mark). */
  disabledFestivals: string[];
  /** Festival greeting in the banner at the top of the shop. */
  showBanner: boolean;
  /** Festival lines added to the scrolling bar. */
  showMarquee: boolean;
}

export interface BrandSettings {
  storeName: string;
  tagline: string;
  badgeText: string;
  logoType: 'text' | 'image';
  logoText: string;
  logoImageUrl?: string;
  accentColor: string;
  marquee: {
    enabled: boolean;
    speedSeconds: number;
    messages: string[];
  };
}

export type SmsProvider = 'twilio' | 'infobip' | 'unifonic' | 'custom_webhook' | 'firebase';

/** A Firebase web app's public config (not secrets: every visitor's browser receives it). */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** How the storefront verifies phones: the shop sends the code, or Firebase does. */
export interface PhoneVerificationConfig {
  method: 'server' | 'firebase';
  firebase?: FirebaseWebConfig;
}

export interface SmsGatewaySettings {
  provider: SmsProvider;
  senderId: string; // e.g. "BUHome" or phone number
  twilio: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    verifyServiceSid?: string;
  };
  infobip: {
    apiKey: string;
    baseUrl: string;
    fromSender: string;
  };
  unifonic?: {
    appSid: string;
    senderId: string;
  };
  customWebhook: {
    endpointUrl: string;
    bearerToken?: string;
  };
  /** Firebase Phone Authentication: the browser asks Firebase to send the SMS. */
  firebase?: FirebaseWebConfig;
  isEnabled: boolean;
}
