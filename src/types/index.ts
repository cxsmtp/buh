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
  /** The owner's own stock code (optional), searchable in the Admin Hub. */
  sku?: string;
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
  /** standard (free, standardDays) or same_day (with Settings → Delivery's charge). */
  deliveryOption?: 'standard' | 'same_day';
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
  /**
   * "Confirm on WhatsApp": the customer sends the shop one message from their own WhatsApp
   * (order number + this code), which shows the owner the number really is theirs. Absent
   * when the order was not asked (no WhatsApp number, or switched off). Kept in the orders
   * table's own columns, not in the order's JSON.
   */
  whatsappCheck?: WhatsAppCheck;
}

export interface WhatsAppCheck {
  status: 'awaiting' | 'confirmed' | 'mismatch';
  /** 4 digits, made by the server. Ties the message to the order; not a password. */
  code: string;
  /** Settings → Store & contact "Hold orders until confirmed": not confirmed or booked until then. */
  hold: boolean;
  /** The customer tapped the button (their WhatsApp opened). */
  openedAt?: string;
  checkedAt?: string;
  checkedBy?: string;
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
  /** "Ask on WhatsApp" on products and in the help menu (needs the number). */
  askOnWhatsApp: boolean;
  /** "Ask on Instagram" (opens a direct message to instagramHandle). */
  askOnInstagram: boolean;
  /** Ask each customer to confirm their order with one WhatsApp message (needs the number). */
  confirmOrdersOnWhatsApp: boolean;
  /** Don't confirm or book an order until that message has come (off: it goes through, marked "not yet confirmed"). */
  holdUntilWhatsAppConfirmed: boolean;
}

/** Settings → Delivery: where we deliver, how fast, and the optional same-day service. */
export interface DeliverySettings {
  /** Emirates we deliver to (all seven by default). */
  emirates: Emirate[];
  /** Areas we don't deliver to (matched by name), e.g. remote islands. */
  notServed: string[];
  /** Shown to customers, e.g. "1–2 days". */
  standardDays: string;
  sameDayEnabled: boolean;
  /** Extra charge for same-day delivery, in AED. */
  sameDayFee: number;
  /** Orders before this time (UAE, HH:MM) can be delivered the same day. */
  sameDayCutoff: string;
  sameDayEmirates: Emirate[];
}

/** One thing the shop assistant knows: matched by its keywords and question, answered as written. */
export interface AssistantEntry {
  id: string;
  question: string;
  keywords: string[];
  answer: string;
}

/** Settings → Chat assistant: the chat on the shop, and its "memory" (what it may answer by itself). */
export interface AssistantSettings {
  /** Show the chat on the shop. */
  enabled: boolean;
  /** Its name in the chat. */
  name: string;
  greeting: string;
  /** Answer size and measurement questions from Settings → Catalogue's size presets. */
  answerSizes: boolean;
  /** No reply from a person within this many seconds: tell the customer we'll get back to them. */
  waitSeconds: number;
  entries: AssistantEntry[];
}

/** A conversation from the shop's chat (customer side never sees contactDetails of others). */
export interface ChatThread {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** bot: the assistant answers; waiting: handed to a person, no reply yet; human: a person replied; closed. */
  status: 'bot' | 'waiting' | 'human' | 'closed';
  customerName: string;
  contact: string;
  page: string;
  /** Messages the admin hasn't seen. */
  unread: number;
  lastMessage: string;
}

export interface ChatMessage {
  id: number;
  at: string;
  author: 'customer' | 'bot' | 'admin' | 'system';
  body: string;
  via: 'web' | 'email' | 'admin';
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
  /** Mailbox the shop reads for replies to chat emails (IMAP, port 993). Empty: chat replies by email are off. */
  imapHost: string;
  imapPort: number;
  /** Empty: the SMTP username. */
  imapUser: string;
  /** Write-only. Empty: the SMTP password (when the username is the same). */
  imapPass: string;
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
