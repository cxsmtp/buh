/**
 * BUH-02.10: expenses with photos of the bills. Amounts are whole fils parsed from text (no float
 * drift); categories and payment methods come from an allow-list; every change keeps the earlier
 * version, "Remove" keeps the expense (who, when, why) and a bill taken off keeps its file; every
 * change is in the audit log before it counts (the log can't be written → nothing saved). Bills are
 * checked by their bytes (JPEG, PNG, WebP, HEIC, PDF; 10 MB), photos lose EXIF/GPS and text, the
 * disk and folder caps apply, and backups keep (and the restore brings back) expenses and bills.
 * The audit coverage added with it: order changes and product prices with before → after, audited
 * before they count, and a restore noted in the log.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const ex = await import('@/lib/server/expenses');
const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const backup = await import('@/lib/server/backup');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getDb } = await import('@/lib/server/db');
const { kvSet } = await import('@/lib/server/kv');

const OWNER = 'owner@shop.test';
const auditFile = () => path.join(dir, `audit-${new Date().toISOString().slice(0, 7)}.jsonl`);
const auditLines = () => (fs.existsSync(auditFile()) ? fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const status = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
/** Run fn while the audit log can't be written (its file is a folder), then put it back. */
function withoutAudit<T>(fn: () => T): T {
  const file = auditFile();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  fs.renameSync(file, `${file}.aside`);
  fs.mkdirSync(file);
  try {
    return fn();
  } finally {
    fs.rmdirSync(file);
    fs.renameSync(`${file}.aside`, file);
  }
}
let n = 0;
const key = () => `test-key-${++n}-${Date.now()}`;
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;

// Test files: a JPEG with EXIF (GPS), XMP and a comment; a PNG with text and EXIF chunks; a WebP
// with EXIF and XMP; a HEIC header; a PDF.
const seg = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
  seg(0xe1, Buffer.from('Exif\0\0GPSLatitude=25.2048;GPSLongitude=55.2708;Model=OwnerPhone', 'latin1')),
  seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS-XMP</x:xmpmeta>', 'latin1')),
  seg(0xfe, Buffer.from('secret comment', 'latin1')),
  seg(0xdb, Buffer.alloc(65, 1)),
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78]),
  Buffer.from([0xff, 0xd9]),
]);
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
};
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG = Buffer.concat([PNG_1PX.subarray(0, 33), chunk('tEXt', Buffer.from('Comment\0GPS 25.2048 55.2708', 'latin1')), chunk('eXIf', Buffer.from('MM\0*GPS', 'latin1')), PNG_1PX.subarray(33)]);
const riff = (fourcc: string, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, 'latin1');
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const webpBody = Buffer.concat([riff('VP8X', Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), riff('VP8 ', Buffer.alloc(20, 7)), riff('EXIF', Buffer.from('GPS 25.2048', 'latin1')), riff('XMP ', Buffer.from('<x>GPS</x>', 'latin1'))]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from(Uint32Array.of(webpBody.length + 4).buffer), Buffer.from('WEBP', 'latin1'), webpBody]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'), Buffer.alloc(64, 3)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);

function newExpense(over: Record<string, unknown> = {}) {
  return ex.createExpense({ date: '2026-09-03', amount: '125.50', categoryId: 'packaging', method: 'cash', payee: 'Al Noor Packaging', ...over }, OWNER, key()).expense;
}

test('amounts are whole fils read from the text: no float drift, at most 2 decimals, never zero or negative', () => {
  assert.equal(ex.parseAmountFils('0.10') + ex.parseAmountFils('0.2'), 30, '0.1 + 0.2 is exactly 0.30');
  assert.equal(ex.parseAmountFils(0.1 + 0.2), 30, 'the float 0.30000000000000004 is 30 fils');
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += ex.parseAmountFils('0.10');
  assert.equal(sum, 10_000, 'a thousand 0.10s are 100.00');
  assert.equal(ex.parseAmountFils('1,250.5'), 125_050);
  assert.equal(ex.parseAmountFils('99.99'), 9_999);
  assert.equal(ex.parseAmountFils(' 7 '), 700);
  for (const bad of ['12.345', '-5', '0', '0.00', 'abc', '1e3', '', null, undefined, {}, Number.NaN, Infinity, 12.345, -1, '100000001']) {
    assert.equal(status(() => ex.parseAmountFils(bad)), 400, String(bad));
  }
  const e = newExpense({ amount: '0.30' });
  assert.equal(e.amountFils, 30);
  assert.equal(getDb().prepare('SELECT typeof(amount_fils) FROM expenses WHERE id = ?').pluck().get(e.id), 'integer', 'stored as an integer');
});

test('categories and payment methods come from the allow-list; the owner can add a category (kept on the server)', () => {
  const names = ex.listCategories().map((c) => c.name);
  assert.deepEqual(names, ['Stock & fabric', 'Packaging', 'Courier & delivery', 'Marketing & ads', 'Rent', 'Utilities', 'Software & fees', 'Bank & card charges', 'Other']);
  assert.equal(status(() => newExpense({ categoryId: 'holiday' })), 400, 'unknown category');
  assert.equal(status(() => newExpense({ categoryId: "packaging' OR 1=1" })), 400);
  assert.equal(status(() => newExpense({ method: 'crypto' })), 400, 'unknown method');
  assert.equal(status(() => newExpense({ date: '2026-02-30' })), 400, 'not a real date');
  assert.equal(status(() => newExpense({ date: '2099-01-01' })), 400, 'in the future');
  assert.equal(status(() => newExpense({ payee: 'x'.repeat(121) })), 400);
  const added = ex.addCategory('Photography', OWNER);
  assert.equal(ex.addCategory('photography', OWNER).id, added.id, 'the same name (any case) is the same category');
  assert.equal(status(() => ex.addCategory('', OWNER)), 400);
  assert.equal(newExpense({ categoryId: added.id }).category, 'Photography');
  assert.ok(auditLines().some((e) => e.action === 'expense.category_added' && e.details.categoryId === added.id && e.details.by === OWNER));
});

test('one key makes one expense: a double tap or a retry returns the first', () => {
  const k = key();
  const a = ex.createExpense({ date: '2026-09-04', amount: '10', categoryId: 'other', method: 'card' }, OWNER, k);
  const b = ex.createExpense({ date: '2026-09-04', amount: '10', categoryId: 'other', method: 'card' }, OWNER, k);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.expense.id, a.expense.id);
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM expenses WHERE idempotency_key = ?').pluck().get(k), 1);
});

test('an edit keeps the earlier version, needs the version seen, and is audited with before → after', () => {
  const e = newExpense();
  const edited = ex.updateExpense(e.id, { version: 1, amount: '130', note: 'corrected total' }, 'other@shop.test');
  assert.equal(edited.version, 2);
  assert.equal(edited.amountFils, 13_000);
  assert.equal(edited.updatedBy, 'other@shop.test');
  const versions = ex.expenseVersions(e.id);
  assert.deepEqual(versions.map((v) => [v.version, v.change, v.data.amountFils]), [[1, 'created', 12_550], [2, 'edited', 13_000]]);
  assert.equal(status(() => ex.updateExpense(e.id, { version: 1, amount: '1' }, OWNER)), 409, 'a stale version is refused');
  assert.equal(status(() => ex.updateExpense(e.id, { amount: '1' }, OWNER)), 400, 'the version is required');
  const entry = auditLines().find((x) => x.action === 'expense.edited' && x.details.expenseId === e.id)!;
  assert.deepEqual(entry.details.changes, { amountFils: { from: 12_550, to: 13_000 }, note: { from: '', to: 'corrected total' } });
  assert.equal(entry.details.before.amountFils, 12_550);
  assert.equal(entry.details.after.amountFils, 13_000);
  assert.equal(entry.details.after.date, '2026-09-03', 'a date is kept as it is (it is not a phone number)');
  assert.equal(entry.details.by, 'other@shop.test');
});

test('"Remove" is soft: out of the list and totals, kept with who, when and why; never deleted', () => {
  const e = newExpense({ amount: '999' });
  assert.equal(status(() => ex.removeExpense(e.id, '', OWNER)), 400, 'a reason is needed');
  const removed = ex.removeExpense(e.id, 'Entered twice', OWNER);
  assert.equal(removed.removed?.why, 'Entered twice');
  assert.equal(removed.removed?.by, OWNER);
  assert.ok(!ex.listExpenses({ from: '2026-09-01', to: '2026-09-30' }).some((x) => x.id === e.id), 'not in the list');
  assert.ok(ex.listExpenses({ from: '2026-09-01', to: '2026-09-30', includeRemoved: true }).some((x) => x.id === e.id), 'still there');
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM expenses WHERE id = ?').pluck().get(e.id), 1);
  assert.deepEqual(ex.expenseVersions(e.id).map((v) => v.change), ['created', 'removed']);
  assert.equal(status(() => ex.updateExpense(e.id, { version: removed.version, amount: '1' }, OWNER)), 409, 'a removed expense is not changed');
  assert.equal(ex.removeExpense(e.id, 'again', OWNER).removed?.why, 'Entered twice', 'removing twice changes nothing');
  assert.ok(auditLines().some((x) => x.action === 'expense.removed' && x.details.expenseId === e.id && x.details.why === 'Entered twice' && x.details.before.amountFils === 99_900));
});

test('the audit log can\'t be written: nothing is saved (a new expense, an edit, a removal, a bill, a category)', () => {
  const before = getDb().prepare('SELECT COUNT(*) FROM expenses').pluck().get();
  assert.equal(withoutAudit(() => status(() => newExpense())), 503);
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM expenses').pluck().get(), before, 'no expense');
  const e = newExpense();
  assert.equal(withoutAudit(() => status(() => ex.updateExpense(e.id, { version: 1, amount: '1' }, OWNER))), 503);
  assert.equal(ex.getExpense(e.id)!.amountFils, 12_550, 'the edit is not saved');
  assert.equal(ex.expenseVersions(e.id).length, 1);
  assert.equal(withoutAudit(() => status(() => ex.removeExpense(e.id, 'x', OWNER))), 503);
  assert.equal(ex.getExpense(e.id)!.removed, undefined, 'not removed');
  const files = fs.existsSync(path.join(dir, 'expenses')) ? fs.readdirSync(path.join(dir, 'expenses')).length : 0;
  assert.equal(withoutAudit(() => status(() => ex.attachBill(e.id, dataUrl('image/png', PNG_1PX), 'bill.png', OWNER))), 503);
  assert.equal(ex.getExpense(e.id)!.bills.length, 0, 'no bill row');
  assert.equal(fs.readdirSync(path.join(dir, 'expenses')).length, files, 'no file left behind');
  assert.equal(withoutAudit(() => status(() => ex.addCategory('Never saved', OWNER))), 503);
  assert.ok(!ex.listCategories().some((c) => c.name === 'Never saved'));
  // And it works once the log can be written.
  assert.equal(ex.updateExpense(e.id, { version: 1, amount: '1' }, OWNER).amountFils, 100);
});

test('bills are checked by their bytes: JPEG, PNG, WebP, HEIC and PDF; anything else (or a disguise) is refused', () => {
  assert.deepEqual(ex.sniffBill(JPEG), { ext: 'jpg', mime: 'image/jpeg' });
  assert.deepEqual(ex.sniffBill(PNG), { ext: 'png', mime: 'image/png' });
  assert.deepEqual(ex.sniffBill(WEBP), { ext: 'webp', mime: 'image/webp' });
  assert.deepEqual(ex.sniffBill(HEIC), { ext: 'heic', mime: 'image/heic' });
  assert.deepEqual(ex.sniffBill(PDF), { ext: 'pdf', mime: 'application/pdf' });
  const e = newExpense();
  for (const [label, file] of [
    ['an SVG', dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))],
    ['HTML called a PNG', dataUrl('image/png', Buffer.from('<html><script>alert(1)</script></html>'))],
    ['an EXE called a PDF', dataUrl('application/pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]))],
    ['not a data URL', 'https://example.com/bill.jpg'],
    ['nothing', ''],
  ] as const) {
    assert.equal(status(() => ex.attachBill(e.id, file, 'x', OWNER)), 400, label);
  }
  // A PNG sent with the wrong label is stored as what it really is.
  const bill = ex.attachBill(e.id, dataUrl('image/jpeg', PNG_1PX), 'receipt.jpg', OWNER);
  assert.equal(bill.ext, 'png');
  assert.equal(bill.mime, 'image/png');
});

test('bills: 10 MB at most each (413)', () => {
  const e = newExpense();
  const big = Buffer.concat([PDF, Buffer.alloc(ex.BILL_LIMITS.fileBytes)]);
  assert.equal(status(() => ex.attachBill(e.id, dataUrl('application/pdf', big), 'big.pdf', OWNER)), 413);
  const fits = Buffer.concat([PDF, Buffer.alloc(ex.BILL_LIMITS.fileBytes - PDF.length)]);
  assert.equal(ex.attachBill(e.id, dataUrl('application/pdf', fits), 'fits.pdf', OWNER).size, ex.BILL_LIMITS.fileBytes);
});

test('photos lose their metadata (EXIF with GPS, XMP, comments, text chunks); the pixels stay; HEIC and PDF are kept as they are', () => {
  const e = newExpense();
  const read = (b: { id: string }) => ex.readBill(e.id, b.id)!.bytes;
  const jpg = read(ex.attachBill(e.id, dataUrl('image/jpeg', JPEG), 'bill.jpg', OWNER));
  for (const gone of ['Exif', 'GPSLatitude', '25.2048', 'xmpmeta', 'secret comment', 'OwnerPhone']) assert.ok(!jpg.includes(gone), `JPEG: ${gone} removed`);
  assert.ok(jpg.includes(Buffer.from('JFIF')), 'JFIF kept');
  assert.deepEqual(jpg.subarray(-8), JPEG.subarray(-8), 'the image data is untouched');
  assert.equal(ex.sniffBill(jpg)?.ext, 'jpg');
  const png = read(ex.attachBill(e.id, dataUrl('image/png', PNG), 'bill.png', OWNER));
  assert.deepEqual(png, PNG_1PX, 'PNG: the text and EXIF chunks removed, nothing else');
  const webp = read(ex.attachBill(e.id, dataUrl('image/webp', WEBP), 'bill.webp', OWNER));
  assert.ok(!webp.includes('EXIF') && !webp.includes('XMP ') && !webp.includes('GPS'), 'WebP: EXIF and XMP chunks removed');
  assert.equal(webp.readUInt32LE(4), webp.length - 8, 'the RIFF size is right');
  assert.equal(webp[20] & 0x0c, 0, 'VP8X says no EXIF, no XMP');
  const heic = ex.attachBill(e.id, dataUrl('image/heic', HEIC), 'IMG_0001.HEIC', OWNER);
  assert.equal(heic.mime, 'image/heic');
  assert.deepEqual(read(heic), HEIC);
  // An unknown type from the browser ("") is fine: the bytes decide.
  assert.equal(ex.attachBill(e.id, `data:;base64,${PDF.toString('base64')}`, 'scan.pdf', OWNER).mime, 'application/pdf');
  // A damaged JPEG is refused, not stored half-read.
  assert.equal(status(() => ex.attachBill(e.id, dataUrl('image/jpeg', JPEG.subarray(0, 40)), 'cut.jpg', OWNER)), 400);
});

test('bills are stored privately under random names, kept when taken off, and audited', () => {
  const e = newExpense();
  const bill = ex.attachBill(e.id, dataUrl('image/png', PNG_1PX), '../../etc/passwd', OWNER);
  assert.match(bill.id, /^[a-f0-9]{24}$/);
  const file = path.join(dir, 'expenses', `${bill.id}.png`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(bill.name, '.._.._etc_passwd', 'the original name is only a label');
  assert.ok(!fs.readdirSync(path.join(dir, 'expenses')).some((f) => f.endsWith('.tmp')));
  const added = auditLines().find((x) => x.action === 'expense.bill_added' && x.details.billId === bill.id)!;
  assert.equal(added.details.sha256, bill.sha256);
  assert.equal(status(() => ex.removeBill(e.id, bill.id, '', OWNER)), 400, 'a reason is needed');
  const off = ex.removeBill(e.id, bill.id, 'Wrong photo', OWNER);
  assert.equal(off.removed?.why, 'Wrong photo');
  assert.ok(fs.existsSync(file), 'the file is kept');
  assert.ok(ex.readBill(e.id, bill.id), 'and still readable from the hub');
  assert.equal(ex.readBill('EXP-OTHER-XXXXXX', bill.id), null, 'only through its own expense');
  assert.equal(ex.readBill(e.id, '../shop.db'), null);
  assert.ok(auditLines().some((x) => x.action === 'expense.bill_removed' && x.details.billId === bill.id));
});

test('bills: refused (507) when the disk is nearly full or the bills folder is at its cap, like the transfer screenshots', () => {
  const e = newExpense();
  const saved = { ...ex.BILL_LIMITS };
  try {
    ex.BILL_LIMITS.minFreeBytes = Number.MAX_SAFE_INTEGER;
    assert.equal(status(() => ex.attachBill(e.id, dataUrl('image/png', PNG_1PX), 'a.png', OWNER)), 507, 'disk');
    ex.BILL_LIMITS.minFreeBytes = 0;
    ex.BILL_LIMITS.folderBytes = 10;
    assert.equal(status(() => ex.attachBill(e.id, dataUrl('image/png', PNG_1PX), 'a.png', OWNER)), 507, 'folder');
  } finally {
    Object.assign(ex.BILL_LIMITS, saved);
  }
  assert.equal(ex.getExpense(e.id)!.bills.length, 0);
  // The receipts guard is the same code.
  assert.match(fs.readFileSync('src/lib/server/orders.ts', 'utf8'), /folderRoomProblem\(receiptsDir\(\), incoming, RECEIPT_LIMITS, 'receipts'\)/);
});

// ── Audit coverage ──────────────────────────────────────────────────────────

function placeCod(phone = `+9715077${String(++n).padStart(5, '0')}`) {
  const p = products.listProducts()[0];
  return orders.placeOrder({
    idempotencyKey: key(),
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Audit Test', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
  }).order;
}

test('an order change (status, cash collected, notes) is audited with before → after, before it counts', () => {
  const o = placeCod();
  orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, OWNER);
  orders.updateOrderByAdmin(o.id, { paymentStatus: 'paid', adminNotes: 'cash collected' }, OWNER);
  const entries = auditLines().filter((x) => x.action === 'order.updated' && x.details.orderId === o.id);
  assert.deepEqual(entries[0].details.status, { from: 'pending_confirmation', to: 'confirmed' });
  assert.deepEqual(entries[1].details.paymentStatus, { from: 'cod_pending', to: 'paid' });
  assert.deepEqual(entries[1].details.adminNotes, { from: '', to: 'cash collected' });
  assert.equal(entries[1].details.amountFils, Math.round(o.total * 100));
  assert.equal(entries[1].details.by, OWNER);
  // Without the log: refused, and the order is as it was.
  const p = placeCod();
  assert.equal(withoutAudit(() => status(() => orders.updateOrderByAdmin(p.id, { status: 'cancelled' }, OWNER))), 503);
  assert.equal(orders.getOrder(p.id)!.status, 'pending_confirmation', 'not cancelled');
  // The route no longer writes its own after-the-fact entry.
  assert.doesNotMatch(fs.readFileSync('src/app/api/admin/orders/[id]/route.ts', 'utf8'), /audit\('order\.updated', \{ by: session\.email, orderId: id, fields: Object\.keys\(body\)/);
});

test('a price change is audited with before → after, before it counts', () => {
  const p = products.listProducts()[0];
  products.updateProduct(p.id, { price: p.price + 10 }, OWNER);
  const entry = auditLines().filter((x) => x.action === 'product.updated' && x.details.productId === p.id).pop()!;
  assert.deepEqual(entry.details.changes.price, { from: p.price, to: p.price + 10 });
  assert.equal(entry.details.by, OWNER);
  assert.equal(withoutAudit(() => status(() => products.updateProduct(p.id, { price: p.price + 99 }, OWNER))), 503);
  assert.equal(products.getProduct(p.id)!.price, p.price + 10, 'the price is not changed');
});

test('a restore is written to the audit log once, on the first start after it', () => {
  kvSet('admin:restored', { at: '2026-10-01T10:00:00.000Z', backup: 'buh-backup-20261001-0800.tar.gz' });
  assert.equal(backup.auditRestoreOnce(), true);
  assert.equal(backup.auditRestoreOnce(), false, 'once');
  const entry = auditLines().find((x) => x.action === 'backup.restored')!;
  assert.equal(entry.details.backup, 'buh-backup-20261001-0800.tar.gz');
  getDb().prepare("DELETE FROM kv WHERE key = 'admin:restored'").run();
});

// ── Backups ─────────────────────────────────────────────────────────────────

test('backups keep the expenses (every version, removed ones too) and every bill; the restore brings them back', async () => {
  const e = newExpense({ payee: '=HYPERLINK("http://x")', amount: '42.42' });
  ex.updateExpense(e.id, { version: 1, note: 'second version' }, OWNER);
  const bill = ex.attachBill(e.id, dataUrl('image/png', PNG_1PX), 'b.png', OWNER);
  const old = ex.attachBill(e.id, dataUrl('application/pdf', PDF), 'old.pdf', OWNER);
  ex.removeBill(e.id, old.id, 'replaced', OWNER);
  const gone = newExpense({ amount: '5' });
  ex.removeExpense(gone.id, 'mistake', OWNER);

  const result = await backup.createBackup();
  assert.match(result.summary, /\d+ expenses, \d+ bills/);
  const entries = backup.openBackup(fs.readFileSync(result.file));
  const names = entries.map((x) => x.name);
  assert.ok(names.includes(`expenses/${bill.id}.png`) && names.includes(`expenses/${old.id}.pdf`), 'both bills, the one taken off too');
  const csv = entries.find((x) => x.name === 'expenses.csv')!.data.toString('utf8');
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`), 'formula-safe');
  assert.ok(csv.includes('42.42'));
  assert.match(csv, new RegExp(`${gone.id},.*,removed,`));
  assert.ok(entries.find((x) => x.name === 'expense_bills.csv')!.data.toString().includes(old.id));
  // The orders CSV is unchanged by this release.
  assert.match(entries.find((x) => x.name === 'orders.csv')!.data.toString(), /^\ufefforder_id,created_at,status,payment_method,/);

  const target = path.join(os.tmpdir(), `buh-restore-expenses-${Date.now()}`);
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /\d+ expenses, \d+ bills\. Integrity check: ok/);
  assert.doesNotMatch(out, /missing/);
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT amount_fils FROM expenses WHERE id = ?').pluck().get(e.id), 4242);
    assert.equal(db.prepare('SELECT COUNT(*) FROM expense_versions WHERE expense_id = ?').pluck().get(e.id), 2);
    assert.equal(db.prepare('SELECT removed_why FROM expenses WHERE id = ?').pluck().get(gone.id), 'mistake');
    assert.equal(db.prepare('SELECT COUNT(*) FROM expense_categories').pluck().get(), ex.listCategories().length);
  } finally {
    db.close();
  }
  assert.deepEqual(fs.readFileSync(path.join(target, 'expenses', `${bill.id}.png`)), ex.readBill(e.id, bill.id)!.bytes);
  assert.deepEqual(fs.readFileSync(path.join(target, 'expenses', `${old.id}.pdf`)), PDF);
});

test('restore --replace keeps this server\'s audit key, so the restored audit log still checks out', async () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-live-'));
  fs.writeFileSync(path.join(live, 'shop.db'), 'old');
  fs.copyFileSync(path.join(dir, 'audit.key'), path.join(live, 'audit.key'));
  const result = await backup.createBackup();
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, live, '--replace']);
  assert.equal(fs.readFileSync(path.join(live, 'audit.key'), 'utf8'), fs.readFileSync(path.join(dir, 'audit.key'), 'utf8'));
  const check = execFileSync(process.execPath, ['--import', 'tsx', '-e', `process.env.DATA_DIR=${JSON.stringify(live)}; const m = await import('@/lib/server/audit'); console.log(JSON.stringify((m.verifyAllAuditLogs ?? m.default.verifyAllAuditLogs)()));`], { encoding: 'utf8' });
  const v = JSON.parse(check.trim().split('\n').pop()!);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.entries > 10);
});

test('migration 12 only adds (tables and an index) and seeds the categories', () => {
  const src = fs.readFileSync('src/lib/server/db.ts', 'utf8');
  const m12 = src.slice(src.indexOf('// 12: expenses'), src.indexOf('];', src.indexOf('// 12: expenses')));
  const sql = m12.slice(m12.indexOf('db.exec(`') + 9, m12.indexOf('`);'));
  const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  assert.ok(statements.length >= 6);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX|UNIQUE INDEX) /, s);
  assert.doesNotMatch(m12, /DROP|ALTER|DELETE|UPDATE /);
  assert.equal(getDb().pragma('user_version', { simple: true }), 13);
});
