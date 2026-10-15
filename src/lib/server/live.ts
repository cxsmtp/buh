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
 * they change, with a heartbeat. One poller per process checks the database
 * every 2 seconds and tells every open stream, so 500 open pages cost one
 * query, not 500. Streams are capped (in total and per address) and end
 * after 10 minutes; the browser reconnects by itself.
 */
const MAX_STREAMS = Number(process.env.LIVE_MAX_STREAMS) || 2000;
const MAX_PER_IP = 5;

interface Subscriber {
  channels: Channel[];
  ip: string;
  send: (text: string) => void;
  last: string;
}
const subscribers = new Set<Subscriber>();
let poller: NodeJS.Timeout | undefined;

function payloadFor(sub: Subscriber, all: Record<Channel, number>): string {
  return JSON.stringify({ ...Object.fromEntries(sub.channels.map((c) => [c, all[c]])), app: process.env.NEXT_PUBLIC_APP_VERSION ?? '' });
}

function poll() {
  let all: Record<Channel, number>;
  try {
    all = versions();
  } catch {
    return;
  }
  for (const sub of subscribers) {
    const payload = payloadFor(sub, all);
    if (payload !== sub.last) {
      sub.last = payload;
      sub.send(`data: ${payload}\n\n`);
    }
  }
}

function subscribe(sub: Subscriber) {
  subscribers.add(sub);
  if (!poller) {
    poller = setInterval(poll, 2000);
    poller.unref?.();
  }
}

function unsubscribe(sub: Subscriber) {
  subscribers.delete(sub);
  if (subscribers.size === 0 && poller) {
    clearInterval(poller);
    poller = undefined;
  }
}

/** Test hook: how many streams are open. */
export function _openStreams() {
  return subscribers.size;
}

export function eventStream(req: Request, channels: Channel[], ip = 'unknown'): Response {
  let fromIp = 0;
  for (const s of subscribers) if (s.ip === ip) fromIp++;
  if (subscribers.size >= MAX_STREAMS || fromIp >= MAX_PER_IP) {
    // The page simply doesn't get live updates; it still works and reloads data as usual.
    return new Response('Too many live connections.', { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } });
  }
  const encoder = new TextEncoder();
  let beat: NodeJS.Timeout | undefined;
  let end: NodeJS.Timeout | undefined;
  let sub: Subscriber | undefined;
  const stop = () => {
    clearInterval(beat);
    clearTimeout(end);
    if (sub) unsubscribe(sub);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      sub = {
        channels,
        ip,
        last: '',
        send: (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            stop();
          }
        },
      };
      sub.send('retry: 5000\n\n');
      try {
        sub.last = payloadFor(sub, versions());
        sub.send(`data: ${sub.last}\n\n`);
      } catch {
        // the poller will send it
      }
      subscribe(sub);
      beat = setInterval(() => sub?.send(': keep-alive\n\n'), 25_000);
      beat.unref?.();
      end = setTimeout(close, 10 * 60_000);
      end.unref?.();
      req.signal.addEventListener('abort', close);
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
