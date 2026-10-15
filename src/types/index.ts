export type Emirate = 
  | 'Dubai'
  | 'Abu Dhabi'
  | 'Sharjah'
  | 'Ajman'
  | 'Ras Al Khaimah'
  | 'Fujairah'
  | 'Umm Al Quwain';

export type BedSizeProfileId = 'single' | 'double' | 'queen' | 'king' | 'super-king' | 'custom';

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
  category: 'bedsheets' | 'duvet-covers' | 'fitted-sheets' | 'hotel-luxury' | 'silk-collection';
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
  stockCount: number;
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
