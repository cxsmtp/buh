import { NextRequest } from 'next/server';
import { deliveryCheck } from '@/lib/delivery';
import { enforceIpLimit } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { getSettings } from '@/lib/server/settings';

/**
 * "Do you deliver to my area?" From the address (emirate and area) and Settings → Delivery:
 * whether we deliver, how fast, and whether same-day delivery can be chosen now. The courier
 * is not named: it is chosen behind the scenes. A GPS reading plays no part.
 */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function check(input: { emirate?: unknown; area?: unknown }) {
  return deliveryCheck({ emirate: text(input.emirate, 40) || 'Dubai', area: text(input.area, 120) }, getSettings('delivery'));
}

export async function POST(req: NextRequest) {
  try {
    enforceIpLimit(req, 'svc', 120, 60 * 1000, 'Too many requests. Please slow down.');
    const body = await readJsonBody(req, 2 * 1024);
    return json(check(body));
  } catch (error) {
    return handleRouteError(error, 'courier/serviceability', { serviceable: false });
  }
}

export async function GET(req: NextRequest) {
  try {
    enforceIpLimit(req, 'svc', 120, 60 * 1000, 'Too many requests. Please slow down.');
    const { searchParams } = new URL(req.url);
    return json(check({ emirate: searchParams.get('emirate'), area: searchParams.get('area') }));
  } catch (error) {
    return handleRouteError(error, 'courier/serviceability', { serviceable: false });
  }
}
