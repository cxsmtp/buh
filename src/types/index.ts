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
  /** Older size presets only (not shown in the shop): use otherPieces on a product. */
  cushionCovers?: string; // e.g. "2 pcs (45 x 45 cm)"
  /** Anything else in the set, free text (e.g. "2 cushion covers 45 x 45 cm"). */
  otherPieces?: string;
  piecesIncluded: number;
  priceDelta: number;   // e.g. +0 for Single, +40 for King, +60 for Super King
  /** Packed weight of one set, in grams (admin only: never shown in the shop). */
  weightGrams?: number;
  /** A simple product's variant only (towels, cushions, decor…): its size as shown, e.g. "50 × 50 cm". */
  dimensions?: string;
}

/**
 * What kind of product: bedding (bed sizes with sheet and pillowcase measurements, everything
 * before BUH-02.17) or simple (towels, cushions, throws, curtains, decor: plain variants such as
 * "50 × 50 cm" or "Bath towel", each with its own price difference, stock and weight). Absent
 * means bedding.
 */
export type ProductType = 'bedding' | 'simple';

export interface Product {
  id: string;
  title: string;
  slug: string;
  /** The owner's own stock code (optional), searchable in the Admin Hub. */
  sku?: string;
  /**
   * The code the product was exported under to Amazon / Noon before it had an SKU (BUH-<id>),
   * kept when the shop gives it one so listings already made keep matching. Set by the server only.
   */
  marketplaceSku?: string;
  /** The owner's own title for Google (empty: "<title> | <shop>", made by the shop). */
  seoTitle?: string;
  /** The owner's own description for Google (empty: from the short description). */
  seoDescription?: string;
  description: string;
  shortDescription: string;
  /** Bedding (bed sizes) or simple (plain variants). Absent: bedding. */
  productType?: ProductType;
  /** A category id from Settings → Catalogue (built-in: bedsheets, duvet-covers, fitted-sheets, hotel-luxury, silk-collection). */
  category: string;
  price: number; // Base price in AED
  compareAtPrice?: number;
  material: string; // e.g. "100% Giza Egyptian Cotton"
  threadCount: number; // e.g. 600 TC
  /** One of the weaves in Settings → Catalogue (built-in: Sateen, Percale, Linen, Jacquard). */
  weave: string;
  colors: { name: string; hex: string }[];
  featuredImage: string;
  galleryImages: string[];
  rawOriginalImage?: string; // Original mobile camera snap
  aiTransformedImage?: string; // AI enhanced luxury bedroom mockup
  aiStagingPrompt?: string;
  isAiEnhanced?: boolean;
  /**
   * Photos made by "Style in a bedroom", by their address (/api/images/<name>). Set by the server
   * only; shoppers see the map (as { staged: true }) only while "Label styled photos" is on.
   */
  stagedPhotos?: Record<string, StagedPhoto | { staged: true }>;
  /**
   * Gift lines by festival id (and "everyday"), written with "Write from photo" and edited by the
   * owner. Admin only: shoppers get `giftLine`, the one for the festival the shop is themed for now.
   */
  giftLines?: Record<string, string>;
  /** Shoppers only (/api/products): today's gift line (the themed festival's, else the everyday one). */
  giftLine?: string;
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
  /**
   * Measurements per size (on profiles) are the ones the owner filled in on this product; the
   * shop shows only those. fitted: the set's sheet is a fitted sheet (elastic corners), so the
   * shop shows "Fitted sheet" with fittedSheet; otherwise (the default) "Flat sheet" with flatSheet.
   */
  fitted?: boolean;
  /** Measurements carried over from the standard sizes by an update: the owner checks them once (Admin Hub only). */
  measurementsReview?: boolean;
  /**
   * Values the BUH-02.10 update took off a size (a standard duvet cover on a set that is not a
   * duvet product), per size id: never shown to customers; the editor offers them back in one tap.
   */
  legacyMeasurements?: Record<string, Partial<Pick<BedProfileMeasurement, 'fittedSheet' | 'flatSheet' | 'pillowcases' | 'duvetCover'>>>;
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
  /** A test booking, not a real shipment: never shown to customers. */
  simulated?: boolean;
  /** Which test: Jeebly's sandbox (its own AWB), or an offline practice booking (no keys saved). */
  testKind?: 'sandbox' | 'practice';
  /** Where an API booking lives at the carrier: Jeebly's demo (sandbox) or its live system. */
  carrierEnv?: 'sandbox' | 'live';
  /** The owner typed the tracking number in (booked in the carrier's own portal). */
  enteredByHand?: boolean;
  /** The carrier's name when provider is 'manual' (another courier), as the owner typed it. */
  carrierName?: string;
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
    /** The size's packed weight when the order was placed (a snapshot: later edits don't change it). */
    weightGrams?: number;
    /** A simple product's variant: its dimensions when the order was placed (e.g. "50 × 50 cm"). */
    dimensions?: string;
    /** 'simple' for a towel, cushion or other simple product (its profileName is a variant, not a bed size). */
    productType?: 'simple';
    /** The size's SKU when the order was placed (BUH-BS-JAIPUR-007-KING). */
    sku?: string;
  }[];
  subtotal: number;
  deliveryFee: number;
  /** standard (free, standardDays) or same_day (with Settings → Delivery's charge). */
  deliveryOption?: 'standard' | 'same_day';
  codFee: number;
  /** Card payment fee (Settings → Payments, % of items + delivery), in AED; absent or 0 for other payments. Part of total. */
  cardFee?: number;
  /** The fee's percent when the order was placed. */
  cardFeePercent?: number;
  /** UAE VAT added on top (Settings → Payments → VAT with prices excluding VAT), in AED. Part of total. */
  vatAdded?: number;
  /** Customer view only: the private address of the order's printable receipt or tax invoice, and its name. */
  documentPath?: string;
  documentLabel?: string;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  /** Bank transfer "on request": no account was saved, so the customer asks for it on the shop's WhatsApp. */
  bankDetailsBy?: 'whatsapp';
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
  /**
   * Card payment through the owner's Stripe account (paymentMethod 'online_card'). Kept in the
   * orders table's own columns, not in the order's JSON. Customers see only state and label.
   */
  card?: CardPayment;
  /**
   * Bank transfer (paymentMethod 'bank_transfer'): the customer gets the bank details privately
   * (email, WhatsApp, the order's private page) and uploads the transfer screenshot there; the
   * owner marks it received. Kept in the orders table's own columns, not in the order's JSON.
   */
  bankTransfer?: BankTransferCheck;
  /** Needs the owner's attention (own column, admin only; cleared with "Mark as handled"). */
  attention?: OrderAttention;
}

/**
 * A card order's payment. Only Stripe's word moves it: the signed webhook, or the server asking
 * Stripe directly. pending: waiting for the customer; failed: the last try was declined (they may
 * try again until the order times out); paid; refund_pending / refunded; canceled: never paid,
 * the order was cancelled and its stock released.
 */
export type CardState = 'pending' | 'failed' | 'paid' | 'refund_pending' | 'refunded' | 'canceled';

export interface CardPayment {
  state: CardState;
  /** "Apple Pay · Visa •••• 4242", from Stripe once paid. */
  label?: string;
  /** The PaymentIntent id (pi_…), from Stripe. Admin only. */
  ref?: string;
  paidAt?: string;
  /** What Stripe confirmed it took, in AED. Admin only. */
  paidAmount?: number;
  refundRef?: string;
  refundedAt?: string;
  /** Refunded so far, in AED (a partial refund made in the Stripe dashboard). Admin only. */
  refundedAmount?: number;
  /** "test" or "live": the Stripe mode the payment was made in. Admin only. */
  mode?: 'test' | 'live';
  /** Cancelled without a refund through the shop (Stripe could not see the payment): refund it in Stripe's dashboard. */
  refundOutsideAt?: string;
}

/** Something on an order the owner must look at (a refund that failed, a booking after a cancel…). Admin only. */
export interface OrderAttention {
  kind: 'refund_failed' | 'booked_after_cancel' | 'refund_outside_stripe' | 'card_unreachable' | 'call_customer' | 'bank_unconfirmed';
  text: string;
  at: string;
}

/** Settings → Payments: card payments (with Apple Pay and Google Pay) through the owner's Stripe account. */
/** The models "Write from photo" may use (Settings → AI writing). */
export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AiModel = (typeof AI_MODELS)[number];

/** Who writes "Write from photo": Anthropic (Claude), Google Gemini or DeepSeek. Styled photos are Gemini only. */
export const AI_PROVIDERS = ['anthropic', 'gemini', 'deepseek'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** A Gemini model id as the shop stores it (checked on the server; filled from Google's live list by Test). */
export const GEMINI_MODEL_ID = /^gemini-[a-z0-9.\-]{1,60}$/;

/** A DeepSeek model id as the shop stores it (checked on the server; DeepSeek's live list by Test). */
export const DEEPSEEK_MODEL_ID = /^deepseek-[a-z0-9.-]{2,60}$/;
/** DeepSeek's model that reads photos (DeepSeek-V4.1-Flash): the default. */
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';
/**
 * Whether a DeepSeek model reads photos: the Flash ones (deepseek-flash, and the retired
 * deepseek-v4-flash / deepseek-v4-flash-vision-exp names) and any "vision"/"vl" model do;
 * deepseek-v4-pro and the others are text only.
 */
export const deepseekReadsPhotos = (model: string): boolean => /-(?:flash|vision|vl)(?=-|\d|$)/.test(model);

/** Settings → AI writing: names and descriptions written from a product photo (off until a key is saved), and styled photos. */
export interface AiSettings {
  enabled: boolean;
  /** Which AI writes the text (default Anthropic). */
  provider: AiProvider;
  model: AiModel;
  /** The owner's Anthropic API key (secret: write-only, never sent to a browser or a backup). */
  anthropicApiKey: string;
  /** The owner's Google Gemini API key, AIza… or AQ.… (secret: write-only, never sent to a browser or a backup). */
  geminiApiKey: string;
  /** Gemini model for writing ('' until Test fills the list). */
  geminiModel: string;
  /** The owner's DeepSeek API key, sk-… (secret: write-only, never sent to a browser or a backup). */
  deepseekApiKey: string;
  /** DeepSeek model for writing (deepseek-flash reads photos; deepseek-v4-pro does not). */
  deepseekModel: string;
  /** Gemini model for AI pictures. */
  geminiImageModel: string;
  /**
   * Who makes AI pictures (Settings → AI pictures): '' until the owner chooses (then Gemini when a
   * Gemini key is saved, else OpenAI's or fal's when that key is). Independent of the writer.
   */
  picturesProvider: '' | 'gemini' | 'openai' | 'fal';
  /** The owner's OpenAI API key, sk-… (secret: write-only, never sent to a browser or a backup). */
  openaiApiKey: string;
  /** OpenAI image model ('' until Test lists them). */
  openaiImageModel: string;
  /** The owner's fal.ai key, key-id:key-secret (secret: write-only, never sent to a browser or a backup). */
  falApiKey: string;
  /** The fal model id (one of the curated list, or any fal edit model). */
  falModel: string;
  /** The shop shows a small "Styled image" tag on styled photos (default on). */
  labelStyledPhotos: boolean;
}

/** A photo made by "Style in a bedroom" (Gemini): never the original, always marked. */
export interface StagedPhoto {
  staged: true;
  /** The photo it was made from (a stored image name), or '' for a photo not kept in the shop. */
  source: string;
  /** One of STAGING_PRESETS' ids. */
  preset: string;
  at: string;
}

export interface PaymentSettings {
  /** Offer "Card" (and Apple Pay / Google Pay) at checkout. Off until the keys are in. */
  cardEnabled: boolean;
  /** pk_test_… or pk_live_… (public: it goes to the browser). */
  stripePublishableKey: string;
  /** sk_… or rk_… (secret: never leaves the server). */
  stripeSecretKey: string;
  /** whsec_… (secret: proves a webhook came from Stripe). */
  stripeWebhookSecret: string;
  /** Added to card orders (items + delivery), 0–10 with up to 2 decimals; 0: no fee. Default 3.5. */
  cardFeePercent: number;
  /**
   * Bank transfer at checkout: send_details (the saved account is emailed and on the order's private
   * page), ask_whatsapp (the customer messages the shop's WhatsApp for the details; no account needs
   * to be saved), off; default: send_details with an account saved, else ask_whatsapp with a WhatsApp
   * number, else off.
   */
  bankTransferMode: BankTransferMode;
}

export type BankTransferMode = 'default' | 'send_details' | 'ask_whatsapp' | 'off';

export type BankState = 'awaiting' | 'uploaded' | 'not_received' | 'paid';

export interface BankTransferCheck {
  /** awaiting the transfer → uploaded (a screenshot to check) → paid; or not_received (looked, not there yet). */
  state: BankState;
  /** Screenshots uploaded so far (the latest replaces the earlier ones on screen; all are kept). */
  uploads: number;
  uploadedAt?: string;
  /** When the bank details were emailed to the customer (once). */
  emailedAt?: string;
  checkedAt?: string;
  checkedBy?: string;
  /** The order's private page, /pay/<token>, while it is open (not paid or cancelled, under 14 days). */
  payPath?: string;
  /** The same page as a full link for the customer, from the shop's configured address only (admin only). */
  payUrl?: string;
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
  /** How it was confirmed: the customer's WhatsApp message, or the owner's phone call. */
  method?: 'whatsapp' | 'call';
  /**
   * Settings → Phone check "WhatsApp (free)": when an order still not confirmed is cancelled
   * (its pieces back on sale). Absent: never cancelled for this (an SMS-verified or older order,
   * or a bank transfer: flagged for the owner instead).
   */
  cancelAt?: string;
  /** Sooner than cancelAt: when it is cancelled if the customer never opens WhatsApp (absent once opened). */
  openBy?: string;
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
  /** Packaging allowance added to every parcel's weight, in grams (default 200). */
  packagingGrams?: number;
  autoAssignRules: {
    codCourier: CourierProvider; // Defaults to 'jeebly'
    prepaidCourier: CourierProvider; // Defaults to 'echo'
  };
  jeebly: {
    /** Live (production) keys: used only when isLive is on. */
    apiKey: string;
    clientKey: string;
    /** Jeebly sandbox keys: test bookings go to Jeebly's sandbox with these. */
    sandboxApiKey: string;
    sandboxClientKey: string;
    serviceType: 'Scheduled' | 'Express';
    isLive: boolean;
    pickupLocationName: string;
    pickupPhone: string;
    pickupAddress: string;
    /** Jeebly's production address, given by Jeebly with the live keys (https, *.jeebly.com). */
    liveBaseUrl?: string;
    /** Building or warehouse name, unit / shop number, area and a landmark: empty until the owner adds them. */
    pickupBuilding?: string;
    pickupArea?: string;
    pickupUnit?: string;
    pickupLandmark?: string;
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
  /** defaultType: what a new product in this category starts as (absent: bedding). */
  /** code: its 2–3 character SKU code (BUH-<code>-…); absent: made from the label (src/lib/sku.ts). */
  categories: Array<{ id: string; label: string; icon: string; defaultType?: ProductType; code?: string }>;
  /** The start of SKUs the shop makes (2–6 capitals or digits); absent: BUH. */
  skuPrefix?: string;
  /** Show "Only 1 left" when a size's stock is at or below this. */
  lowStockThreshold: number;
  /** The weaves a product may have, in the order the editor offers them (1–30, each 1–30 characters). */
  weaves: string[];
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

/**
 * Settings → Look: the shop's look (src/lib/design/themes.ts) and whether the device picks light
 * or dark. Who changed it and when are part of it, so each version in the settings history says so.
 */
export interface LookSettings {
  preset: import('@/lib/design/themes').LookPresetId;
  mode: import('@/lib/design/themes').LookMode;
  /** What the owner sees in the list ("Noir & Champagne · Always dark", "Switched back to: …"). */
  label: string;
  /** When this look was chosen (ISO, UTC). */
  changedAt: string;
  /** Who chose it (the admin's email; empty for the shop itself). */
  changedBy: string;
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
  /**
   * Settings → Phone check. 'whatsapp' (the default): no code is sent; the customer confirms the
   * order with one WhatsApp message. Absent (pages from before) or 'sms_code': the SMS code.
   */
  check?: PhoneCheckMode;
  /** WhatsApp mode: orders not confirmed within this many hours are cancelled. */
  cancelHours?: number;
}

export type PhoneCheckMode = 'whatsapp' | 'sms_code';

/** Settings → Phone check: how checkout makes sure the phone number is the customer's. */
export interface PhoneCheckSettings {
  /** 'whatsapp' (free, the default): one WhatsApp message after ordering. 'sms_code': a code by SMS gateway or Firebase. */
  mode: PhoneCheckMode;
  /** WhatsApp mode: an order not confirmed within this many hours (2 to 168) is cancelled, its pieces back on sale. */
  unconfirmedCancelHours: number;
  /** WhatsApp mode: sooner, when the customer never even opened WhatsApp (2 to 48, never later than unconfirmedCancelHours). */
  unopenedCancelHours: number;
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
