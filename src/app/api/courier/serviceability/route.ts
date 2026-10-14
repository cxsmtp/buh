import { NextRequest } from 'next/server';
import { checkJeeblyServiceability } from '@/lib/jeeblyServiceability';
import { enforceIpLimit } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';

function coordinate(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'string' && value !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
}

function check(input: { emirate?: unknown; area?: unknown; lat?: unknown; lng?: unknown }) {
  return checkJeeblyServiceability({
    emirate: text(input.emirate, 40) || 'Dubai',
    area: text(input.area, 120),
    lat: coordinate(input.lat, -90, 90),
    lng: coordinate(input.lng, -180, 180),
  });
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
    return json(check({
      emirate: searchParams.get('emirate'),
      area: searchParams.get('area'),
      lat: searchParams.get('lat'),
      lng: searchParams.get('lng'),
    }));
  } catch (error) {
    return handleRouteError(error, 'courier/serviceability', { serviceable: false });
  }
}
