'use client';

import { Product, Order, Customer, CourierSettings, BankTransferDetails, CourierProvider, BrandSettings, SmsGatewaySettings } from '@/types';
import { INITIAL_PRODUCTS, INITIAL_ORDERS, INITIAL_CUSTOMERS, INITIAL_COURIER_SETTINGS, INITIAL_BANK_DETAILS, INITIAL_BRAND_SETTINGS, INITIAL_SMS_SETTINGS } from '@/data/initialData';

const PRODUCTS_KEY = 'buh_products_v1';
const ORDERS_KEY = 'buh_orders_v1';
const CUSTOMERS_KEY = 'buh_customers_v1';
const COURIER_SETTINGS_KEY = 'buh_courier_settings_v1';
const BANK_DETAILS_KEY = 'buh_bank_details_v1';
const BRAND_SETTINGS_KEY = 'buh_brand_settings_v1';
const SMS_SETTINGS_KEY = 'buh_sms_settings_v1';

/**
 * Read a JSON list from localStorage, falling back to (and restoring) the
 * defaults when it is missing, unreadable or not the expected shape, so one
 * corrupted entry cannot break the whole storefront.
 */
function readList<T>(key: string, fallback: T[]): T[] {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === 'object') as T[];
    localStorage.setItem(key, JSON.stringify(fallback));
  } catch {
    // unreadable or storage blocked: use the defaults
  }
  return fallback;
}

function readObject<T extends object>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    localStorage.setItem(key, JSON.stringify(fallback));
  } catch {
    // unreadable or storage blocked: use the defaults
  }
  return fallback;
}

/** localStorage writes can throw (quota full, private mode); never let that crash a page. */
function write(key: string, value: unknown): boolean {
  if (typeof window === 'undefined') return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn(`Could not save ${key}:`, err);
    return false;
  }
}

export function getStoredProducts(): Product[] {
  return readList(PRODUCTS_KEY, INITIAL_PRODUCTS);
}

export function saveStoredProducts(products: Product[]): void {
  write(PRODUCTS_KEY, products);
}

export function addProduct(product: Product): Product[] {
  const products = [product, ...getStoredProducts()];
  saveStoredProducts(products);
  return products;
}

export function getStoredOrders(): Order[] {
  return readList(ORDERS_KEY, INITIAL_ORDERS);
}

export function saveStoredOrders(orders: Order[]): void {
  write(ORDERS_KEY, orders);
}

export function addOrder(order: Order): Order[] {
  const currentOrders = getStoredOrders();
  const updatedOrders = [order, ...currentOrders];
  saveStoredOrders(updatedOrders);
  
  // Also update or add to CRM Customers
  syncCustomerFromOrder(order);
  return updatedOrders;
}

export function updateOrder(orderId: string, updates: Partial<Order>): Order[] {
  const currentOrders = getStoredOrders();
  const updatedOrders = currentOrders.map((o) => {
    if (o.id === orderId) {
      return { ...o, ...updates };
    }
    return o;
  });
  saveStoredOrders(updatedOrders);
  return updatedOrders;
}

export function getStoredCustomers(): Customer[] {
  return readList(CUSTOMERS_KEY, INITIAL_CUSTOMERS);
}

export function saveStoredCustomers(customers: Customer[]): void {
  write(CUSTOMERS_KEY, customers);
}

function syncCustomerFromOrder(order: Order) {
  const customers = getStoredCustomers();
  const existingIndex = customers.findIndex(
    (c) => c.phone.replace(/\s+/g, '') === order.customer.phone.replace(/\s+/g, '')
  );

  if (existingIndex >= 0) {
    customers[existingIndex].totalOrders += 1;
    customers[existingIndex].totalSpent += order.total;
    customers[existingIndex].lastOrderDate = order.createdAt;
  } else {
    customers.unshift({
      id: `cust-${Date.now()}`,
      fullName: order.customer.fullName,
      phone: order.customer.phone,
      email: order.customer.email,
      emirate: order.customer.emirate,
      area: order.customer.area,
      totalOrders: 1,
      totalSpent: order.total,
      lastOrderDate: order.createdAt,
      defaultAddress: {
        buildingVilla: order.customer.buildingVilla,
        flatVillaNo: order.customer.flatVillaNo,
        streetAddress: order.customer.streetAddress,
        landmark: order.customer.landmark,
      },
    });
  }
  saveStoredCustomers(customers);
}

export function getCourierSettings(): CourierSettings {
  return readObject(COURIER_SETTINGS_KEY, INITIAL_COURIER_SETTINGS);
}

export function saveCourierSettings(settings: CourierSettings): void {
  write(COURIER_SETTINGS_KEY, settings);
}

export function getBankDetails(): BankTransferDetails {
  return readObject(BANK_DETAILS_KEY, INITIAL_BANK_DETAILS);
}

export function saveBankDetails(details: BankTransferDetails): void {
  write(BANK_DETAILS_KEY, details);
}

export function getBrandSettings(): BrandSettings {
  const parsed = readObject<Partial<BrandSettings>>(BRAND_SETTINGS_KEY, INITIAL_BRAND_SETTINGS);
  return {
    ...INITIAL_BRAND_SETTINGS,
    ...parsed,
    marquee: {
      ...INITIAL_BRAND_SETTINGS.marquee,
      ...(parsed.marquee || {}),
    },
  };
}

export function saveBrandSettings(settings: BrandSettings): void {
  write(BRAND_SETTINGS_KEY, settings);
}

export function getSmsSettings(): SmsGatewaySettings {
  const parsed = readObject<Partial<SmsGatewaySettings>>(SMS_SETTINGS_KEY, INITIAL_SMS_SETTINGS);
  return {
    ...INITIAL_SMS_SETTINGS,
    ...parsed,
    twilio: {
      ...INITIAL_SMS_SETTINGS.twilio,
      ...(parsed.twilio || {}),
    },
    infobip: {
      ...INITIAL_SMS_SETTINGS.infobip,
      ...(parsed.infobip || {}),
    },
    unifonic: {
      ...INITIAL_SMS_SETTINGS.unifonic,
      ...(parsed.unifonic || {}),
    },
    customWebhook: {
      ...INITIAL_SMS_SETTINGS.customWebhook,
      ...(parsed.customWebhook || {}),
    },
  };
}

export function saveSmsSettings(settings: SmsGatewaySettings): void {
  write(SMS_SETTINGS_KEY, settings);
}

/**
 * Smart courier determination:
 * Cash on Delivery -> Default to Jeebly
 * Prepaid / Bank Transfer -> Default to Echo
 */
export function getDefaultCourierForOrder(paymentMethod: Order['paymentMethod']): CourierProvider {
  const settings = getCourierSettings();
  if (paymentMethod === 'cod') {
    return settings.autoAssignRules.codCourier || 'jeebly';
  }
  return settings.autoAssignRules.prepaidCourier || 'echo';
}
