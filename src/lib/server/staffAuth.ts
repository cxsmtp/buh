import crypto from 'node:crypto';
import fs from 'node:fs';
import { passwordFingerprint, SESSION_TTL_MS, signSessionPayload, type AdminSession, type SessionPayload } from './adminAuth';
import { hashSegment } from './adminLink';
import { audit, auditedTransaction } from './audit';
import { dataFile } from './dataDir';
import { getDb } from './db';
import { HttpError } from './http';
import { logEvent } from './log';
import { emailConfigured, sender, transport } from './mail';
import { hashPassword } from './password';

/**
 * The accountant's read-only sign-in.
 *
 *  - The owner invites an accountant by email (Settings → Security). The account gets the role
 *    'accountant' and a one-time setup link, emailed, valid 72 hours: its path is a grant of its own
 *    that opens the Admin Hub (the same door as the private admin link, src/lib/server/adminLink.ts,
 *    for as long as the setup is open); the token is in the fragment. Only hashes are kept.
 *  - After choosing a password the accountant signs in at the shop's private Admin Hub link (the
 *    owner gives it to them), with the same sign-in form, the same pauses after wrong passwords and
 *    the same session cookie (8 h) as the owner. No passkeys, recovery codes or password reset.
 *  - What an accountant session may do is decided on the server by requireAdmin (guard.ts): every
 *    admin route is owner-only unless it is on the read-only allow-list (ACCOUNTANT_ROUTES).
 *  - Every request checks the account in the database: revoking it (or sending a new setup link)
 *    ends its sessions at once, in every running copy of the shop. A data folder restored from a
 *    backup starts a new staff-session epoch (not in backups), so no earlier cookie works there.
 *  - Sign-ins, setup, invites, revokes and exports are in the audit log.
 */

export const STAFF_SETUP_TTL_MS = 72 * 60 * 60 * 1000;
export const MAX_STAFF = 10;
const EMAIL = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;

export type StaffStatus = 'invited' | 'active' | 'revoked';

interface Row {
  id: string;
  email: string;
  role: 'accountant';
  name: string;
  password_hash: string | null;
  status: StaffStatus;
  setup_hash: string | null;
  setup_grant_hash: string | null;
  setup_expires_at: number | null;
  session_gen: number;
  invited_at: string;
  invited_by: string;
  activated_at: string | null;
  last_sign_in_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface StaffAccount {
  id: string;
  email: string;
  role: 'accountant';
  name: string;
  status: StaffStatus;
  /** An invite whose setup link has passed its 72 hours. */
  setupExpired: boolean;
  setupExpiresAt: string | null;
  invitedAt: string;
  invitedBy: string;
  activatedAt: string | null;
  lastSignInAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

/** For signIn (adminAuth.ts): an active accountant's email, id and password hash. */
export interface ActiveStaff {
  id: string;
  email: string;
  passwordHash: string;
  sessionGen: number;
}

function view(r: Row, now = Date.now()): StaffAccount {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    name: r.name,
    status: r.status,
    setupExpired: r.status === 'invited' && !(Number(r.setup_expires_at) > now),
    setupExpiresAt: r.setup_expires_at ? new Date(r.setup_expires_at).toISOString() : null,
    invitedAt: r.invited_at,
    invitedBy: r.invited_by,
    activatedAt: r.activated_at,
    lastSignInAt: r.last_sign_in_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
  };
}

const sha = (s: string) => crypto.createHash('sha256').update(`buh-staff-setup\n${s}`).digest('base64url');

export function listStaff(now = Date.now()): StaffAccount[] {
  return (getDb().prepare('SELECT * FROM staff_accounts ORDER BY invited_at DESC').all() as Row[]).map((r) => view(r, now));
}

export function activeStaffByEmail(email: string): ActiveStaff | undefined {
  const r = getDb().prepare("SELECT * FROM staff_accounts WHERE email = ? AND status = 'active' AND password_hash IS NOT NULL").get(email.trim().toLowerCase()) as Row | undefined;
  return r ? { id: r.id, email: r.email, passwordHash: r.password_hash!, sessionGen: r.session_gen } : undefined;
}

// ── Sessions ────────────────────────────────────────────────────────────────

const EPOCH_FILE = () => dataFile('staff-session-state.json');

/** This data folder's staff-session epoch (random on a new or restored folder; never in backups). */
export function staffEpoch(): number {
  try {
    const n = Number(JSON.parse(fs.readFileSync(EPOCH_FILE(), 'utf8')).epoch);
    if (Number.isSafeInteger(n) && n > 0) return n;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return 0;
  }
  const fresh = crypto.randomInt(1_000_000, 2 ** 47);
  try {
    fs.writeFileSync(EPOCH_FILE(), JSON.stringify({ epoch: fresh }), { mode: 0o600, flag: 'wx' });
    return fresh;
  } catch {
    try {
      const n = Number(JSON.parse(fs.readFileSync(EPOCH_FILE(), 'utf8')).epoch);
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }
}

export function staffSessionToken(staff: ActiveStaff, now = Date.now()): string {
  getDb().prepare('UPDATE staff_accounts SET last_sign_in_at = ? WHERE id = ?').run(new Date(now).toISOString(), staff.id);
  return signSessionPayload({ e: staff.email, g: staff.sessionGen, h: passwordFingerprint(staff.passwordHash), iat: now, exp: now + SESSION_TTL_MS, m: 'pw', r: 'acc', a: staff.id, x: staffEpoch() });
}

/** The session for a signed accountant token, if the account is still active and nothing ended it. */
export function staffSessionFrom(payload: SessionPayload): AdminSession | null {
  if (typeof payload.a !== 'string' || payload.a.length > 40) return null;
  const r = getDb().prepare("SELECT * FROM staff_accounts WHERE id = ? AND status = 'active'").get(payload.a) as Row | undefined;
  if (!r || !r.password_hash || r.role !== 'accountant') return null;
  if (payload.e !== r.email || payload.g !== r.session_gen || payload.h !== passwordFingerprint(r.password_hash)) return null;
  const epoch = staffEpoch();
  if (!epoch || payload.x !== epoch) return null;
  return { email: r.email, role: 'accountant', staffId: r.id, mustChangePassword: false, expiresAt: payload.exp, issuedAt: Number(payload.iat) || 0, method: 'password', recoveryPending: false };
}

/** Sign one accountant out (every device): their sessions end, the owner's don't. */
export function endStaffSessions(id: string): void {
  getDb().prepare('UPDATE staff_accounts SET session_gen = session_gen + 1 WHERE id = ?').run(id);
}

// ── Invite, setup, revoke ───────────────────────────────────────────────────

export interface Invite {
  account: StaffAccount;
  /** The setup token (goes in the link's fragment) and the path grant that opens the hub for it. */
  token: string;
  grant: string;
}

/**
 * Invite an accountant (or send a new setup link to one): a new one-time link, valid 72 hours. A
 * new link to an account that was active or revoked starts it again as an invite: its password and
 * every session it had stop working until the new link is used. The owner's own email is refused.
 */
export function inviteAccountant(emailInput: unknown, nameInput: unknown, ownerEmail: string, by: string, now = Date.now()): Invite {
  const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, 'Please check the accountant’s email address.');
  if (email === ownerEmail.trim().toLowerCase()) throw new HttpError(400, 'That is your own sign-in email. Use your accountant’s own address.');
  const name = typeof nameInput === 'string' ? nameInput.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 80) : '';
  if (nameInput !== undefined && nameInput !== null && typeof nameInput !== 'string') throw new HttpError(400, 'Name must be text.');
  const token = crypto.randomBytes(32).toString('base64url');
  const grant = crypto.randomBytes(32).toString('base64url');
  const at = new Date(now).toISOString();
  const expires = now + STAFF_SETUP_TTL_MS;
  const id = auditedTransaction((auditOrThrow) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM staff_accounts WHERE email = ?').get(email) as Row | undefined;
    if (existing) {
      db.prepare("UPDATE staff_accounts SET status = 'invited', name = CASE WHEN ? <> '' THEN ? ELSE name END, password_hash = NULL, setup_hash = ?, setup_grant_hash = ?, setup_expires_at = ?, session_gen = session_gen + 1, invited_at = ?, invited_by = ?, activated_at = NULL, revoked_at = NULL, revoked_by = NULL WHERE id = ?")
        .run(name, name, sha(token), hashSegment(grant, 'buh-staff-grant'), expires, at, by, existing.id);
      auditOrThrow('accountant.invited', { by, staffId: existing.id, email, again: true, was: existing.status });
      return existing.id;
    }
    const count = db.prepare("SELECT COUNT(*) FROM staff_accounts WHERE status <> 'revoked'").pluck().get() as number;
    if (count >= MAX_STAFF) throw new HttpError(409, `There are already ${MAX_STAFF} accountant accounts. Revoke one first.`);
    const newId = `acc_${crypto.randomBytes(9).toString('base64url')}`;
    db.prepare("INSERT INTO staff_accounts (id, email, role, name, status, setup_hash, setup_grant_hash, setup_expires_at, invited_at, invited_by) VALUES (?, ?, 'accountant', ?, 'invited', ?, ?, ?, ?, ?)")
      .run(newId, email, name, sha(token), hashSegment(grant, 'buh-staff-grant'), expires, at, by);
    auditOrThrow('accountant.invited', { by, staffId: newId, email });
    return newId;
  });
  return { account: view(getDb().prepare('SELECT * FROM staff_accounts WHERE id = ?').get(id) as Row, now), token, grant };
}

/**
 * The accountant chooses a password with the setup link: once, within 72 hours, and only while the
 * invite stands (a revoked or re-sent one is refused). Returns the account, ready to sign in.
 */
export async function completeStaffSetup(token: unknown, password: string, now = Date.now()): Promise<ActiveStaff> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new HttpError(400, 'This setup link is not valid. Ask the shop owner for a new one.');
  const hash = sha(token);
  const row = getDb().prepare("SELECT * FROM staff_accounts WHERE setup_hash = ? AND status = 'invited'").get(hash) as Row | undefined;
  if (!row || !(Number(row.setup_expires_at) > now)) throw new HttpError(400, 'This setup link has expired or was already used. Ask the shop owner for a new one.');
  const passwordHash = await hashPassword(password);
  return auditedTransaction((auditOrThrow) => {
    // Used once: only the request that clears the setup hash sets the password.
    const changed = getDb()
      .prepare("UPDATE staff_accounts SET status = 'active', password_hash = ?, setup_hash = NULL, setup_grant_hash = NULL, setup_expires_at = NULL, session_gen = session_gen + 1, activated_at = ? WHERE id = ? AND setup_hash = ? AND status = 'invited' AND setup_expires_at > ?")
      .run(passwordHash, new Date(now).toISOString(), row.id, hash, now).changes;
    if (changed !== 1) throw new HttpError(400, 'This setup link has expired or was already used. Ask the shop owner for a new one.');
    auditOrThrow('accountant.setup_done', { by: row.email, staffId: row.id });
    const r = getDb().prepare('SELECT * FROM staff_accounts WHERE id = ?').get(row.id) as Row;
    return { id: r.id, email: r.email, passwordHash: r.password_hash!, sessionGen: r.session_gen };
  });
}

/** Revoke an accountant: their sessions and any setup link stop working now. Audited first. */
export function revokeStaff(id: unknown, by: string, now = Date.now()): StaffAccount {
  if (typeof id !== 'string' || !/^acc_[A-Za-z0-9_-]{6,30}$/.test(id)) throw new HttpError(404, 'Account not found.');
  return auditedTransaction((auditOrThrow) => {
    const before = getDb().prepare('SELECT * FROM staff_accounts WHERE id = ?').get(id) as Row | undefined;
    if (!before) throw new HttpError(404, 'Account not found.');
    if (before.status !== 'revoked') {
      getDb()
        .prepare("UPDATE staff_accounts SET status = 'revoked', password_hash = NULL, setup_hash = NULL, setup_grant_hash = NULL, setup_expires_at = NULL, session_gen = session_gen + 1, revoked_at = ?, revoked_by = ? WHERE id = ?")
        .run(new Date(now).toISOString(), by, id);
      auditOrThrow('accountant.revoked', { by, staffId: id, email: before.email, was: before.status });
    }
    return view(getDb().prepare('SELECT * FROM staff_accounts WHERE id = ?').get(id) as Row, now);
  });
}

/** Email the setup link (when the shop's email is set up). Never throws; true when sent. */
export async function emailStaffInvite(to: string, link: string, shop: string, ownerEmail: string): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    await (await transport()).sendMail({
      from: sender(),
      to,
      replyTo: ownerEmail,
      subject: `[${shop}] Your read-only accountant access`,
      text: [
        `${shop} has given you read-only access to its books: sales, refunds, expenses with the bills, VAT and the audit log, and the exports for your work.`,
        '',
        'Choose your password here (the link works once, for 72 hours):',
        link,
        '',
        'Afterwards, sign in at the shop’s private Admin Hub link, which the shop owner will send you. Your access is read-only: nothing in the shop can be changed with it.',
        '',
        `If you were not expecting this, ignore this email or reply to ${ownerEmail}.`,
      ].join('\n'),
    });
    return true;
  } catch (err) {
    logEvent('warn', 'accountant_invite_email_failed', { error: err instanceof Error ? err.message : String(err) });
    audit('accountant.invite_email_failed', { to });
    return false;
  }
}
