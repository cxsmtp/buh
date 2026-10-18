/**
 * Fixes from the review of BUH-02.10 (expenses, reports, the accountant's ZIP): refunds booked on
 * the day each was made (the refunds ledger: partial refunds, the rest later, a refund that failed;
 * older refunds filled in once, their dates marked approximate); every expense counted however many
 * there are; the ZIP made without holding up the shop, guarded by the free disk and one at a time,
 * a failed one audited; bills: the same file twice is one bill, the type served is fixed by the
 * kind, the file is in place before the row counts, JPEG's extra pictures and anything after its
 * end go; category and file names normalised; a long expense note kept whole in the audit log.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const { getDb } = await import('@/lib/server/db');
const orders = await import('@/lib/server/orders');
const reports = await import('@/lib/server/reports');
const ex = await import('@/lib/server/expenses');
const backup = await import('@/lib/server/backup');
// (Imported so this file also runs, and fails test by test, against a build without the lock.)
const takeExportLock = ((await import('@/lib/server/exportLock').catch(() => null))?.takeExportLock ?? (() => { throw new Error('no export lock'); })) as () => () => void;
const { readZip } = await import('@/lib/server/zip');
const logModule = await import('@/lib/server/log');

const OWNER = 'owner@shop.test';
const auditLines = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

function insertCardOrder(id: string, at: string, totalFils: number, card: { state: string; paidFils?: number; refundedFils?: number; refundedAt?: string; updatedAt?: string; live?: boolean }) {
  const order = {
    id,
    createdAt: at,
    customer: { fullName: 'Layla Test', phone: '+971501234567', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: 'prod-1', title: 'Mughal Garden', image: '', profileId: 'king', profileName: 'King', mattressSize: '', fittedSheet: '', flatSheet: '', pillowcases: '', unitPrice: totalFils / 100, quantity: 1, totalPrice: totalFils / 100 }],
    subtotal: totalFils / 100,
    deliveryFee: 0,
    codFee: 0,
    discount: 0,
    total: totalFils / 100,
    paymentMethod: 'online_card',
    paymentStatus: 'paid',
    status: 'delivered',
    courier: { provider: 'jeebly', serviceType: 'Scheduled', awbNumber: '', trackingUrl: '', status: '', pickupDate: '', weightKg: 1, pieces: 1, labelGenerated: false },
  };
  getDb()
    .prepare(
      `INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, data, card_state, paid_fils, refunded_fils, refunded_at, card_livemode, payment_ref)
       VALUES (?, ?, ?, '+971501234567', 'confirmed', 'online_card', 'paid', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, at, card.updatedAt ?? at, totalFils, JSON.stringify(order), card.state, card.paidFils ?? null, card.refundedFils ?? null, card.refundedAt ?? null, card.live === false ? 0 : 1, `pi_${id}`);
}

const refundsIn = (from: string, to: string) => reports.buildReport(from, to).refunds;

// ── Refunds by the day they were made ───────────────────────────────────────

test('a partial refund, the rest a month later, and that refund failing: each booked on its own day, never on the order\'s', async () => {
  insertCardOrder('BUH-R1', '2026-07-30T10:00:00Z', 40_000, { state: 'paid', paidFils: 40_000 });
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-19T10:00:00Z') });
  try {
    // A partial refund made in Stripe's dashboard (its webhook).
    assert.equal(orders.markCardRefunded('pi_BUH-R1', { amount: 40_000, amountRefunded: 10_000, refundId: 're_part' }, 'stripe'), 'partial');
    assert.deepEqual(refundsIn('2026-07-01', '2026-07-31'), { count: 0, fils: 0 }, 'not on the day the order was placed');
    assert.deepEqual(refundsIn('2026-08-01', '2026-08-31'), { count: 1, fils: 10_000 });
    // The rest from the hub, in September.
    mock.timers.setTime(Date.parse('2026-09-03T10:00:00Z'));
    assert.equal(orders.recordCardRefund('BUH-R1', { id: 're_rest', status: 'succeeded', amount: 30_000 }, OWNER).outcome, 'refunded');
    // Stripe's webhook for the same refund changes nothing.
    assert.equal(orders.markCardRefunded('pi_BUH-R1', { amount: 40_000, amountRefunded: 40_000, refundId: 're_rest' }, 'stripe'), 'already');
    assert.deepEqual(refundsIn('2026-08-01', '2026-08-31'), { count: 1, fils: 10_000 }, 'August keeps the partial refund');
    assert.deepEqual(refundsIn('2026-09-01', '2026-09-30'), { count: 1, fils: 30_000 });
    // The September refund fails on the 5th: it comes off on that day, August stays.
    mock.timers.setTime(Date.parse('2026-09-05T10:00:00Z'));
    assert.equal(orders.markRefundFailed('pi_BUH-R1', { id: 're_rest', amount: 30_000, reason: 'expired_or_canceled_card' }, 'stripe'), 'refund_failed');
    assert.deepEqual(refundsIn('2026-09-01', '2026-09-30'), { count: 1, fils: 0 });
    assert.deepEqual(refundsIn('2026-09-05', '2026-09-05'), { count: 0, fils: -30_000 });
    assert.deepEqual(refundsIn('2026-08-01', '2026-08-31'), { count: 1, fils: 10_000 });
    assert.deepEqual(refundsIn('2026-07-01', '2026-07-31'), { count: 0, fils: 0 });
    assert.ok(reports.buildReport('2026-09-01', '2026-09-30').notes.some((n) => /failed after being made: AED 300\.00/.test(n)));
  } finally {
    mock.timers.reset();
  }
  const rows = getDb().prepare("SELECT amount_fils, source, stripe_refund_id, substr(at, 1, 10) AS day FROM card_refunds WHERE order_id = 'BUH-R1' ORDER BY id").all();
  assert.deepEqual(rows, [
    { amount_fils: 10_000, source: 'stripe', stripe_refund_id: 're_part', day: '2026-08-19' },
    { amount_fils: 30_000, source: 'hub', stripe_refund_id: 're_rest', day: '2026-09-03' },
    { amount_fils: -30_000, source: 'stripe', stripe_refund_id: 're_rest', day: '2026-09-05' },
  ]);
  // The partial refund noted from Stripe is in the audit log, before it counts.
  assert.ok(auditLines().some((e) => e.action === 'payment.refunded_so_far' && e.details.orderId === 'BUH-R1' && e.details.toFils === 10_000));
  // The order and the ledger agree.
  assert.equal(getDb().prepare("SELECT COALESCE(refunded_fils, 0) FROM orders WHERE id = 'BUH-R1'").pluck().get(), 10_000);
});

test('a partial refund noted when "Cancel & refund" checks Stripe is in the ledger, on that day, and audited in its transaction', () => {
  insertCardOrder('BUH-R2', '2026-06-10T10:00:00Z', 20_000, { state: 'paid', paidFils: 20_000 });
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-06-20T10:00:00Z') });
  try {
    orders.noteRefundedSoFar('BUH-R2', 5_000);
    orders.noteRefundedSoFar('BUH-R2', 5_000);
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(getDb().prepare("SELECT amount_fils, substr(at, 1, 10) AS day FROM card_refunds WHERE order_id = 'BUH-R2'").all(), [{ amount_fils: 5_000, day: '2026-06-20' }], 'once');
  assert.match(fs.readFileSync('src/lib/server/orders.ts', 'utf8'), /export function noteRefundedSoFar[\s\S]{0,400}auditedTransaction\(/);
});

test('refunds made before the ledger: filled in once, dated when refunded (or last changed, never when placed), marked approximate', async () => {
  // Refunded on 2 March, placed in February.
  insertCardOrder('BUH-OLD1', '2026-02-20T10:00:00Z', 15_000, { state: 'refunded', paidFils: 15_000, refundedFils: 15_000, refundedAt: '2026-03-02T08:00:00Z' });
  // A partial refund without a date (an older version): the order last changed on 5 March.
  insertCardOrder('BUH-OLD2', '2026-02-21T10:00:00Z', 30_000, { state: 'paid', paidFils: 30_000, refundedFils: 7_000, updatedAt: '2026-03-05T09:00:00Z' });
  // Refunded with no amount recorded: the whole payment.
  insertCardOrder('BUH-OLD3', '2026-02-22T10:00:00Z', 9_000, { state: 'refunded', paidFils: 9_000, refundedAt: '2026-03-06T08:00:00Z' });
  // A Stripe test payment: in the ledger, but never counted.
  insertCardOrder('BUH-OLD4', '2026-02-23T10:00:00Z', 1_000, { state: 'refunded', paidFils: 1_000, refundedAt: '2026-03-06T08:00:00Z', live: false });
  assert.deepEqual(refundsIn('2026-02-01', '2026-02-28'), { count: 0, fils: 0 }, 'nothing on the days the orders were placed');
  assert.deepEqual(refundsIn('2026-03-01', '2026-03-31'), { count: 3, fils: 15_000 + 7_000 + 9_000 });
  const ledger = () => getDb().prepare("SELECT order_id, amount_fils, at, date_approx FROM card_refunds WHERE order_id LIKE 'BUH-OLD%' ORDER BY order_id").all();
  assert.deepEqual(ledger(), [
    { order_id: 'BUH-OLD1', amount_fils: 15_000, at: '2026-03-02T08:00:00Z', date_approx: 1 },
    { order_id: 'BUH-OLD2', amount_fils: 7_000, at: '2026-03-05T09:00:00Z', date_approx: 1 },
    { order_id: 'BUH-OLD3', amount_fils: 9_000, at: '2026-03-06T08:00:00Z', date_approx: 1 },
    { order_id: 'BUH-OLD4', amount_fils: 1_000, at: '2026-03-06T08:00:00Z', date_approx: 1 },
  ]);
  assert.equal(orders.backfillRefundLedger(), 0, 'once: nothing more to fill in');
  reports.buildReport('2026-03-01', '2026-03-31');
  assert.equal(ledger().length, 4);
  // The export says which dates are approximate.
  const result = await reports.writeAccountantZip('2026-03-01', '2026-03-31');
  const zip = readZip(fs.readFileSync(result.file));
  fs.rmSync(result.file);
  const refundsCsv = zip.get('refunds.csv')!.toString('utf8').trim().split('\r\n');
  assert.equal(refundsCsv[0], 'date,order_number,amount_aed,kind,made_in,stripe_refund_id,at_utc,date_approximate,counted_in_refunds,not_counted_because');
  assert.ok(refundsCsv.includes('2026-03-02,BUH-OLD1,150.00,refund,Stripe,,2026-03-02T08:00:00Z,approximate,yes,'), refundsCsv.join('\n'));
  assert.ok(refundsCsv.some((r) => r.startsWith('2026-03-06,BUH-OLD4,10.00,') && r.endsWith(',no,Stripe test mode (not real money)')));
  assert.ok(reports.buildReport('2026-03-01', '2026-03-31').notes.some((n) => /best known/.test(n)));
  // A backup carries the ledger; the restore brings it back.
  const b = await backup.createBackup();
  const target = path.join(os.tmpdir(), `buh-restore-ledger-${Date.now()}`);
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', b.file, target]).toString();
  assert.match(out, /\d+ card refunds/);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) FROM card_refunds').pluck().get(), getDb().prepare('SELECT COUNT(*) FROM card_refunds').pluck().get());
    assert.equal(db.prepare("SELECT date_approx FROM card_refunds WHERE order_id = 'BUH-OLD2'").pluck().get(), 1);
  } finally {
    db.close();
  }
  fs.rmSync(target, { recursive: true, force: true });
});

// ── Every expense ───────────────────────────────────────────────────────────

test('more than 2,000 expenses in a period: every one is in the totals and in the ZIP', async () => {
  const insert = getDb().prepare("INSERT INTO expenses (id, spent_on, amount_fils, category_id, payee, method, note, version, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, 'Bulk', ?, '', 1, ?, 'owner', ?, 'owner')");
  const N = 2_150;
  getDb().transaction(() => {
    for (let i = 0; i < N; i++) {
      const at = new Date(Date.parse('2025-05-01T08:00:00Z') + i * 60_000).toISOString();
      insert.run(`EXP-250501-B${String(i).padStart(5, '0')}`, `2025-05-${String(1 + (i % 28)).padStart(2, '0')}`, 100 + (i % 7), i % 3 ? 'packaging' : 'rent', i % 2 ? 'cash' : 'card', at, at);
    }
  })();
  let fils = 0;
  for (let i = 0; i < N; i++) fils += 100 + (i % 7);
  const r = reports.buildReport('2025-05-01', '2025-05-31');
  assert.equal(r.expenses.count, N);
  assert.equal(r.expenses.fils, fils);
  assert.equal(r.expenses.byCategory.reduce((n, c) => n + c.count, 0), N);
  assert.equal(Object.values(r.expenses.byMethod).reduce((n, m) => n + m.count, 0), N);
  const result = await reports.writeAccountantZip('2025-05-01', '2025-05-31');
  assert.equal(result.expenses, N);
  const zip = readZip(fs.readFileSync(result.file));
  fs.rmSync(result.file);
  const rows = zip.get('expenses.csv')!.toString('utf8').trim().split('\r\n');
  assert.equal(rows.length, N + 1);
  assert.equal(new Set(rows.slice(1).map((l) => l.split(',')[0])).size, N, 'each once');
  assert.ok(zip.get('summary.csv')!.toString().includes(`Expenses,Total expenses,${N},`));
});

// ── The ZIP: not blocking, disk-guarded, one at a time, failures audited ────

test('the ZIP is made without holding up the shop: other work runs while it is built', async () => {
  const e = ex.createExpense({ date: '2025-05-02', amount: '9', categoryId: 'other', method: 'cash' }, OWNER, `k-${Date.now()}`).expense;
  ex.attachBill(e.id, `data:application/pdf;base64,${Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024, 0x20)]).toString('base64')}`, 'big.pdf', OWNER);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    const result = await reports.writeAccountantZip('2025-05-01', '2025-05-31');
    fs.rmSync(result.file);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'the event loop turned while the ZIP was made');
});

test('the ZIP is refused (507) when the disk would be left too full, and a failed export is in the audit log', async () => {
  const before = reports.EXPORT_LIMITS.minFreeBytes;
  reports.EXPORT_LIMITS.minFreeBytes = Number.MAX_SAFE_INTEGER;
  try {
    assert.equal(await status(() => reports.writeAccountantZip('2025-05-01', '2025-05-31')), 507);
    assert.equal(await status(() => reports.prepareAccountantExport(OWNER, '2025-05-01', '2025-05-31')), 507);
  } finally {
    reports.EXPORT_LIMITS.minFreeBytes = before;
  }
  const lines = auditLines();
  const i = lines.findLastIndex((x) => x.action === 'report.exported' && x.details.from === '2025-05-01');
  assert.ok(i >= 0);
  assert.equal(lines[i + 1]?.action, 'report.export_failed');
  assert.match(String(lines[i + 1].details.error), /disk/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'exports')), [], 'no half-made file left');
  // And the lock is free again.
  takeExportLock()();
});

test('one export at a time: a second one while the first is prepared is told to wait (429)', async () => {
  const release = takeExportLock();
  try {
    assert.equal(await status(() => reports.prepareAccountantExport(OWNER, '2025-05-01', '2025-05-31')), 429);
    const { auditExportStream } = await import('@/lib/server/auditView');
    assert.equal(await status(() => auditExportStream(OWNER, 'csv', {})), 429);
  } finally {
    release();
  }
  const ok = await reports.prepareAccountantExport(OWNER, '2025-05-01', '2025-05-31');
  assert.equal(await status(() => takeExportLock()), 429, 'held until the download is done');
  ok.release();
  fs.rmSync(ok.file);
  takeExportLock()();
});

// ── Bills ───────────────────────────────────────────────────────────────────

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
const newExpense = () => ex.createExpense({ date: '2026-10-01', amount: '5', categoryId: 'other', method: 'cash' }, OWNER, `k-${Math.random()}`).expense;

test('the same bill sent twice (a retry after a lost answer) is one bill', () => {
  const e = newExpense();
  const a = ex.attachBill(e.id, dataUrl('image/png', PNG), 'a.png', OWNER);
  const b = ex.attachBill(e.id, dataUrl('image/png', PNG), 'again.png', OWNER);
  assert.equal(b.id, a.id);
  assert.equal(ex.getExpense(e.id)!.bills.length, 1);
  assert.equal(auditLines().filter((x) => x.action === 'expense.bill_added' && x.details.expenseId === e.id).length, 1);
  // Taken off, the same photo can be attached again (a new bill).
  ex.removeBill(e.id, a.id, 'wrong', OWNER);
  assert.notEqual(ex.attachBill(e.id, dataUrl('image/png', PNG), 'a.png', OWNER).id, a.id);
});

test('a bill is served as the type its kind has, never what the database says; an unknown kind is not served', () => {
  const e = newExpense();
  const bill = ex.attachBill(e.id, dataUrl('image/png', PNG), 'b.png', OWNER);
  getDb().prepare('UPDATE expense_bills SET mime = ? WHERE id = ?').run('text/html', bill.id);
  assert.equal(ex.readBill(e.id, bill.id)!.mime, 'image/png');
  assert.equal(ex.getExpense(e.id)!.bills[0].mime, 'image/png');
  fs.copyFileSync(path.join(dir, 'expenses', `${bill.id}.png`), path.join(dir, 'expenses', `${bill.id}.html`));
  getDb().prepare('UPDATE expense_bills SET ext = ? WHERE id = ?').run('html', bill.id);
  assert.equal(ex.readBill(e.id, bill.id), null);
  assert.throws(() => ex.billFile({ id: bill.id, ext: 'html' }), /Not a bill/);
  assert.throws(() => ex.billFile({ id: '../shop', ext: 'db' }), /Not a bill/);
  getDb().prepare('UPDATE expense_bills SET ext = ? WHERE id = ?').run('png', bill.id);
  fs.rmSync(path.join(dir, 'expenses', `${bill.id}.html`));
});

test('a restore refuses a backup whose bill rows name a kind of file that is not a bill', async () => {
  const e = newExpense();
  const bill = ex.attachBill(e.id, dataUrl('application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40, 0x20)])), 'b.pdf', OWNER);
  getDb().prepare('UPDATE expense_bills SET ext = ? WHERE id = ?').run('svg', bill.id);
  try {
    const b = await backup.createBackup();
    const target = path.join(os.tmpdir(), `buh-restore-badbill-${Date.now()}`);
    let failed = '';
    try {
      execFileSync(process.execPath, ['scripts/restore-backup.mjs', b.file, target], { stdio: 'pipe' });
    } catch (err) {
      failed = String((err as { stderr?: Buffer }).stderr);
    }
    assert.match(failed, /not a photo or PDF/);
    assert.ok(!fs.existsSync(target) || fs.readdirSync(target).length === 0, 'nothing left behind');
  } finally {
    getDb().prepare('UPDATE expense_bills SET ext = ? WHERE id = ?').run('pdf', bill.id);
  }
});

test('a bill whose file can\'t be put in place is not added (no row without its file)', () => {
  const e = newExpense();
  const spy = mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('EIO: rename failed'), { code: 'EIO' });
  });
  try {
    assert.throws(() => ex.attachBill(e.id, dataUrl('image/png', PNG), 'b.png', OWNER), /rename failed/);
  } finally {
    spy.mock.restore();
  }
  assert.equal(ex.getExpense(e.id)!.bills.length, 0, 'no row');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'expenses')).filter((f) => f.endsWith('.tmp')), [], 'no leftover');
  const lines = auditLines();
  const added = lines.findLastIndex((x) => x.action === 'expense.bill_added' && x.details.expenseId === e.id);
  assert.ok(added >= 0 && lines[added + 1].action === 'audit.rolled_back', 'the log says it did not count');
  assert.equal(ex.attachBill(e.id, dataUrl('image/png', PNG), 'b.png', OWNER).expenseId, e.id, 'works again');
});

test('JPEG: the extra pictures (APP2 MPF) and anything after the end of the image go; the colour profile stays', () => {
  const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const icc = seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01profile-bytes', 'latin1'));
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    icc,
    seg(0xe2, Buffer.from('MPF\0MM\0*second-picture-at-offset', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56]),
    // A second scan (progressive), with a comment between.
    seg(0xfe, Buffer.from('between scans', 'latin1')),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x78]),
    Buffer.from([0xff, 0xd9]),
    // Hidden after the end: a whole second JPEG with GPS.
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=25.2', 'latin1')),
    Buffer.from([0xff, 0xd9]),
  ]);
  const out = ex.stripImageMetadata(jpeg, 'jpg');
  assert.ok(!out.includes(Buffer.from('MPF\0')), 'MPF gone');
  assert.ok(!out.includes(Buffer.from('GPSLatitude')), 'the hidden picture after the end is gone');
  assert.ok(!out.includes(Buffer.from('between scans')), 'comments between scans go');
  assert.ok(out.includes(icc), 'the colour profile stays');
  assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9], 'ends at the end of the image');
  assert.ok(out.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56])) && out.includes(Buffer.from([0x78, 0xff, 0xd9])), 'the picture itself is untouched');
});

test('category and bill names are normalised (NFKC, no invisible characters, single spaces) and compared normalised', () => {
  const a = ex.addCategory('Photo  shoots', OWNER);
  assert.equal(a.name, 'Photo shoots');
  for (const twin of ['ＰＨＯＴＯ shoots', 'Photo​ shoots', ' photo shoots ', 'Pho­to shoots']) assert.equal(ex.addCategory(twin, OWNER).id, a.id, JSON.stringify(twin));
  const e = newExpense();
  const bill = ex.attachBill(e.id, dataUrl('image/png', PNG), 'ｂｉｌｌ‮ gnp.exe  copy.png', OWNER);
  assert.equal(bill.name, 'bill gnp.exe copy.png');
});

test('a long expense note is in the audit log whole (up to 2,000 characters), still masked', () => {
  const note = `${'a'.repeat(960)} call +971 50 123 4567`;
  const longNote = `${'x'.repeat(900)} call +971 50 765 4321`;
  const e = ex.createExpense({ date: '2026-10-01', amount: '5', categoryId: 'other', method: 'cash', note }, OWNER, `k-${Math.random()}`).expense;
  ex.updateExpense(e.id, { version: 1, note: longNote }, OWNER);
  const edited = auditLines().filter((x) => x.action === 'expense.edited' && x.details.expenseId === e.id).pop()!;
  assert.equal(edited.details.before.note, `${'a'.repeat(960)} call +971***67`, 'whole, the phone masked');
  assert.equal(edited.details.after.note, `${'x'.repeat(900)} call +971***21`);
  assert.equal(edited.details.changes.note.to, edited.details.after.note);
  assert.ok(!JSON.stringify(edited).includes('123 4567') && !JSON.stringify(edited).includes('765 4321'));
  // Other fields keep the usual cap.
  assert.equal((logModule.redact({ other: 'y'.repeat(900) }) as { other: string }).other.length, 500);
});
