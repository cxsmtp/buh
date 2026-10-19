import { redact } from './server/log';
import { safeRequest, type SafeRequestInit, type SafeResponse } from './server/outbound';

/**
 * Everything this shop knows about Jeebly's Scheduled API, in one place.
 *
 * VERIFIED 2026-10-19 against Jeebly's docs (https://integration.jeebly.com/v1/: scheduled
 * create order, label, tracking, cancel) and the demo system (demo.jeebly.com) with the owner's
 * demo keys: create → label PDF → track → cancel. Every call is a POST with a JSON body and the
 * headers `X-API-KEY` and `client_key`. `success` is a STRING ("true"/"false", once "false1").
 * The production host is issued by Jeebly with the production keys (Couriers → Live address).
 */
export const JEEBLY_API = {
  /** Jeebly's demo (sandbox) environment. */
  sandboxBase: 'https://demo.jeebly.com',
  paths: {
    create: '/customer/create_shipment',
    label: '/customer/generate_shipment_label',
    track: '/customer/track_shipment',
    cancel: '/customer/cancel_shipment',
  },
  headers: { apiKey: 'X-API-KEY', clientKey: 'client_key' },
  /** The AWB in a create reply: the key is literally "AWB No". */
  awbField: 'AWB No',
  /** The UAE cities Jeebly accepts (note "Al-Ain" and "Umm Al-Quwain"). */
  cities: ['Abu Dhabi', 'Ajman', 'Al-Ain', 'Dubai', 'Fujairah', 'Ras Al Khaimah', 'Sharjah', 'Umm Al-Quwain'],
  /** The label PDF is about 43 KB; anything over this is refused. */
  labelMaxBytes: 2 * 1024 * 1024,
} as const;

export type JeeblyTarget = 'sandbox' | 'live';

/** The live address the owner enters (from Jeebly): https on jeebly.com or a *.jeebly.com host, nothing else. */
export function jeeblyLiveBase(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return '';
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return '';
  if (host !== 'jeebly.com' && !host.endsWith('.jeebly.com')) return '';
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return '';
  return `https://${host}`;
}

/** An emirate as Jeebly names the city ("Umm Al Quwain" → "Umm Al-Quwain"); '' when unknown. */
export function jeeblyCity(emirate: string): string {
  const key = String(emirate || '').toLowerCase().replace(/[^a-z]/g, '');
  return JEEBLY_API.cities.find((c) => c.toLowerCase().replace(/[^a-z]/g, '') === key) ?? '';
}

/** A UAE mobile as Jeebly takes it: digits only, without +971 or a leading 0 (501234567). */
export function jeeblyMobile(phone: string): string {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00971')) d = d.slice(5);
  else if (d.startsWith('971')) d = d.slice(3);
  return d.replace(/^0+/, '');
}

/** True for Jeebly's string or boolean success. */
export function jeeblyOk(data: unknown): boolean {
  const s = data && typeof data === 'object' ? (data as Record<string, unknown>).success : undefined;
  return s === 'true' || s === true;
}

/** The AWB from a create reply ("AWB No"), only letters, digits and dashes. */
export function jeeblyAwb(data: unknown): string {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>)[JEEBLY_API.awbField] : undefined;
  const awb = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  return /^[A-Za-z0-9-]{4,40}$/.test(awb) ? awb : '';
}

/** Jeebly's own message, verbatim as text: at most 200 characters, the keys and personal data masked. */
export function jeeblySaid(data: unknown, secrets: string[] = []): string {
  const raw = data && typeof data === 'object' ? (data as Record<string, unknown>).message : undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  let text = String(raw).trim();
  for (const s of secrets) if (s && s.length >= 4) text = text.split(s).join('[redacted]');
  return String(redact(text.replace(/[\u0000-\u001f\u007f]+/g, ' '))).slice(0, 200);
}

/** A hint for a Jeebly refusal the owner can fix in their Jeebly account. */
export function jeeblyHint(said: string): string {
  if (/bank details/i.test(said)) return ' Add your bank details in your Jeebly account (Jeebly needs them to pay out cash-on-delivery amounts), then book again.';
  if (/invalid api token|invalid customer key/i.test(said)) return ' Check the Jeebly keys in Couriers.';
  return '';
}

export interface JeeblyCall {
  /** False: no answer at all (network, timeout, also a reply cut off part way). */
  reached: boolean;
  status?: number;
  data?: unknown;
  /** False: Jeebly answered, but not with JSON that could be read (or longer than the cap). */
  readable?: boolean;
  /** 'blocked': the address is not a public one, so nothing was sent. */
  error?: 'timeout' | 'network' | 'blocked';
}

/** JSON replies are small (an AWB, a message, tracking events): anything longer is not read. */
export const JEEBLY_JSON_MAX_BYTES = 256 * 1024;

/**
 * The tests' stand-in for Jeebly (test/fixtures/jeebly-mock.mjs) is a fetch-style function set
 * here; otherwise every call goes through safeRequest (https only, public addresses only, checked
 * at connect time, no redirects, capped and timed out).
 */
const MOCK_FETCH = Symbol.for('buh.jeebly.fetch');

async function viaMock(mock: typeof fetch, url: string, init: SafeRequestInit): Promise<SafeResponse> {
  const signal = AbortSignal.timeout(init.timeoutMs ?? 10_000);
  const response = await mock(url, { method: init.method, headers: init.headers, body: init.body, redirect: 'manual', signal });
  const max = init.maxBytes ?? JEEBLY_JSON_MAX_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(Buffer.from(value.subarray(0, max - size)));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    size += value.length;
    chunks.push(Buffer.from(value));
  }
  return { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), body: Buffer.concat(chunks), truncated };
}

function send(url: string, init: SafeRequestInit): Promise<SafeResponse> {
  const mock = (globalThis as Record<symbol, unknown>)[MOCK_FETCH];
  return typeof mock === 'function' ? viaMock(mock as typeof fetch, url, init) : safeRequest(url, init);
}

const why = (err: unknown): NonNullable<JeeblyCall['error']> => {
  const e = err as { code?: string; name?: string };
  if (e?.code === 'EBLOCKED') return 'blocked';
  return e?.code === 'ETIMEDOUT' || e?.name === 'TimeoutError' ? 'timeout' : 'network';
};

const post = (keys: { apiKey: string; clientKey: string }, body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', [JEEBLY_API.headers.apiKey]: keys.apiKey, [JEEBLY_API.headers.clientKey]: keys.clientKey },
  body: JSON.stringify(body),
});

/** One JSON request to Jeebly (fixed paths; the base is the sandbox or the vetted live address). */
export async function callJeebly(base: string, path: string, keys: { apiKey: string; clientKey: string }, body: unknown, timeoutMs = 15_000): Promise<JeeblyCall> {
  let response: SafeResponse;
  try {
    response = await send(`${base}${path}`, { ...post(keys, body), timeoutMs, maxBytes: JEEBLY_JSON_MAX_BYTES });
  } catch (err) {
    return { reached: false, error: why(err) };
  }
  let data: unknown = null;
  let readable = false;
  if (!response.truncated) {
    try {
      data = JSON.parse(response.body.toString('utf8'));
      readable = data !== null && typeof data === 'object';
    } catch {
      data = null;
    }
  }
  return { reached: true, status: response.status, data, readable };
}

/**
 * The label PDF for an AWB (generate_shipment_label): only a reply that says application/pdf, starts
 * with %PDF- and stays under labelMaxBytes (reading stops just past it). Otherwise Jeebly's message
 * (a JSON refusal) or why not.
 */
export async function fetchJeeblyLabel(base: string, keys: { apiKey: string; clientKey: string }, awb: string): Promise<{ pdf: Buffer } | { error: string; status?: number }> {
  let response: SafeResponse;
  try {
    response = await send(`${base}${JEEBLY_API.paths.label}`, { ...post(keys, { reference_number: awb }), timeoutMs: 20_000, maxBytes: JEEBLY_API.labelMaxBytes + 1 });
  } catch (err) {
    return { error: `Could not reach Jeebly (${why(err)}).` };
  }
  const type = response.headers['content-type'] || '';
  const bytes = response.body;
  if (response.truncated || bytes.length > JEEBLY_API.labelMaxBytes) return { error: 'Jeebly sent a label that is too large.', status: response.status };
  if (response.ok && /application\/pdf/i.test(type) && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { pdf: bytes };
  }
  let said = '';
  try {
    said = jeeblySaid(JSON.parse(bytes.subarray(0, 4096).toString('utf8')), [keys.apiKey, keys.clientKey]);
  } catch {
    said = '';
  }
  return { error: `Jeebly did not send a label (HTTP ${response.status})${said ? `: ${said}` : ''}.`, status: response.status };
}

export interface JeeblyTracking {
  awb: string;
  lastStatus: string;
  /** Newest first. Only status, description, hub and time: never phones, rider, proof of delivery or signature. */
  events: Array<{ status: string; desc: string; hub: string; at: string }>;
}

const short = (v: unknown, max = 120) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');

/** track_shipment's reply → the fields the shop shows (others, phones and rider included, are dropped). */
export function mapJeeblyTracking(data: unknown): JeeblyTracking | null {
  if (!jeeblyOk(data)) return null;
  const t = (data as Record<string, unknown>).Tracking;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const tr = t as Record<string, unknown>;
  const events = Array.isArray(tr.events) ? tr.events : [];
  return {
    awb: short(tr.reference_no, 40),
    lastStatus: short(tr.last_status, 80),
    events: events.slice(0, 30).flatMap((e) => {
      if (!e || typeof e !== 'object') return [];
      const ev = e as Record<string, unknown>;
      const at = short(ev.event_date_time, 40);
      return [{ status: short(ev.status, 80), desc: short(ev.desc), hub: short(ev.hub_name, 60), at: Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : '' }];
    }),
  };
}
