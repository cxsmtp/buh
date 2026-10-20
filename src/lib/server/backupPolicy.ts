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

// ── Retention: local backups and Google Drive copies ────────────────────────

/** The Monday a UAE day's week starts on ('YYYY-MM-DD'). */
export function dubaiWeek(t: number): string {
  const d = new Date(t + 4 * HOUR);
  const back = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** More than this ahead of the newest copy, the clock is not trusted: nothing is deleted. */
export const CLOCK_AHEAD_MS = 2 * DAY;
/** At most this many Drive copies are deleted in one run. */
export const DRIVE_DELETE_PER_RUN = 10;
/** Drive: copies kept per UAE day in the last 7 days (before the cap thins them). */
export const DRIVE_PER_DAY = 4;

export interface DriveCopy {
  id: string;
  name: string;
  at: string;
}

const time = (c: { at: string }) => at(c.at) ?? 0;

/**
 * Which tracked Drive copies to remove. Ages count from the newest copy's time when the clock is
 * ahead of it (a clock that jumped forward never makes copies look old), and when the clock is more
 * than 2 days ahead nothing is removed at all (`clockAhead`, for a warning).
 *
 *  - the last 7 days: the newest 4 of each UAE day;
 *  - 7 to 30 days: the newest of each UAE day;
 *  - 30 days to 6 months: the newest of each UAE week (Monday to Sunday);
 *  - older: removed.
 *
 * Over `keep`, the newest buckets are thinned first: fewer a day in the last week (down to one),
 * then the recent days, then the daily ones, then the weekly ones from the newest; the oldest
 * weekly copy and the newest copy (and `protect`, the one just made) are never removed for the
 * cap. At most DRIVE_DELETE_PER_RUN go in one run, oldest first.
 */
export function driveRetention(copies: DriveCopy[], keep: number, now: number, protect = ''): { remove: DriveCopy[]; clockAhead: boolean } {
  if (copies.length <= 1) return { remove: [], clockAhead: false };
  const sorted = [...copies].sort((a, b) => time(b) - time(a)); // newest first
  const newestAt = time(sorted[0]);
  if (now - newestAt > CLOCK_AHEAD_MS) return { remove: [], clockAhead: true };
  const ref = Math.min(now, newestAt);
  const newest = sorted[0].id;
  const safe = (c: DriveCopy) => c.id === newest || c.id === protect;
  const tierOf = (c: DriveCopy) => {
    const age = ref - time(c);
    return age > 182 * DAY ? 'old' : age > 30 * DAY ? 'weekly' : age > WEEKLY_DAYS * DAY ? 'daily' : 'recent';
  };
  const pick = (perDay: number) => {
    const kept: DriveCopy[] = [];
    const used = new Map<string, number>();
    for (const c of sorted) {
      const tier = tierOf(c);
      const key = tier === 'recent' || tier === 'daily' ? `d${dubaiDay(time(c))}` : tier === 'weekly' ? `w${dubaiWeek(time(c))}` : 'old';
      const limit = tier === 'recent' ? perDay : tier === 'old' ? 0 : 1;
      const n = used.get(key) ?? 0;
      if (safe(c) || n < limit) kept.push(c);
      used.set(key, n + 1);
    }
    return kept;
  };
  const cap = Math.max(1, keep);
  let kept = pick(DRIVE_PER_DAY);
  for (let perDay = DRIVE_PER_DAY - 1; kept.length > cap && perDay >= 1; perDay--) kept = pick(perDay);
  if (kept.length > cap) {
    // Still over: newest buckets first (recent, then daily, then weekly), never the oldest weekly copy.
    const weekly = kept.filter((c) => tierOf(c) === 'weekly');
    const oldestWeekly = weekly.length ? weekly[weekly.length - 1].id : '';
    const order = ['recent', 'daily', 'weekly'].flatMap((tier) => kept.filter((c) => tierOf(c) === tier && !safe(c) && c.id !== oldestWeekly));
    const drop = new Set<string>();
    for (const c of order) {
      if (kept.length - drop.size <= cap) break;
      drop.add(c.id);
    }
    kept = kept.filter((c) => !drop.has(c.id));
  }
  const keepIds = new Set(kept.map((c) => c.id));
  const remove = sorted.filter((c) => !keepIds.has(c.id)).sort((a, b) => time(a) - time(b));
  return { remove: remove.slice(0, DRIVE_DELETE_PER_RUN), clockAhead: false };
}

/** The copies driveRetention removes (oldest first). */
export function driveCopiesToRemove(copies: DriveCopy[], keep: number, now: number, protect = ''): DriveCopy[] {
  return driveRetention(copies, keep, now, protect).remove;
}

/** Local backups: never fewer than this many (the newest). */
export const LOCAL_KEEP_MIN = 14;
export const LOCAL_KEEP_DAYS = 14;

/** When a local backup was made, from its name (buh-backup-YYYYMMDD-HHMM…, UTC), or null. */
export function localBackupTime(name: string): number | null {
  const m = /^buh-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(t) ? t : null;
}

/**
 * Which local backups (file names) to remove. The newest 14 always stay. With room on the disk,
 * only those older than 14 days go; with the disk tight, also all but the newest of each UAE day
 * older than 24 hours. Ages count from the newest backup when the clock is ahead of it, and with
 * the clock more than 2 days ahead nothing is removed.
 */
export function localBackupsToRemove(names: string[], now: number, diskTight: boolean): string[] {
  const dated = names.map((name) => ({ name, t: localBackupTime(name) })).filter((x): x is { name: string; t: number } => x.t !== null).sort((a, b) => b.t - a.t || (a.name < b.name ? 1 : -1));
  if (dated.length <= LOCAL_KEEP_MIN) return [];
  if (now - dated[0].t > CLOCK_AHEAD_MS) return [];
  const ref = Math.min(now, dated[0].t);
  const remove: string[] = [];
  const days = new Set<string>();
  dated.forEach((b, i) => {
    const age = ref - b.t;
    const day = dubaiDay(b.t);
    const firstOfDay = !days.has(day);
    days.add(day);
    if (i < LOCAL_KEEP_MIN) return;
    if (age > LOCAL_KEEP_DAYS * DAY) remove.push(b.name);
    else if (diskTight && age > DAY && !firstOfDay) remove.push(b.name);
  });
  return remove;
}
