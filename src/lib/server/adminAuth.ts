import crypto from 'node:crypto';
import fs from 'node:fs';
import { dataFile, writePrivateFile } from './dataDir';
import { HttpError } from './http';
import { logEvent } from './log';
import { _resetServerSecret, serverSecret } from './secrets';
import { dummyPasswordHash, generatePassword, hashPassword, verifyPassword } from './password';

/**
 * Server-side admin authentication.
 *
 * Credentials come from ADMIN_EMAIL + ADMIN_PASSWORD_HASH (scrypt hash, made
 * with `npm run hash-password`), or, when those are not set, from an account
 * created on first start whose random password is printed to the server log
 * once and must be changed at first sign-in. Nothing about the credentials is
 * ever sent to the browser.
 *
 * Sessions are stateless HMAC-signed cookies (HttpOnly, SameSite=Strict,
 * Secure in production, 8 h). Each carries a session generation kept in
 * DATA_DIR and a fingerprint of the password hash: signing out or changing the
 * password bumps the generation, and rotating ADMIN_PASSWORD_HASH changes the
 * fingerprint, so every earlier session ends at once.
 *
 * Wrong passwords: 5 in 15 minutes from one address pause sign-in for that
 * email from that address for 15 minutes; 50 in an hour from anywhere pause
 * it everywhere (a distributed guess). While paused the password is not
 * checked at all, so a pause reveals nothing about whether a guess was right,
 * and a stranger on another address cannot lock the owner out.
 */

export const SESSION_COOKIE = 'buh_admin';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const PER_ADDRESS_FAILS = 5;
const PER_ADDRESS_WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_FAILS = 50;
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const PAUSE_MS = 15 * 60 * 1000;

interface AdminAccount {
  email: string;
  passwordHash: string;
  mustChangePassword: boolean;
  managedByEnv: boolean;
}

let cached: AdminAccount | null = null;
let cachedMtime = 0;

const ACCOUNT_FILE = () => dataFile('admin.json');
const SESSION_STATE_FILE = () => dataFile('session-state.json');

function serialize(account: AdminAccount): string {
  const { email, passwordHash, mustChangePassword } = account;
  return JSON.stringify({ email, passwordHash, mustChangePassword }, null, 2);
}

function persist(account: AdminAccount) {
  cached = account;
  if (account.managedByEnv) return;
  writePrivateFile(ACCOUNT_FILE(), serialize(account));
  cachedMtime = fs.statSync(ACCOUNT_FILE()).mtimeMs;
}

async function loadAccount(): Promise<AdminAccount> {
  if (cached && !cached.managedByEnv) {
    // Re-read when the file changed (a password reset or email change made by the other running copy).
    let mtime = 0;
    try {
      mtime = fs.statSync(ACCOUNT_FILE()).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime === cachedMtime) return cached;
    cached = null;
  }
  if (cached) return cached;

  const envEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const envHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (envEmail && envHash) {
    cached = { email: envEmail, passwordHash: envHash, mustChangePassword: false, managedByEnv: true };
    return cached;
  }

  const file = ACCOUNT_FILE();
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached = {
      email: String(stored.email),
      passwordHash: String(stored.passwordHash),
      mustChangePassword: stored.mustChangePassword === true,
      managedByEnv: false,
    };
    cachedMtime = fs.statSync(file).mtimeMs;
    return cached;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // First start: create the owner account with a one-time password.
  const email = (envEmail || 'admin@beautifuluaehome.com').toLowerCase();
  const password = generatePassword();
  const account: AdminAccount = {
    email,
    passwordHash: await hashPassword(password),
    mustChangePassword: true,
    managedByEnv: false,
  };
  try {
    // wx: if another worker created it first, use theirs instead.
    fs.writeFileSync(file, serialize(account), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return loadAccount();
    throw err;
  }
  cached = account;
  console.log(
    [
      '',
      '==================================================================',
      '  Beautiful UAE Home — first admin account created',
      `  Email:    ${email}`,
      `  Password: ${password}`,
      '  This is shown once. You will be asked to choose a new password',
      '  at first sign-in. Set ADMIN_EMAIL / ADMIN_PASSWORD_HASH to manage',
      '  the account from the environment instead.',
      '==================================================================',
      '',
    ].join('\n')
  );
  return account;
}

/** Create the owner account on first start, so its one-time password is in the log straight away. */
export async function ensureAdminAccount(): Promise<void> {
  await loadAccount();
}

/** The session generation: bumped to end every existing session. */
function sessionGeneration(): number {
  try {
    const n = Number(JSON.parse(fs.readFileSync(SESSION_STATE_FILE(), 'utf8')).generation);
    return Number.isSafeInteger(n) && n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

function bumpSessionGeneration(): number {
  const next = sessionGeneration() + 1;
  writePrivateFile(SESSION_STATE_FILE(), JSON.stringify({ generation: next }));
  return next;
}

function hashFingerprint(passwordHash: string): string {
  return crypto.createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);
}

function sign(body: string): string {
  return crypto.createHmac('sha256', serverSecret()).update(`session\n${body}`).digest('base64url');
}

interface SessionPayload {
  e: string;
  g: number;
  h: string;
  iat: number;
  exp: number;
}

export function createSessionToken(account: { email: string; passwordHash: string }, now = Date.now()): string {
  const payload: SessionPayload = {
    e: account.email,
    g: sessionGeneration(),
    h: hashFingerprint(account.passwordHash),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export interface AdminSession {
  email: string;
  mustChangePassword: boolean;
  expiresAt: number;
}

export async function verifySessionToken(token: string | undefined, now = Date.now()): Promise<AdminSession | null> {
  if (!token || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  // Check the MAC before parsing anything the client sent.
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;

  const account = await loadAccount();
  if (payload.e !== account.email) return null;
  if (payload.g !== sessionGeneration()) return null; // signed out or password changed since
  if (payload.h !== hashFingerprint(account.passwordHash)) return null; // password hash rotated
  return { email: account.email, mustChangePassword: account.mustChangePassword, expiresAt: payload.exp };
}

/** Sign out everywhere: every session issued so far stops working. */
export function endAllSessions() {
  bumpSessionGeneration();
}

export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function clearedSessionCookie() {
  return { ...sessionCookie(''), maxAge: 0 };
}

// ── Failed sign-in tracking (in memory; single instance) ─────────────────────

interface FailState {
  fails: number[];
  pausedUntil: number;
}
const failStates = new Map<string, FailState>();
const MAX_FAIL_KEYS = 10_000;

function failState(key: string): FailState {
  let state = failStates.get(key);
  if (!state) {
    state = { fails: [], pausedUntil: 0 };
    failStates.set(key, state);
    if (failStates.size > MAX_FAIL_KEYS) {
      // Drop the oldest entry that is not currently paused.
      for (const [k, s] of failStates) {
        if (s.pausedUntil < Date.now()) {
          failStates.delete(k);
          break;
        }
      }
    }
  }
  return state;
}

function recordFailure(key: string, max: number, windowMs: number, now: number): boolean {
  const state = failState(key);
  state.fails = state.fails.filter((t) => t > now - windowMs);
  state.fails.push(now);
  if (state.fails.length >= max) {
    state.pausedUntil = now + PAUSE_MS;
    state.fails = [];
    return true;
  }
  return false;
}

function pausedFor(keys: string[], now: number): number {
  return Math.max(0, ...keys.map((k) => (failStates.get(k)?.pausedUntil ?? 0) - now));
}

/**
 * Check a sign-in. Unknown email or wrong password get the same answer. While
 * sign-in is paused for this email (from this address, or everywhere) the
 * password is not checked: everyone gets the same 429.
 */
export async function signIn(emailInput: string, password: string, options: { ip?: string | null; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const account = await loadAccount();
  const email = emailInput.trim().toLowerCase();
  const addressKey = `addr|${email}|${options.ip ?? 'unknown'}`;
  const accountKey = `acct|${email}`;

  const paused = pausedFor([addressKey, accountKey], now);
  if (paused > 0) {
    const minutes = Math.ceil(paused / 60000);
    throw new HttpError(429, `Sign-in is paused for ${minutes} minute${minutes === 1 ? '' : 's'} after repeated wrong passwords.`, {
      'Retry-After': String(Math.ceil(paused / 1000)),
    });
  }

  const ok = email === account.email
    ? await verifyPassword(password, account.passwordHash)
    : (await verifyPassword(password, await dummyPasswordHash()), false);

  if (!ok) {
    const addressPaused = recordFailure(addressKey, PER_ADDRESS_FAILS, PER_ADDRESS_WINDOW_MS, now);
    const accountPaused = recordFailure(accountKey, ACCOUNT_FAILS, ACCOUNT_WINDOW_MS, now);
    if (addressPaused || accountPaused) {
      logEvent('warn', 'admin_signin_paused', { email, ip: options.ip, everywhere: accountPaused });
    }
    throw new HttpError(401, 'Wrong email or password.');
  }

  failStates.delete(addressKey);
  return { token: createSessionToken(account, now), mustChangePassword: account.mustChangePassword, email: account.email };
}

export async function changePassword(currentPassword: string, newPassword: string, options: { ip?: string | null } = {}) {
  const account = await loadAccount();
  if (account.managedByEnv) {
    throw new HttpError(409, 'This admin account is managed by ADMIN_PASSWORD_HASH. Change it there.');
  }
  // Re-verify through signIn so the same pauses apply here as well.
  await signIn(account.email, currentPassword, options);
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password different from the current one.');

  account.passwordHash = await hashPassword(newPassword);
  account.mustChangePassword = false;
  persist(account);
  endAllSessions();
  return createSessionToken(account);
}

/** The sign-in email, and whether it is set in the environment (then it can't be changed here). */
export async function adminAccountInfo(): Promise<{ email: string; managedByEnv: boolean }> {
  const a = await loadAccount();
  return { email: a.email, managedByEnv: a.managedByEnv };
}

/** Change the sign-in email (current password required). Every session ends; the owner signs in again. */
export async function changeAdminEmail(currentPassword: string, newEmail: string, options: { ip?: string | null } = {}) {
  const account = await loadAccount();
  if (account.managedByEnv) throw new HttpError(409, 'This admin account is set by ADMIN_EMAIL in .env.production. Change it there.');
  const email = newEmail.trim().toLowerCase();
  if (!/^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Please check the email address.');
  await signIn(account.email, currentPassword, options);
  account.email = email;
  persist(account);
  endAllSessions();
  return createSessionToken(account);
}

// ── Forgotten password: a one-time link by email ────────────────────────────

const RESET_TTL_MS = 30 * 60 * 1000;
const RESET_KEY = 'admin:password-reset';

/**
 * A reset link for the admin email (anything else gets nothing, and the caller
 * answers the same either way, so the admin email can't be discovered). The
 * token is random, kept only as a hash, single use, valid 30 minutes; a new
 * request replaces the old one.
 */
export async function startPasswordReset(emailInput: string): Promise<string | null> {
  const account = await loadAccount();
  if (account.managedByEnv || emailInput.trim().toLowerCase() !== account.email) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const { kvSet } = await import('./kv');
  kvSet(RESET_KEY, { hash: crypto.createHash('sha256').update(token).digest('base64url'), expires: Date.now() + RESET_TTL_MS, email: account.email });
  return token;
}

/** Set a new password with a reset token. Every session ends. */
export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  const { kvGet, kvSet } = await import('./kv');
  const account = await loadAccount();
  // From here to kvSet(null) nothing awaits, so two requests can't both use one link.
  const stored = kvGet<{ hash: string; expires: number; email: string } | null>(RESET_KEY)?.data;
  const given = Buffer.from(crypto.createHash('sha256').update(String(token)).digest('base64url'));
  const valid =
    stored &&
    Date.now() < stored.expires &&
    given.length === Buffer.from(stored.hash).length &&
    crypto.timingSafeEqual(given, Buffer.from(stored.hash));
  if (!valid) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
  if (account.managedByEnv || stored.email !== account.email) throw new HttpError(400, 'This reset link is no longer valid. Ask for a new one.');
  kvSet(RESET_KEY, null); // single use
  account.passwordHash = await hashPassword(newPassword);
  account.mustChangePassword = false;
  persist(account);
  failStates.clear();
  endAllSessions();
}

/** Test hook: forget cached account/secret/failures so a new DATA_DIR is picked up. */
export function _resetAdminAuthState() {
  cached = null;
  cachedMtime = 0;
  _resetServerSecret();
  failStates.clear();
}
