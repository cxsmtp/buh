/**
 * Review of the bank transfer (BUH-02.09): uploads can't fill the disk (5 versions per order, a
 * cap on the receipts folder, a floor on free disk space, only while the order is open); the logs
 * and the audit keep order numbers (and, in the audit, who acted) readable while customer phones
 * and emails stay masked; start-up steps fail one by one, and the private-link rehash is retried;
 * bank orders an older version wrote after migration 10 get their state; the old "payment status"
 * route can't mark a bank transfer paid; files move only after the change is saved, and a failed
 * save leaves a "rolled back" note in the audit; customer emails are one plain address, links to
 * customers come only from the configured shop address, and names in emails can't carry a link.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { jsonRequest, tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
Object.assign(process.env, { BACKUP_DISABLED: 'true', MONITOR_DISABLED: 'true', CHAT_SWEEP_DISABLED: '1' });
const orders = await import('@/lib/server/orders');
const pay = await import('@/lib/server/bankPay');
const { emailBankDetails } = await import('@/lib/server/bankMail');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings } = await import('@/lib/server/settings');
const { getDb } = await import('@/lib/server/db');
const { kvSet } = await import('@/lib/server/kv');
const { redact, logEvent } = await import('@/lib/server/log');
const { audit } = await import('@/lib/server/audit');
const { currentProblems } = await import('@/lib/server/monitor');
const { createBackup } = await import('@/lib/server/backup');
const { bankUpkeepOnce, onStartup } = await import('@/lib/server/startup');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const messages = await import('@/lib/bankMessages');
const uploadRoute = await import('@/app/api/pay/[token]/route');

await updateSettings('bank', { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' });
await updateSettings('brand', { storeName: 'Beautiful UAE Home' });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG.split(',')[1], 'base64');
const receipts = path.join(dir, 'receipts');

let n = 0;
function place(over: Record<string, unknown> = {}, customer: Record<string, unknown> = {}) {
  const p = listProducts()[0];
  const phone = `+9715060${String(++n).padStart(5, '0')}`;
  return orders.placeOrder({
    idempotencyKey: `bank-review-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Aisha Test', email: 'aisha@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7', ...customer },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'bank_transfer',
    ...over,
  }).order;
}
const tokenOf = (o: { bankTransfer?: { payPath?: string } }) => o.bankTransfer!.payPath!.slice('/pay/'.length);
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const filesOf = (id: string) => fs.readdirSync(receipts).filter((f) => f.startsWith(`${id}.`)).sort();
const upload = (token: string, body: unknown) =>
  uploadRoute.POST(jsonRequest(body, { origin: 'http://shop.test' }, `http://shop.test/api/pay/${token}`), { params: Promise.resolve({ token }) });
async function captured<T>(fn: () => T | Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(saved) as Array<keyof typeof saved>) console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}
/** Make the next COMMIT that changes `column` of this order fail (a deferred foreign key it breaks). */
function failCommitOn(orderId: string, column: string): () => void {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS t_parent (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS t_child (parent TEXT REFERENCES t_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER t_fail AFTER UPDATE OF ${column} ON orders WHEN NEW.id = '${orderId}' BEGIN INSERT INTO t_child (parent) VALUES ('missing'); END;`);
  return () => db.exec('DROP TRIGGER t_fail;');
}

// ── 1. Uploads can't fill the disk ──────────────────────────────────────────

test('uploads: only the latest 5 screenshots of an order are kept; the hub links only those', () => {
  _clearAllRateLimits();
  const o = place();
  for (let i = 0; i < 7; i++) orders.uploadTransfer(o.id, PNG);
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.uploads, 7);
  assert.deepEqual(filesOf(o.id), [`${o.id}.png`, `${o.id}.v3.png`, `${o.id}.v4.png`, `${o.id}.v5.png`, `${o.id}.v6.png`]);
  assert.equal(orders.readReceipt(o.id, 2), null, 'the oldest are deleted');
  assert.ok(orders.readReceipt(o.id, 3));
  assert.ok(orders.readReceipt(o.id));
});

test('uploads: refused politely (WhatsApp instead) when the receipts folder is full or the disk is low; the owner is told', async () => {
  _clearAllRateLimits();
  const saved = { ...orders.RECEIPT_LIMITS };
  const o = place();
  const before = filesOf(o.id);
  try {
    orders.RECEIPT_LIMITS.folderBytes = 1; // the folder already holds more
    const res = await upload(tokenOf(o), { file: PNG });
    assert.equal(res.status, 507);
    const body = await res.json();
    assert.match(body.message, /send the screenshot on WhatsApp instead/);
    assert.equal(orders.getOrder(o.id)!.bankTransfer!.uploads, 0, 'nothing saved');
    assert.deepEqual(filesOf(o.id), before);
    assert.ok(!fs.readdirSync(receipts).some((f) => f.endsWith('.tmp')), 'no half-written file left');
    assert.match(orders.receiptsNoRoom()!.why, /receipts folder/);
    assert.ok(currentProblems().some((p) => p.id === 'receipts'), 'Settings → System says so');

    orders.RECEIPT_LIMITS.folderBytes = saved.folderBytes;
    orders.RECEIPT_LIMITS.minFreeBytes = Number.MAX_SAFE_INTEGER; // "less than this free on the disk"
    assert.equal(await status(() => orders.uploadTransfer(o.id, PNG)), 507);
    assert.match(orders.receiptsNoRoom()!.why, /disk has only/);
    // A screenshot sent with a checkout from an older page: the order still goes through, without it.
    const legacy = place({ receipt: PNG });
    assert.equal(legacy.bankTransfer!.uploads, 0);
    assert.deepEqual(filesOf(legacy.id), []);
  } finally {
    Object.assign(orders.RECEIPT_LIMITS, saved);
  }
  assert.equal(orders.uploadTransfer(o.id, PNG).bankTransfer!.uploads, 1, 'with room again, it works');
});

test('uploads: only while the order is open for payment (its link dies once paid or cancelled)', async () => {
  _clearAllRateLimits();
  const paid = place();
  orders.checkBankTransfer(paid.id, 'received', 'owner@shop.test');
  assert.equal((await upload(tokenOf(paid), { file: PNG })).status, 404);
  const cancelled = place();
  orders.updateOrderByAdmin(cancelled.id, { status: 'cancelled' }, 'owner@shop.test');
  assert.equal((await upload(tokenOf(cancelled), { file: PNG })).status, 404);
  assert.equal(await status(() => orders.uploadTransfer(cancelled.id, PNG)), 409, 'checked again inside too');
  const open = place();
  assert.equal((await upload(tokenOf(open), { file: PNG })).status, 200);
});

// ── 2. Masking keeps order numbers and the acting admin ──────────────────────

test('logs: phones are masked, order numbers and dates are not', () => {
  for (const phone of ['+971 50 123 4567', '0501234567', '971501234567', 'call 050-123-4567']) {
    const out = String(redact(phone));
    assert.ok(!/1234567|123 4567|123-4567/.test(out), `${phone} → ${out}`);
    assert.match(out, /\*\*\*/);
  }
  for (const id of ['BUH-261018-123456', 'BUH-261018-54W44L', '2026-10-18T09:00:00.000Z']) assert.equal(redact(id), id);
  assert.equal(redact('order BUH-261018-123456 for +971501234567'), 'order BUH-261018-123456 for +971***67');
  const { lines } = { lines: [] as string[] };
  const savedLog = console.log;
  console.log = (l: string) => void lines.push(l);
  try {
    logEvent('info', 'x', { orderId: 'BUH-261018-123456', phone: '+971501234567' });
  } finally {
    console.log = savedLog;
  }
  assert.match(lines[0], /"orderId":"BUH-261018-123456"/);
  assert.match(lines[0], /"phone":"\+971\*\*\*67"/);
});

test('audit: the order number and who acted are exact; customer phones and emails in free text stay masked', () => {
  const start = auditEntries().length;
  assert.ok(audit('test.review', { by: 'owner@shop.test', orderId: 'BUH-261018-123456', note: 'customer +971 50 123 4567, aisha@example.com' }));
  assert.ok(audit('test.review', { by: 'owner@shop.test', orderId: 'BUH-261018-54W44L' }));
  const [a, b] = auditEntries().slice(start);
  assert.equal(a.details.orderId, 'BUH-261018-123456');
  assert.equal(a.details.by, 'owner@shop.test');
  assert.equal(a.details.note, 'customer +971***67, a***@example.com');
  assert.equal(b.details.orderId, 'BUH-261018-54W44L');
});

// ── 3. Start-up steps fail one by one; the rehash is retried ────────────────

test('start-up: a busy database during the rehash is logged and retried, and the other steps still run', async () => {
  const o = place();
  kvSet('pay:key', 'another-server'); // as after a restore onto another server
  getDb().prepare('UPDATE orders SET pay_token_hash = ? WHERE id = ?').run('stale', o.id);
  getDb().pragma('busy_timeout = 50');
  const other = new Database(path.join(dir, 'shop.db'));
  other.exec('BEGIN IMMEDIATE'); // another copy of the shop holds the write lock (an update)
  try {
    const { lines } = await captured(() => onStartup());
    const text = lines.join('\n');
    assert.match(text, /pay_links_rehash_failed/);
    assert.doesNotMatch(text, /startup_failed/, 'not one failure for every step');
    assert.equal(bankUpkeepOnce(), false);
  } finally {
    other.exec('ROLLBACK');
    other.close();
    getDb().pragma('busy_timeout = 5000');
  }
  assert.equal(pay.openPayOrderId(tokenOf(orders.getOrder(o.id)!)), null, 'not rehashed yet');
  assert.equal(bankUpkeepOnce(), true, 'the next round (every minute) works');
  assert.equal(pay.openPayOrderId(tokenOf(orders.getOrder(o.id)!)), o.id);
});

// ── 4. Bank orders an older version wrote after migration 10 ────────────────

test('bank orders written by an older version after migration 10 get their state (read, start-up, every minute)', () => {
  const asOld = (id: string, paymentStatus: string, receipt: boolean) =>
    getDb()
      .prepare(
        `UPDATE orders SET bank_state = 'none', transfer_uploads = 0, transfer_uploaded_at = NULL, pay_nonce = NULL, pay_token_hash = NULL, pay_expires_at = NULL, payment_status = ?,
          data = json_set(data, '$.paymentStatus', ?, '$.paymentReceiptUrl', ?) WHERE id = ?`
      )
      .run(paymentStatus, paymentStatus, receipt ? `/api/admin/orders/${id}/receipt` : null, id);
  const toCheck = place();
  asOld(toCheck.id, 'receipt_uploaded', true);
  const waiting = place();
  asOld(waiting.id, 'pending', false);
  const paid = place();
  asOld(paid.id, 'verified', false);

  // Read as it would be once filled in.
  assert.deepEqual([orders.getOrder(toCheck.id)!.bankTransfer!.state, orders.getOrder(toCheck.id)!.bankTransfer!.uploads], ['uploaded', 1]);
  assert.equal(orders.getOrder(waiting.id)!.bankTransfer!.state, 'awaiting');
  assert.equal(orders.getOrder(paid.id)!.bankTransfer!.state, 'paid');
  const counted = orders.transfersToCheckCount();
  assert.ok(orders.normalizeBankStates() >= 3);
  assert.equal(orders.normalizeBankStates(), 0, 'idempotent');
  assert.equal(orders.transfersToCheckCount(), counted + 1, 'now counted for the daily summary');
  const row = getDb().prepare('SELECT bank_state, transfer_uploads FROM orders WHERE id = ?').get(toCheck.id);
  assert.deepEqual(row, { bank_state: 'uploaded', transfer_uploads: 1 });
  assert.equal(orders.checkBankTransfer(waiting.id, 'received', 'owner@shop.test').order.bankTransfer!.state, 'paid');
});

// ── 5. The old payment-status route ─────────────────────────────────────────

test('the old PATCH {paymentStatus} can’t mark a bank transfer paid (use "Payment received"), not even a cancelled one', async () => {
  const o = place();
  const start = auditEntries().length;
  for (const paymentStatus of ['verified', 'paid', 'receipt_uploaded']) {
    try {
      orders.updateOrderByAdmin(o.id, { paymentStatus }, 'owner@shop.test');
      assert.fail('refused');
    } catch (e) {
      assert.equal((e as { status: number }).status, 409);
      assert.equal((e as { details?: { code?: string } }).details?.code, 'use_bank_check');
      assert.match((e as Error).message, /Payment received/);
    }
  }
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.state, 'awaiting');
  const c = place();
  orders.updateOrderByAdmin(c.id, { status: 'cancelled' }, 'owner@shop.test');
  assert.equal(await status(() => orders.updateOrderByAdmin(c.id, { paymentStatus: 'verified' }, 'owner@shop.test')), 409);
  assert.equal(await status(() => orders.checkBankTransfer(c.id, 'received', 'owner@shop.test')), 409);
  assert.equal(orders.getOrder(c.id)!.paymentStatus, 'pending');
  assert.equal(auditEntries().length, start, 'nothing recorded');
  // Cash on delivery keeps its payment status by hand.
  const cod = place({ paymentMethod: 'cod' });
  assert.equal(orders.updateOrderByAdmin(cod.id, { paymentStatus: 'paid' }, 'owner@shop.test').paymentStatus, 'paid');
});

// ── 6. Files after the commit; a failed commit is noted in the audit ─────────

test('a failed save: "Payment received" is not kept, and the audit says it was rolled back', () => {
  const o = place();
  const start = auditEntries().length;
  const undo = failCommitOn(o.id, 'bank_checked_at');
  try {
    assert.throws(() => orders.checkBankTransfer(o.id, 'received', 'owner@shop.test'), /FOREIGN KEY/);
  } finally {
    undo();
  }
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.state, 'awaiting', 'not saved');
  const added = auditEntries().slice(start);
  assert.deepEqual(added.map((e) => e.action), ['payment.bank_received', 'audit.rolled_back']);
  assert.deepEqual([added[1].details.action, added[1].details.orderId, added[1].details.by], ['payment.bank_received', o.id, 'owner@shop.test']);
  assert.equal(orders.checkBankTransfer(o.id, 'received', 'owner@shop.test').changed, true, 'the retry works');
});

test('a failed save: an upload leaves the screenshots as they were (files move only once saved)', () => {
  _clearAllRateLimits();
  const o = place();
  orders.uploadTransfer(o.id, PNG);
  const before = filesOf(o.id);
  const start = auditEntries().length;
  const undo = failCommitOn(o.id, 'transfer_uploads');
  try {
    assert.throws(() => orders.uploadTransfer(o.id, `data:application/pdf;base64,${Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]).toString('base64')}`), /FOREIGN KEY/);
  } finally {
    undo();
  }
  assert.deepEqual(filesOf(o.id), before, 'no version renamed, no new file');
  assert.deepEqual(fs.readFileSync(path.join(receipts, `${o.id}.png`)), PNG_BYTES);
  assert.ok(!fs.readdirSync(receipts).some((f) => f.endsWith('.tmp')));
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.uploads, 1);
  assert.deepEqual(auditEntries().slice(start).map((e) => e.action), ['order.transfer_uploaded', 'audit.rolled_back']);
});

test('backups leave out files still being written (*.tmp)', async () => {
  fs.writeFileSync(path.join(receipts, 'BUH-261018-AAAAAA.upload-1-abc.tmp'), 'half');
  fs.writeFileSync(path.join(receipts, 'checkout-1-abc.upload.tmp'), 'half');
  try {
    const { file } = await createBackup();
    const tar = zlib.gunzipSync(fs.readFileSync(file)).toString('latin1');
    assert.ok(!tar.includes('.upload-1-abc.tmp') && !tar.includes('checkout-1-abc'));
    assert.ok(tar.includes('receipts/'), 'the screenshots themselves are in');
  } finally {
    for (const f of fs.readdirSync(receipts).filter((x) => x.endsWith('.tmp'))) fs.rmSync(path.join(receipts, f));
  }
});

// ── 7. Emails, links and names ──────────────────────────────────────────────

test('customer emails: one plain address (no "," ";" spaces or control characters)', async () => {
  for (const email of ['a@b.co,c@d.co', 'a@b.co;c@d.co', 'a b@c.co', 'a@b.co\r\nBcc: x@y.z', 'a\u0007b@c.co', '"a"@b.co', 'a@(b).co']) {
    assert.equal(await status(() => place({}, { email })), 400, JSON.stringify(email));
  }
  for (const email of ['aisha@example.com', "o'brien@shop.ae", 'first.last+tag@sub.example.ae']) assert.equal(place({}, { email }).customer.email, email);
});

test('links to customers come only from the configured shop address (never the request Host)', () => {
  const o = place();
  assert.ok(o.bankTransfer!.payPath);
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.payUrl, undefined, 'not configured: no full link');
  try {
    process.env.NEXT_PUBLIC_APP_URL = 'https://beautifuluaehome.com/';
    assert.equal(orders.getOrder(o.id)!.bankTransfer!.payUrl, `https://beautifuluaehome.com${o.bankTransfer!.payPath}`);
    for (const bad of ['javascript:alert(1)', 'https://user:pw@beautifuluaehome.com', 'not a url', 'ftp://x.ae']) {
      process.env.NEXT_PUBLIC_APP_URL = bad;
      assert.equal(orders.getOrder(o.id)!.bankTransfer!.payUrl, undefined, bad);
    }
  } finally {
    delete process.env.NEXT_PUBLIC_APP_URL;
  }
  // The customer's own view keeps the relative link only.
  assert.deepEqual(Object.keys(orders.customerView(orders.getOrder(o.id)!).bankTransfer!).sort(), ['payPath', 'state', 'uploads']);
});

test('names in messages: letters, spaces, apostrophes, hyphens and dots only; nothing link-like', async () => {
  assert.equal(messages.safeFirstName('evil.com Aisha'), 'Aisha');
  assert.equal(messages.safeFirstName('http://evil.example/x'), '');
  assert.equal(messages.safeFirstName("O'Brien-Smith"), "O'Brien-Smith");
  assert.equal(messages.safeFirstName('<b>Ali</b> Khan'), 'Khan');
  assert.equal(messages.safeFirstName('محمد علي'), 'محمد');
  const mail = messages.bankDetailsEmail({ orderId: 'BUH-261018-ABC234', total: 100, bank: { bankName: 'B', accountName: 'A', iban: 'AE07', accountNumber: '', swiftCode: '', branch: '', instructions: '' }, firstName: 'www.evil.com', shopName: 'S' });
  assert.ok(mail.text.startsWith('Hello,\n'), mail.text.slice(0, 40));
  assert.ok(!mail.text.includes('evil'));
  assert.ok(!messages.bankDetailsWhatsApp({ orderId: 'BUH-1', total: 1, bank: { bankName: 'B', accountName: 'A', iban: 'AE07', accountNumber: '', swiftCode: '', branch: '', instructions: '' }, firstName: 'evil.com' }).includes('evil'));

  // The real email: no link without the shop's address, and the name cleaned.
  const { SMTPServer } = await import('smtp-server');
  const mails: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        mails.push(raw);
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test' });
  try {
    const o = place({}, { fullName: 'visit.evil.example Aisha' });
    assert.equal(await captured(() => emailBankDetails(o.id)).then((r) => r.value), 'sent');
    const { simpleParser } = await import('mailparser');
    const body = (await simpleParser(mails[0])).text ?? '';
    assert.ok(body.startsWith('Hello Aisha,'), body.slice(0, 40));
    assert.ok(!body.includes('/pay/') && !body.includes('evil'), 'no link from a Host header, no link in the name');
    assert.match(body, /reply to this email with your screenshot/);
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL']) delete process.env[k];
  }
});
