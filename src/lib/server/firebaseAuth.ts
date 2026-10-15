import crypto from 'node:crypto';

/**
 * Verify a Firebase Authentication ID token with Node's crypto only (no
 * firebase-admin), following Google's published rules:
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
 *
 * - header: alg RS256 and a kid that Google currently publishes;
 * - signature: RSA-SHA256 against Google's securetoken certificates (cached
 *   for the Cache-Control max-age; refetched once when an unknown kid shows up);
 * - claims: iss and aud name *this* project, exp in the future, iat and
 *   auth_time not in the future (60 s skew), a non-empty sub, signed in by
 *   phone, recently, and carrying a phone_number.
 *
 * The certificate fetcher is injectable so tests run without the network.
 */

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const SKEW_SEC = 60;
const MAX_TOKEN_LENGTH = 8 * 1024;
/** Don't refetch for an unknown kid more often than this: random kids must not turn us into a Google pinger. */
const MIN_REFETCH_MS = 60 * 1000;
const DEFAULT_MAX_AGE_SEC = 60 * 60;
/** A sign-in older than this is not proof the customer holds the phone now. */
export const DEFAULT_MAX_AUTH_AGE_SEC = 10 * 60;

export const FIREBASE_PROJECT_ID = /^[a-z0-9-]{4,40}$/;

/** PEM certificates or PEM public keys by kid, and how long they may be cached. */
export interface CertSet {
  keys: Record<string, string>;
  maxAgeSec?: number;
}
export type FetchCerts = () => Promise<CertSet>;

export interface VerifyOptions {
  fetchCerts?: FetchCerts;
  /** Milliseconds since the epoch (tests). */
  now?: number;
  maxAuthAgeSec?: number;
}

export interface VerifiedFirebaseUser {
  phone: string;
  uid: string;
}

/** Why a token was refused (for logs; the customer sees a generic message). */
export class FirebaseTokenError extends Error {
  constructor(public readonly reason: string) {
    super(`Firebase ID token refused: ${reason}`);
    this.name = 'FirebaseTokenError';
  }
}

interface CacheEntry {
  keys: Map<string, crypto.KeyObject>;
  fetchedAt: number;
  expiresAt: number;
}

const caches = new WeakMap<FetchCerts, CacheEntry>();
/** One fetch at a time per fetcher: concurrent checkouts share it. */
const pending = new WeakMap<FetchCerts, Promise<CacheEntry>>();

/** Google's certificates over https, with a 10 s timeout and a size cap. */
export const fetchGoogleCerts: FetchCerts = async () => {
  const res = await fetch(GOOGLE_CERTS_URL, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Google certificates: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 64 * 1024) throw new Error('Google certificates: response too large');
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Google certificates: not an object');
  const keys: Record<string, string> = {};
  for (const [kid, pem] of Object.entries(data)) if (typeof pem === 'string') keys[kid] = pem;
  const maxAge = /(?:^|[,\s])max-age=(\d+)/i.exec(res.headers.get('cache-control') || '')?.[1];
  return { keys, maxAgeSec: maxAge ? Number(maxAge) : undefined };
};

function toKey(pem: string): crypto.KeyObject | null {
  try {
    const key = pem.includes('BEGIN CERTIFICATE') ? new crypto.X509Certificate(pem).publicKey : crypto.createPublicKey(pem);
    return key.asymmetricKeyType === 'rsa' ? key : null;
  } catch {
    return null;
  }
}

function load(fetchCerts: FetchCerts, now: number): Promise<CacheEntry> {
  const running = pending.get(fetchCerts);
  if (running) return running;
  const promise = fetchCerts()
    .then((set) => {
      const keys = new Map<string, crypto.KeyObject>();
      for (const [kid, pem] of Object.entries(set?.keys || {})) {
        const key = typeof pem === 'string' ? toKey(pem) : null;
        if (key) keys.set(kid, key);
      }
      const age = Number(set?.maxAgeSec);
      const maxAge = Number.isFinite(age) && age > 0 ? Math.min(age, 24 * 60 * 60) : DEFAULT_MAX_AGE_SEC;
      const entry: CacheEntry = { keys, fetchedAt: now, expiresAt: now + maxAge * 1000 };
      caches.set(fetchCerts, entry);
      return entry;
    })
    // A failed fetch leaves the previous cache as it was.
    .finally(() => pending.delete(fetchCerts));
  pending.set(fetchCerts, promise);
  return promise;
}

async function keyFor(kid: string, fetchCerts: FetchCerts, now: number): Promise<crypto.KeyObject | null> {
  let entry = caches.get(fetchCerts);
  let fetched = false;
  if (!entry || now >= entry.expiresAt) {
    entry = await load(fetchCerts, now);
    fetched = true;
  }
  const key = entry.keys.get(kid);
  if (key) return key;
  // Google may have rotated: refetch once, but not on every forged kid.
  if (!fetched && now - entry.fetchedAt >= MIN_REFETCH_MS) {
    entry = await load(fetchCerts, now);
    return entry.keys.get(kid) ?? null;
  }
  return null;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodePart(part: string, what: string): Record<string, unknown> {
  if (!B64URL.test(part)) throw new FirebaseTokenError(`malformed ${what}`);
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new FirebaseTokenError(`malformed ${what}`);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The verified E.164 phone number (and Firebase uid) carried by `idToken`, or
 * a FirebaseTokenError. Network failures fetching certificates are thrown as
 * ordinary errors (the route answers 500/503, not "invalid").
 */
export async function verifyFirebaseIdToken(idToken: unknown, projectId: string, options: VerifyOptions = {}): Promise<VerifiedFirebaseUser> {
  const now = options.now ?? Date.now();
  const nowSec = Math.floor(now / 1000);
  const fetchCerts = options.fetchCerts ?? fetchGoogleCerts;
  const maxAuthAge = options.maxAuthAgeSec ?? DEFAULT_MAX_AUTH_AGE_SEC;

  if (!FIREBASE_PROJECT_ID.test(projectId)) throw new FirebaseTokenError('no project configured');
  if (typeof idToken !== 'string' || !idToken || idToken.length > MAX_TOKEN_LENGTH) throw new FirebaseTokenError('missing token');
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[2]) throw new FirebaseTokenError('not a signed JWT');
  const [h, p, s] = parts;
  const header = decodePart(h, 'header');
  // Before any network: only RS256 with a key id is ever accepted (no "none", no HS256 with a public key as secret).
  if (header.alg !== 'RS256') throw new FirebaseTokenError('algorithm');
  if (typeof header.kid !== 'string' || !header.kid || header.kid.length > 128) throw new FirebaseTokenError('kid');
  const payload = decodePart(p, 'payload');
  if (!B64URL.test(s)) throw new FirebaseTokenError('malformed signature');

  const key = await keyFor(header.kid, fetchCerts, now);
  if (!key) throw new FirebaseTokenError('unknown kid');
  const signature = Buffer.from(s, 'base64url');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  if (!ok) throw new FirebaseTokenError('signature');

  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new FirebaseTokenError('issuer');
  if (payload.aud !== projectId) throw new FirebaseTokenError('audience');
  if (!isNum(payload.exp) || payload.exp <= nowSec) throw new FirebaseTokenError('expired');
  if (!isNum(payload.iat) || payload.iat > nowSec + SKEW_SEC) throw new FirebaseTokenError('issued in the future');
  if (!isNum(payload.auth_time) || payload.auth_time > nowSec + SKEW_SEC) throw new FirebaseTokenError('auth_time in the future');
  if (nowSec - payload.auth_time > maxAuthAge) throw new FirebaseTokenError('sign-in too old');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new FirebaseTokenError('subject');
  const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
  if (firebase?.sign_in_provider !== 'phone') throw new FirebaseTokenError('not a phone sign-in');
  const phone = payload.phone_number;
  if (typeof phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(phone)) throw new FirebaseTokenError('no phone number');
  return { phone, uid: payload.sub };
}

/** Test hook. */
export function _clearFirebaseCertCache(fetchCerts: FetchCerts = fetchGoogleCerts) {
  caches.delete(fetchCerts);
  pending.delete(fetchCerts);
}
