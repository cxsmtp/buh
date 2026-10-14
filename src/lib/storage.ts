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
const CART_KEY = 'buh_cart_v1';

export function getStoredProducts(): Product[] {
  if (typeof window === 'undefined') return INITIAL_PRODUCTS;
  try {
    const raw = localStorage.getItem(PRODUCTS_KEY);
    if (!raw) {
      localStorage.setItem(PRODUCTS_KEY, JSON.stringify(INITIAL_PRODUCTS));
      return INITIAL_PRODUCTS;
    }
    return JSON.parse(raw);
  } catch {
    return INITIAL_PRODUCTS;
  }
}

export function saveStoredProducts(products: Product[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(PRODUCTS_KEY, JSON.stringify(products));
}

export function addProduct(product: Product): Product[] {
  const products = [product, ...getStoredProducts()];
  saveStoredProducts(products);
  return products;
}

export function getStoredOrders(): Order[] {
  if (typeof window === 'undefined') return INITIAL_ORDERS;
  try {
    const raw = localStorage.getItem(ORDERS_KEY);
    if (!raw) {
      localStorage.setItem(ORDERS_KEY, JSON.stringify(INITIAL_ORDERS));
      return INITIAL_ORDERS;
    }
    return JSON.parse(raw);
  } catch {
    return INITIAL_ORDERS;
  }
}

export function saveStoredOrders(orders: Order[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
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
  if (typeof window === 'undefined') return INITIAL_CUSTOMERS;
  try {
    const raw = localStorage.getItem(CUSTOMERS_KEY);
    if (!raw) {
      localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(INITIAL_CUSTOMERS));
      return INITIAL_CUSTOMERS;
    }
    return JSON.parse(raw);
  } catch {
    return INITIAL_CUSTOMERS;
  }
}

export function saveStoredCustomers(customers: Customer[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CUSTOMERS_KEY, JSON.stringify(customers));
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
  if (typeof window === 'undefined') return INITIAL_COURIER_SETTINGS;
  try {
    const raw = localStorage.getItem(COURIER_SETTINGS_KEY);
    if (!raw) {
      localStorage.setItem(COURIER_SETTINGS_KEY, JSON.stringify(INITIAL_COURIER_SETTINGS));
      return INITIAL_COURIER_SETTINGS;
    }
    return JSON.parse(raw);
  } catch {
    return INITIAL_COURIER_SETTINGS;
  }
}

export function saveCourierSettings(settings: CourierSettings): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(COURIER_SETTINGS_KEY, JSON.stringify(settings));
}

export function getBankDetails(): BankTransferDetails {
  if (typeof window === 'undefined') return INITIAL_BANK_DETAILS;
  try {
    const raw = localStorage.getItem(BANK_DETAILS_KEY);
    if (!raw) {
      localStorage.setItem(BANK_DETAILS_KEY, JSON.stringify(INITIAL_BANK_DETAILS));
      return INITIAL_BANK_DETAILS;
    }
    return JSON.parse(raw);
  } catch {
    return INITIAL_BANK_DETAILS;
  }
}

export function saveBankDetails(details: BankTransferDetails): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(BANK_DETAILS_KEY, JSON.stringify(details));
}

export function getBrandSettings(): BrandSettings {
  if (typeof window === 'undefined') return INITIAL_BRAND_SETTINGS;
  try {
    const raw = localStorage.getItem(BRAND_SETTINGS_KEY);
    if (!raw) {
      localStorage.setItem(BRAND_SETTINGS_KEY, JSON.stringify(INITIAL_BRAND_SETTINGS));
      return INITIAL_BRAND_SETTINGS;
    }
    const parsed = JSON.parse(raw);
    return {
      ...INITIAL_BRAND_SETTINGS,
      ...parsed,
      marquee: {
        ...INITIAL_BRAND_SETTINGS.marquee,
        ...(parsed.marquee || {}),
      },
    };
  } catch {
    return INITIAL_BRAND_SETTINGS;
  }
}

export function saveBrandSettings(settings: BrandSettings): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(BRAND_SETTINGS_KEY, JSON.stringify(settings));
}

export function getSmsSettings(): SmsGatewaySettings {
  if (typeof window === 'undefined') return INITIAL_SMS_SETTINGS;
  try {
    const raw = localStorage.getItem(SMS_SETTINGS_KEY);
    if (!raw) {
      localStorage.setItem(SMS_SETTINGS_KEY, JSON.stringify(INITIAL_SMS_SETTINGS));
      return INITIAL_SMS_SETTINGS;
    }
    const parsed = JSON.parse(raw);
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
  } catch {
    return INITIAL_SMS_SETTINGS;
  }
}

export function saveSmsSettings(settings: SmsGatewaySettings): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SMS_SETTINGS_KEY, JSON.stringify(settings));
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
