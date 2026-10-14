import fs from 'node:fs';
import { dataFile, writePrivateFile } from './dataDir';

/**
 * Live courier bookings, by order id, so an order is never booked twice: a
 * repeat request returns the booking already made, and an attempt that got no
 * answer from the carrier (it may or may not have been created) must be
 * confirmed by the owner before booking again. Sandbox bookings are not kept.
 */

export interface BookingRecord {
  state: 'booked' | 'uncertain';
  provider: 'jeebly' | 'echo';
  awbNumber: string;
  trackingUrl: string;
  at: string;
}

const FILE = () => dataFile('bookings.json');

function readAll(): Record<string, BookingRecord> {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getBooking(orderId: string): BookingRecord | undefined {
  const all = readAll();
  return Object.hasOwn(all, orderId) ? all[orderId] : undefined;
}

export function saveBooking(orderId: string, record: BookingRecord) {
  const all = readAll();
  all[orderId] = record;
  writePrivateFile(FILE(), JSON.stringify(all, null, 2));
}
