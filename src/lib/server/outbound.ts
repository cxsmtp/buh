import { lookup } from 'node:dns/promises';
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

export function isPrivateAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) ip = mapped[1];

  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    const first = parseInt(ip.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (ip.startsWith('64:ff9b:') || ip.startsWith('2001:db8:')) return true;
    return false;
  }
  return true; // not an IP at all: refuse rather than guess
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
 * fetch with a timeout, no automatic redirects (a redirect could bounce a
 * vetted URL to an internal one) and a cap on how much of the reply is read.
 */
export async function safeFetch(
  url: string | URL,
  init: RequestInit & { timeoutMs?: number; maxBytes?: number } = {}
): Promise<{ status: number; ok: boolean; data: unknown }> {
  const { timeoutMs = 10_000, maxBytes = 256 * 1024, ...rest } = init;
  const res = await fetch(url, { ...rest, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const text = await readCapped(res, maxBytes);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
