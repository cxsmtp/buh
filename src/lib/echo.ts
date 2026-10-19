import crypto from 'node:crypto';
import { Order, CourierSettings } from '@/types';
import { ECO_LIVE_NOT_CONNECTED } from './courierMode';

/**
 * Eco Express. Its published API spec (ecoexpress-api.json) points at an Apiary MOCK server, not
 * Eco Express itself, so there is no real booking connection yet: live mode refuses (book in the
 * Eco portal, then "Enter tracking number" on the order), and a test booking is an offline
 * practice one. Nothing, keys included, is sent to the mock: its answers are not shipments.
 */

export interface EchoApiResponse {
  success: boolean;
  awbNumber: string;
  trackingNumber: string;
  trackingUrl: string;
  message: string;
  isSimulated: boolean;
  testKind?: 'sandbox' | 'practice';
  httpStatus?: number;
  rawResponse?: Record<string, unknown>;
  uncertain?: boolean;
  /** Eco live mode: not connected, nothing was sent. */
  notConnected?: boolean;
}

export async function createEchoShipment(order: Order, settings: CourierSettings['echo']): Promise<EchoApiResponse> {
  void order;
  if (settings.isLive) {
    return { success: false, awbNumber: '', trackingNumber: '', trackingUrl: '', message: ECO_LIVE_NOT_CONNECTED, isSimulated: false, notConnected: true };
  }
  const awbNumber = `PRACTICE-${crypto.randomInt(100000, 1000000)}`;
  return {
    success: true,
    awbNumber,
    trackingNumber: awbNumber,
    trackingUrl: '',
    message: 'Practice booking: nothing was sent to Eco Express. This is not a shipment.',
    isSimulated: true,
    testKind: 'practice',
  };
}
