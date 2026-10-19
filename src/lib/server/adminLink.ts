import crypto from 'node:crypto';
import { getDb, inTransaction } from './db';
import { kvGet, kvSet } from './kv';
import { mac, serverSecret } from './secrets';

/**
 * The Admin Hub's private link, and the "door" cookie it gives.
 *
 * The hub is not on the public site: it lives at one random path, e.g.
 * https://shop.example/k7Qm2vXa9pTeLr4w…, which the owner bookmarks. Everything
 * else, /admin and every /api/admin/ address included, answers exactly like an
 * address that does not exist until the browser has been through that path.
 *
 * - The path segment is 24 random bytes (192 bits) in base64url: 32 characters.
 * - Only its SHA-256 (with a purpose prefix) is stored, in the database (kv
 *   "admin:link", so it is in backups and survives a restore). A copy of the
 *   database or a backup does not reveal the link. Checks compare digests in
 *   constant time.
 * - Each link has a random version. Visiting the link sets the door cookie: a
 *   token signed with the server's key, bound to that version and to the link's
 *   hash, valid 30 days and renewed (at most once a day) while it is used.
 *   Changing the link gives a new version, so the old link and every door
 *   cookie stop working at once, in every running copy of the shop.
 * - The link cannot be shown again (only the hash is kept). Lost it? Make a new
 *   one: `node scripts/admin-link.mjs --new` on the server.
 *
 * scripts/admin-link.mjs writes the same record (keep the format in step).
 */

export const DOOR_COOKIE = 'buh_door';
export const DOOR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A door cookie is renewed when it is older than this. */
const DOOR_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const LINK_KEY = 'admin:link';
const REVEAL_KEY = 'admin:link-reveal';
const NOTICE_KEY = 'admin:link-notice';
const RESET_KEY = 'admin:password-reset';

export const LINK_BYTES = 24;
/** A link segment: 32 base64url characters (192 bits). */
export const LINK_PATTERN = /^[A-Za-z0-9_-]{32}$/;
/** A password-reset email's single-reset door grant: 43 base64url characters (256 bits). */
export const GRANT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The internal page the link is served from. Never reachable by its own name (src/lib/server/frontGate.ts). */
export const HUB_ROUTE = '/hub';
/** The proxy passes this to the hub page, so the page can tell it came through the link. */
export const HUB_HEADER = 'x-buh-door';

export interface LinkRecord {
  hash: string;
  version: string;
  createdAt: string;
  /** Who made it: "startup" (first start or the update that brought links), "hub", "script". */
  via: string;
}

export function generateLinkSegment(): string {
  return crypto.randomBytes(LINK_BYTES).toString('base64url');
}

/** The stored form of a link segment (or a reset grant): SHA-256 with a purpose prefix, base64url. */
export function hashSegment(segment: string, purpose = 'buh-admin-link'): string {
  return crypto.createHash('sha256').update(`${purpose}\n${segment}`).digest('base64url');
}

function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** For logs: the first 4 characters only. */
export function maskSegment(segment: string): string {
  return `${segment.slice(0, 4)}…`;
}

function isRecord(v: unknown): v is LinkRecord {
  const r = v as LinkRecord;
  return Boolean(r) && typeof r.hash === 'string' && typeof r.version === 'string' && r.hash.length > 0 && r.version.length > 0;
}

/** The current link's record (read from the database each time, so a change elsewhere counts at once). */
export function currentLink(): LinkRecord | null {
  const rec = kvGet<unknown>(LINK_KEY)?.data;
  return isRecord(rec) ? rec : null;
}

function newRecord(segment: string, via: string): LinkRecord {
  return { hash: hashSegment(segment), version: crypto.randomBytes(9).toString('base64url'), createdAt: new Date().toISOString(), via };
}

/** Is this path segment the admin link? Constant-time on the digest. */
export function matchesLink(segment: string, rec: LinkRecord | null = currentLink()): boolean {
  if (!rec || !LINK_PATTERN.test(segment)) return false;
  return sameDigest(hashSegment(segment), rec.hash);
}

/**
 * Make the first link if there is none yet (atomic: when two copies of the shop start
 * together, one makes it). Returns the new segment, or null when a link already existed.
 */
export function createLinkIfAbsent(via = 'startup'): string | null {
  const segment = generateLinkSegment();
  const rec = newRecord(segment, via);
  const changed = getDb()
    .prepare('INSERT INTO kv (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .run(LINK_KEY, JSON.stringify(rec), rec.createdAt).changes;
  return changed === 1 ? segment : null;
}

/** A new link: the old one and every door cookie stop working now. Returns the new segment. */
export function rotateLink(via: string): string {
  const segment = generateLinkSegment();
  inTransaction(() => {
    kvSet(LINK_KEY, newRecord(segment, via));
    kvSet(REVEAL_KEY, null);
  });
  return segment;
}

// ── The door cookie ─────────────────────────────────────────────────────────

interface DoorPayload {
  v: string;
  iat: number;
  exp: number;
  /** A hard end (ms): a door given by a grant (a reset or setup email) never lasts past the grant, renewed or not. */
  cap?: number;
  /** An accountant's door (given through their setup link): their account id and session generation. */
  s?: string;
  g?: number;
}

/** What a door is bound to besides the link: a hard end, and an accountant's account (src/lib/server/staffAuth.ts). */
export interface DoorBinding {
  cap?: number;
  staff?: { id: string; gen: number };
}

function doorMac(body: string, rec: LinkRecord): string {
  return mac('admin-door', `${rec.version}\n${rec.hash}\n${body}`);
}

/**
 * A door token for the current link (null when there is no link yet, or its cap has passed). With a
 * binding: never valid past `cap` (a renewal keeps it), and an accountant's door ends with their
 * sessions (a revoke, a new setup link, a sign-out everywhere). The owner's door has neither.
 */
export function issueDoorToken(now = Date.now(), rec: LinkRecord | null = currentLink(), ttlMs = DOOR_TTL_MS, bind: DoorBinding = {}): string | null {
  if (!rec) return null;
  const cap = typeof bind.cap === 'number' && Number.isFinite(bind.cap) ? bind.cap : undefined;
  const exp = Math.min(now + Math.min(ttlMs, DOOR_TTL_MS), cap ?? Infinity);
  if (!(exp > now)) return null;
  const payload: DoorPayload = { v: rec.version, iat: now, exp, ...(cap !== undefined ? { cap } : {}), ...(bind.staff ? { s: bind.staff.id, g: bind.staff.gen } : {}) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${doorMac(body, rec)}`;
}

/** An accountant's door stands while their account does, with the same session generation (as their session does). */
function staffDoorStands(id: unknown, gen: unknown): boolean {
  if (typeof id !== 'string' || id.length > 40 || typeof gen !== 'number') return false;
  const row = getDb().prepare("SELECT session_gen FROM staff_accounts WHERE id = ? AND status IN ('invited', 'active')").get(id) as { session_gen: number } | undefined;
  return row?.session_gen === gen;
}

/** Is this door token valid for the current link? `renew` when it should be re-issued (with the same `bind`). */
export function verifyDoorToken(token: string | undefined | null, now = Date.now(), rec: LinkRecord | null = currentLink()): { ok: boolean; renew: boolean; bind?: DoorBinding } {
  const no = { ok: false, renew: false };
  if (!rec || !token || token.length > 512) return no;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return no;
  const body = token.slice(0, dot);
  if (!sameDigest(doorMac(body, rec), token.slice(dot + 1))) return no;
  let payload: DoorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return no;
  }
  if (payload.v !== rec.version || !Number.isFinite(payload.exp) || payload.exp <= now) return no;
  if (payload.cap !== undefined && !(Number(payload.cap) > now)) return no;
  if (payload.s !== undefined && !staffDoorStands(payload.s, payload.g)) return no;
  const bind: DoorBinding = {
    ...(payload.cap !== undefined ? { cap: Number(payload.cap) } : {}),
    ...(payload.s !== undefined ? { staff: { id: String(payload.s), gen: Number(payload.g) } } : {}),
  };
  return { ok: true, renew: now - Number(payload.iat || 0) > DOOR_RENEW_AFTER_MS, ...(bind.cap !== undefined || bind.staff ? { bind } : {}) };
}

/** The door token in a Cookie header. */
export function doorTokenFromCookieHeader(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === DOOR_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function doorCookie(token: string, ttlMs = DOOR_TTL_MS) {
  return {
    name: DOOR_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: Math.max(1, Math.floor(Math.min(ttlMs, DOOR_TTL_MS) / 1000)),
  };
}

/** What the proxy hands the hub page (a value only the server can make, for the current link). */
export function hubHeaderValue(rec: LinkRecord | null = currentLink()): string {
  return rec ? mac('admin-hub-page', `${rec.version}\n${rec.hash}`) : '';
}

export function hubHeaderMatches(given: string | null | undefined): boolean {
  const expected = hubHeaderValue();
  return Boolean(expected && given) && sameDigest(expected, String(given));
}

// ── The password-reset email's door grant ───────────────────────────────────

/**
 * A password-reset email opens the hub through a grant of its own (a random path,
 * valid only while that reset is open: 30 minutes, ended by setting the password), so
 * a reset works from a phone's mail app that has never been through the admin link.
 * The door it gives lasts only as long as the grant (not 30 days). Not used up on the
 * first visit on purpose: a mail app's link check opens links before the owner does.
 * Returns when the grant ends (ms), or 0 when it doesn't open anything.
 */
export function resetGrantExpiry(segment: string, now = Date.now()): number {
  if (!GRANT_PATTERN.test(segment)) return 0;
  const raw = kvGet<unknown>(RESET_KEY)?.data;
  const links = Array.isArray(raw) ? raw : [];
  const given = hashSegment(segment, 'buh-reset-grant');
  let found = 0;
  for (const l of links as Array<{ grant?: unknown; expires?: unknown }>) {
    // Every entry is compared (no early exit), so the time taken says nothing.
    if (typeof l?.grant === 'string' && typeof l.expires === 'number' && l.expires > now && sameDigest(given, l.grant)) found = l.expires;
  }
  return found || staffGrantExpiry(segment, now);
}

/**
 * An accountant's setup email opens the hub the same way (src/lib/server/staffAuth.ts): its own
 * grant, valid while that invite is open (72 hours, ended by choosing a password or by a revoke).
 */
function staffGrant(segment: string, now: number): { expires: number; id: string; gen: number } | null {
  const row = getDb()
    .prepare("SELECT id, session_gen AS gen, setup_grant_hash AS hash, setup_expires_at AS expires FROM staff_accounts WHERE setup_grant_hash = ? AND status = 'invited'")
    .get(hashSegment(segment, 'buh-staff-grant')) as { id: string; gen: number; hash: string; expires: number | null } | undefined;
  return row && Number(row.expires) > now && sameDigest(hashSegment(segment, 'buh-staff-grant'), row.hash) ? { expires: Number(row.expires), id: row.id, gen: row.gen } : null;
}

function staffGrantExpiry(segment: string, now: number): number {
  return staffGrant(segment, now)?.expires ?? 0;
}

/**
 * The door a grant path gives (a password-reset email's, or an accountant's setup email's): capped
 * at the grant's end, however often it is renewed; an accountant's is also bound to their account,
 * so a revoke or a new setup link ends it at once. Null when the path opens nothing.
 */
export function grantDoorBinding(segment: string, now = Date.now()): (DoorBinding & { cap: number }) | null {
  if (!GRANT_PATTERN.test(segment)) return null;
  const expires = resetGrantExpiry(segment, now);
  if (!expires) return null;
  const staff = staffGrant(segment, now);
  return staff && staff.expires === expires ? { cap: expires, staff: { id: staff.id, gen: staff.gen } } : { cap: expires };
}

export function matchesResetGrant(segment: string, now = Date.now()): boolean {
  return resetGrantExpiry(segment, now) > 0;
}

export function newResetGrant(): { grant: string; grantHash: string } {
  const grant = crypto.randomBytes(32).toString('base64url');
  return { grant, grantHash: hashSegment(grant, 'buh-reset-grant') };
}

// ── Showing a new link once to an owner who is signed in ────────────────────

/** How long the link made by an update can be shown to a signed-in owner (an admin session's longest life). */
export const REVEAL_TTL_MS = 8 * 60 * 60 * 1000;

function revealKey(): Buffer {
  return crypto.createHmac('sha256', serverSecret()).update('admin-link-reveal').digest();
}

/**
 * Keep the link made by an update for one showing to an owner who is signed in at
 * that moment (they open the shop, and land on the new link once). Encrypted with
 * the server's key (not in the database or in backups), deleted once shown or after
 * 8 hours, and left out of backups.
 */
export function storeReveal(segment: string, now = Date.now()) {
  const rec = currentLink();
  if (!rec) return;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', revealKey(), iv);
  const data = Buffer.concat([c.update(segment, 'utf8'), c.final()]);
  kvSet(REVEAL_KEY, { v: rec.version, iv: iv.toString('base64url'), tag: c.getAuthTag().toString('base64url'), data: data.toString('base64url'), expires: now + REVEAL_TTL_MS });
}

/** Take the pending link (once). Null when there is none, it expired, or the link changed since. */
export function takeReveal(now = Date.now()): string | null {
  const raw = kvGet<{ v?: string; iv?: string; tag?: string; data?: string; expires?: number }>(REVEAL_KEY)?.data;
  if (!raw || !raw.data) return null;
  // Single use: only the request that deletes it shows it.
  const deleted = getDb().prepare("DELETE FROM kv WHERE key = ? AND data != 'null'").run(REVEAL_KEY).changes === 1;
  if (!deleted) return null;
  const rec = currentLink();
  if (!rec || raw.v !== rec.version || !raw.expires || raw.expires <= now) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', revealKey(), Buffer.from(String(raw.iv), 'base64url'));
    d.setAuthTag(Buffer.from(String(raw.tag), 'base64url'));
    const segment = Buffer.concat([d.update(Buffer.from(raw.data, 'base64url')), d.final()]).toString('utf8');
    return matchesLink(segment, rec) ? segment : null;
  } catch {
    return null;
  }
}

export function hasPendingReveal(now = Date.now()): boolean {
  const raw = kvGet<{ expires?: number }>(REVEAL_KEY)?.data;
  return Boolean(raw && raw.expires && raw.expires > now);
}

// ── "Bookmark this page" in the hub ─────────────────────────────────────────

/** The hub says "this is your admin link: bookmark it" until the owner dismisses it. */
export function setLinkNotice(reason: 'created' | 'moved' | 'new') {
  const rec = currentLink();
  if (rec) kvSet(NOTICE_KEY, { v: rec.version, reason });
}

export function linkNotice(): 'created' | 'moved' | 'new' | null {
  const raw = kvGet<{ v?: string; reason?: 'created' | 'moved' | 'new' }>(NOTICE_KEY)?.data;
  const rec = currentLink();
  return raw && rec && raw.v === rec.version && raw.reason ? raw.reason : null;
}

export function clearLinkNotice() {
  kvSet(NOTICE_KEY, null);
}

/** The full link, for the owner's eyes only (console, email, the one-time answer). */
export function linkUrl(segment: string, base: string | undefined): string {
  return base ? `${base.replace(/\/$/, '')}/${segment}` : `/${segment}`;
}
