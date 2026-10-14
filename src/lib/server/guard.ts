import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionToken, type AdminSession } from './adminAuth';
import { assertSameOrigin, clientIp, HttpError } from './http';
import { rateLimit } from './rateLimit';

/**
 * Gate for admin-only route handlers: a valid session cookie, a same-site
 * request, and — until the first-run password is changed — nothing else.
 */
export async function requireAdmin(req: Request, { allowPendingPasswordChange = false } = {}): Promise<AdminSession> {
  if (req.method !== 'GET' && req.method !== 'HEAD') assertSameOrigin(req);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!session) throw new HttpError(401, 'Please sign in to the admin hub.');
  if (session.mustChangePassword && !allowPendingPasswordChange) {
    throw new HttpError(403, 'Choose a new admin password before continuing.');
  }
  return session;
}

/** Throw 429 with Retry-After when a limit is exceeded. */
export function enforceLimit(key: string, max: number, windowMs: number, message: string) {
  const result = rateLimit(key, max, windowMs);
  if (!result.ok) {
    throw new HttpError(429, message, { 'Retry-After': String(result.retryAfterSec) });
  }
}

/**
 * A per-address limit. Skipped when the address is unknown (no trusted proxy),
 * so it never turns into one limit shared by every visitor; the per-account,
 * per-phone and global limits still apply.
 */
export function enforceIpLimit(req: Request, scope: string, max: number, windowMs: number, message: string) {
  const ip = clientIp(req);
  if (ip) enforceLimit(`${scope}:${ip}`, max, windowMs, message);
}

export { clientIp };
