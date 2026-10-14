import crypto from 'node:crypto';

/**
 * scrypt password hashing. Stored as `scrypt$N$r$p$salt$hash` (base64url) so
 * the cost can be raised later without breaking existing hashes.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
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
