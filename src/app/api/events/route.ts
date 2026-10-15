import { clientIp } from '@/lib/server/http';
import { eventStream } from '@/lib/server/live';

/** Live updates for shoppers: catalogue and settings counters (no order data). Capped per address. */
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  return eventStream(req, ['catalog', 'settings'], clientIp(req) ?? 'unknown');
}
