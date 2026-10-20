/**
 * When backups run, which are emailed, and which Google Drive copies are kept: plain functions of
 * the time, the settings and what is waiting (no database, no clock of their own), so every rule is
 * tested with any "now". backup.ts applies them.
 *
 *  - Nothing new since the last successful backup: no backup, no email, no Drive copy.
 *  - The first critical change (an order, stock, a price, a payment, settings…) starts the clock: a
 *    backup is due `delayMinutes` later (2 h by default). Later changes never postpone it.
 *  - Only non-critical changes (chats, visits): due 24 h after the first one.
 *  - The weekly check (on by default): a backup when none has succeeded for 7 days, so a quiet shop
 *    still proves its backups work.
 *  - After a failure, tried again hourly. BACKUP_INTERVAL_HOURS (old setting), when set, is an upper
 *    bound between backups while changes wait.
 */

export const BACKUP_EMAIL_CHOICES = ['every', 'daily', 'weekly', 'never'] as const;
export type BackupEmailChoice = (typeof BACKUP_EMAIL_CHOICES)[number];

export interface BackupSettings {
  /** Minutes from the first critical change to the backup: 30 to 720. */
  delayMinutes: number;
  /** Which backups are emailed. */
  email: BackupEmailChoice;
  /** A backup at least weekly, even when nothing changes. */
  weeklyCheck: boolean;
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = { delayMinutes: 120, email: 'daily', weeklyCheck: true };
export const DELAY_LIMITS = { min: 30, max: 720 };

export type BackupReason = 'changes' | 'weekly-check' | 'manual' | 'startup';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const NON_CRITICAL_HOURS = 24;
export const WEEKLY_DAYS = 7;
/** Health: no successful backup for this long (weekly check on) is failing. */
export const WEEKLY_OVERDUE_DAYS = 8;
export const RETRY_MS = HOUR;

/** Validated settings (the hub's form, or a version from Settings history). Throws a readable message. */
export function validateBackupSettings(input: Record<string, unknown>, current: BackupSettings = DEFAULT_BACKUP_SETTINGS): BackupSettings {
  const delay = input.delayMinutes === undefined ? current.delayMinutes : Number(input.delayMinutes);
  if (!Number.isInteger(delay) || delay < DELAY_LIMITS.min || delay > DELAY_LIMITS.max) {
    throw new RangeError(`Back up after: a whole number of minutes from ${DELAY_LIMITS.min} (half an hour) to ${DELAY_LIMITS.max} (12 hours).`);
  }
  const email = input.email === undefined ? current.email : input.email;
  if (typeof email !== 'string' || !(BACKUP_EMAIL_CHOICES as readonly string[]).includes(email)) throw new RangeError('Email backups: choose one of the options.');
  const weekly = input.weeklyCheck === undefined ? current.weeklyCheck : input.weeklyCheck;
  if (typeof weekly !== 'boolean') throw new RangeError('Weekly check: on or off.');
  return { delayMinutes: delay, email: email as BackupEmailChoice, weeklyCheck: weekly };
}

export interface ScheduleInput {
  now: number;
  settings: BackupSettings;
  pending: { total: number; critical: boolean; firstChangeAt: string | null; firstCriticalAt: string | null };
  state: { lastSuccessAt?: string; lastAttemptAt?: string; lastError?: string };
  /** BACKUP_INTERVAL_HOURS when set on the server (the old fixed schedule), else null. */
  fallbackHours: number | null;
}

export interface ScheduleDecision {
  /** Run a backup now, and why; null when none is due. */
  run: BackupReason | null;
  /** When the waiting changes are due (null when nothing waits). */
  dueAt: number | null;
  /** When the weekly check would run (null when switched off). */
  weeklyAt: number | null;
  /** A failure is being waited out (tried again hourly). */
  retryAt: number | null;
}

const at = (iso?: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** When waiting changes are due: the first critical one plus the delay, the first of any plus 24 h, whichever is sooner. */
export function changesDueAt(input: Omit<ScheduleInput, 'now'>): number | null {
  const { pending, settings, state, fallbackHours } = input;
  if (pending.total <= 0) return null;
  const candidates: number[] = [];
  const critical = at(pending.firstCriticalAt);
  if (pending.critical) candidates.push((critical ?? at(pending.firstChangeAt) ?? Date.now()) + settings.delayMinutes * 60_000);
  const first = at(pending.firstChangeAt);
  candidates.push((first ?? critical ?? Date.now()) + NON_CRITICAL_HOURS * HOUR);
  const last = at(state.lastSuccessAt);
  if (fallbackHours && last) candidates.push(last + fallbackHours * HOUR);
  return Math.min(...candidates);
}

export function decideBackup(input: ScheduleInput): ScheduleDecision {
  const { now, settings, state } = input;
  const last = at(state.lastSuccessAt);
  const attempt = at(state.lastAttemptAt);
  const dueAt = changesDueAt(input);
  const weeklyAt = settings.weeklyCheck ? (last ?? now) + WEEKLY_DAYS * DAY : null;
  const failing = Boolean(state.lastError) && attempt !== null && (last === null || attempt > last);
  const retryAt = failing && attempt !== null && now - attempt < RETRY_MS ? attempt + RETRY_MS : null;
  let run: BackupReason | null = null;
  if (retryAt === null) {
    if (last === null) run = 'startup'; // the shop's first backup
    // A failure is retried hourly until a backup works (the changes it held are still waiting).
    else if (failing) run = input.pending.total > 0 ? 'changes' : 'weekly-check';
    else if (dueAt !== null && now >= dueAt) run = 'changes';
    else if (weeklyAt !== null && now >= weeklyAt) run = input.pending.total > 0 ? 'changes' : 'weekly-check';
  }
  return { run, dueAt, weeklyAt, retryAt };
}

/** The UAE calendar day (Asia/Dubai is UTC+4 all year). */
export function dubaiDay(t: number): string {
  return new Date(t + 4 * HOUR).toISOString().slice(0, 10);
}

/**
 * Is this backup emailed? `asked`: the owner's "Back up now" asked for an email (true) or not
 * (false); undefined follows the choice. `lastChangeEmailAt`: the last change-driven backup emailed.
 */
export function shouldEmail(choice: BackupEmailChoice, reason: BackupReason, now: number, lastChangeEmailAt?: string, asked?: boolean): boolean {
  if (reason === 'manual') return asked ?? (choice === 'every' || choice === 'daily');
  if (choice === 'never') return false;
  if (choice === 'every') return true;
  if (reason === 'weekly-check') return true;
  if (choice === 'weekly') return false;
  // daily: the first change-driven backup of the UAE day.
  const prev = at(lastChangeEmailAt);
  return prev === null || dubaiDay(prev) !== dubaiDay(now);
}

/**
 * "At most one a day" leaves later backups of a day unemailed: the newest one is emailed the next
 * UAE day even when nothing else changes, so with email as the only copy away from the server no
 * change waits more than about a day for one.
 */
export function catchUpEmailDue(choice: BackupEmailChoice, now: number, state: { lastSuccessAt?: string; unemailedSince?: string; lastChangeEmailAt?: string }): boolean {
  if (choice !== 'daily' || !state.unemailedSince || !state.lastSuccessAt) return false;
  const since = at(state.unemailedSince);
  if (since === null) return false;
  const prev = at(state.lastChangeEmailAt);
  return dubaiDay(now) !== dubaiDay(since) && (prev === null || dubaiDay(prev) !== dubaiDay(now));
}

// ── Google Drive retention ──────────────────────────────────────────────────

export interface DriveCopy {
  id: string;
  name: string;
  at: string;
}

/**
 * Which tracked Drive copies to remove: every copy from the last 7 days stays; from 7 to 30 days
 * old, the newest of each UAE day; from 30 days to 6 months, the newest of each week; older ones
 * go. Then, beyond `keep` copies, the oldest go. The newest copy (and so an only copy) is never
 * removed, nor `protect` (the one just uploaded).
 */
export function driveCopiesToRemove(copies: DriveCopy[], keep: number, now: number, protect = ''): DriveCopy[] {
  if (copies.length <= 1) return [];
  const sorted = [...copies].sort((a, b) => (at(b.at) ?? 0) - (at(a.at) ?? 0)); // newest first
  const newest = sorted[0].id;
  const kept: DriveCopy[] = [];
  const remove: DriveCopy[] = [];
  const seen = new Set<string>();
  for (const c of sorted) {
    const t = at(c.at) ?? now;
    const age = now - t;
    let bucket = '';
    if (age > 182 * DAY) bucket = 'old';
    else if (age > 30 * DAY) bucket = `w${Math.floor(t / (7 * DAY))}`;
    else if (age > WEEKLY_DAYS * DAY) bucket = `d${dubaiDay(t)}`;
    const safe = c.id === newest || c.id === protect;
    if (!safe && (bucket === 'old' || (bucket && seen.has(bucket)))) remove.push(c);
    else kept.push(c);
    if (bucket) seen.add(bucket);
  }
  const cap = Math.max(1, keep);
  // Over the cap: the oldest kept go first (never the newest or the protected one).
  let count = kept.length;
  for (let i = kept.length - 1; i >= 0 && count > cap; i--) {
    const c = kept[i];
    if (c.id === newest || c.id === protect) continue;
    remove.push(c);
    count--;
  }
  // Oldest first, as before.
  return remove.sort((a, b) => (at(a.at) ?? 0) - (at(b.at) ?? 0));
}
