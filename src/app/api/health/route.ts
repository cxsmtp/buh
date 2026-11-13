import fs from 'node:fs';
import { json } from '@/lib/server/http';

/**
 * Written inside this container only (its own /tmp, never the shared data folder) by the updater
 * just before it stops this copy, once the new copy serves (deploy/updater/updater.sh drain_colour).
 */
const drainMark = () => process.env.BUH_DRAIN_MARK || '/tmp/buh-draining';

/**
 * Liveness probe for Docker / PM2 / uptime monitors and Caddy's health checks. Reveals nothing
 * else. Caddy's own probe (?lb=1, deploy/shop-snippets.caddy) answers 503 while this copy is being
 * replaced, so Caddy sends every request to the new copy and stops reusing its connections here;
 * the old copy then closes at once when stopped, instead of waiting for connections that never go
 * quiet (on Node 26 that held it until it was killed, cutting off the requests still on them).
 * Every other caller still gets 200: this copy keeps serving until Caddy has moved.
 */
export function GET(req: Request) {
  if (new URL(req.url).searchParams.get('lb') === '1' && fs.existsSync(drainMark())) return json({ ok: false, draining: true }, 503);
  return json({ ok: true });
}
