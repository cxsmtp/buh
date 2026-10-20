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
const { kvSet } = await import('@/lib/server/kv');

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

test('Drive retention: every copy of the last week, then one a day, one a week; never the newest or the only one', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const c = (id: string, ageH: number) => ({ id, name: `${id}.enc`, at: iso(now - ageH * H) });
  assert.deepEqual(policy.driveCopiesToRemove([c('only', 400 * 24)], 1, now), [], 'the only copy, however old');
  assert.deepEqual(policy.driveCopiesToRemove([], 30, now), []);
  // Two old copies, keep 1: the newest stays even though it is over 6 months old.
  assert.deepEqual(policy.driveCopiesToRemove([c('a', 300 * 24), c('b', 200 * 24)], 1, now).map((x) => x.id), ['a']);
  const list = [
    c('w1', 1), c('w2', 30), c('w3', 6 * 24), // this week: all stay
    c('d1a', 10 * 24), c('d1b', 10 * 24 + 1), // the same UAE day, 10 days ago: the newer stays
    c('d2', 20 * 24),
    c('k1', 60 * 24), c('k2', 60 * 24 + 2), // the same week, 2 months ago: one stays
    c('old', 200 * 24), // over 6 months: goes
  ];
  const removed = policy.driveCopiesToRemove(list, 30, now).map((x) => x.id).sort();
  assert.deepEqual(removed, ['d1b', 'k2', 'old']);
  // keep 2: the oldest go first; the newest and the copy just made never.
  const capped = policy.driveCopiesToRemove(list, 2, now, 'w3').map((x) => x.id);
  assert.ok(!capped.includes('w1') && !capped.includes('w3'), JSON.stringify(capped));
  assert.equal(list.length - capped.length, 2);
  assert.equal(capped[0], 'old', 'oldest first');
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
