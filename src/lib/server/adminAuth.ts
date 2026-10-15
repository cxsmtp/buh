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
 * and a stranger on another address cannot lock the owner out. Wrong recovery
 * codes count towards the same pauses.
 *
 * Ways back in when the password is forgotten: a one-time recovery code
 * (recoveryCodes.ts; the session it gives can only choose a new password) or a
 * passkey (passkeys.ts; the same session as a password sign-in).
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

/**
 * How a session was started: a password, a passkey, or a recovery code. A
 * recovery-code session can do one thing only, choose a new password (unless
 * the password is set in the environment), and lasts 30 minutes.
 */
export type SignInMethod = 'password' | 'passkey' | 'recovery';
const METHOD_CODES: Record<SignInMethod, string> = { password: 'pw', passkey: 'pk', recovery: 'rc' };
export const RECOVERY_SESSION_TTL_MS = 30 * 60 * 1000;

interface SessionPayload {
  e: string;
  g: number;
  h: string;
  iat: number;
  exp: number;
  /** Sign-in method (absent in sessions from older builds: a password). */
  m?: string;
}

export function createSessionToken(account: { email: string; passwordHash: string }, now = Date.now(), method: SignInMethod = 'password'): string {
  const payload: SessionPayload = {
    e: account.email,
    g: sessionGeneration(),
    h: hashFingerprint(account.passwordHash),
    iat: now,
    exp: now + (method === 'recovery' ? RECOVERY_SESSION_TTL_MS : SESSION_TTL_MS),
    m: METHOD_CODES[method],
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export interface AdminSession {
  email: string;
  mustChangePassword: boolean;
  expiresAt: number;
  issuedAt: number;
  method: SignInMethod;
  /** Signed in with a recovery code and the password can be changed here: a new one must be chosen. */
  recoveryPending: boolean;
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
  const method = (Object.keys(METHOD_CODES) as SignInMethod[]).find((k) => METHOD_CODES[k] === payload.m) ?? 'password';
  const recoveryPending = method === 'recovery' && !account.managedByEnv;
  return {
    email: account.email,
    mustChangePassword: account.mustChangePassword || recoveryPending,
    expiresAt: payload.exp,
    issuedAt: Number(payload.iat) || 0,
    method,
    recoveryPending,
  };
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

function pauseKeys(emailInput: string, ip: string | null | undefined) {
  const email = emailInput.trim().toLowerCase();
  return { email, addressKey: `addr|${email}|${ip ?? 'unknown'}`, accountKey: `acct|${email}` };
}

/**
 * Refuse while sign-in is paused for this email (from this address, or
 * everywhere). Shared by every way in that can be guessed (a password, a
 * recovery code): their wrong guesses count together, and while paused
 * nothing is checked, so a pause reveals nothing about a guess.
 */
export function assertSignInNotPaused(emailInput: string, ip: string | null | undefined, now = Date.now()) {
  const { addressKey, accountKey } = pauseKeys(emailInput, ip);
  const paused = pausedFor([addressKey, accountKey], now);
  if (paused > 0) {
    const minutes = Math.ceil(paused / 60000);
    throw new HttpError(429, `Sign-in is paused for ${minutes} minute${minutes === 1 ? '' : 's'} after repeated wrong passwords or codes.`, {
      'Retry-After': String(Math.ceil(paused / 1000)),
    });
  }
}

/** Count a wrong password or recovery code towards the pause. */
export function recordSignInFailure(emailInput: string, ip: string | null | undefined, now = Date.now()) {
  const { email, addressKey, accountKey } = pauseKeys(emailInput, ip);
  const addressPaused = recordFailure(addressKey, PER_ADDRESS_FAILS, PER_ADDRESS_WINDOW_MS, now);
  const accountPaused = recordFailure(accountKey, ACCOUNT_FAILS, ACCOUNT_WINDOW_MS, now);
  if (addressPaused || accountPaused) {
    logEvent('warn', 'admin_signin_paused', { email, ip, everywhere: accountPaused });
  }
}

function clearAddressFailures(emailInput: string, ip: string | null | undefined) {
  failStates.delete(pauseKeys(emailInput, ip).addressKey);
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
  assertSignInNotPaused(email, options.ip, now);

  const ok = email === account.email
    ? await verifyPassword(password, account.passwordHash)
    : (await verifyPassword(password, await dummyPasswordHash()), false);

  if (!ok) {
    recordSignInFailure(email, options.ip, now);
    throw new HttpError(401, 'Wrong email or password.');
  }

  clearAddressFailures(email, options.ip);
  return { token: createSessionToken(account, now), mustChangePassword: account.mustChangePassword, email: account.email };
}

// ── Recovery codes and passkeys ──────────────────────────────────────────────

/**
 * Sign in with a one-time recovery code. The same pauses as a wrong password
 * (while paused the code is not even looked at). The code is used up
 * atomically in the database, so it works once even when two copies of the
 * shop share it. Every other session ends. The session that comes back can
 * only choose a new password, when the password can be changed here.
 */
export async function signInWithRecoveryCode(emailInput: string, code: string, options: { ip?: string | null; now?: number } = {}) {
  const now = options.now ?? Date.now();
  const account = await loadAccount();
  const email = emailInput.trim().toLowerCase();
  assertSignInNotPaused(email, options.ip, now);
  const { consumeRecoveryCode, recoveryCodeStatus } = await import('./recoveryCodes');
  // A wrong email never reaches the codes, so it can't use one up.
  if (email !== account.email || !consumeRecoveryCode(code, now)) {
    recordSignInFailure(email, options.ip, now);
    throw new HttpError(401, 'Wrong email or recovery code.');
  }
  clearAddressFailures(email, options.ip);
  endAllSessions();
  return {
    token: createSessionToken(account, now, 'recovery'),
    email: account.email,
    managedByEnv: account.managedByEnv,
    mustChangePassword: !account.managedByEnv,
    remaining: recoveryCodeStatus().remaining,
  };
}

/** The session for a verified passkey: the same as a password sign-in's. */
export async function passkeySession(now = Date.now()) {
  const account = await loadAccount();
  return { token: createSessionToken(account, now, 'passkey'), email: account.email, mustChangePassword: account.mustChangePassword };
}

/** For this long after a passkey sign-in the owner has just proved it's them (no password needed for new recovery codes). */
export const FRESH_PASSKEY_MS = 10 * 60 * 1000;

export function isFreshPasskeySession(session: AdminSession, now = Date.now()): boolean {
  return session.method === 'passkey' && now >= session.issuedAt && now - session.issuedAt <= FRESH_PASSKEY_MS;
}

/**
 * The owner proves it's them again before changing how they can sign in: the
 * current password (with the same pauses as signing in) or, where allowed, a
 * passkey sign-in in the last 10 minutes. A wrong password is a 400, not a
 * 401: the owner is still signed in.
 */
export async function confirmOwner(session: AdminSession, currentPassword: string, options: { ip?: string | null; allowFreshPasskey?: boolean } = {}) {
  if (!currentPassword) {
    if (options.allowFreshPasskey && isFreshPasskeySession(session)) return;
    throw new HttpError(400, 'Type your current password.');
  }
  const account = await loadAccount();
  try {
    await signIn(account.email, currentPassword, { ip: options.ip });
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) throw new HttpError(400, 'That is not your current password.');
    throw err;
  }
}

/** After a recovery-code sign-in: choose a new password (the forgotten one is not asked for). Every other session ends. */
export async function setPasswordAfterRecovery(session: AdminSession, newPassword: string) {
  const account = await loadAccount();
  if (account.managedByEnv) {
    throw new HttpError(409, 'This admin account is managed by ADMIN_PASSWORD_HASH. Change it there.');
  }
  if (!session.recoveryPending) throw new HttpError(400, 'Type your current password.');
  account.passwordHash = await hashPassword(newPassword);
  account.mustChangePassword = false;
  persist(account);
  failStates.clear();
  endAllSessions();
  return createSessionToken(account);
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

const RESET_PER_HOUR = 3;
interface ResetLink {
  hash: string;
  expires: number;
  email: string;
}

/**
 * A reset link for the admin email (anything else gets nothing, and the caller
 * answers the same either way, so the admin email can't be discovered). The
 * token is random, kept only as a hash, single use, valid 30 minutes. Earlier
 * links stay valid (a stranger asking again can't cancel the owner's link), and
 * at most 3 are sent an hour (null after that: the owner already has them).
 */
export async function startPasswordReset(emailInput: string): Promise<string | null> {
  const account = await loadAccount();
  if (account.managedByEnv || emailInput.trim().toLowerCase() !== account.email) return null;
  const { kvGet, kvSet } = await import('./kv');
  const now = Date.now();
  const live = resetLinks(kvGet<unknown>(RESET_KEY)?.data).filter((l) => l.expires > now && l.email === account.email);
  if (live.filter((l) => l.expires > now + RESET_TTL_MS - 60 * 60 * 1000).length >= RESET_PER_HOUR) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  kvSet(RESET_KEY, [...live, { hash: crypto.createHash('sha256').update(token).digest('base64url'), expires: now + RESET_TTL_MS, email: account.email }]);
  return token;
}

/** Stored links (an older build kept one object, not a list). */
function resetLinks(raw: unknown): ResetLink[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((l): l is ResetLink => Boolean(l) && typeof l.hash === 'string' && typeof l.expires === 'number' && typeof l.email === 'string');
}

/** Set a new password with a reset token. Every session ends. */
export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  const { kvGet, kvSet } = await import('./kv');
  const account = await loadAccount();
  // From here to kvSet(null) nothing awaits, so two requests can't both use one link.
  const links = resetLinks(kvGet<unknown>(RESET_KEY)?.data);
  const given = Buffer.from(crypto.createHash('sha256').update(String(token)).digest('base64url'));
  const stored = links.find((l) => Date.now() < l.expires && given.length === Buffer.from(l.hash).length && crypto.timingSafeEqual(given, Buffer.from(l.hash)));
  if (!stored) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
  if (account.managedByEnv || stored.email !== account.email) throw new HttpError(400, 'This reset link is no longer valid. Ask for a new one.');
  kvSet(RESET_KEY, null); // single use: the new password makes every other link void too
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
