import crypto from 'node:crypto';

/**
 * scrypt password hashing. Stored as `scrypt$N$r$p$salt$hash` (base64url) so
 * the cost can be raised later without breaking existing hashes.
 */
/**
 * The cost of new hashes: N=2^15, r=8, p=3 (one of OWASP's equivalent scrypt settings), six times
 * the work of the first setting (N=2^14, r=8, p=1). Chosen so that every release that ever shipped
 * can still check it: their verify allows 64 MiB (`maxmem`) and reads N, r and p from the stored
 * hash, and during an update, or after a rollback, the older version checks hashes this one made.
 * scrypt needs about 128·r·(N+2) + 128·r·p bytes: N=2^16 with r=8 is 64 MiB plus 2 KiB, just over,
 * so N stops at 2^15 (32 MiB) and the rest of the cost comes from p, which adds work but not memory.
 */
const N = 32768;
const R = 8;
const P = 3;
const KEYLEN = 32;
/** Never lower this: a released version's verify is limited to it (see above). */
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function costOf(stored: string): { n: number; r: number; p: number } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  return Number.isInteger(n) && Number.isInteger(r) && Number.isInteger(p) && n > 1 && r > 0 && p > 0 ? { n, r, p } : null;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const saltBytes = Buffer.from(salt, 'base64url');
  const actual = await scrypt(password, saltBytes, Number(n), Number(r), Number(p));
  // A hash from before the cost was raised takes as long to check as a new one (the missing work
  // is done and thrown away), so the time a wrong password takes does not tell an account that
  // has not signed in since from one that does not exist (checked against dummyPasswordHash).
  const cost = costOf(stored);
  if (cost && cost.n * cost.r * cost.p < N * R * P) {
    const extra = Math.round((N * R * P - cost.n * cost.r * cost.p) / (cost.n * cost.r));
    if (extra > 0) await scrypt(password, saltBytes, cost.n, cost.r, extra).catch(() => null);
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Whether a stored hash was made with less than today's cost (it is replaced at the next successful sign-in). */
export function passwordNeedsRehash(stored: string): boolean {
  const cost = costOf(stored);
  return !!cost && (cost.n < N || cost.r < R || cost.n * cost.r * cost.p < N * R * P);
}

/** A hash of a random password, verified against when the account is unknown so timing does not reveal it. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

export function generatePassword(): string {
  // 18 random bytes → 24 url-safe characters, ~144 bits of entropy.
  return crypto.randomBytes(18).toString('base64url');
}

export function passwordProblem(password: string): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  // Upper bound keeps scrypt input (and so CPU per attempt) bounded.
  if (password.length > 256) return 'Use at most 256 characters.';
  if (new Set(password).size < 5) return 'Use at least 5 different characters.';
  return null;
}
