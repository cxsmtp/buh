import { json } from '@/lib/server/http';

/** Liveness probe for Docker / PM2 / uptime monitors. Reveals nothing else. */
export function GET() {
  return json({ ok: true });
}
