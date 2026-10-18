/**
 * BUH-02.10: reports for the accountant and the audit log viewer. Totals against hand-computed
 * fixtures (orders across cash on delivery, bank transfer and card; refunds; cancelled, unpaid and
 * Stripe-test orders left out; month boundaries in UAE time); report periods (months, quarters,
 * financial years with another start month); the VAT threshold warning; the ZIP's files and their
 * contents (Excel-safe CSV with a BOM, bills named by date, category and amount, the period's audit
 * log and its check). The audit viewer's filters, pages and chain-break detection.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
const { getDb } = await import('@/lib/server/db');
const reports = await import('@/lib/server/reports');
const periods = await import('@/lib/reportPeriods');
const ex = await import('@/lib/server/expenses');
const view = await import('@/lib/server/auditView');
const auditLib = await import('@/lib/server/audit');
const { readZip } = await import('@/lib/server/zip');
const { toCsv, aedText } = await import('@/lib/server/csv');

const OWNER = 'owner@shop.test';

interface Fixture {
  id: string;
  at: string;
  method: 'cod' | 'bank_transfer' | 'online_card';
  total: number;
  status?: string;
  paymentStatus?: string;
  bank?: string;
  card?: { state: string; paidFils?: number; refundedFils?: number; refundedAt?: string; live?: boolean };
  name?: string;
}

function insert(f: Fixture) {
  const order = {
    id: f.id,
    createdAt: f.at,
    customer: { fullName: f.name ?? 'Layla Test', phone: '+971501234567', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '9' },
    items: [{ productId: 'prod-1', title: 'Mughal Garden', image: '', profileId: 'king', profileName: 'King', mattressSize: '', fittedSheet: '', flatSheet: '', pillowcases: '', unitPrice: f.total, quantity: 1, totalPrice: f.total }],
    subtotal: f.total,
    deliveryFee: 0,
    codFee: 0,
    discount: 0,
    total: f.total,
    paymentMethod: f.method,
    paymentStatus: f.paymentStatus ?? (f.method === 'cod' ? 'cod_pending' : 'pending'),
    status: f.status ?? 'confirmed',
    courier: { provider: 'jeebly', serviceType: 'Scheduled', awbNumber: 'AWB123', trackingUrl: '', status: '', pickupDate: '', weightKg: 1, pieces: 1, labelGenerated: false },
  };
  getDb()
    .prepare(
      `INSERT INTO orders (id, created_at, updated_at, phone, status, payment_method, payment_status, total_fils, data, bank_state, card_state, paid_fils, refunded_fils, refunded_at, card_livemode, payment_ref)
       VALUES (?, ?, ?, '+971501234567', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(f.id, f.at, f.at, order.status, f.method, order.paymentStatus, Math.round(f.total * 100), JSON.stringify(order), f.bank ?? 'none', f.card?.state ?? 'none', f.card?.paidFils ?? null, f.card?.refundedFils ?? null, f.card?.refundedAt ?? null, f.card ? (f.card.live === false ? 0 : 1) : null, f.card ? `pi_${f.id}` : null);
}

// August 2026 in UAE time is 2026-07-31T20:00Z to 2026-08-31T20:00Z.
const FIXTURES: Fixture[] = [
  { id: 'BUH-A', at: '2026-08-05T10:00:00Z', method: 'cod', total: 100, status: 'delivered', paymentStatus: 'paid' },
  { id: 'BUH-B', at: '2026-08-10T10:00:00Z', method: 'bank_transfer', total: 250.5, paymentStatus: 'verified', bank: 'paid' },
  // Paid in August, refunded in September: a sale in August, a refund in September.
  { id: 'BUH-C', at: '2026-08-12T10:00:00Z', method: 'online_card', total: 300, status: 'cancelled', paymentStatus: 'paid', card: { state: 'refunded', paidFils: 30_000, refundedFils: 30_000, refundedAt: '2026-09-02T08:00:00Z' } },
  // Paid and refunded in August: both in August.
  { id: 'BUH-D', at: '2026-08-14T10:00:00Z', method: 'online_card', total: 120, status: 'cancelled', paymentStatus: 'paid', card: { state: 'refunded', paidFils: 12_000, refundedFils: 12_000, refundedAt: '2026-08-20T08:00:00Z' } },
  { id: 'BUH-E', at: '2026-08-15T10:00:00Z', method: 'cod', total: 80, status: 'cancelled' },
  { id: 'BUH-F', at: '2026-08-16T10:00:00Z', method: 'online_card', total: 999, status: 'pending_payment', card: { state: 'pending' } },
  { id: 'BUH-G', at: '2026-08-17T10:00:00Z', method: 'online_card', total: 50, paymentStatus: 'paid', card: { state: 'paid', paidFils: 5_000, live: false } },
  // 00:30 on 1 August in the UAE (still 31 July in UTC): August.
  { id: 'BUH-H', at: '2026-07-31T20:30:00Z', method: 'cod', total: 40 },
  // 00:30 on 1 September in the UAE: September, not August.
  { id: 'BUH-I', at: '2026-08-31T20:30:00Z', method: 'cod', total: 70 },
  // 23:30 on 31 August in the UAE: August.
  { id: 'BUH-K', at: '2026-08-31T19:30:00Z', method: 'bank_transfer', total: 10, bank: 'awaiting' },
  // A partial refund (from the Stripe dashboard) of AED 50 on a paid order.
  { id: 'BUH-J', at: '2026-08-18T10:00:00Z', method: 'online_card', total: 200, paymentStatus: 'paid', card: { state: 'paid', paidFils: 20_000, refundedFils: 5_000, refundedAt: '2026-08-19T10:00:00Z' } },
  { id: 'BUH-Z', at: '2026-07-20T10:00:00Z', method: 'cod', total: 1000, status: 'delivered', paymentStatus: 'paid', name: '=cmd|calc' },
];
for (const f of FIXTURES) insert(f);

const k = () => `rk-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const e1 = ex.createExpense({ date: '2026-08-03', amount: '0.10', categoryId: 'packaging', method: 'cash', payee: '=HYPERLINK("http://evil")', note: '@SUM(A1)' }, OWNER, k()).expense;
ex.createExpense({ date: '2026-08-31', amount: '0.20', categoryId: 'packaging', method: 'card', payee: '+cmd' }, OWNER, k()).expense;
const e3 = ex.createExpense({ date: '2026-08-01', amount: '1500', categoryId: 'rent', method: 'bank_transfer', payee: 'Landlord' }, OWNER, k()).expense;
const gone = ex.createExpense({ date: '2026-08-02', amount: '999', categoryId: 'other', method: 'cash' }, OWNER, k()).expense;
ex.removeExpense(gone.id, 'entered twice', OWNER);
ex.createExpense({ date: '2026-07-31', amount: '777', categoryId: 'other', method: 'cash' }, OWNER, k());
const bill1 = ex.attachBill(e1.id, `data:image/png;base64,${PNG.toString('base64')}`, 'b.png', OWNER);
const bill2 = ex.attachBill(e1.id, `data:application/pdf;base64,${Buffer.from('%PDF-1.4 bill two....').toString('base64')}`, 'b.pdf', OWNER);
const offBill = ex.attachBill(e3.id, `data:image/png;base64,${PNG.toString('base64')}`, 'wrong.png', OWNER);
ex.removeBill(e3.id, offBill.id, 'wrong photo', OWNER);

test('August, by hand: sales, refunds, net sales, methods, expenses by category, profit; cancelled, unpaid-card and test orders left out', () => {
  const r = reports.buildReport('2026-08-01', '2026-08-31');
  // Counted: A 100 + B 250.50 + C 300 + D 120 + H 40 + K 10 + J 200 = 1020.50.
  assert.equal(r.sales.orders, 7);
  assert.equal(r.sales.grossFils, 102_050);
  // Refunds dated in August: D 120 + J 50.
  assert.deepEqual(r.refunds, { count: 2, fils: 17_000 });
  assert.equal(r.netSalesFils, 85_050);
  assert.deepEqual(r.byMethod.cod, { orders: 2, fils: 14_000, paidOrders: 1, paidFils: 10_000 });
  assert.deepEqual(r.byMethod.bank_transfer, { orders: 2, fils: 26_050, paidOrders: 1, paidFils: 25_050 });
  assert.deepEqual(r.byMethod.online_card, { orders: 3, fils: 62_000, paidOrders: 3, paidFils: 62_000 });
  assert.equal(r.sales.unpaidFils, 4_000 + 1_000, 'H (cash not collected) and K (transfer not received)');
  assert.deepEqual(r.card, { paidCount: 3, paidFils: 62_000, refundedFils: 17_000 });
  assert.deepEqual(r.excluded, { cancelled: 1, awaitingCard: 1, testMode: 1 });
  // Expenses: 0.10 + 0.20 (exactly 0.30) + 1500; the removed one and July's are out.
  assert.equal(r.expenses.count, 3);
  assert.equal(r.expenses.fils, 150_030);
  assert.deepEqual(r.expenses.byCategory.map((c) => [c.name, c.count, c.fils]), [['Rent', 1, 150_000], ['Packaging', 2, 30]]);
  assert.equal(r.profitFils, 85_050 - 150_030);
});

test('September: the late refund of an August sale, and the order placed at 00:30 on 1 September (UAE time)', () => {
  const r = reports.buildReport('2026-09-01', '2026-09-30');
  assert.equal(r.sales.orders, 1);
  assert.equal(r.sales.grossFils, 7_000);
  assert.deepEqual(r.refunds, { count: 1, fils: 30_000 });
  assert.equal(r.netSalesFils, 7_000 - 30_000);
});

test('periods: months, quarters and financial years in UAE dates, also when the year starts in another month', () => {
  assert.deepEqual(periods.monthPeriod(2028, 2), { from: '2028-02-01', to: '2028-02-29', label: 'February 2028' });
  assert.deepEqual(periods.financialYear(2026), { from: '2026-01-01', to: '2026-12-31', label: 'FY 2026' });
  assert.deepEqual(periods.financialYear(2026, 4), { from: '2026-04-01', to: '2027-03-31', label: 'FY 2026–27' });
  assert.deepEqual(periods.quarterPeriod(2026, 4, 4), { from: '2027-01-01', to: '2027-03-31', label: 'Q4 FY 2026–27' });
  assert.deepEqual(periods.periodContaining('quarter', '2026-08-15'), { from: '2026-07-01', to: '2026-09-30', label: 'Q3 FY 2026' });
  assert.equal(periods.financialYearOf('2027-02-10', 4), 2026);
  assert.equal(periods.dubaiDateOf('2026-08-31T20:30:00Z'), '2026-09-01');
  assert.equal(periods.dubaiDateOf('2026-08-31T19:59:59Z'), '2026-08-31');
  assert.deepEqual(periods.twelveMonthsTo('2026-10-18'), { from: '2025-10-19', to: '2026-10-18' });
  assert.deepEqual(periods.twelveMonthsTo('2028-02-29'), { from: '2027-03-01', to: '2028-02-29' });
  assert.equal(reports.yearStartMonth(), 1, 'the calendar year by default');
  reports.setYearStartMonth(4);
  assert.equal(reports.yearStartMonth(), 4);
  reports.setYearStartMonth(1);
  for (const bad of [0, 13, 1.5, '4', null]) assert.throws(() => reports.setYearStartMonth(bad));
  for (const [from, to] of [['2026-08-31', '2026-08-01'], ['2026-02-30', '2026-03-01'], ['x', '2026-01-01'], ['2010-01-01', '2026-01-01'], ['2020-01-01', '2026-01-01']]) {
    assert.throws(() => reports.parsePeriod(from, to), (e: { status?: number }) => e.status === 400, `${from}..${to}`);
  }
});

test('VAT (not registered): 12-month sales against AED 375,000; a warning from 80%, "mandatory" from 100%; older sales and refunds count right', () => {
  const now = Date.parse('2026-10-18T08:00:00Z');
  const order = (total: number, at = '2026-05-01T10:00:00Z') => ({ id: 'BUH-V', createdAt: at, total, status: 'delivered', paymentMethod: 'cod', paymentStatus: 'paid' }) as never;
  const ok = reports.vatStatus(now, [order(299_999.99)]);
  assert.equal(ok.level, 'ok');
  assert.equal(ok.registered, false);
  assert.match(ok.text, /^Not VAT-registered/);
  const near = reports.vatStatus(now, [order(200_000), order(100_000)]);
  assert.equal(near.level, 'near');
  assert.match(near.text, /80% of the AED 375,000 VAT registration threshold/);
  const over = reports.vatStatus(now, [order(375_000)]);
  assert.equal(over.level, 'over');
  assert.match(over.text, /mandatory/);
  assert.equal(reports.vatStatus(now, [order(375_000, '2025-10-18T10:00:00Z')]).level, 'ok', 'a sale 12 months and a day ago is outside the window');
  assert.equal(reports.vatStatus(now, [order(375_000, '2025-10-18T21:00:00Z')]).level, 'over', 'the 19th in the UAE is inside');
  assert.deepEqual([over.from, over.to], ['2025-10-19', '2026-10-18']);
  // The monitor raises it too.
  assert.match(fs.readFileSync('src/lib/server/monitor.ts', 'utf8'), /id: 'vat', level: 'warning', text: vat\.text/);
});

test('CSV: UTF-8 with a BOM, formula-injection safe (= + - @ get an apostrophe), amounts as plain decimals', () => {
  const csv = toCsv(['a', 'b', 'c', 'd'], [['=1+1', '+971', '-2+3', '@SUM(A1)'], ['-3.05', '12.50', 'فاطمة', 'tab\there']]);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes("'=1+1,'+971,'-2+3,'@SUM(A1)"));
  assert.ok(csv.includes('-3.05,12.50,فاطمة'), 'a negative number stays a number');
  assert.equal(aedText(30), '0.30');
  assert.equal(aedText(125_050), '1250.50');
  assert.equal(aedText(-305), '-3.05');
  assert.equal(aedText(7), '0.07');
});

test('the accountant\'s ZIP: every file, sales and expenses as in the report, bills named date_category_amount_id, the period\'s audit log and its check', () => {
  const result = reports.writeAccountantZip('2026-08-01', '2026-08-31', 'Beautiful UAE Home');
  assert.equal(result.name, 'accounts_2026-08-01_to_2026-08-31.zip');
  assert.ok(result.file.startsWith(path.join(dir, 'exports')), 'built in the private exports folder');
  const zip = readZip(fs.readFileSync(result.file));
  const names = [...zip.keys()];
  // A standard tool opens it too (Info-ZIP's unzip, like Windows Explorer reads the same format).
  const unzip = spawnSync('unzip', ['-t', result.file], { encoding: 'utf8' });
  if (!unzip.error) {
    assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
    assert.match(unzip.stdout, /No errors detected/);
  }
  const billNames = [`bills/2026-08-03_packaging_0.10_${e1.id}.png`, `bills/2026-08-03_packaging_0.10_${e1.id}-2.pdf`];
  assert.deepEqual(names.filter((x) => !x.startsWith('bills/')), ['README.txt', 'summary.html', 'summary.csv', 'sales.csv', 'order-items.csv', 'expenses.csv', 'audit-log.jsonl', 'audit-check.txt']);
  assert.deepEqual(names.filter((x) => x.startsWith('bills/')), billNames, 'active bills only (the one taken off is not sent)');
  assert.deepEqual(zip.get(billNames[0]), ex.readBill(e1.id, bill1.id)!.bytes);
  assert.deepEqual(zip.get(billNames[1]), ex.readBill(e1.id, bill2.id)!.bytes);
  assert.equal(result.bills, 2);

  const sales = zip.get('sales.csv')!.toString('utf8');
  assert.ok(sales.startsWith('\ufeffdate,order_number,customer_name,emirate,items,quantity,items_aed,delivery_fee_aed,cod_fee_aed,discount_aed,total_aed,payment_method,payment_status,payment_ref,paid,refund_aed,refund_date,order_status,courier,awb,counted_in_sales'));
  const rows = sales.trim().split('\r\n').slice(1);
  assert.equal(rows.length, 10, 'every order placed in August, the ones not counted too');
  const row = (id: string) => rows.find((r) => r.includes(`,${id},`))!;
  assert.match(row('BUH-B'), /^2026-08-10,BUH-B,Layla Test,Dubai,Mughal Garden \(King\) x1,1,250\.50,0\.00,0\.00,0\.00,250\.50,Bank transfer,paid,,yes,/);
  assert.match(row('BUH-D'), /,Card \(Stripe\),refunded,pi_BUH-D,yes,120\.00,2026-08-20,cancelled,/);
  assert.match(row('BUH-E'), /,no,cancelled,/);
  assert.match(row('BUH-G'), /,no,Stripe test mode/);
  assert.match(row('BUH-H'), /^2026-08-01,BUH-H,/, 'the UAE date');
  assert.ok(!rows.some((r) => r.includes('BUH-I') || r.includes('BUH-Z')), 'other months are not in it');
  assert.equal(zip.get('order-items.csv')!.toString().trim().split('\r\n').length, 11);

  const expenses = zip.get('expenses.csv')!.toString('utf8');
  assert.ok(expenses.startsWith('\ufeffexpense_id,date,category,paid_to,method,amount_aed,note,bills,status'));
  assert.ok(expenses.includes(`"'=HYPERLINK(""http://evil"")"`), 'the payee is not a formula');
  assert.ok(expenses.includes("'@SUM(A1)") && expenses.includes("'+cmd"));
  assert.ok(expenses.includes(`2026-08-03_packaging_0.10_${e1.id}.png; 2026-08-03_packaging_0.10_${e1.id}-2.pdf`));
  assert.match(expenses, new RegExp(`${gone.id},2026-08-02,Other,,Cash,999\\.00,,,removed,[^,]+,${OWNER},entered twice`), 'the removed one is listed, marked');
  assert.match(expenses, /,1500\.00,/);

  const summary = zip.get('summary.csv')!.toString('utf8');
  assert.ok(summary.includes('Sales,Gross sales,7,1020.50'));
  assert.ok(summary.includes('Sales,Refunds,2,-170.00'));
  assert.ok(summary.includes('Sales,Net sales,,850.50'));
  assert.ok(summary.includes('Expenses,Total expenses,3,1500.30'));
  assert.ok(summary.includes('Result,Profit (net sales less expenses),,-649.80'));
  const html = zip.get('summary.html')!.toString();
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('1020.50') && html.includes('Not VAT-registered'));
  assert.ok(!html.includes('<script'), 'no script in the printable summary');
  const readme = zip.get('README.txt')!.toString();
  assert.match(readme, /2026-08-01 to 2026-08-31/);
  assert.match(readme, /audit-log\.jsonl/);
  assert.match(readme, /The log is intact/);

  // Everything in this test's log happened today, not in August: the period's log is empty.
  assert.equal(zip.get('audit-log.jsonl')!.toString(), '');
  assert.match(zip.get('audit-check.txt')!.toString(), /intact/);
  fs.rmSync(result.file);
});

test('the ZIP includes the audit entries of the period (and only those), with their signatures', () => {
  const today = periods.dubaiToday();
  const result = reports.writeAccountantZip(today, today);
  const zip = readZip(fs.readFileSync(result.file));
  const lines = zip.get('audit-log.jsonl')!.toString().trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.action === 'expense.created' && e.details.expenseId === e1.id));
  assert.ok(lines.every((e) => typeof e.mac === 'string' && e.mac.length > 20 && periods.dubaiDateOf(e.at) === today));
  fs.rmSync(result.file);
});

test('the audit viewer: newest first, filters by date, action (prefix), who and order; pages of 50', () => {
  for (let i = 0; i < 60; i++) auditLib.audit('test.viewer', { by: i % 2 ? 'a@shop.test' : 'stripe', orderId: `BUH-VIEW-${i}`, n: i });
  const all = view.auditPage({ action: 'test.viewer' });
  assert.equal(all.total, 60);
  assert.equal(all.pages, 2);
  assert.equal(all.entries.length, 50);
  assert.equal(all.entries[0].details.n, 59, 'newest first');
  assert.equal(view.auditPage({ action: 'test.viewer', page: 2 }).entries.length, 10);
  assert.equal(view.auditPage({ action: 'test.', who: 'stripe' }).total, 30, 'by who');
  assert.equal(view.auditPage({ action: 'test.viewer', order: 'buh-view-17' }).total, 1, 'by order number (any case)');
  assert.equal(view.auditPage({ order: e1.id }).entries.every((e) => e.details.expenseId === e1.id), true, 'an expense number finds its entries');
  assert.ok(view.auditPage({ order: e1.id }).total >= 3);
  assert.equal(view.auditPage({ action: 'expense.' }).entries.every((e) => e.action.startsWith('expense.')), true);
  assert.equal(view.auditPage({ action: 'test.viewer', from: '2020-01-01', to: '2020-01-31' }).total, 0, 'by date');
  const today = periods.dubaiToday();
  assert.equal(view.auditPage({ action: 'test.viewer', from: today, to: today }).total, 60);
  assert.ok(all.actions.includes('expense.created') && all.actions.includes('test.viewer'));
  assert.equal(all.verification.ok, true);
  assert.deepEqual(view.verificationText(all.verification).length, 1);
  assert.match(view.verificationText(all.verification)[0], /^The log is intact: \d+ entries/);
  // Exports: CSV (Excel-safe, with a BOM) and the original signed lines.
  const entries = view.auditEntries({ action: 'test.viewer', who: 'stripe' });
  const csv = view.auditExport(entries, 'csv');
  assert.ok(csv.startsWith('\ufeffat_utc,date_uae,seq,action,who,order,details,entry_id,file,line,mac'));
  assert.equal(csv.trim().split('\r\n').length, 31);
  const jsonl = view.auditExport(entries, 'jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(jsonl.length, 30);
  assert.ok(jsonl.every((e) => e.mac && e.prev && !('file' in e)));
});

test('the chain check says where the log breaks (an edited line), and tells a log signed by another server from tampering', () => {
  const file = path.join(dir, `audit-${new Date().toISOString().slice(0, 7)}.jsonl`);
  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n').filter(Boolean);
  const edited = JSON.parse(lines[4]);
  edited.details.amountFils = 1;
  fs.writeFileSync(file, [...lines.slice(0, 4), JSON.stringify(edited), ...lines.slice(5)].join('\n') + '\n');
  let v = auditLib.verifyAllAuditLogs();
  assert.equal(v.ok, false);
  assert.equal(v.months[0].problems[0], 'line 5: MAC mismatch');
  assert.match(view.verificationText(v)[0], /BROKEN at line 5: MAC mismatch/);
  // A line removed: the next one's link to it breaks.
  fs.writeFileSync(file, [...lines.slice(0, 6), ...lines.slice(7)].join('\n') + '\n');
  v = auditLib.verifyAllAuditLogs();
  assert.match(v.months[0].problems.join(' '), /line 7: sequence gap.*line 7: chain broken/);
  fs.writeFileSync(file, original);
  assert.equal(auditLib.verifyAllAuditLogs().ok, true, 'intact again');
  // Another server's key (a restore onto a new server): every link in order, no signature checks.
  const keyFile = path.join(dir, 'audit.key');
  const key = fs.readFileSync(keyFile, 'utf8');
  fs.writeFileSync(keyFile, Buffer.alloc(32, 9).toString('base64url'));
  auditLib._resetAuditState();
  try {
    v = auditLib.verifyAllAuditLogs();
    assert.equal(v.ok, false);
    assert.equal(v.months[0].otherKey, true);
    assert.match(view.verificationText(v)[0], /signed with another server's key/);
  } finally {
    fs.writeFileSync(keyFile, key);
    auditLib._resetAuditState();
  }
  assert.equal(auditLib.verifyAllAuditLogs().ok, true);
});

test('the viewer never shows secrets: the entries are redacted when written', () => {
  auditLib.audit('test.secret', { by: OWNER, password: 'hunter2', note: 'call +971 50 123 4567 or a@b.com', stripeSecretKey: 'sk_live_abcdefghijk' });
  const e = view.auditPage({ action: 'test.secret' }).entries[0];
  const text = JSON.stringify(e);
  assert.ok(!text.includes('hunter2') && !text.includes('123 4567') && !text.includes('a@b.com') && !text.includes('sk_live_abcdefghijk'), text);
  assert.equal(e.who, OWNER);
});
