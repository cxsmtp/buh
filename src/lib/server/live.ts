import { getDb } from './db';
import { kvBump } from './kv';

/**
 * Change counters for live updates. Anything that changes what shoppers see
 * (products, stock, settings) or what the admin sees (orders) bumps a counter
 * in the database; open pages watch them through /api/events and reload just
 * that data, quietly. Kept in the database, not in memory, so it works across
 * both running copies during an update.
 */

export type Channel = 'catalog' | 'settings' | 'orders';

export function bump(channel: Channel): void {
  try {
    kvBump(`v:${channel}`);
  } catch {
    // never let a counter break a sale or a save
  }
}

export function versions(): Record<Channel, number> {
  const rows = getDb().prepare("SELECT key, data FROM kv WHERE key IN ('v:catalog', 'v:settings', 'v:orders')").all() as Array<{ key: string; data: string }>;
  const out: Record<Channel, number> = { catalog: 0, settings: 0, orders: 0 };
  for (const r of rows) out[r.key.slice(2) as Channel] = Number(r.data) || 0;
  return out;
}

/**
 * A text/event-stream that sends the counters (and the app's version) when
 * they change, checking every 2 seconds, with a heartbeat. It ends after
 * 10 minutes; the browser reconnects by itself.
 */
export function eventStream(req: Request, channels: Channel[]): Response {
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | undefined;
  let beat: NodeJS.Timeout | undefined;
  let end: NodeJS.Timeout | undefined;
  const stop = () => {
    clearInterval(timer);
    clearInterval(beat);
    clearTimeout(end);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = '';
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      const check = () => {
        let v: Record<string, number>;
        try {
          const all = versions();
          v = Object.fromEntries(channels.map((c) => [c, all[c]]));
        } catch {
          return;
        }
        const payload = JSON.stringify({ ...v, app: process.env.NEXT_PUBLIC_APP_VERSION ?? '' });
        if (payload !== last) {
          last = payload;
          send(`data: ${payload}\n\n`);
        }
      };
      send('retry: 5000\n\n');
      check();
      timer = setInterval(check, 2000);
      beat = setInterval(() => send(': keep-alive\n\n'), 25_000);
      end = setTimeout(() => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }, 10 * 60_000);
      req.signal.addEventListener('abort', () => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel: stop,
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Cached data (the catalogue, the settings) is dropped when another copy of
 * the shop changed it: the counter in the database moved since this copy last
 * looked. Checked at most every 2 seconds, so it costs one tiny query.
 */
const seen: Partial<Record<Channel, number>> = {};
let checkedAt = 0;
let lastVersions: Record<Channel, number> | null = null;

export function changedElsewhere(channel: Channel): boolean {
  const now = Date.now();
  if (!lastVersions || now - checkedAt > 2000) {
    try {
      lastVersions = versions();
    } catch {
      return false;
    }
    checkedAt = now;
  }
  const v = lastVersions[channel];
  if (seen[channel] === undefined) {
    seen[channel] = v;
    return false;
  }
  if (v !== seen[channel]) {
    seen[channel] = v;
    return true;
  }
  return false;
}
