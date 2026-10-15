import crypto from 'node:crypto';
import { getDb, inTransaction } from './db';

/**
 * Recovery codes: the owner's way back into the Admin Hub when the password is
 * forgotten and no passkey is at hand.
 *
 *  - 10 codes per set, each 16 characters from a 32-letter alphabet without
 *    0/O/1/I (80 random bits), shown as XXXX-XXXX-XXXX-XXXX;
 *  - only a SHA-256 hash of each code is stored (80 random bits can't be
 *    guessed back from it, so a slow hash adds nothing but CPU per sign-in);
 *  - a code is used up by one UPDATE … WHERE used_at IS NULL: SQLite applies
 *    it once, so a code works once even with two copies of the shop running;
 *  - creating a new set deletes the old one in the same transaction.
 */

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 letters: no 0, O, 1 or I
const CODE_LENGTH = 16;

export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join('-');
}

/** The code as stored: upper case, spaces and dashes removed; null when it can't be a code. */
export function normalizeRecoveryCode(input: string): string | null {
  const raw = String(input).toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!ALPHABET.includes(ch)) return null;
  return raw;
}

function hashCode(normalized: string): string {
  return crypto.createHash('sha256').update(`buh-recovery-code\n${normalized}`).digest('base64url');
}

/** A new set of codes (shown once); the old set stops working at the same moment. */
export function createRecoveryCodes(now = Date.now()): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const setId = crypto.randomUUID();
  const at = new Date(now).toISOString();
  inTransaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM admin_recovery_codes').run();
    const insert = db.prepare('INSERT INTO admin_recovery_codes (code_hash, set_id, created_at) VALUES (?, ?, ?)');
    for (const code of codes) insert.run(hashCode(normalizeRecoveryCode(code)!), setId, at);
  });
  return codes;
}

/** Use a code up. True only for the one call that turned an unused code into a used one. */
export function consumeRecoveryCode(input: string, now = Date.now()): boolean {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return false;
  const result = getDb()
    .prepare('UPDATE admin_recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
    .run(new Date(now).toISOString(), hashCode(normalized));
  return result.changes === 1;
}

export interface RecoveryCodeStatus {
  /** Codes in the current set (0: none created yet). */
  total: number;
  remaining: number;
  createdAt: string | null;
}

export function recoveryCodeStatus(): RecoveryCodeStatus {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS remaining, MIN(created_at) AS created FROM admin_recovery_codes')
    .get() as { total: number; remaining: number | null; created: string | null };
  return { total: row.total, remaining: row.remaining ?? 0, createdAt: row.created };
}
