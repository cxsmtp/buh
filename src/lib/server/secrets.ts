import crypto from 'node:crypto';
import fs from 'node:fs';
import { dataFile } from './dataDir';

let secret: Buffer | null = null;

/**
 * The server's signing key: SESSION_SECRET (32+ characters) or 32 random bytes
 * kept in DATA_DIR/session.key (0600). Every use signs a message with its own
 * prefix ("session\n", "phone\n"…) so one kind of token can never pass as
 * another.
 */
export function serverSecret(): Buffer {
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

/** HMAC a message under a purpose prefix. */
export function mac(purpose: string, message: string): string {
  return crypto.createHmac('sha256', serverSecret()).update(`${purpose}\n${message}`).digest('base64url');
}

export function macMatches(purpose: string, message: string, given: string): boolean {
  const expected = Buffer.from(mac(purpose, message));
  const actual = Buffer.from(given);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Test hook. */
export function _resetServerSecret() {
  secret = null;
}
