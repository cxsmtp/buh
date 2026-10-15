import crypto from 'node:crypto';
import net from 'node:net';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { audit } from './audit';
import { getDb, inTransaction } from './db';
import { HttpError } from './http';
import { logEvent } from './log';
import { appUrl } from './runtimeConfig';
import { mac, macMatches } from './secrets';
import { getSettings } from './settings';

/**
 * Passkeys (WebAuthn) for the Admin Hub: sign in with the fingerprint, face or
 * screen lock of a phone or computer instead of the password.
 *
 *  - The shop's domain (the relying party) comes from NEXT_PUBLIC_APP_URL,
 *    never from a request header. It must be https://, or http://localhost
 *    (a browser only offers passkeys there). Without it, passkeys work only
 *    for a browser on the server itself at http://localhost.
 *  - Every ceremony gets a random challenge, kept in the database for 5
 *    minutes, used up by the first answer (DELETE … RETURNING), and tied to
 *    this browser by an HttpOnly, SameSite=Strict cookie carrying its id with
 *    an HMAC; adding a passkey is also tied to the session that asked.
 *  - Only discoverable passkeys with user verification (fingerprint, face,
 *    PIN) are made and accepted; no attestation is asked for.
 *  - The signature counter is checked: a counter that goes backwards means the
 *    passkey may have been copied, and it is refused (and reported).
 */

export const CHALLENGE_COOKIE = 'buh_webauthn';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_LIVE_CHALLENGES = 10_000;
export const MAX_PASSKEYS = 20;
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;

export interface RelyingParty {
  rpID: string;
  origin: string;
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

/**
 * The shop's identity for passkeys, from NEXT_PUBLIC_APP_URL. Only when that
 * is not set, a browser on this computer (Host: localhost) may use them: a
 * passkey made for "localhost" works only in a browser on the same machine,
 * so believing that Host header gives nobody anything. A plain-language
 * problem comes back when passkeys can't work here.
 */
export function relyingParty(hostHeader?: string | null): RelyingParty | { problem: string } {
  const configured = appUrl();
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      return { problem: 'Passkeys need the shop’s address: NEXT_PUBLIC_APP_URL in .env.production is not a valid address.' };
    }
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
      return { problem: 'Passkeys need the shop’s domain name (like https://yourdomain.ae), not a numeric address, in NEXT_PUBLIC_APP_URL.' };
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost(url.hostname))) {
      return { problem: 'Passkeys need a secure address: NEXT_PUBLIC_APP_URL must start with https:// (or be http://localhost while testing).' };
    }
    return { rpID: url.hostname.toLowerCase(), origin: url.origin };
  }
  const host = (hostHeader || '').trim().toLowerCase();
  if (/^localhost(:\d{1,5})?$/.test(host)) return { rpID: 'localhost', origin: `http://${host}` };
  return { problem: 'Passkeys need the shop’s address: set NEXT_PUBLIC_APP_URL=https://yourdomain.ae in .env.production and restart the shop.' };
}

export function requireRelyingParty(hostHeader?: string | null): RelyingParty {
  const rp = relyingParty(hostHeader);
  if ('problem' in rp) throw new HttpError(409, rp.problem);
  return rp;
}

// ── Challenges ───────────────────────────────────────────────────────────────

type Purpose = 'register' | 'sign-in';

/**
 * Keep a challenge. The table is bounded, but a full table never refuses: the
 * oldest sign-in challenges make room (no shop-wide counter that a stranger
 * could use up to block passkey sign-in; to push out the owner's own challenge
 * in the few seconds of a sign-in they would have to start thousands).
 */
function saveChallenge(purpose: Purpose, challenge: string, boundTo: string, now: number): string {
  const db = getDb();
  const id = crypto.randomBytes(24).toString('base64url');
  inTransaction(() => {
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(now);
    const live = (db.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get() as { n: number }).n;
    if (live >= MAX_LIVE_CHALLENGES) {
      db.prepare("DELETE FROM webauthn_challenges WHERE id IN (SELECT id FROM webauthn_challenges WHERE purpose = 'sign-in' ORDER BY expires_at LIMIT ?)").run(live - MAX_LIVE_CHALLENGES + 1);
    }
    db.prepare('INSERT INTO webauthn_challenges (id, purpose, challenge, bound_to, expires_at) VALUES (?, ?, ?, ?, ?)').run(id, purpose, challenge, boundTo, now + CHALLENGE_TTL_MS);
  });
  return id;
}

/** Use a challenge up (whatever the outcome): it can answer one passkey response only. */
function takeChallenge(id: string | null, purpose: Purpose, boundTo: string, now: number): string {
  const expired = new HttpError(400, 'This passkey request has expired. Please try again.');
  if (!id) throw expired;
  const row = getDb().prepare('DELETE FROM webauthn_challenges WHERE id = ? RETURNING purpose, challenge, bound_to, expires_at').get(id) as
    | { purpose: string; challenge: string; bound_to: string; expires_at: number }
    | undefined;
  if (!row || row.purpose !== purpose || row.expires_at <= now || row.bound_to !== boundTo) throw expired;
  return row.challenge;
}

/** The cookie that ties a challenge to this browser: its id and an HMAC of it. */
export function challengeCookie(id: string) {
  return {
    name: CHALLENGE_COOKIE,
    value: `${id}.${mac('webauthn-challenge', id)}`,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
    sameSite: 'strict' as const,
    path: '/api/admin',
    maxAge: Math.floor(CHALLENGE_TTL_MS / 1000),
  };
}

/** Adding a passkey is tied to the session that asked for it, as well as to the browser. */
export function registrationBinding(session: { email: string; issuedAt: number }): string {
  return crypto.createHash('sha256').update(`${session.email}\n${session.issuedAt}`).digest('base64url');
}

export function clearedChallengeCookie() {
  return { ...challengeCookie(''), value: '', maxAge: 0 };
}

export function challengeIdFromCookie(value: string | undefined): string | null {
  if (!value || value.length > 200) return null;
  const [id, sig] = value.split('.');
  if (!id || !sig || !macMatches('webauthn-challenge', id, sig)) return null;
  return id;
}

// ── The owner's WebAuthn identity ────────────────────────────────────────────

/** A random user handle for the owner (the same for every passkey), kept with the shop's data. */
function ownerUserId(): Buffer {
  const db = getDb();
  db.prepare("INSERT INTO kv (key, data, updated_at) VALUES ('admin:webauthn-user-id', ?, ?) ON CONFLICT(key) DO NOTHING").run(
    JSON.stringify(crypto.randomBytes(32).toString('base64url')),
    new Date().toISOString()
  );
  const row = db.prepare("SELECT data FROM kv WHERE key = 'admin:webauthn-user-id'").get() as { data: string };
  return Buffer.from(JSON.parse(row.data) as string, 'base64url');
}

// ── Stored passkeys ──────────────────────────────────────────────────────────

interface PasskeyRow {
  id: string;
  public_key: Buffer;
  counter: number;
  transports: string;
  name: string;
  rp_id: string;
  device_type: string;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Synced to the owner's other devices (iCloud Keychain, Google Password Manager…). */
  synced: boolean;
  /** Made for another address of the shop: it won't work here until added again. */
  otherAddress: boolean;
  /** Came back with a restored backup: switched off until the owner confirms it. */
  suspended: boolean;
}

function info(row: PasskeyRow, rpID?: string, suspended = suspendedPasskeyIds()): PasskeyInfo {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    synced: row.backed_up === 1,
    otherAddress: Boolean(rpID && row.rp_id !== rpID),
    suspended: suspended.has(row.id),
  };
}

export function listPasskeys(rpID?: string): PasskeyInfo[] {
  const suspended = suspendedPasskeyIds();
  return (getDb().prepare('SELECT * FROM admin_passkeys ORDER BY created_at').all() as PasskeyRow[]).map((r) => info(r, rpID, suspended));
}

export function removePasskey(id: string): PasskeyInfo | null {
  const row = getDb().prepare('DELETE FROM admin_passkeys WHERE id = ? RETURNING *').get(id) as PasskeyRow | undefined;
  if (!row) return null;
  const result = info(row);
  setSuspended([...suspendedPasskeyIds()].filter((x) => x !== id));
  return { ...result, suspended: false };
}

// ── After a restore ──────────────────────────────────────────────────────────
//
// A backup can be older than the owner's last "Remove" (a lost phone) or new
// set of recovery codes, and nothing in the restored data can say so. So the
// restore script (scripts/restore-backup.mjs) voids every restored recovery
// code and lists every restored passkey here: they stay switched off until the
// owner, signed in with the password (a restore always leaves one: a fresh
// one-time password in the log, or ADMIN_PASSWORD_HASH), confirms or removes
// each. The Admin Hub shows a banner until the owner has reviewed them.

const SUSPENDED_KEY = 'admin:passkeys-suspended';
const RESTORED_KEY = 'admin:restored';

export function suspendedPasskeyIds(): Set<string> {
  const row = getDb().prepare('SELECT data FROM kv WHERE key = ?').get(SUSPENDED_KEY) as { data: string } | undefined;
  try {
    const list = row ? (JSON.parse(row.data) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function setSuspended(ids: string[]) {
  const db = getDb();
  if (!ids.length) db.prepare('DELETE FROM kv WHERE key = ?').run(SUSPENDED_KEY);
  else db.prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(SUSPENDED_KEY, JSON.stringify(ids), new Date().toISOString());
}

/** The owner keeps a restored passkey: it works again. */
export function confirmPasskey(id: string): PasskeyInfo | null {
  const row = getDb().prepare('SELECT * FROM admin_passkeys WHERE id = ?').get(id) as PasskeyRow | undefined;
  if (!row) return null;
  setSuspended([...suspendedPasskeyIds()].filter((x) => x !== id));
  return info(row);
}

export interface RestoreNotice {
  restoredAt: string;
  backup: string;
  suspendedPasskeys: number;
}

/** Set by the restore script; shown as a banner in the Admin Hub until dismissed. */
export function restoreNotice(): RestoreNotice | null {
  const row = getDb().prepare('SELECT data FROM kv WHERE key = ?').get(RESTORED_KEY) as { data: string } | undefined;
  if (!row) return null;
  try {
    const data = JSON.parse(row.data) as { at?: unknown; backup?: unknown };
    const live = new Set((getDb().prepare('SELECT id FROM admin_passkeys').all() as Array<{ id: string }>).map((r) => r.id));
    return {
      restoredAt: typeof data.at === 'string' ? data.at : '',
      backup: typeof data.backup === 'string' ? data.backup.slice(0, 200) : '',
      suspendedPasskeys: [...suspendedPasskeyIds()].filter((id) => live.has(id)).length,
    };
  } catch {
    return null;
  }
}

export function dismissRestoreNotice() {
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(RESTORED_KEY);
}

/** A passkey's name: printable, one line, at most 60 characters. */
export function cleanPasskeyName(input: unknown): string {
  const name = typeof input === 'string' ? input.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  return name || 'Passkey';
}

// ── What the browser sends back (only the fields WebAuthn defines) ───────────

const B64URL = /^[A-Za-z0-9_-]*$/;

function b64(value: unknown, max: number, field: string, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.length > max || !B64URL.test(value)) throw new HttpError(400, `The passkey answer is not valid (${field}).`);
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'The passkey answer is not valid.');
  return value as Record<string, unknown>;
}

export function parseRegistrationResponse(value: unknown): RegistrationResponseJSON {
  const v = asObject(value);
  const r = asObject(v.response);
  if (v.type !== 'public-key') throw new HttpError(400, 'The passkey answer is not valid.');
  const transports = Array.isArray(r.transports) ? r.transports.filter((t): t is string => typeof t === 'string' && /^[a-z-]{1,20}$/.test(t)).slice(0, 8) : undefined;
  return {
    id: b64(v.id, 1400, 'id')!,
    rawId: b64(v.rawId, 1400, 'rawId')!,
    type: 'public-key',
    response: {
      clientDataJSON: b64(r.clientDataJSON, 4000, 'clientDataJSON')!,
      attestationObject: b64(r.attestationObject, 16000, 'attestationObject')!,
      ...(transports ? { transports: transports as RegistrationResponseJSON['response']['transports'] } : {}),
    },
    clientExtensionResults: {},
    ...(v.authenticatorAttachment === 'platform' || v.authenticatorAttachment === 'cross-platform' ? { authenticatorAttachment: v.authenticatorAttachment } : {}),
  };
}

export function parseAuthenticationResponse(value: unknown): AuthenticationResponseJSON {
  const v = asObject(value);
  const r = asObject(v.response);
  if (v.type !== 'public-key') throw new HttpError(400, 'The passkey answer is not valid.');
  const userHandle = r.userHandle === null || r.userHandle === '' ? undefined : b64(r.userHandle, 200, 'userHandle', false);
  return {
    id: b64(v.id, 1400, 'id')!,
    rawId: b64(v.rawId, 1400, 'rawId')!,
    type: 'public-key',
    response: {
      clientDataJSON: b64(r.clientDataJSON, 4000, 'clientDataJSON')!,
      authenticatorData: b64(r.authenticatorData, 4000, 'authenticatorData')!,
      signature: b64(r.signature, 2000, 'signature')!,
      ...(userHandle ? { userHandle } : {}),
    },
    clientExtensionResults: {},
  };
}

// ── Adding a passkey (signed in, password typed again) ───────────────────────

export async function startPasskeyRegistration(opts: { rp: RelyingParty; email: string; boundTo: string; now?: number }): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeId: string }> {
  const now = opts.now ?? Date.now();
  const existing = getDb().prepare('SELECT id, transports, rp_id FROM admin_passkeys').all() as Array<Pick<PasskeyRow, 'id' | 'transports' | 'rp_id'>>;
  if (existing.length >= MAX_PASSKEYS) throw new HttpError(400, `You already have ${MAX_PASSKEYS} passkeys. Remove one you no longer use first.`);
  const options = await generateRegistrationOptions({
    rpName: getSettings('brand').storeName || 'Beautiful UAE Home',
    rpID: opts.rp.rpID,
    userName: opts.email,
    userDisplayName: `${opts.email} (Admin Hub)`,
    userID: new Uint8Array(ownerUserId()),
    attestationType: 'none',
    timeout: CEREMONY_TIMEOUT_MS,
    // The same phone or key can't be added twice.
    excludeCredentials: existing.filter((c) => c.rp_id === opts.rp.rpID).map((c) => ({ id: c.id, transports: JSON.parse(c.transports) as string[] })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  });
  return { options, challengeId: saveChallenge('register', options.challenge, opts.boundTo, now) };
}

export async function finishPasskeyRegistration(opts: {
  rp: RelyingParty;
  challengeId: string | null;
  boundTo: string;
  response: RegistrationResponseJSON;
  name: string;
  now?: number;
}): Promise<PasskeyInfo> {
  const now = opts.now ?? Date.now();
  const challenge = takeChallenge(opts.challengeId, 'register', opts.boundTo, now);
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response: opts.response,
      expectedChallenge: challenge,
      expectedOrigin: opts.rp.origin,
      expectedRPID: opts.rp.rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    logEvent('warn', 'passkey_registration_refused', { error: err instanceof Error ? err.message : String(err) });
    throw new HttpError(400, 'The passkey could not be checked. Please try again.');
  }
  if (!result.verified) throw new HttpError(400, 'The passkey could not be checked. Please try again.');
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  const at = new Date(now).toISOString();
  const inserted = getDb()
    .prepare(
      'INSERT INTO admin_passkeys (id, public_key, counter, transports, name, rp_id, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING'
    )
    .run(credential.id, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), cleanPasskeyName(opts.name), opts.rp.rpID, credentialDeviceType, credentialBackedUp ? 1 : 0, at);
  if (inserted.changes !== 1) throw new HttpError(409, 'This passkey is already added.');
  return info(getDb().prepare('SELECT * FROM admin_passkeys WHERE id = ?').get(credential.id) as PasskeyRow, opts.rp.rpID);
}

// ── Signing in with a passkey ────────────────────────────────────────────────

export async function startPasskeySignIn(opts: { rp: RelyingParty; now?: number }): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeId: string }> {
  const now = opts.now ?? Date.now();
  // No list of passkeys: the browser offers the ones it has for this shop (discoverable passkeys).
  const options = await generateAuthenticationOptions({ rpID: opts.rp.rpID, userVerification: 'required', timeout: CEREMONY_TIMEOUT_MS });
  return { options, challengeId: saveChallenge('sign-in', options.challenge, '', now) };
}

export class PasskeyCloneSuspected extends HttpError {
  constructor(public readonly device: string) {
    super(401, 'This passkey was refused: it looks like it may have been copied. Sign in another way, then remove it in Settings → Passkeys & recovery codes and add it again.');
  }
}

/** Check a passkey sign-in; returns the passkey used. The caller then starts the session. */
export async function finishPasskeySignIn(opts: { rp: RelyingParty; challengeId: string | null; response: AuthenticationResponseJSON; now?: number }): Promise<PasskeyInfo> {
  const now = opts.now ?? Date.now();
  const challenge = takeChallenge(opts.challengeId, 'sign-in', '', now);
  const refused = new HttpError(401, 'That passkey was not accepted. Use your password or a recovery code, or try again.');
  const row = getDb().prepare('SELECT * FROM admin_passkeys WHERE id = ?').get(opts.response.id) as PasskeyRow | undefined;
  if (!row || row.rp_id !== opts.rp.rpID) throw refused;
  const handle = opts.response.response.userHandle;
  if (handle && handle !== ownerUserId().toString('base64url')) throw refused;
  if (suspendedPasskeyIds().has(row.id)) {
    throw new HttpError(401, 'This passkey came back with a restored backup and is switched off until you confirm it. Sign in with your password, then check it in Settings → Passkeys & recovery codes.');
  }

  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response: opts.response,
      expectedChallenge: challenge,
      expectedOrigin: opts.rp.origin,
      expectedRPID: opts.rp.rpID,
      // Counter 0 here: the library's own counter check would run on an unchecked answer's say-so;
      // ours below runs only once the signature is proven.
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: 0, transports: JSON.parse(row.transports) },
      requireUserVerification: true,
    });
  } catch (err) {
    logEvent('warn', 'passkey_sign_in_refused', { error: err instanceof Error ? err.message : String(err) });
    throw refused;
  }
  if (!result.verified) throw refused;

  // Signed by this passkey, yet a counter that did not go up (when the authenticator keeps one):
  // two copies of the key exist.
  const counter = result.authenticationInfo.newCounter;
  if ((counter > 0 || row.counter > 0) && counter <= row.counter) {
    logEvent('warn', 'passkey_counter_went_back', { device: row.name, stored: row.counter, given: counter });
    audit('admin.passkey_counter_went_back', { device: row.name, stored: row.counter, given: counter });
    throw new PasskeyCloneSuspected(row.name);
  }
  const at = new Date(now).toISOString();
  getDb()
    .prepare('UPDATE admin_passkeys SET counter = MAX(counter, ?), last_used_at = ?, backed_up = ? WHERE id = ?')
    .run(result.authenticationInfo.newCounter, at, result.authenticationInfo.credentialBackedUp ? 1 : 0, row.id);
  return info({ ...row, last_used_at: at }, opts.rp.rpID);
}
