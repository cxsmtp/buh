import crypto from 'node:crypto';
import fs from 'node:fs';
import { dataFile, writePrivateFile } from './dataDir';
import { HttpError } from './http';
import { logEvent } from './log';
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
 * Secure in production, 8 h). Each carries the account's session version,
 * which a password change bumps, so every other session ends at once.
 */

export const SESSION_COOKIE = 'buh_admin';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

interface AdminAccount {
  email: string;
  passwordHash: string;
  sessionVersion: number;
  mustChangePassword: boolean;
  failedLogins: number;
  lockedUntil: number;
  managedByEnv: boolean;
}

let cached: AdminAccount | null = null;
let secret: Buffer | null = null;

const ACCOUNT_FILE = () => dataFile('admin.json');

function serialize(account: AdminAccount): string {
  const { email, passwordHash, sessionVersion, mustChangePassword, failedLogins, lockedUntil } = account;
  return JSON.stringify({ email, passwordHash, sessionVersion, mustChangePassword, failedLogins, lockedUntil }, null, 2);
}

function persist(account: AdminAccount) {
  cached = account;
  if (account.managedByEnv) return;
  writePrivateFile(ACCOUNT_FILE(), serialize(account));
}

async function loadAccount(): Promise<AdminAccount> {
  if (cached) return cached;

  const envEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const envHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (envEmail && envHash) {
    cached = {
      email: envEmail,
      passwordHash: envHash,
      sessionVersion: 1,
      mustChangePassword: false,
      failedLogins: 0,
      lockedUntil: 0,
      managedByEnv: true,
    };
    return cached;
  }

  const file = ACCOUNT_FILE();
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached = { failedLogins: 0, lockedUntil: 0, ...stored, managedByEnv: false };
    return cached!;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // First start: create the owner account with a one-time password.
  const email = (envEmail || 'admin@beautifuluaehome.com').toLowerCase();
  const password = generatePassword();
  const account: AdminAccount = {
    email,
    passwordHash: await hashPassword(password),
    sessionVersion: 1,
    mustChangePassword: true,
    failedLogins: 0,
    lockedUntil: 0,
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

function sessionSecret(): Buffer {
  if (secret) return secret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
    secret = Buffer.from(fromEnv, 'utf8');
    return secret;
  }
  const file = dataFile('session.key');
  try {
    secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
  } catch {
    const fresh = crypto.randomBytes(32);
    try {
      fs.writeFileSync(file, fresh.toString('base64url'), { mode: 0o600, flag: 'wx' });
      secret = fresh;
    } catch {
      secret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
    }
  }
  return secret;
}

function sign(body: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(`session\n${body}`).digest('base64url');
}

interface SessionPayload {
  e: string;
  v: number;
  iat: number;
  exp: number;
}

export function createSessionToken(account: { email: string; sessionVersion: number }, now = Date.now()): string {
  const payload: SessionPayload = { e: account.email, v: account.sessionVersion, iat: now, exp: now + SESSION_TTL_MS };
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
  if (payload.e !== account.email || payload.v !== account.sessionVersion) return null;
  return { email: account.email, mustChangePassword: account.mustChangePassword, expiresAt: payload.exp };
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

/**
 * Check a sign-in. The same "wrong email or password" answer is given whether
 * or not the account exists, and while locked; only someone who supplies the
 * correct password learns that the account is locked (423).
 */
export async function signIn(emailInput: string, password: string, now = Date.now()) {
  const account = await loadAccount();
  const email = emailInput.trim().toLowerCase();
  const wrong = new HttpError(401, 'Wrong email or password.');

  if (email !== account.email) {
    await verifyPassword(password, await dummyPasswordHash());
    throw wrong;
  }

  const ok = await verifyPassword(password, account.passwordHash);
  if (account.lockedUntil > now) {
    if (!ok) throw wrong;
    const minutes = Math.ceil((account.lockedUntil - now) / 60000);
    throw new HttpError(423, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
  if (!ok) {
    account.failedLogins += 1;
    if (account.failedLogins >= MAX_FAILED) {
      account.lockedUntil = now + LOCK_MS;
      account.failedLogins = 0;
      logEvent('warn', 'admin_locked', { email });
    }
    persist(account);
    throw wrong;
  }
  if (account.failedLogins || account.lockedUntil) {
    account.failedLogins = 0;
    account.lockedUntil = 0;
    persist(account);
  }
  return { token: createSessionToken(account, now), mustChangePassword: account.mustChangePassword, email: account.email };
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const account = await loadAccount();
  if (account.managedByEnv) {
    throw new HttpError(409, 'This admin account is managed by ADMIN_PASSWORD_HASH. Change it there.');
  }
  // Re-verify through signIn so lockout applies here as well.
  await signIn(account.email, currentPassword);
  if (currentPassword === newPassword) throw new HttpError(400, 'Choose a password different from the current one.');

  account.passwordHash = await hashPassword(newPassword);
  account.sessionVersion += 1; // ends every other session
  account.mustChangePassword = false;
  persist(account);
  return createSessionToken(account);
}

/** Test hook: forget cached account/secret so a new DATA_DIR is picked up. */
export function _resetAdminAuthState() {
  cached = null;
  secret = null;
}
