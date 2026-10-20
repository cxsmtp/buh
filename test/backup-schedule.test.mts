/**
 * Backups when there is something new (backupPolicy.ts, dataChanges.ts, backup.ts): the database
 * counts every write to the shop's data; a backup is due 2 h after the first critical change (later
 * changes never postpone it), 24 h after chats or visits alone, weekly as a check when nothing
 * changes, and never when nothing changed (no backup, no email, no Drive copy). Emails: at most one
 * a day (UAE days) by default, the weekly check, "Back up now". A restart keeps the due time. The
 * marker moves on only after a backup succeeds, and a change made during one stays pending.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import Database from 'better-sqlite3';
import { SMTPServer } from 'smtp-server';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
delete process.env.BACKUP_INTERVAL_HOURS;
process.env.MONITOR_DISABLED = 'true';

const policy = await import('@/lib/server/backupPolicy');
const changes = await import('@/lib/server/dataChanges');
const backup = await import('@/lib/server/backup');
const { getDb, _closeDb } = await import('@/lib/server/db');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const settings = await import('@/lib/server/settings');
const { kvGet, kvSet } = await import('@/lib/server/kv');

const H = 3600_000;
const DAY = 24 * H;
const S: import('@/lib/server/backupPolicy').BackupSettings = { delayMinutes: 120, email: 'daily', weeklyCheck: true };
const none = { total: 0, critical: false, firstChangeAt: null, firstCriticalAt: null };
const iso = (t: number) => new Date(t).toISOString();

// A mail server counting what the shop sends.
const mails: string[] = [];
let smtp: SMTPServer;
before(async () => {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, cb) {
      let raw = '';
      stream.on('data', (d) => (raw += d));
      stream.on('end', () => {
        mails.push(raw);
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const port = (smtp.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@test', BACKUP_EMAIL: 'owner@test' });
});
after(() => {
  smtp.close();
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL']) delete process.env[k];
});

function order(name = 'Fatima') {
  const p = products.listProducts()[0];
  return orders.placeOrder({
    idempotencyKey: `sched-${crypto.randomUUID()}`,
    verificationToken: issuePhoneToken(`+97150${String(crypto.randomInt(1_000_000, 9_999_999))}`),
    customer: { fullName: name, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
}

const backupFiles = () => fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('buh-backup-'));
const counts = () => Object.fromEntries((getDb().prepare('SELECT area, n FROM data_changes').all() as Array<{ area: string; n: number }>).map((r) => [r.area, r.n]));

// ── The rules, with any clock ───────────────────────────────────────────────

test('rules: nothing changed → no backup; a critical change → due 2 h after it, and later changes never postpone it', () => {
  const t0 = Date.parse('2026-10-20T08:00:00Z');
  const state = { lastSuccessAt: iso(t0 - H) };
  assert.deepEqual(policy.decideBackup({ now: t0 + 6 * DAY, settings: S, pending: none, state, fallbackHours: null }).run, null, 'quiet for 6 days: nothing to do');
  const first = { total: 1, critical: true, firstChangeAt: iso(t0), firstCriticalAt: iso(t0) };
  const d = policy.decideBackup({ now: t0 + 1.9 * H, settings: S, pending: first, state, fallbackHours: null });
  assert.equal(d.run, null);
  assert.equal(d.dueAt, t0 + 2 * H);
  // 30 more changes since, the last a minute ago: still due at the first one + 2 h.
  const busy = { ...first, total: 31 };
  assert.equal(policy.decideBackup({ now: t0 + 2 * H, settings: S, pending: busy, state, fallbackHours: null }).run, 'changes');
  assert.equal(policy.decideBackup({ now: t0 + 2 * H, settings: S, pending: busy, state, fallbackHours: null }).dueAt, t0 + 2 * H);
  // The owner's delay (30 min).
  assert.equal(policy.decideBackup({ now: t0 + 31 * 60_000, settings: { ...S, delayMinutes: 30 }, pending: first, state, fallbackHours: null }).run, 'changes');
});

test('rules: only chats or visits → a backup within 24 h; the weekly check runs, and is skipped after a recent backup', () => {
  const t0 = Date.parse('2026-10-20T08:00:00Z');
  const chatsOnly = { total: 4, critical: false, firstChangeAt: iso(t0), firstCriticalAt: null };
  const state = { lastSuccessAt: iso(t0 - H) };
  assert.equal(policy.decideBackup({ now: t0 + 23 * H, settings: S, pending: chatsOnly, state, fallbackHours: null }).run, null);
  assert.equal(policy.decideBackup({ now: t0 + 24 * H, settings: S, pending: chatsOnly, state, fallbackHours: null }).run, 'changes');
  // A chat at 08:00 and an order at 15:00: the order's 2 h, unless the chat's 24 h is sooner.
  const mixed = { total: 5, critical: true, firstChangeAt: iso(t0), firstCriticalAt: iso(t0 + 7 * H) };
  assert.equal(policy.decideBackup({ now: t0, settings: S, pending: mixed, state, fallbackHours: null }).dueAt, t0 + 9 * H);

  // Weekly: 7 days after the last backup with nothing new.
  const quiet = { lastSuccessAt: iso(t0) };
  assert.equal(policy.decideBackup({ now: t0 + 6.9 * DAY, settings: S, pending: none, state: quiet, fallbackHours: null }).run, null, 'a backup in the last 7 days: skipped');
  assert.equal(policy.decideBackup({ now: t0 + 7 * DAY, settings: S, pending: none, state: quiet, fallbackHours: null }).run, 'weekly-check');
  assert.equal(policy.decideBackup({ now: t0 + 7 * DAY, settings: S, pending: none, state: quiet, fallbackHours: null }).weeklyAt, t0 + 7 * DAY);
  assert.equal(policy.decideBackup({ now: t0 + 30 * DAY, settings: { ...S, weeklyCheck: false }, pending: none, state: quiet, fallbackHours: null }).run, null, 'switched off');
  // The first backup ever runs at once.
  assert.equal(policy.decideBackup({ now: t0, settings: S, pending: none, state: {}, fallbackHours: null }).run, 'startup');
});

test('rules: after a failure, tried again hourly; BACKUP_INTERVAL_HOURS (old) bounds the wait while changes are pending', () => {
  const t0 = Date.parse('2026-10-20T08:00:00Z');
  const pending = { total: 1, critical: true, firstChangeAt: iso(t0 - 5 * H), firstCriticalAt: iso(t0 - 5 * H) };
  const failed = { lastSuccessAt: iso(t0 - DAY), lastAttemptAt: iso(t0), lastError: 'disk full' };
  assert.equal(policy.decideBackup({ now: t0 + 30 * 60_000, settings: S, pending, state: failed, fallbackHours: null }).run, null);
  assert.equal(policy.decideBackup({ now: t0 + 30 * 60_000, settings: S, pending, state: failed, fallbackHours: null }).retryAt, t0 + H);
  assert.equal(policy.decideBackup({ now: t0 + H, settings: S, pending, state: failed, fallbackHours: null }).run, 'changes');
  // A failure with nothing pending is still retried (hourly), so the hub turns green again.
  assert.equal(policy.decideBackup({ now: t0 + H, settings: S, pending: none, state: failed, fallbackHours: null }).run, 'weekly-check');
  // BACKUP_INTERVAL_HOURS=1 with a 12 h delay: due an hour after the last backup.
  const p2 = { total: 1, critical: true, firstChangeAt: iso(t0), firstCriticalAt: iso(t0) };
  assert.equal(policy.decideBackup({ now: t0, settings: { ...S, delayMinutes: 720 }, pending: p2, state: { lastSuccessAt: iso(t0 - 30 * 60_000) }, fallbackHours: 1 }).dueAt, t0 + 30 * 60_000);
  assert.equal(policy.decideBackup({ now: t0, settings: { ...S, delayMinutes: 720 }, pending: none, state: { lastSuccessAt: iso(t0 - 5 * H) }, fallbackHours: 1 }).run, null, 'no changes: the old interval never forces a backup');
});

test('emails: each choice; "at most one a day" counts UAE days, across UTC midnight', () => {
  const t = Date.parse('2026-10-20T10:00:00Z');
  for (const reason of ['changes', 'weekly-check', 'manual', 'startup'] as const) assert.equal(policy.shouldEmail('every', reason, t), true, reason);
  assert.equal(policy.shouldEmail('never', 'changes', t), false);
  assert.equal(policy.shouldEmail('never', 'weekly-check', t), false);
  assert.equal(policy.shouldEmail('never', 'manual', t), false, '"Back up now" follows the choice…');
  assert.equal(policy.shouldEmail('never', 'manual', t, undefined, true), true, '…unless the owner asks for the email');
  assert.equal(policy.shouldEmail('weekly', 'changes', t), false);
  assert.equal(policy.shouldEmail('weekly', 'weekly-check', t), true);
  assert.equal(policy.shouldEmail('weekly', 'manual', t), false);
  assert.equal(policy.shouldEmail('daily', 'manual', t), true);
  assert.equal(policy.shouldEmail('daily', 'manual', t, undefined, false), false);
  assert.equal(policy.shouldEmail('daily', 'weekly-check', t, iso(t - H)), true);
  assert.equal(policy.shouldEmail('daily', 'changes', t), true, 'the first of the day');
  assert.equal(policy.shouldEmail('daily', 'changes', t, iso(t - 3 * H)), false, 'the second of the day');
  // 19:30 UTC is 23:30 in Dubai; 20:30 UTC is 00:30 the next day there: a new day.
  assert.equal(policy.shouldEmail('daily', 'changes', Date.parse('2026-10-20T20:30:00Z'), '2026-10-20T19:30:00.000Z'), true);
  // 21:00 UTC and 23:59 UTC, then 00:30 UTC (another UTC day): all 20 Oct + 1 in Dubai, one email.
  assert.equal(policy.shouldEmail('daily', 'changes', Date.parse('2026-10-21T00:30:00Z'), '2026-10-20T21:00:00.000Z'), false);
  assert.equal(policy.dubaiDay(Date.parse('2026-10-20T19:59:59Z')), '2026-10-20');
  assert.equal(policy.dubaiDay(Date.parse('2026-10-20T20:00:00Z')), '2026-10-21');
  // The next UAE day, the newest unemailed backup goes by email (daily only).
  const st = { lastSuccessAt: '2026-10-20T15:00:00.000Z', unemailedSince: '2026-10-20T15:00:00.000Z', lastChangeEmailAt: '2026-10-20T06:00:00.000Z' };
  assert.equal(policy.catchUpEmailDue('daily', Date.parse('2026-10-20T19:00:00Z'), st), false, 'same UAE day');
  assert.equal(policy.catchUpEmailDue('daily', Date.parse('2026-10-20T20:05:00Z'), st), true, 'the next UAE day');
  assert.equal(policy.catchUpEmailDue('weekly', Date.parse('2026-10-21T20:05:00Z'), st), false);
});

test('UAE weeks start on Monday; days turn at 20:00 UTC', () => {
  assert.equal(policy.dubaiWeek(Date.parse('2026-10-25T19:59:00Z')), '2026-10-19', 'Sunday 23:59 in Dubai: the week from Monday 19th');
  assert.equal(policy.dubaiWeek(Date.parse('2026-10-25T20:00:00Z')), '2026-10-26', 'Monday 00:00 in Dubai: a new week');
  assert.equal(policy.dubaiWeek(Date.parse('2026-10-19T00:00:00Z')), '2026-10-19');
});

/** 12 backups a day (every 2 h) for 60 days, ending at `end`. */
function twelveADay(end: number, days = 60) {
  const out: number[] = [];
  for (let t = end - days * DAY + 2 * H; t <= end; t += 2 * H) out.push(t);
  return out;
}

test('Drive: 12 backups a day for 60 days keep 4 a day for a week, one a day to 30 days, one a week beyond, within 60 copies', () => {
  const end = Date.parse('2026-10-20T10:00:00Z');
  let kept: Array<{ id: string; name: string; at: string; createdTime?: string }> = [];
  let mostInOneRun = 0;
  for (const t of twelveADay(end)) {
    // As copyOnce does: the new copy is added, then retention runs at that moment.
    const id = `c${t}`;
    kept.push({ id, name: `buh-backup-${t}.tar.gz.enc`, at: iso(t), createdTime: iso(t) });
    const remove = policy.driveCopiesToRemove(kept, 60, t, id);
    mostInOneRun = Math.max(mostInOneRun, remove.length);
    const gone = new Set(remove.map((r) => r.id));
    assert.ok(!gone.has(id), 'never the copy just made');
    kept = kept.filter((c) => !gone.has(c.id));
  }
  assert.ok(kept.length <= 60, `${kept.length} copies`);
  assert.ok(mostInOneRun <= policy.DRIVE_DELETE_PER_RUN);
  const ages = kept.map((c) => (end - Date.parse(c.at)) / DAY);
  const perDay = (from: number, to: number) => {
    const m = new Map<string, number>();
    for (const c of kept) {
      const age = (end - Date.parse(c.at)) / DAY;
      if (age > from && age <= to) m.set(policy.dubaiDay(Date.parse(c.at)), (m.get(policy.dubaiDay(Date.parse(c.at))) ?? 0) + 1);
    }
    return m;
  };
  // The last 7 days: every UAE day there, up to 4 each (the full days have 4).
  const week = perDay(-1, 7);
  assert.ok(week.size >= 7, `${week.size} days in the last week`);
  assert.ok([...week.values()].every((n) => n >= 1 && n <= 4), JSON.stringify([...week]));
  assert.ok([...week.values()].filter((n) => n === 4).length >= 6, JSON.stringify([...week]));
  // 7 to 30 days: one each day, no day missing.
  const month = perDay(7.01, 30);
  assert.ok(month.size >= 22, `${month.size} days between 7 and 30 days`);
  assert.ok([...month.values()].every((n) => n === 1));
  // Beyond 30 days: one a UAE week, back to the start.
  const old = kept.filter((c) => (end - Date.parse(c.at)) / DAY > 30.01);
  const weeks = new Set(old.map((c) => policy.dubaiWeek(Date.parse(c.at))));
  assert.equal(weeks.size, old.length, 'one per week');
  assert.ok(old.length >= 4, `${old.length} weekly copies`);
  assert.ok(Math.max(...ages) >= 53, `the oldest copy is ${Math.max(...ages).toFixed(1)} days old`);
});

test('Drive: over the cap, the newest days are thinned first and the oldest weekly copy stays', () => {
  const end = Date.parse('2026-10-20T10:00:00Z');
  const list = twelveADay(end, 120).map((t) => ({ id: `c${t}`, name: `n${t}`, at: iso(t), createdTime: iso(t) }));
  // keep 20 and no per-run limit in the way: run retention until nothing more goes.
  let kept = list;
  for (let i = 0; i < 200; i++) {
    const remove = policy.driveCopiesToRemove(kept, 20, end);
    if (!remove.length) break;
    const gone = new Set(remove.map((r) => r.id));
    kept = kept.filter((c) => !gone.has(c.id));
  }
  assert.ok(kept.length <= 20, String(kept.length));
  const oldest = Math.min(...kept.map((c) => Date.parse(c.at)));
  assert.ok((end - oldest) / DAY > 110, 'the oldest weekly copy (about 4 months old) is still there');
  assert.ok(kept.some((c) => Date.parse(c.at) === end), 'and the newest');
  // Only one or two copies: the newest and the only one are never removed, however old.
  assert.deepEqual(policy.driveCopiesToRemove([{ id: 'only', name: 'x', at: iso(end - 400 * DAY), createdTime: iso(end - 400 * DAY) }], 1, end), []);
  assert.deepEqual(policy.driveCopiesToRemove([{ id: 'a', name: 'a', at: iso(end - 300 * DAY), createdTime: iso(end - 300 * DAY) }, { id: 'b', name: 'b', at: iso(end - 100 * DAY), createdTime: iso(end - 100 * DAY) }], 1, end - 100 * DAY).map((x) => x.id), ['a']);
});

test('Drive: ages are Google’s (createdTime), never the server’s recorded time; copies Google has not dated are never removed; at most 10 a run', () => {
  const end = Date.parse('2026-10-20T10:00:00Z');
  const list = twelveADay(end).map((t) => ({ id: `c${t}`, name: `n${t}`, at: iso(t), createdTime: iso(t) }));
  assert.equal(policy.driveCopiesToRemove(list, 60, end).length, policy.DRIVE_DELETE_PER_RUN);
  // The server recorded every copy a year ahead (its clock jumped): Google's times decide, so the same go.
  const skewed = list.map((c) => ({ ...c, at: iso(Date.parse(c.at) + 365 * DAY) }));
  assert.deepEqual(policy.driveCopiesToRemove(skewed, 60, end).map((c) => c.id), policy.driveCopiesToRemove(list, 60, end).map((c) => c.id));
  // Recorded before createdTime was kept (only the server's time): none is removed, however old or over the cap.
  const undated = list.map((c) => ({ id: c.id, name: c.name, at: iso(Date.parse(c.at) - 400 * DAY) }));
  assert.deepEqual(policy.driveCopiesToRemove(undated, 5, end), []);
  const mixed = [...undated.slice(0, 50), ...list.slice(-20)];
  const gone = policy.driveCopiesToRemove(mixed, 5, end);
  assert.ok(gone.length > 0 && gone.every((c) => 'createdTime' in c), 'only dated copies go');
});

test('the clock check: more than a day from Google’s is wrong (either way); a wrong clock holds for 7 days, and ends when the clock is put back', () => {
  const g = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(policy.clockSkewed(g + 23 * H, g), false);
  assert.equal(policy.clockSkewed(g + 25 * H, g), true);
  assert.equal(policy.clockSkewed(g - 25 * H, g), true);
  assert.equal(policy.clockSkewed(g + 365 * DAY, g), true);
  const ahead = g + 365 * DAY;
  const mark = { setAt: iso(ahead), until: iso(ahead + policy.CLOCK_SUSPECT_MS) };
  assert.equal(policy.clockSuspectActive(mark, ahead + DAY), true);
  assert.equal(policy.clockSuspectActive(mark, ahead + 8 * DAY), false, 'not renewed for 7 days: over');
  assert.equal(policy.clockSuspectActive(mark, g), false, 'the clock was put right (back before the mark): over');
  assert.equal(policy.clockSuspectActive({}, g), false);
  assert.equal(policy.clockSuspectActive(null, g), false);
});

const stamp = (t: number) => `buh-backup-${iso(t).slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}.tar.gz.enc`;

/** Backups made at each time in `times`, pruned after each one as backup.ts does; the names kept and the most removed in one run. */
function simulateLocal(times: number[], tight: boolean, start: string[] = []) {
  let names = [...start];
  let most = 0;
  for (const t of times) {
    names.push(stamp(t));
    const gone = new Set(policy.localBackupsToRemove(names, t, tight));
    most = Math.max(most, gone.size);
    names = names.filter((n) => !gone.has(n));
  }
  return { names, most };
}

test('local backups: 12 a day for 60 days keep every one of 14 days; with the disk tight, all of the last day then one a day; never fewer than 14; at most 5 a run', () => {
  const end = Date.parse('2026-10-20T10:00:00Z');
  const all = twelveADay(end);
  const fine = simulateLocal(all, false);
  const kept = fine.names.map((n) => policy.localBackupTime(n)!);
  assert.ok(fine.most <= policy.LOCAL_DELETE_PER_RUN, String(fine.most));
  // Every backup of the last 14 days; none older than 14 days before the 14th newest (26 h ago).
  for (const t of all.filter((x) => end - x <= 14 * DAY)) assert.ok(kept.includes(t), `kept ${iso(t)}`);
  assert.ok(kept.every((t) => end - t <= 14 * DAY + 26 * H), 'none older');
  const tight = simulateLocal(all, true);
  const tk = tight.names.map((n) => policy.localBackupTime(n)!);
  assert.ok(tight.most <= policy.LOCAL_DELETE_PER_RUN);
  for (const t of all.filter((x) => end - x <= DAY)) assert.ok(tk.includes(t), 'all of the last 24 hours');
  const older = tk.filter((t) => end - t > 26 * H + DAY);
  assert.equal(new Set(older.map((t) => policy.dubaiDay(t))).size, older.length, 'then one a UAE day');
  assert.ok(older.length >= 12 && tk.every((t) => end - t <= 14 * DAY + 26 * H), String(older.length));
  // Never fewer than the newest 14, and other files are never touched.
  const names = all.map(stamp);
  assert.deepEqual(policy.localBackupsToRemove(names.slice(-14), end + 100 * DAY, true), []);
  assert.equal(policy.localBackupsToRemove(['pre-update-1.db', ...names.slice(-3)], end, true).length, 0, 'other files are never touched');
  // A clock put back (behind the backups): ages count from the clock, so fewer look old, never more.
  assert.ok(policy.localBackupsToRemove(names, end - 30 * DAY, false).length <= policy.localBackupsToRemove(names, end, false).length);
});

test('local backups: a clock a year ahead for 5 backups in a row removes nothing of the 14 days before it (with or without a tight disk)', () => {
  const end = Date.parse('2026-10-20T10:00:00Z');
  const before = simulateLocal(twelveADay(end, 30), false).names;
  const real = before.map((n) => policy.localBackupTime(n)!).filter((t) => end - t <= 14 * DAY);
  assert.ok(real.length >= 14 * 12);
  const jumped = [1, 2, 3, 4, 5].map((i) => end + 365 * DAY + i * 2 * H);
  for (const tight of [false, true]) {
    const after = simulateLocal(jumped, tight, before);
    const left = new Set(after.names.map((n) => policy.localBackupTime(n)!));
    if (!tight) for (const t of real) assert.ok(left.has(t), `kept ${iso(t)}`);
    else {
      // Tight: still every one of the last day before the jump, and one of each of the 14 days.
      for (const t of real.filter((x) => end - x <= DAY)) assert.ok(left.has(t));
      const days = new Set(real.map((t) => policy.dubaiDay(t)));
      for (const d of days) assert.ok([...left].some((t) => policy.dubaiDay(t) === d), d);
    }
    for (const t of jumped) assert.ok(left.has(t));
  }
  // Even a wrong clock that lasts: at most 5 go in a run (and with Google Drive connected, none: backup.ts).
  const longer = Array.from({ length: 30 }, (_, i) => end + 365 * DAY + (i + 1) * 2 * H);
  assert.ok(simulateLocal(longer, false, before).most <= policy.LOCAL_DELETE_PER_RUN);
});

test('settings: validated, kept in history, restorable, and in the backup', async () => {
  const bad = async (v: Record<string, unknown>) => {
    try {
      await settings.updateSettings('backups', v);
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  };
  assert.deepEqual(settings.getSettings('backups'), { delayMinutes: 120, email: 'daily', weeklyCheck: true }, 'the defaults');
  assert.equal(await bad({ delayMinutes: 29 }), 400);
  assert.equal(await bad({ delayMinutes: 721 }), 400);
  assert.equal(await bad({ delayMinutes: 90.5 }), 400);
  assert.equal(await bad({ email: 'sometimes' }), 400);
  assert.equal(await bad({ weeklyCheck: 'yes' }), 400);
  await settings.updateSettings('backups', { delayMinutes: 30, email: 'weekly', weeklyCheck: false });
  await settings.updateSettings('backups', { delayMinutes: 240, email: 'every', weeklyCheck: true });
  assert.deepEqual(settings.getSettings('backups'), { delayMinutes: 240, email: 'every', weeklyCheck: true });
  const v = settings.settingsHistory().find((x) => x.key === 'backups')!;
  await settings.restoreSettingsVersion(v.id);
  assert.deepEqual(settings.getSettings('backups'), { delayMinutes: 30, email: 'weekly', weeklyCheck: false }, 'history puts the earlier version back');

  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-sched-restore-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const restored = new Database(path.join(target, 'shop.db'), { readonly: true });
  assert.deepEqual(JSON.parse((restored.prepare("SELECT data FROM settings WHERE key = 'backups'").get() as { data: string }).data), { delayMinutes: 30, email: 'weekly', weeklyCheck: false });
  assert.ok(restored.prepare("SELECT 1 FROM sqlite_master WHERE name = 'data_changes'").get(), 'the change record comes back too');
  restored.close();
  await settings.updateSettings('backups', { delayMinutes: 120, email: 'daily', weeklyCheck: true });
});

// ── Change tracking: every kind of write moves the marker ───────────────────

async function moved(area: string, fn: () => unknown) {
  const before = counts();
  await fn();
  const after = counts();
  assert.ok(after[area] > before[area], `${area} did not move`);
}
async function still(what: string, fn: () => unknown) {
  const before = counts();
  await fn();
  assert.deepEqual(counts(), before, `${what} counted as a change`);
}

test('every kind of write marks the data changed; reads, sign-ins and sessions do not', async () => {
  const db = getDb();
  const o = order('Tracked');
  await moved('orders', () => order('Another'));
  await moved('orders', () => orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, 'owner@test'));
  await moved('payments', () => db.prepare("INSERT INTO card_refunds (order_id, amount_fils, at, source, stripe_refund_id) VALUES (?, 100, ?, 'stripe', 're_1')").run(o.id, new Date().toISOString()));
  await moved('payments', () => db.prepare("INSERT INTO stripe_events (id, type, at, outcome) VALUES ('evt_1', 'payment_intent.succeeded', ?, 'applied')").run(new Date().toISOString()));
  const p = products.listProducts()[0];
  const moves = await import('@/lib/server/stockMoves');
  await moved('stock', () => moves.applyStockMove(p.id, moves.parseMoveRequest({ key: `k-${crypto.randomUUID()}`, reason: 'correction', changes: [{ sizeId: p.profiles[0].id, delta: 1 }] }), 'owner@test'));
  await moved('products', () => products.setArchived(products.listProducts()[1].id, false));
  await moved('products', () => products.duplicateProduct(p.id, `dup-${crypto.randomUUID()}`, 'owner@test'));
  const drafts = await import('@/lib/server/productDrafts');
  await moved('products', () => drafts.saveDraft('new', { title: 'Half done', price: '199' }, 'owner@test'));
  const images = await import('@/lib/server/images');
  await moved('photos', () => images.saveImageBytes(crypto.randomBytes(64), 'image/png'));
  const collections = await import('@/lib/server/collections');
  const col = collections.createCollection({ key: `k-col-${crypto.randomUUID().slice(0, 12)}`, title: 'Eid picks', productIds: [p.id] }, 'owner@test').collection;
  await moved('collections', () => collections.updateCollection(col.id, { title: 'Eid picks 2', productIds: [p.id] }, 'owner@test'));
  await moved('visits', () => collections.countCollectionEvent(col.slug, 'view'));
  const ex = await import('@/lib/server/expenses');
  await moved('expenses', () => ex.createExpense({ date: '2026-10-01', amount: '5', categoryId: 'other', method: 'cash' }, 'owner@test', `k-${crypto.randomUUID()}`));
  await moved('expenses', () => ex.addCategory('Photo shoots', 'owner@test'));
  await moved('settings', () => settings.updateSettings('store', { supportEmail: 'help@shop.test' }));
  const vat = await import('@/lib/server/vat');
  await moved('settings', () => vat.saveVatSettings({ legalName: 'Beautiful UAE Home' }, 'owner@test'));
  await moved('vat', () => db.prepare("INSERT INTO order_vat (order_id, rate_bp, inclusive, net_fils, vat_fils, total_fils, lines, supplier, created_at) VALUES (?, 500, 1, 100, 5, 105, '[]', '{}', ?)").run(o.id, new Date().toISOString()));
  const staff = await import('@/lib/server/staffAuth');
  let staffId = '';
  await moved('accounts', () => (staffId = staff.inviteAccountant('ca@firm.test', 'Our CA', 'owner@test', 'owner@test').account.id));
  const recovery = await import('@/lib/server/recoveryCodes');
  await moved('accounts', () => recovery.createRecoveryCodes());
  await moved('accounts', () => db.prepare("INSERT INTO admin_passkeys (id, public_key, name, rp_id, created_at) VALUES ('pk1', x'00', 'Phone', 'shop.test', ?)").run(new Date().toISOString()));
  const chat = await import('@/lib/server/chat');
  let thread = { id: '', token: '' };
  await moved('chats', () => (thread = chat.startChat({ message: 'Hello, is the king size in stock?' })));

  // Reads, sign-ins, sessions, the chat's "seen" marks: never.
  await still('reading', () => {
    products.listProducts({ includeHidden: true, includeArchived: true });
    orders.allOrders();
    orders.listCustomers();
    settings.adminView('store');
    chat.listChats('all');
    chat.chatForAdmin(thread.id);
    ex.listExpenses({});
    collections.listCollections();
    backup.backupHealth();
  });
  await still('a customer polling the chat', () => chat.customerPoll(thread.id, thread.token, 0));
  await still('an accountant signing in', () => db.prepare('UPDATE staff_accounts SET last_sign_in_at = ? WHERE id = ?').run(new Date().toISOString(), staffId));
  await still('signing an accountant out', () => staff.endStaffSessions(staffId));
  await still('a passkey sign-in', () => db.prepare("UPDATE admin_passkeys SET counter = counter + 1, last_used_at = ? WHERE id = 'pk1'").run(new Date().toISOString()));
  await still('caches and counters', () => {
    kvSet('fx', { base: 'AED', rates: {}, fetchedAt: new Date().toISOString() });
    kvSet('monitor:dbcheck', { ok: true, at: Date.now() });
    kvSet('backup:drive-state', { lastSuccessAt: new Date().toISOString() });
  });
  // The changes waiting are described by area, critical first.
  const pending = changes.pendingChanges();
  assert.equal(pending.critical, true);
  assert.match(changes.describeAreas(pending.areas), /^orders, payments, stock, products, photos, collections, expenses, VAT documents, settings, accounts, chats, visits$/);
});

// ── The schedule with the real database ─────────────────────────────────────

test('the marker resets only after a successful backup; a change made while one runs stays pending', async () => {
  await backup.runBackup('manual', { email: false });
  assert.equal(changes.pendingChanges().total, 0, 'all backed up');

  // A failure leaves everything pending.
  order('Before failure');
  const bdir = path.join(dir, 'backups');
  const aside = `${bdir}-aside`;
  fs.renameSync(bdir, aside);
  fs.writeFileSync(bdir, 'not a folder');
  try {
    const failed = await backup.runBackup('changes');
    assert.ok(failed.lastError);
    assert.equal(changes.pendingChanges().areas.orders > 0, true, 'still pending after the failure');
  } finally {
    fs.rmSync(bdir, { force: true });
    fs.renameSync(aside, bdir);
  }

  // A change while the backup runs (after it took its mark) stays for the next one.
  const run = backup.runBackup('changes', { email: false });
  order('During the backup');
  const state = await run;
  assert.equal(state.lastError, undefined);
  const left = changes.pendingChanges();
  assert.ok(left.areas.orders >= 1, JSON.stringify(left));
  assert.ok(left.firstCriticalAt && Date.parse(left.firstCriticalAt) <= Date.now(), 'its clock has started');
  assert.ok((state.lastChanges?.total ?? 0) >= 1, 'the backup records how many changes it held');
  await backup.runBackup('manual', { email: false });
  assert.equal(changes.pendingChanges().total, 0);
});

test('no changes: no backup, no email, no Drive copy; a change: due 2 h later, the restart keeps that time', async () => {
  await settings.updateSettings('backups', { email: 'weekly' }); // no daily catch-up email in the way
  await backup.runBackup('manual', { email: false });
  const files = backupFiles().length;
  const mailCount = mails.length;
  const lastSuccess = backup.readBackupState().lastSuccessAt;
  for (const later of [5 * 60_000, 3 * H, 2 * DAY, 6 * DAY]) assert.equal(backup.backupTick(Date.now() + later), null);
  assert.equal(backupFiles().length, files, 'no backup');
  assert.equal(mails.length, mailCount, 'no email');
  assert.equal(backup.readBackupState().lastSuccessAt, lastSuccess);
  const h = backup.backupHealth(Date.now() + 6 * DAY);
  assert.notEqual(h.level, 'failing', 'a quiet shop is fine');
  assert.equal(h.pending.total, 0);
  assert.equal(h.nextDueAt, null);
  assert.ok(h.weeklyCheckAt);

  const t0 = Date.now();
  order('Starts the clock');
  const due = Date.parse(backup.backupHealth().nextDueAt!);
  assert.ok(due >= t0 + 2 * H - 1000 && due <= Date.now() + 2 * H, 'due 2 h after the first change');
  order('Later change');
  assert.equal(Date.parse(backup.backupHealth().nextDueAt!), due, 'a later change does not postpone it');
  assert.equal(backup.backupTick(due - 60_000), null, 'not before');

  // The shop restarts: the database is opened again, the due time is the same.
  _closeDb();
  assert.equal(Date.parse(backup.backupHealth().nextDueAt!), due);
  assert.equal(backup.backupHealth(due + 2 * H).level, 'failing', 'waiting past the delay + 1 h is flagged');

  assert.equal(backup.backupTick(due + 60_000), 'changes');
  const state = await backup.runBackup('manual', { email: false }); // waits for the run the tick started
  assert.equal(state.lastError, undefined);
  assert.equal(changes.pendingChanges().total, 0);
  await settings.updateSettings('backups', { email: 'daily' });
});

test('emails under "at most one a day": the first change-driven backup of a UAE day, the weekly check, then the catch-up the next day', async () => {
  await settings.updateSettings('backups', { email: 'daily' });
  await backup.runBackup('manual', { email: false });
  const day1 = Date.parse('2030-01-15T05:00:00Z'); // 09:00 in Dubai, a day no other test emails on
  const start = mails.length;
  order('Morning');
  await backup.runBackup('changes', { now: () => day1 });
  assert.equal(mails.length, start + 1, 'the first of the day is emailed');
  order('Noon');
  const second = await backup.runBackup('changes', { now: () => day1 + 3 * H });
  assert.equal(mails.length, start + 1, 'the second is not');
  assert.match(second.lastEmailSkipped ?? '', /one backup a day/);
  assert.ok(second.unemailedSince);
  // The next UAE day (after 20:00 UTC): the newest backup goes by email even with nothing new.
  assert.equal(policy.catchUpEmailDue('daily', Date.parse('2030-01-15T19:00:00Z'), backup.readBackupState()), false, 'not the same UAE day');
  assert.equal(policy.catchUpEmailDue('daily', Date.parse('2030-01-15T20:30:00Z'), backup.readBackupState()), true, 'the next UAE day');
  assert.equal(await backup.emailCatchUp(Date.parse('2030-01-15T20:30:00Z')), true);
  assert.equal(mails.length, start + 2);
  assert.equal(backup.readBackupState().unemailedSince, undefined);
  // The weekly check is emailed even under "at most one a day".
  await backup.runBackup('weekly-check', { now: () => Date.parse('2030-01-15T21:00:00Z') });
  assert.equal(mails.length, start + 3);
  // "Never": not even the weekly check; "Back up now" only when asked.
  await settings.updateSettings('backups', { email: 'never' });
  await backup.runBackup('weekly-check');
  await backup.runBackup('manual');
  assert.equal(mails.length, start + 3);
  await backup.runBackup('manual', { email: true });
  assert.equal(mails.length, start + 4);
  await settings.updateSettings('backups', { email: 'daily' });
  // The audit log says why each ran and how many changes, never what they were.
  const auditText = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(auditText, /"action":"backup\.taken","details":\{"reason":"changes","changes":\d+,"areas":"orders/);
  assert.match(auditText, /"reason":"weekly-check"/);
  assert.doesNotMatch(auditText.split('\n').filter((l) => l.includes('backup.taken')).join('\n'), /Morning|Noon/);
});

test('failure emails are unchanged: one per error, again on "Back up now"', async () => {
  const bdir = path.join(dir, 'backups');
  const aside = `${bdir}-aside2`;
  fs.renameSync(bdir, aside);
  fs.writeFileSync(bdir, 'not a folder');
  const start = mails.length;
  try {
    await backup.runBackup('changes');
    await backup.runBackup('changes');
    assert.equal(mails.filter((m) => m.includes('[Backup FAILED]')).length >= 1, true);
    assert.equal(mails.length, start + 1, 'one failure email for the same error');
    await backup.runBackup('manual');
    assert.equal(mails.length, start + 2);
  } finally {
    fs.rmSync(bdir, { force: true });
    fs.renameSync(aside, bdir);
  }
  await backup.runBackup('manual', { email: false });
});

test('health warns when the newest backups are only on the server (no Drive, not emailed for 2 days)', async () => {
  await settings.updateSettings('backups', { email: 'never' });
  order('Never emailed');
  const st = await backup.runBackup('changes');
  assert.equal(st.lastError, undefined);
  assert.equal(backup.backupHealth().offServerWarning, undefined, 'the last email is recent');
  const later = backup.backupHealth(Date.now() + 3 * DAY);
  assert.equal(later.offServerWarning, backup.ONLY_ON_SERVER);
  assert.equal(later.level, 'warning', 'allowed, but warned (never failing)');
  // Emailed again: the warning goes.
  await backup.runBackup('manual', { email: true });
  assert.equal(backup.backupHealth(Date.now() + 3 * DAY).offServerWarning, undefined);
  await settings.updateSettings('backups', { email: 'daily' });
  await backup.runBackup('manual', { email: false });
});

test('a new shop is not told its backups are only on the server until 2 days after its first backup', async () => {
  const file = path.join(dir, 'backup-state.json');
  const saved = fs.readFileSync(file, 'utf8');
  await settings.updateSettings('backups', { email: 'never' });
  try {
    // As a shop's first backup leaves it: never emailed, the first success just now.
    const now = Date.now();
    const st = JSON.parse(saved);
    for (const k of ['lastEmailedAt', 'lastChangeEmailAt', 'lastEmailError', 'lastError']) delete st[k];
    fs.writeFileSync(file, JSON.stringify({ ...st, lastSuccessAt: iso(now), lastAttemptAt: iso(now), firstSuccessAt: iso(now) }));
    assert.equal(backup.backupHealth(now + 60_000).offServerWarning, undefined, 'right after the first backup');
    assert.equal(backup.backupHealth(now + DAY).offServerWarning, undefined, 'a day on');
    assert.equal(backup.backupHealth(now + 2 * DAY + H).offServerWarning, backup.ONLY_ON_SERVER, 'more than 2 days on');
    // The first backup is recorded by the run itself (kept from then on).
    const fresh = { ...st };
    delete fresh.lastSuccessAt;
    delete fresh.firstSuccessAt;
    fs.writeFileSync(file, JSON.stringify(fresh));
    order('First of a new shop');
    const first = await backup.runBackup('changes');
    assert.ok(first.firstSuccessAt && Math.abs(Date.parse(first.firstSuccessAt) - Date.now()) < 60_000, String(first.firstSuccessAt));
    assert.equal(backup.backupHealth().offServerWarning, undefined, 'not warned at its first backup');
    const again = await backup.runBackup('manual', { email: false });
    assert.equal(again.firstSuccessAt, first.firstSuccessAt);
  } finally {
    await settings.updateSettings('backups', { email: 'daily' });
    fs.writeFileSync(file, saved);
  }
});

test('a backup whose changes cannot be recorded is failing, and no change-driven backup runs again within the hour', async () => {
  order('Before the broken record');
  const db = getDb();
  db.pragma('query_only = ON'); // the backup reads; recording what it held (a write) fails
  let st;
  try {
    st = await backup.runBackup('changes');
  } finally {
    db.pragma('query_only = OFF');
  }
  assert.equal(st.lastError, backup.MARK_FAILED);
  assert.ok(st.lastSuccessAt, 'the backup itself was made');
  assert.equal(backup.backupHealth().level, 'failing');
  assert.ok(changes.pendingChanges().total > 0, 'its changes still wait');
  const files = backupFiles().length;
  for (const later of [60_000, 5 * 60_000, 30 * 60_000, 55 * 60_000]) assert.equal(backup.backupTick(Date.now() + later), null, `no loop (${later / 60_000} min)`);
  assert.equal(backupFiles().length, files);
  // An hour on, the next one runs and records them.
  assert.equal(backup.backupTick(Date.now() + 61 * 60_000), 'changes');
  const next = await backup.runBackup('manual', { email: false });
  assert.equal(next.lastError, undefined);
  assert.equal(changes.pendingChanges().total, 0);
});

test('a bank-transfer screenshot moved into place after the order is saved still counts as a change', async () => {
  await settings.updateSettings('bank', { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' });
  const p = products.listProducts()[0];
  const o = orders.placeOrder({
    idempotencyKey: `sched-bank-${crypto.randomUUID()}`,
    verificationToken: issuePhoneToken(`+97150${String(crypto.randomInt(1_000_000, 9_999_999))}`),
    customer: { fullName: 'Aisha Test', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'bank_transfer',
  }).order;
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // Note the orders count at the moment the screenshot is moved into place (after the commit).
  const rename = fs.renameSync;
  let atMove = -1;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith(`${path.sep}${o.id}.png`)) atMove = counts().orders;
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    orders.uploadTransfer(o.id, PNG);
  } finally {
    fs.renameSync = rename;
  }
  assert.ok(atMove >= 0, 'the screenshot was moved into place');
  assert.ok(counts().orders > atMove, 'a change was counted after the file landed');
});

test('every watched table has its 3 triggers; ones a table rebuild lost are made again at start', async () => {
  const db = getDb();
  const { changeTriggerDefs, ensureChangeTriggers } = await import('@/lib/server/db');
  const triggers = () => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name));
  const have = triggers();
  const byTable = new Map<string, string[]>();
  for (const t of changeTriggerDefs()) byTable.set(t.table, [...(byTable.get(t.table) ?? []), t.name]);
  for (const [table, names] of byTable) {
    if (table === 'collections') assert.equal(names.length, 4, 'collections: its 3 and the visits counter');
    else if (table === 'kv') assert.equal(names.length, 9, 'kv: 3 for each of its 3 groups');
    else assert.equal(names.length, 3, table);
    for (const n of names) assert.ok(have.has(n), `${table}: ${n} is missing`);
  }
  assert.deepEqual(ensureChangeTriggers(db), [], 'nothing to repair');
  // A tool rebuilds a table (create new, copy, drop, rename): its triggers are gone.
  db.exec("CREATE TABLE product_drafts_new (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT ''); INSERT INTO product_drafts_new SELECT * FROM product_drafts; DROP TABLE product_drafts; ALTER TABLE product_drafts_new RENAME TO product_drafts;");
  assert.ok(!triggers().has('data_changes_product_drafts_products_insert'));
  const repaired = ensureChangeTriggers(db);
  assert.deepEqual(repaired.sort(), ['data_changes_product_drafts_products_delete', 'data_changes_product_drafts_products_insert', 'data_changes_product_drafts_products_update']);
  const drafts = await import('@/lib/server/productDrafts');
  await moved('products', () => drafts.saveDraft('new', { title: 'After the rebuild', price: '150' }, 'owner@test'));
  // The start-up step does this and says so in the log.
  const startupSrc = fs.readFileSync('src/lib/server/startup.ts', 'utf8');
  assert.match(startupSrc, /ensureChangeTriggers\(getDb\(\)\)[\s\S]*backup_triggers_repaired/);
  // The Drive settings (kv backup:drive) count as settings; the copies' own state does not.
  const before = kvGet('backup:drive');
  await moved('settings', () => kvSet('backup:drive', before?.data ?? { enabled: false, keep: 60 }));
  await still('the Drive copies list', () => kvSet('backup:drive-files', []));
  await backup.runBackup('manual', { email: false });
});
