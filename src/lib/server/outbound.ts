import dns from 'node:dns';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { HttpError } from './http';

/**
 * SSRF guard for any URL that an admin (or a request body) can choose, such as
 * an SMS webhook or an Infobip base URL. Only https, no embedded credentials,
 * no non-default ports unless allowed, and every address the host resolves to
 * must be public: no loopback, private, link-local (cloud metadata), CGNAT or
 * multicast ranges.
 */

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

/** Expand an IPv6 address (with optional embedded IPv4 tail) to 8 16-bit groups, or null. */
function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase().replace(/%.*$/, '');
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (!net.isIPv4(v4[1])) return null;
    const n = ipv4ToInt(v4[1]);
    s = `${s.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * True for any address a server-side request must not reach. IPv6 is an
 * allow-list: only global unicast (2000::/3) passes, minus documentation,
 * Teredo and 6to4 (which tunnel to arbitrary IPv4). IPv4-mapped forms are
 * judged by the IPv4 address inside them. Anything unparsable is refused.
 */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  if (!net.isIPv6(ip)) return true;
  const g = parseIPv6(ip);
  if (!g) return true;
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated): judge the IPv4 inside.
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  if ((zeros(5) && g[5] === 0xffff) || (zeros(4) && g[4] === 0xffff && g[5] === 0)) {
    return isBlockedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if ((g[0] & 0xe000) !== 0x2000) return true; // outside 2000::/3: loopback, ULA, link-local, multicast, NAT64, discard…
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true; // documentation, Teredo
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return true; // ORCHID
  if (g[0] === 0x2002) return true; // 6to4
  return false;
}

export async function assertPublicHttpsUrl(raw: string, field = 'URL'): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${field} is not a valid URL.`);
  }
  if (url.protocol !== 'https:') throw new HttpError(400, `${field} must use https.`);
  if (url.username || url.password) throw new HttpError(400, `${field} must not contain credentials.`);
  if (url.port && url.port !== '443') throw new HttpError(400, `${field} must use the standard https port.`);

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new HttpError(400, `${field} must point to a public host.`);
  }

  const addresses = net.isIP(host)
    ? [host]
    : await lookup(host, { all: true, verbatim: true })
        .then((list) => list.map((a) => a.address))
        .catch(() => {
          throw new HttpError(400, `${field} host could not be resolved.`);
        });
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new HttpError(400, `${field} must point to a public host.`);
  }
  return url;
}

/**
 * A DNS lookup that refuses to hand back any non-public address. Used as the
 * connection's own lookup, so the address checked is the address connected
 * to: a name that resolves differently a second time (DNS rebinding) cannot
 * slip through.
 */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(`Refusing to connect to a non-public address for ${hostname}`), { code: 'EBLOCKED' }), '');
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/** What safeRequest got back: the status, the headers, and at most maxBytes of the body. */
export interface SafeResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: Buffer;
  /** The reply was longer than maxBytes: reading stopped there (body holds what came before). */
  truncated: boolean;
}

export type SafeRequestInit = { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number };

/**
 * HTTPS request with a timeout (for the whole exchange, the body included), no redirects (a
 * redirect could bounce a vetted URL to an internal one), a cap on how much of the reply is read,
 * and every connection checked against the non-public address ranges above. A timeout rejects
 * (code ETIMEDOUT), also once the reply has started: a cut-off body is never taken as the answer.
 */
export function safeRequest(url: string | URL, init: SafeRequestInit = {}): Promise<SafeResponse> {
  const { method = 'GET', headers = {}, body, timeoutMs = 10_000, maxBytes = 256 * 1024 } = init;
  const target = new URL(url);
  if (target.protocol !== 'https:') return Promise.reject(new Error('Only https is allowed.'));
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(Object.assign(new Error('Refusing to connect to a non-public address.'), { code: 'EBLOCKED' }));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(err);
    };
    const timedOut = () => Object.assign(new Error('Request timed out.'), { code: 'ETIMEDOUT' });
    const req = https.request(
      target,
      {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
        lookup: guardedLookup as unknown as typeof dns.lookup,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => {
          if (settled) return;
          if (!truncated && !res.complete) return fail(Object.assign(new Error('The reply was cut off.'), { code: 'ECONNRESET' }));
          settled = true;
          clearTimeout(deadline);
          const status = res.statusCode ?? 0;
          const head: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) head[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          resolve({ status, ok: status >= 200 && status < 300, headers: head, body: Buffer.concat(chunks), truncated });
        };
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            finish();
            res.destroy();
            return;
          }
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (err) => fail(err));
      }
    );
    // Overall deadline, not just idle time.
    const deadline = setTimeout(() => {
      fail(timedOut());
      req.destroy(timedOut());
    }, timeoutMs);
    req.on('timeout', () => {
      fail(timedOut());
      req.destroy(timedOut());
    });
    req.on('error', (err) => fail(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** safeRequest with the reply read as JSON (null when it is not JSON, or longer than maxBytes). */
export async function safeFetch(url: string | URL, init: SafeRequestInit = {}): Promise<{ status: number; ok: boolean; data: unknown }> {
  const res = await safeRequest(url, init);
  let data: unknown = null;
  if (!res.truncated) {
    try {
      const text = res.body.toString('utf8');
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
  }
  return { status: res.status, ok: res.ok, data };
}
