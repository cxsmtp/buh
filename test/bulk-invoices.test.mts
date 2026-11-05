/**
 * Bulk orders (BUH-02.37.00, Money → Invoices): the owner types in an order received outside the
 * shop; it is checked on the server (allow-listed fields, amounts in fils), becomes an order with
 * its invoice from exactly that data, counts in the sales (Money → Reports, the hub's Sales), never
 * touches stock, is made once per key, audited, and backed up.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const orders = await import('@/lib/server/orders');
const invoices = await import('@/lib/server/invoices');
const bulk = await import('@/lib/server/bulkOrders');
const { updateSettings } = await import('@/lib/server/settings');
const { getDb } = await import('@/lib/server/db');
const { buildReport } = await import('@/lib/server/reports');
const { saleFils } = await import('@/lib/orderMoney');
const backup = await import('@/lib/server/backup');
const { dubaiToday } = await import('@/lib/reportPeriods');

const OWNER = 'owner@shop.test';
const VAT_KEY = 'vat:settings';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const status = (f: () => unknown) => {
  try {
    f();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
await updateSettings('store', { whatsappNumber: '+971501234567', legalName: 'Beautiful Home Trading LLC', tradeLicenceNumber: '1234567', storeAddress: 'Shop 12, Al Fahidi Street, Bur Dubai', supportEmail: 'hello@shop.test' });

/** The text drawn in a PDF (its fonts' ToUnicode maps), line by line. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const streams: string[] = [];
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try {
      streams.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      // not a deflated stream
    }
  }
  const map = new Map<string, string>();
  for (const s of streams) for (const m of s.matchAll(/<([0-9a-f]{4})> <([0-9a-f]{4,8})>/g)) map.set(m[1], String.fromCodePoint(...(m[2].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16))));
  return streams
    .filter((s) => s.includes(' Tj ET'))
    .flatMap((s) => [...s.matchAll(/<([0-9a-f]*)> Tj/g)].map((m) => (m[1].match(/.{4}/g) ?? []).map((g) => map.get(g) ?? '?').join('')))
    .join('\n');
}
let k = 0;
const key = () => `bulk-test-${++k}-${Date.now()}`;
const BODY = {
  customer: { fullName: 'Fatima Al Mansoori', company: 'Palm Suites Hotel LLC', trn: '100123456700003', phone: '04 123 4567', email: 'purchasing@palmsuites.example', emirate: 'Dubai', area: 'Palm Jumeirah', address: 'Crescent Road, Building 7' },
  lines: [
    { description: 'King fitted sheet, white percale 300TC', quantity: 40, unitPrice: '85.50' },
    { description: 'Pillowcase pair, white', quantity: 80, unitPrice: 35 },
  ],
  deliveryFee: 150,
  discount: '200',
  paidWith: 'bank_transfer',
  reference: 'TT-55821',
  delivered: true,
  note: 'Hotel refurbishment, floor 3',
};

test('a bulk order: exactly the data given (lines, delivery, discount), worked out in fils; its invoice made at once; counted in the sales; no stock moved; audited; made once per key', () => {
  const stock = getDb().prepare('SELECT SUM(qty) FROM product_stock').pluck().get();
  const today = dubaiToday(Date.now());
  const before = buildReport(today, today).sales.grossFils;
  const k1 = key();
  const r = bulk.createBulkInvoice(BODY, OWNER, k1);
  assert.equal(r.created, true);
  const o = r.order;
  // 40 × 85.50 + 80 × 35 = 3420 + 2800 = 6220; + 150 delivery − 200 discount = 6170.
  assert.deepEqual([o.subtotal, o.deliveryFee, o.discount, o.total], [6220, 150, 200, 6170]);
  assert.deepEqual(o.items.map((i) => [i.title, i.quantity, i.unitPrice, i.totalPrice]), [
    ['King fitted sheet, white percale 300TC', 40, 85.5, 3420],
    ['Pillowcase pair, white', 80, 35, 2800],
  ]);
  assert.deepEqual([o.status, o.paymentStatus, o.customer.phone, o.customer.trn, o.bulk?.paidWith], ['delivered', 'paid', '+97141234567', '100123456700003', 'bank_transfer']);
  assert.equal(getDb().prepare('SELECT SUM(qty) FROM product_stock').pluck().get(), stock, 'no stock moved');
  assert.ok(r.invoice.number.startsWith('INV-'));
  assert.equal(buildReport(today, today).sales.grossFils - before, 617000, 'counted in the sales');
  assert.equal(saleFils(o), 617000, 'and in the hub’s Sales');
  // The same key again: the same order, not a second one.
  const again = bulk.createBulkInvoice(BODY, OWNER, k1);
  assert.equal(again.created, false);
  assert.equal(again.order.id, o.id);
  assert.equal(again.invoice.number, r.invoice.number);
  // The invoice: exactly that data.
  const pdf = invoices.invoicePdf(o.id)!.pdf;
  if (process.env.INVOICE_PDF) fs.writeFileSync(process.env.INVOICE_PDF, pdf);
  const text = pdfText(pdf);
  for (const want of ['Palm Suites Hotel LLC', 'Fatima Al Mansoori', 'TRN: 100123456700003', 'King fitted sheet, white percale 300TC', '3,420.00', 'Pillowcase pair, white', '2,800.00', 'Delivery', '150.00', 'Discount', '-200.00', 'AED 6,170.00', 'Bank transfer · paid (TT-55821)', 'PAID', 'Beautiful Home Trading LLC', 'Trade licence: 1234567']) assert.ok(text.includes(want), `${want} in:\n${text}`);
  const logs = fs.readdirSync(dir).filter((f) => /^audit-.*\.jsonl$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
  assert.match(logs, /"order\.bulk_created"/);
  assert.match(logs, /"invoice\.issued"/);
  assert.equal(bulk.listBulkInvoices().find((x) => x.orderId === o.id)?.number, r.invoice.number);
});

test('not paid yet: the invoice says it is due; a past date counts in its own month; still to deliver: the order waits to be delivered', () => {
  const r = bulk.createBulkInvoice({ ...BODY, paidWith: 'unpaid', reference: '', date: '2026-10-03', delivered: false }, OWNER, key());
  assert.equal(r.order.paymentStatus, 'pending');
  assert.equal(r.order.status, 'confirmed');
  assert.equal(dubaiToday(Date.parse(r.order.createdAt)), '2026-10-03');
  assert.ok(buildReport('2026-10-01', '2026-10-31').sales.grossFils >= 617000);
  const text = pdfText(invoices.invoicePdf(r.order.id)!.pdf);
  assert.ok(text.includes('Due on receipt of this invoice'), text);
  assert.ok(text.includes('DUE'));
});

test('checked on the server: allow-listed fields, the lines, the amounts, the phone, the TRN, the date; nothing saved when refused', () => {
  const n = getDb().prepare('SELECT COUNT(*) FROM orders').pluck().get();
  const bad: Array<[string, Record<string, unknown>]> = [
    ['unknown field', { ...BODY, total: 1 }],
    ['unknown customer field', { ...BODY, customer: { ...BODY.customer, isAdmin: true } }],
    ['no name', { ...BODY, customer: { ...BODY.customer, fullName: ' ' } }],
    ['bad phone', { ...BODY, customer: { ...BODY.customer, phone: '12' } }],
    ['bad TRN', { ...BODY, customer: { ...BODY.customer, trn: '123' } }],
    ['bad emirate', { ...BODY, customer: { ...BODY.customer, emirate: 'Narnia' } }],
    ['no lines', { ...BODY, lines: [] }],
    ['too many lines', { ...BODY, lines: Array.from({ length: 51 }, () => BODY.lines[0]) }],
    ['line field', { ...BODY, lines: [{ ...BODY.lines[0], total: 1 }] }],
    ['no description', { ...BODY, lines: [{ ...BODY.lines[0], description: '' }] }],
    ['zero quantity', { ...BODY, lines: [{ ...BODY.lines[0], quantity: 0 }] }],
    ['fraction quantity', { ...BODY, lines: [{ ...BODY.lines[0], quantity: 1.5 }] }],
    ['three decimals', { ...BODY, lines: [{ ...BODY.lines[0], unitPrice: '1.234' }] }],
    ['negative price', { ...BODY, lines: [{ ...BODY.lines[0], unitPrice: -5 }] }],
    ['discount over the total', { ...BODY, discount: 99999 }],
    ['future date', { ...BODY, date: '2099-01-01' }],
    ['bad date', { ...BODY, date: '2026-02-30x' }],
    ['bad payment', { ...BODY, paidWith: 'bitcoin' }],
  ];
  for (const [what, body] of bad) assert.equal(status(() => bulk.createBulkInvoice(body, OWNER, key())), 400, what);
  assert.equal(status(() => bulk.createBulkInvoice(BODY, OWNER, 'x')), 400, 'a key is needed');
  assert.equal(getDb().prepare('SELECT COUNT(*) FROM orders').pluck().get(), n, 'nothing saved');
});

test('its lines stay as entered (an edit of the quantities is refused); with VAT on, refused until a tax invoice can be made', async () => {
  const r = bulk.createBulkInvoice({ ...BODY, paidWith: 'cash', delivered: false }, OWNER, key());
  assert.equal(r.order.paymentMethod, 'cod');
  assert.throws(() => orders.editOrderDetails(r.order.id, { lines: [{ quantity: 2, unitPrice: 85.5 }, { quantity: 80, unitPrice: 35 }] }, OWNER), /amounts can.t change|quantities stay as entered/);
  const { kvSet } = await import('@/lib/server/kv');
  const vat = await import('@/lib/server/vat');
  kvSet(VAT_KEY, { enabled: true, trn: '100000000000003' });
  try {
    assert.equal(vat.vatSettings().enabled, true);
    assert.throws(() => bulk.createBulkInvoice(BODY, OWNER, key()), (e) => code(e) === 'bulk_vat');
  } finally {
    kvSet(VAT_KEY, { enabled: false });
  }
});

test('bulk orders and their invoices are in the backup and come back with the restore', async () => {
  const r = bulk.createBulkInvoice(BODY, OWNER, key());
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-bulk-'));
  fs.rmSync(target, { recursive: true });
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  assert.equal(db.prepare('SELECT order_id FROM invoices WHERE number = ?').pluck().get(r.invoice.number), r.order.id);
  assert.match(String(db.prepare('SELECT data FROM orders WHERE id = ?').pluck().get(r.order.id)), /Palm Suites Hotel LLC/);
  db.close();
  fs.rmSync(target, { recursive: true, force: true });
});
