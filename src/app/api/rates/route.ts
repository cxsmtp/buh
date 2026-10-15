import { getRates } from '@/lib/server/fx';
import { handleRouteError, json } from '@/lib/server/http';

/** Approximate exchange rates from AED (display only; customers pay in AED). */
export function GET() {
  try {
    return json({ rates: getRates() }, 200, { 'Cache-Control': 'public, max-age=3600' });
  } catch (err) {
    return handleRouteError(err, 'rates');
  }
}
