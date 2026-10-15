import crypto from 'node:crypto';
import { Order, CourierSettings } from '@/types';

/** `uncertain`: no answer from the carrier, so the shipment may or may not exist. */
function liveFailure(message: string, httpStatus?: number, uncertain = false): JeeblyApiResponse {
  return { success: false, awbNumber: '', trackingNumber: '', trackingUrl: '', message, isSimulated: false, httpStatus, uncertain };
}

export interface JeeblyCreateOrderPayload {
  pickupDate: string; // YYYY-MM-DD
  serviceType: 'Scheduled' | 'Express';
  consignmetLoadType: string;
  consignmentType: 'FORWARD' | 'REVERSE';
  sender: {
    name: string;
    phone: string;
    email: string;
    address: string;
    buildingName: string;
    houseNo: string;
    landmark?: string;
    emirate?: string;
  };
  recipient: {
    name: string;
    phone: string;
    email?: string;
    address: string;
    buildingName: string;
    houseNo: string;
    landmark?: string;
    emirate: string;
  };
  packageDetails: {
    weight: number;
    pieces: number;
    description: string;
    codAmount?: number;
    codCurrency?: string;
  };
  referenceNumber: string;
}

export interface JeeblyApiResponse {
  success: boolean;
  awbNumber: string;
  trackingNumber: string;
  trackingUrl: string;
  labelUrl?: string;
  message: string;
  isSimulated: boolean;
  httpStatus?: number;
  rawResponse?: Record<string, unknown>;
  uncertain?: boolean;
}

export async function createJeeblyShipment(
  order: Order,
  settings: CourierSettings['jeebly']
): Promise<JeeblyApiResponse> {
  const pickupDate = order.courier?.pickupDate || new Date(Date.now() + 86400000).toISOString().split('T')[0];
  
  const payload: JeeblyCreateOrderPayload = {
    pickupDate,
    serviceType: settings.serviceType || 'Scheduled',
    consignmetLoadType: 'Non-Document',
    consignmentType: 'FORWARD',
    sender: {
      name: settings.pickupLocationName || 'Beautiful UAE Home Central Warehouse',
      phone: settings.pickupPhone,
      email: 'logistics@beautifuluaehome.com',
      address: settings.pickupAddress || 'Warehouse 14, Al Quoz Industrial Area 3',
      buildingName: 'Al Quoz Logistics Park',
      houseNo: 'WH-14',
      landmark: 'Near Times Square Center',
      emirate: settings.pickupEmirate || 'Dubai',
    },
    recipient: {
      name: order.customer.fullName,
      phone: order.customer.phone,
      email: order.customer.email || 'customer@beautifuluaehome.com',
      address: `${order.customer.streetAddress}, ${order.customer.area}`,
      buildingName: order.customer.buildingVilla,
      houseNo: order.customer.flatVillaNo,
      landmark: order.customer.landmark || '',
      emirate: order.customer.emirate,
    },
    packageDetails: {
      weight: order.courier?.weightKg || 2.5,
      pieces: order.courier?.pieces || order.items.reduce((sum, item) => sum + item.quantity, 0),
      description: `Home Bedding: ${order.items.map(i => `${i.quantity}x ${i.title} (${i.profileName})`).join(', ')}`,
      ...(order.paymentMethod === 'cod' ? {
        codAmount: order.total,
        codCurrency: 'AED',
      } : {}),
    },
    referenceNumber: order.id,
  };

  const endpoint = settings.isLive
    ? 'https://portal.jeebly.com/customer/create_shipment'
    : 'https://demo.jeebly.com/customer/create_shipment';

  // Attempt real API call
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'XApiKey': settings.apiKey || 'test',
        'ClientKey': settings.clientKey || 'test',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });

    const data = await response.json().catch(() => null);

    if (response.ok && data && (data.success === 'true' || data.success === true)) {
      const awbNumber = data.awbNumber || data.trackingNumber ? String(data.awbNumber || data.trackingNumber) : '';
      if (!awbNumber) return liveFailure('Jeebly accepted the request but returned no AWB number.', response.status);
      return {
        success: true,
        awbNumber,
        trackingNumber: awbNumber,
        trackingUrl: `https://jeebly.com/track/${encodeURIComponent(awbNumber)}`,
        labelUrl: `https://integration.jeebly.com/v1/scheduled/label/${encodeURIComponent(awbNumber)}`,
        message: 'Order successfully registered with live Jeebly Logistics API.',
        isSimulated: false,
        httpStatus: response.status,
        rawResponse: data,
      };
    }
    if (settings.isLive) {
      // Live mode never invents an AWB: the customer would get a tracking
      // number the carrier does not know. Report the failure instead.
      return liveFailure(`Jeebly did not accept the shipment${data?.message ? `: ${String(data.message).slice(0, 200)}` : ''}.`, response.status);
    }
  } catch (err) {
    console.warn('Jeebly API connection attempt error:', (err as Error).message);
    if (settings.isLive) {
      return liveFailure(
        `No answer from Jeebly (timeout or network), so the shipment may or may not have been created. Check the Jeebly portal for reference ${order.id} before booking again.`,
        undefined,
        true
      );
    }
  }

  // Sandbox only: a clearly simulated AWB so the flow can be tried end to end.
  const randomSuffix = crypto.randomInt(100000, 1000000);
  const prefix = order.customer.emirate === 'Dubai' ? 'GPY-DXB' : 'GPY-UAE';
  const awbNumber = `${prefix}-${randomSuffix}`;

  return {
    success: true,
    awbNumber,
    trackingNumber: awbNumber,
    trackingUrl: `https://jeebly.com/track/${awbNumber}`,
    message: 'Sandbox: simulated Jeebly AWB (no live booking was made). Turn on live mode to book with the carrier.',
    isSimulated: true,
  };
}
