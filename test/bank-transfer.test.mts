/**
 * BUH-02.09: bank transfer without the bank account on the website. Each bank-transfer order gets
 * a private page (/pay/<token>): the token is random (256 bits), never stored (only its hash),
 * opens the page for 14 days and dies when the order is paid or cancelled; a wrong token is the
 * front gate's "unknown address". The screenshot upload is checked like a receipt (type by its
 * bytes, 5 MB) and a new one keeps the earlier ones. The owner's "Payment received" / "Not
 * received yet" is idempotent and audited before it counts. The bank details email goes once,
 * with the private link, only when there is an address. WhatsApp texts are encoded right, logs
 * mask the link, uploads are rate-limited, migration 10 only adds, and backups keep it all.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { jsonRequest, tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const pay = await import('@/lib/server/bankPay');
const gate = await import('@/lib/server/frontGate');
const { emailBankDetails } = await import('@/lib/server/bankMail');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { updateSettings } = await import('@/lib/server/settings');
const { getDb } = await import('@/lib/server/db');
const { logEvent } = await import('@/lib/server/log');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { dailySummary } = await import('@/lib/server/monitor');
const messages = await import('@/lib/bankMessages');
const wa = await import('@/lib/whatsappConfirm');
const uploadRoute = await import('@/app/api/pay/[token]/route');

const IBAN_SHOWN = 'AE07 0331 2345 6789 0123 456'; // as Settings keeps it
const BANK = { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' };
await updateSettings('bank', BANK);
await updateSettings('brand', { storeName: 'Beautiful UAE Home' });

// A real 1×1 PNG, and a minimal PDF.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = `data:application/pdf;base64,${Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]).toString('base64')}`;

let n = 0;
function place(over: Record<string, unknown> = {}, phone = `+9715040${String(++n).padStart(5, '0')}`) {
  const p = listProducts()[0];
  return orders.placeOrder({
    idempotencyKey: `bank-test-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    verificationToken: issuePhoneToken(phone),
    customer: { fullName: 'Aisha Test', email: 'aisha@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
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
const row = (id: string) => getDb().prepare('SELECT * FROM orders WHERE id = ?').get(id) as Record<string, unknown>;
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
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
const upload = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  uploadRoute.POST(jsonRequest(body, { origin: 'http://shop.test', ...headers }, `http://shop.test/api/pay/${token}`), { params: Promise.resolve({ token }) });

test('the private link: random (256 bits), only its hash at rest, one per order, and it opens only its own order', () => {
  const a = place();
  const b = place();
  const ta = tokenOf(a);
  const tb = tokenOf(b);
  assert.match(ta, pay.PAY_TOKEN_PATTERN);
  assert.equal(Buffer.from(ta, 'base64url').length, 32, '256 bits');
  assert.notEqual(ta, tb);
  const r = row(a.id);
  assert.equal(r.pay_token_hash, crypto.createHash('sha256').update(ta).digest('hex'), 'stored as a hash');
  assert.ok(!JSON.stringify(r).includes(ta), 'the token itself is nowhere in the row');
  const raw = fs.readFileSync(path.join(dir, 'shop.db')).toString('latin1') + (fs.existsSync(path.join(dir, 'shop.db-wal')) ? fs.readFileSync(path.join(dir, 'shop.db-wal')).toString('latin1') : '');
  assert.ok(!raw.includes(ta), 'nor anywhere in the database file');
  assert.equal(pay.openPayOrderId(ta), a.id);
  assert.equal(pay.openPayOrderId(tb), b.id);
  // Wrong, altered, malformed: nothing.
  const flipped = (ta[0] === 'A' ? 'B' : 'A') + ta.slice(1);
  for (const t of [flipped, ta.slice(0, 42), `${ta}x`, '', '../../etc/passwd', ta.toUpperCase() === ta ? ta.toLowerCase() : ta.toUpperCase(), 123, null]) assert.equal(pay.openPayOrderId(t), null, String(t));
  // The same order again (a checkout retry) keeps its one link.
  assert.equal(tokenOf(orders.getOrder(a.id)!), ta);
  // Cash on delivery and card orders have none.
  assert.equal(place({ paymentMethod: 'cod' }).bankTransfer, undefined);
});

test('the link expires after 14 days, and dies when the order is paid or cancelled', () => {
  const o = place();
  const t = tokenOf(o);
  const created = Date.parse(o.createdAt);
  assert.equal(pay.openPayOrderId(t, created + 13 * 24 * 3600_000), o.id);
  assert.equal(pay.openPayOrderId(t, created + 14 * 24 * 3600_000 + 1), null, 'expired');

  const paid = place();
  orders.checkBankTransfer(paid.id, 'received', 'owner@shop.test');
  assert.equal(pay.openPayOrderId(tokenOf(paid)), null, 'paid');
  assert.equal(orders.getOrder(paid.id)!.bankTransfer!.payPath, undefined, 'and no longer shown');

  const cancelled = place();
  orders.updateOrderByAdmin(cancelled.id, { status: 'cancelled' }, 'owner@shop.test');
  assert.equal(pay.openPayOrderId(tokenOf(cancelled)), null, 'cancelled');

  // Marked paid by an older version (only the payment status it knows): the page closes too.
  const old = place();
  getDb().prepare("UPDATE orders SET payment_status = 'verified', data = json_set(data, '$.paymentStatus', 'verified') WHERE id = ?").run(old.id);
  assert.equal(pay.openPayOrderId(tokenOf(old)), null);
  assert.equal(orders.getOrder(old.id)!.bankTransfer!.state, 'paid');
});

test('the front gate: a link that opens an order passes with private headers; any other is the unknown address', () => {
  const o = place();
  const t = tokenOf(o);
  assert.deepEqual(gate.decide(`/pay/${t}`, ''), { kind: 'pay', orderId: o.id, api: false });
  assert.deepEqual(gate.decide(`/api/pay/${t}`, ''), { kind: 'pay', orderId: o.id, api: true });
  assert.deepEqual(gate.decide(`/pay/${t}?utm=x`, ''), { kind: 'pay', orderId: o.id, api: false });
  const wrong = crypto.randomBytes(32).toString('base64url');
  assert.deepEqual(gate.decide(`/pay/${wrong}`, ''), { kind: 'unknown', url: gate.NOWHERE_PAGE });
  assert.deepEqual(gate.decide(`/pay/${wrong}?a=1`, ''), { kind: 'unknown', url: `${gate.NOWHERE_PAGE}?a=1` });
  assert.deepEqual(gate.decide(`/api/pay/${wrong}`, ''), { kind: 'unknown', url: gate.NOWHERE_API });
  assert.deepEqual(gate.decide('/pay/x', ''), { kind: 'unknown', url: gate.NOWHERE_PAGE });
  assert.deepEqual(gate.decide(`/%70ay/${wrong}`, ''), { kind: 'unknown', url: gate.NOWHERE_PAGE }, 'escaped forms are recognised');
  // The shop, product pages and the hub's door are as before.
  assert.equal(gate.decide('/', '').kind, 'pass');
  assert.equal(gate.decide('/p/x', '').kind, 'pass');
  orders.checkBankTransfer(o.id, 'received', 'owner@shop.test');
  assert.deepEqual(gate.decide(`/pay/${t}`, ''), { kind: 'unknown', url: gate.NOWHERE_PAGE }, 'paid: gone');
});

test('the customer sees their own link (confirmation, Track Order), never the account; the order answer carries none', () => {
  const o = place();
  const view = orders.customerView(o) as Record<string, unknown>;
  assert.deepEqual(view.bankTransfer, { state: 'awaiting', uploads: 0, payPath: o.bankTransfer!.payPath });
  const tracked = orders.lookupOrder(o.id, o.customer.phone)!;
  assert.deepEqual(tracked.bankTransfer, view.bankTransfer);
  assert.equal(orders.lookupOrder(o.id, '+971500000001'), null, 'another phone: nothing');
  for (const v of [JSON.stringify(view), JSON.stringify(tracked)]) for (const s of [IBAN_SHOWN, BANK.iban, 'AE07', BANK.accountName, BANK.accountNumber]) assert.ok(!v.includes(s));
});

test('upload: type by its bytes, 5 MB, only while open; a new one replaces it on screen and keeps the earlier ones', async () => {
  const o = place();
  for (const bad of [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    `data:application/pdf;base64,${Buffer.from('not a pdf').toString('base64')}`,
    `data:image/png;base64,${Buffer.from('GIF89a-pretending').toString('base64')}`,
    'hello',
    42,
  ]) {
    assert.equal(await status(() => orders.uploadTransfer(o.id, bad)), 400, String(bad).slice(0, 30));
  }
  const big = `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5 * 1024 * 1024 + 10)]).toString('base64')}`;
  assert.equal(await status(() => orders.uploadTransfer(o.id, big)), 413);
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.uploads, 0, 'nothing kept from refused files');

  const first = orders.uploadTransfer(o.id, PNG);
  assert.deepEqual({ state: first.bankTransfer!.state, uploads: first.bankTransfer!.uploads }, { state: 'uploaded', uploads: 1 });
  assert.equal(first.paymentStatus, 'receipt_uploaded');
  assert.equal(first.paymentReceiptUrl, `/api/admin/orders/${o.id}/receipt`);
  assert.equal(orders.readReceipt(o.id)!.mime, 'image/png');
  const second = orders.uploadTransfer(o.id, PDF);
  assert.equal(second.bankTransfer!.uploads, 2);
  assert.equal(orders.readReceipt(o.id)!.mime, 'application/pdf', 'the latest is shown');
  assert.equal(orders.readReceipt(o.id, 1)!.mime, 'image/png', 'the first is kept');
  assert.equal(orders.readReceipt(o.id, 2), null);
  for (const v of [0, -1, 1.5, 1e9]) assert.equal(orders.readReceipt(o.id, v), null, String(v));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'receipts')).filter((f) => f.startsWith(o.id)).sort(), [`${o.id}.pdf`, `${o.id}.v1.png`]);
  const events = orders.orderEvents(o.id).map((e) => e.event);
  assert.deepEqual(events, ['created', 'bank_link_made', 'transfer_uploaded', 'transfer_uploaded']);

  orders.checkBankTransfer(o.id, 'received', 'owner@shop.test');
  assert.equal(await status(() => orders.uploadTransfer(o.id, PNG)), 409, 'paid: nothing more to upload');
  assert.equal(await status(() => orders.uploadTransfer(place({ paymentMethod: 'cod' }).id, PNG)), 404, 'not a bank-transfer order');
});

test('the upload route: same site, allow-listed body, size-capped, a wrong token 404, and limited per order', async () => {
  _clearAllRateLimits();
  const o = place();
  const t = tokenOf(o);
  assert.equal((await upload(t, { file: PNG }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await upload(t, { file: PNG, orderId: 'BUH-x' })).status, 400, 'fields outside the allow-list');
  assert.equal((await upload(crypto.randomBytes(32).toString('base64url'), { file: PNG })).status, 404);
  assert.equal((await upload(t, 'x'.repeat(7 * 1024 * 1024 + 1))).status, 413);
  const ok = await upload(t, { file: PNG });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, uploads: 1 });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  // 10 per order per hour (the refused ones above count too), then 429.
  let last = 0;
  for (let i = 0; i < 12 && last !== 429; i++) last = (await upload(t, { file: PNG })).status;
  assert.equal(last, 429);
  assert.ok(orders.getOrder(o.id)!.bankTransfer!.uploads <= 10);
  // Per address too (with a trusted proxy): 20 an hour.
  _clearAllRateLimits();
  process.env.TRUST_PROXY = '1';
  try {
    const other = Array.from({ length: 3 }, () => tokenOf(place()));
    let byIp = 0;
    for (let i = 0; i < 25 && byIp !== 429; i++) byIp = (await upload(other[i % 3], { file: PNG }, { 'x-real-ip': '203.0.113.9' })).status;
    assert.equal(byIp, 429);
    assert.equal((await upload(other[0], { file: PNG }, { 'x-real-ip': '203.0.113.10' })).status, 200, 'another address is not affected');
  } finally {
    delete process.env.TRUST_PROXY;
    _clearAllRateLimits();
  }
});

test('"Payment received": paid once (idempotent), audited first, history shows each step; "Not received yet" too', async () => {
  const o = place();
  orders.uploadTransfer(o.id, PNG);
  const before = auditEntries().length;
  const nr = orders.checkBankTransfer(o.id, 'not_received', 'owner@shop.test');
  assert.equal(nr.changed, true);
  assert.equal(nr.order.bankTransfer!.state, 'not_received');
  assert.equal(orders.checkBankTransfer(o.id, 'not_received', 'owner@shop.test').changed, false);
  assert.ok(pay.openPayOrderId(tokenOf(o)), 'the customer may still upload');
  orders.uploadTransfer(o.id, PNG);
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.state, 'uploaded');
  const paid = orders.checkBankTransfer(o.id, 'received', 'owner@shop.test');
  assert.equal(paid.changed, true);
  assert.equal(paid.order.bankTransfer!.state, 'paid');
  assert.equal(paid.order.paymentStatus, 'verified', 'paid the way every version knows');
  assert.equal(paid.order.bankTransfer!.checkedBy, 'owner@shop.test');
  const again = orders.checkBankTransfer(o.id, 'received', 'other@shop.test');
  assert.equal(again.changed, false);
  assert.equal(again.order.bankTransfer!.checkedBy, 'owner@shop.test', 'a second tap changes nothing');
  assert.equal(await status(() => orders.checkBankTransfer(o.id, 'not_received', 'owner@shop.test')), 409, 'never un-paid');
  assert.equal(await status(() => orders.updateOrderByAdmin(o.id, { paymentStatus: 'pending' }, 'owner@shop.test')), 409, 'not by the old route either');
  const added = auditEntries().slice(before);
  assert.deepEqual(added.map((e) => e.action), ['payment.bank_not_received', 'order.transfer_uploaded', 'payment.bank_received']);
  const received = added[2];
  // The order number and who acted are kept exactly (never masked as if a phone number or a customer's email).
  assert.equal(received.details.orderId, o.id);
  assert.equal(added[1].details.orderId, o.id);
  assert.equal(received.details.amountFils, Math.round(o.total * 100));
  assert.equal(received.details.by, 'owner@shop.test');
  assert.deepEqual(orders.orderEvents(o.id).map((e) => e.event), ['created', 'bank_link_made', 'transfer_uploaded', 'bank_not_received', 'transfer_uploaded', 'bank_paid']);

  assert.equal(await status(() => orders.checkBankTransfer('BUH-000000-NOSUCH', 'received', 'x')), 404);
  assert.equal(await status(() => orders.checkBankTransfer(place({ paymentMethod: 'cod' }).id, 'received', 'x')), 409);
  const c = place();
  orders.updateOrderByAdmin(c.id, { status: 'cancelled' }, 'x');
  assert.equal(await status(() => orders.checkBankTransfer(c.id, 'received', 'x')), 409, 'cancelled');
});

test('"Payment received" is not saved when the audit log cannot be written', async () => {
  const o = place();
  const file = path.join(dir, `audit-${new Date().toISOString().slice(0, 7)}.jsonl`);
  const aside = `${file}.aside`;
  fs.renameSync(file, aside);
  fs.mkdirSync(file);
  let code = 0;
  try {
    code = await status(() => orders.checkBankTransfer(o.id, 'received', 'owner@shop.test'));
  } finally {
    fs.rmdirSync(file);
    fs.renameSync(aside, file);
  }
  assert.equal(code, 503);
  const after = orders.getOrder(o.id)!;
  assert.equal(after.bankTransfer!.state, 'awaiting', 'nothing changed');
  assert.equal(after.paymentStatus, 'pending');
  assert.equal(orders.checkBankTransfer(o.id, 'received', 'owner@shop.test').changed, true, 'the retry works');
});

test('the bank details email: once per order, with the details, amount, reference and private link; never without an address', async () => {
  const { SMTPServer } = await import('smtp-server');
  const mails: Array<{ to: string; raw: string }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        mails.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test', NEXT_PUBLIC_APP_URL: 'https://beautifuluaehome.com' });
  try {
    const o = place();
    const link = `https://beautifuluaehome.com${o.bankTransfer!.payPath}`;
    const { value, lines } = await captured(() => emailBankDetails(o.id));
    assert.equal(value, 'sent');
    assert.equal(await emailBankDetails(o.id), 'skipped', 'once per order');
    await Promise.all([emailBankDetails(o.id), emailBankDetails(o.id)]);
    assert.equal(mails.length, 1);
    const mail = mails[0];
    assert.equal(mail.to, 'aisha@example.com');
    const { simpleParser } = await import('mailparser');
    const parsed = await simpleParser(mail.raw);
    assert.equal(parsed.subject, `Bank details for your order ${o.id}`);
    const body = parsed.text ?? '';
    for (const s of [IBAN_SHOWN, BANK.accountName, BANK.bankName, `AED ${o.total}`, `use ${o.id} as the transfer reference`, link, 'or reply to this email with your screenshot']) assert.ok(body.includes(s), s);
    assert.equal(parsed.headers.get('auto-submitted'), 'auto-generated');
    const history = orders.orderEvents(o.id).map((e) => e.event);
    assert.ok(history.includes('bank_emailed'), 'noted on the order');
    assert.ok(orders.getOrder(o.id)!.bankTransfer!.emailedAt);
    // The log line masks the address and the link.
    const logged = lines.join('\n');
    assert.match(logged, /bank_details_emailed/);
    assert.ok(!logged.includes(tokenOf(o)) && !logged.includes('aisha@example.com'), logged);

    // No email on the order: nothing sent.
    const noEmail = place({ customer: { fullName: 'No Mail', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' } });
    assert.equal(await emailBankDetails(noEmail.id), 'skipped');
    // Cash on delivery: nothing sent.
    assert.equal(await emailBankDetails(place({ paymentMethod: 'cod' }).id), 'skipped');
    assert.equal(mails.length, 1);
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
  }
  // Email not set up: nothing sent, nothing claimed.
  const o = place();
  assert.equal(await emailBankDetails(o.id), 'skipped');
  assert.equal(orders.getOrder(o.id)!.bankTransfer!.emailedAt, undefined);
});

test('a failed email is noted on the order, and the claim is given back', async () => {
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false' });
  try {
    const o = place();
    const { value } = await captured(() => emailBankDetails(o.id));
    assert.equal(value, 'failed');
    assert.ok(orders.orderEvents(o.id).some((e) => e.event === 'bank_email_failed'));
    assert.equal(orders.getOrder(o.id)!.bankTransfer!.emailedAt, undefined);
  } finally {
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS']) delete process.env[k];
  }
});

test('WhatsApp texts: the confirmation asks for the bank details; the owner’s messages carry details, amount, reference and link, encoded right', () => {
  assert.equal(wa.confirmMessage('BUH-261018-ABC234', '0427', { bankDetails: true }), 'Confirm my order BUH-261018-ABC234 · code 0427, and please send me the bank details');
  assert.equal(wa.confirmMessage('BUH-261018-ABC234', '0427'), 'Confirm my order BUH-261018-ABC234 · code 0427', 'other orders unchanged');
  const link = 'https://beautifuluaehome.com/pay/' + 'A'.repeat(43);
  const bank = { ...BANK, accountName: 'Al Noor & Sons #1 + Co', branch: '', instructions: '' };
  const text = messages.bankDetailsWhatsApp({ orderId: 'BUH-261018-ABC234', total: 1234.5, bank, link, firstName: 'مريم', shopName: 'Beautiful UAE Home' });
  for (const s of ['BUH-261018-ABC234', 'AED 1234.50', `IBAN: ${BANK.iban}`, 'Account name: Al Noor & Sons #1 + Co', 'Reference: BUH-261018-ABC234', link, 'مريم']) assert.ok(text.includes(s), s);
  assert.ok(!text.includes('Branch'), 'only the details filled in');
  const href = wa.waMeLink('+971 50 111 2222', text)!;
  assert.ok(href.startsWith('https://wa.me/971501112222?text='));
  assert.equal(new URL(href).searchParams.get('text'), text, 'read back exactly');
  assert.ok(!/[ &#+\n]/.test(href.split('?text=')[1]), 'reserved characters and new lines are escaped');
  assert.equal(messages.paymentReceivedReply('BUH-1'), "We've received your payment for order BUH-1, thank you ✓");
  assert.match(messages.notReceivedReply('BUH-1', 490, link), /haven't seen your transfer of AED 490 for order BUH-1[\s\S]*\/pay\//);
  const email = messages.bankDetailsEmail({ orderId: 'BUH-1', total: 490, bank: { ...BANK, branch: '', instructions: '' }, link });
  assert.equal(email.subject, 'Bank details for your order BUH-1');
  assert.ok(email.text.includes(link) && email.text.includes('or reply to this email with your screenshot'));
});

test('logs mask the private link like the admin link', async () => {
  const o = place();
  const t = tokenOf(o);
  const { lines } = await captured(() => logEvent('info', 'test', { url: `https://shop.ae/pay/${t}?x=1`, path: `/api/pay/${t}` }));
  assert.ok(!lines.join('').includes(t));
  assert.ok(lines.join('').includes(`/pay/${t.slice(0, 4)}…`));
});

test('the daily summary counts the transfers to check and those still awaited', () => {
  const before = dailySummary().text;
  const o = place();
  orders.uploadTransfer(o.id, PNG);
  const text = dailySummary().text;
  const count = (s: string, re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  assert.equal(count(text, /Bank transfers to check \(screenshot received\): (\d+)/), count(before, /Bank transfers to check \(screenshot received\): (\d+)/) + 1);
  assert.equal(orders.transfersToCheckCount(), count(text, /Bank transfers to check \(screenshot received\): (\d+)/));
  assert.ok(orders.transfersAwaitedCount() >= 1);
  assert.match(text, /Bank transfers not received yet: \d+/);
});

test('migration 10 only adds (columns, indexes) and fills its own columns; older bank orders carry on', () => {
  const src = fs.readFileSync('src/lib/server/db.ts', 'utf8');
  const m10 = src.slice(src.indexOf('// 10: bank transfer'), src.indexOf('];', src.indexOf('// 10: bank transfer')));
  const statements = m10.slice(m10.indexOf('db.exec(`') + 9, m10.indexOf('`);')).split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  assert.ok(statements.length >= 10);
  for (const s of statements) assert.match(s, /^(ALTER TABLE orders ADD COLUMN|CREATE (UNIQUE )?INDEX|UPDATE orders SET bank_state = )/, s);
  const update = statements.find((s) => s.startsWith('UPDATE'))!;
  assert.match(update, /SET bank_state = [\s\S]*transfer_uploads = [\s\S]*WHERE payment_method = 'bank_transfer'$/, 'the UPDATE only sets the new columns');

  // A database at version 9 with older bank orders (one with a checkout receipt, one verified).
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-v9-'));
  const run = (code: string) => spawnSync(process.execPath, ['--import', 'tsx', '-e', `process.env.DATA_DIR=${JSON.stringify(old)}; ${code}`], { encoding: 'utf8' });
  assert.equal(run(`const m = await import('@/lib/server/db'); (m.getDb ?? m.default.getDb)();`).status, 0);
  const db = new Database(path.join(old, 'shop.db'));
  db.exec(`DROP INDEX orders_by_pay_token; DROP INDEX orders_transfer_to_check; ${['pay_nonce', 'pay_token_hash', 'pay_expires_at', 'bank_state', 'transfer_uploads', 'transfer_uploaded_at', 'bank_emailed_at', 'bank_checked_at', 'bank_checked_by'].map((c) => `ALTER TABLE orders DROP COLUMN ${c};`).join(' ')}`);
  const ins = db.prepare("INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, data) VALUES (?, '2026-01-01', '2026-01-01', '+971501234567', 'pending_confirmation', ?, ?, 100, ?)");
  ins.run('BUH-OLD-A', 'bank_transfer', 'receipt_uploaded', JSON.stringify({ id: 'BUH-OLD-A', paymentReceiptUrl: '/api/admin/orders/BUH-OLD-A/receipt' }));
  ins.run('BUH-OLD-B', 'bank_transfer', 'verified', '{"id":"BUH-OLD-B"}');
  ins.run('BUH-OLD-C', 'bank_transfer', 'pending', '{"id":"BUH-OLD-C"}');
  ins.run('BUH-OLD-D', 'cod', 'cod_pending', '{"id":"BUH-OLD-D"}');
  db.pragma('user_version = 9');
  db.close();
  const up = run(`const m = await import('@/lib/server/db'); const db = (m.getDb ?? m.default.getDb)(); console.log(JSON.stringify({ v: db.pragma('user_version', { simple: true }), rows: db.prepare("SELECT id, data, bank_state, transfer_uploads, pay_token_hash FROM orders WHERE id LIKE 'BUH-OLD-%' ORDER BY id").all() }));`);
  assert.equal(up.status, 0, up.stderr);
  const out = JSON.parse(up.stdout.trim().split('\n').pop()!);
  assert.equal(out.v, 10);
  assert.deepEqual(
    out.rows.map((r: Record<string, unknown>) => [r.id, r.bank_state, r.transfer_uploads, r.pay_token_hash]),
    [
      ['BUH-OLD-A', 'uploaded', 1, null],
      ['BUH-OLD-B', 'paid', 0, null],
      ['BUH-OLD-C', 'awaiting', 0, null],
      ['BUH-OLD-D', 'none', 0, null],
    ]
  );
  assert.equal(out.rows[0].data, JSON.stringify({ id: 'BUH-OLD-A', paymentReceiptUrl: '/api/admin/orders/BUH-OLD-A/receipt' }), 'the JSON is untouched');
});

test('a backup keeps the bank transfers and every screenshot; the restore brings them back, and a new key re-makes the links', async () => {
  const o = place();
  orders.uploadTransfer(o.id, PNG);
  orders.uploadTransfer(o.id, PDF);
  const paid = place();
  orders.checkBankTransfer(paid.id, 'received', 'owner@shop.test');
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const csv = result.csv.find((c) => c.name === 'orders.csv')!.data.toString('utf8');
  assert.match(csv.split(/\r?\n/)[0], /bank_transfer,transfer_screenshots,transfer_uploaded_at,bank_details_emailed_at,bank_checked_at,bank_checked_by/);
  assert.ok(csv.split(/\r?\n/).some((l) => l.startsWith(o.id) && l.includes(',uploaded,2,')));
  assert.ok(!csv.includes('/pay/'), 'never the private links');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-bank-'));
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const restored = new Database(path.join(target, 'shop.db'), { readonly: true });
  const r = restored.prepare('SELECT bank_state, transfer_uploads, pay_nonce, pay_token_hash, payment_status FROM orders WHERE id = ?').get(o.id) as Record<string, unknown>;
  assert.deepEqual({ state: r.bank_state, uploads: r.transfer_uploads, pay: r.payment_status }, { state: 'uploaded', uploads: 2, pay: 'receipt_uploaded' });
  assert.ok(r.pay_nonce && r.pay_token_hash);
  assert.equal((restored.prepare('SELECT bank_state FROM orders WHERE id = ?').get(paid.id) as { bank_state: string }).bank_state, 'paid');
  restored.close();
  assert.equal(fs.readFileSync(path.join(target, 'receipts', `${o.id}.pdf`)).subarray(0, 5).toString(), '%PDF-');
  assert.ok(fs.existsSync(path.join(target, 'receipts', `${o.id}.v1.png`)), 'the earlier screenshot too');

  // The restored shop on a new server (another key): its links are made again and open the order.
  const env = { ...process.env, DATA_DIR: target, SESSION_SECRET: 'a-different-server-key-of-32-characters!' };
  const out = spawnSync(
    process.execPath,
    ['--import', 'tsx', '-e', `const pm = await import('@/lib/server/bankPay'); const om = await import('@/lib/server/orders'); const p = pm.refreshPayHashes ? pm : pm.default; const o = om.getOrder ? om : om.default; const n = p.refreshPayHashes(); const order = o.getOrder(${JSON.stringify(o.id)}); const t = order.bankTransfer.payPath.slice(5); console.log(JSON.stringify({ n, opens: p.openPayOrderId(t), again: p.refreshPayHashes(), uploads: order.bankTransfer.uploads }));`],
    { encoding: 'utf8', env }
  );
  assert.equal(out.status, 0, out.stderr);
  const res = JSON.parse(out.stdout.trim().split('\n').pop()!);
  assert.ok(res.n >= 2);
  assert.equal(res.opens, o.id);
  assert.equal(res.again, 0, 'once per key');
  assert.equal(res.uploads, 2);
});
