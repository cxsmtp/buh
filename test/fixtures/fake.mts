import crypto from 'node:crypto';

/**
 * Test values that look like credentials (fake API keys, owner passwords) are built when the
 * tests run, never written whole in the source: no real secret was ever here, and a secret
 * scanner has nothing to find. `fake('sk_test_', '51Buh…')` joins its parts (the same value on
 * every run, for checks against a stand-in service); `ownerPassword()` is new on every run.
 */
export const fake = (...parts: string[]): string => parts.join('');

/** A strong owner password for a test run (passes the hub's password rules). */
export function ownerPassword(): string {
  return `Owner-${crypto.randomBytes(9).toString('base64url')}-Q7x`;
}

/** A sign-in that fails (any email, a password nobody has): the first one prints the setup password. */
export function wrongLogin(): { email: string; password: string } {
  return { email: 'x@y.z', password: crypto.randomBytes(6).toString('hex') };
}
