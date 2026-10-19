/**
 * UAE VAT, opt-in and off by default. The maths in whole fils (inclusive: round(total × 5/105), shared
 * across the lines so they add up; exclusive: 5% on top, half up); nothing about VAT with it off or
 * before the effective date (and old orders never rewritten); switching on needs a valid TRN, a date
 * not in the past and the typed confirmation, and is audited; the tax invoice series is gap-free,
 * also with several copies of the shop issuing at once and with a rolled-back transaction; credit
 * notes follow refunds (partial, full, a refund that failed) and cancellations; the VAT return
 * helper's totals and CSV; expenses carry their VAT and the supplier's TRN; and a backup brings all
 * of it back.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
const money = await import('@/lib/money');
const vat = await import('@/lib/server/vat');
const orders = await import('@/lib/server/orders');
const products = await import('@/lib/server/products');
const ex = await import('@/lib/server/expenses');
const backup = await import('@/lib/server/backup');
const doc = await import('@/lib/server/taxDocument');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getDb, inTransaction } = await import('@/lib/server/db');
const { dubaiToday } = await import('@/lib/reportPeriods');
const { kvSet } = await import('@/lib/server/kv');

const OWNER = 'owner@shop.test';
const TRN = '100123456700003';
let n = 0;
const key = () => `vat-key-${++n}-${Date.now()}`;
const auditLines = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> }));
const statusOf = (fn: () => unknown) => {
  try {
    fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

function placeCod(quantity = 1) {
  // Round the catalogue, so no one size sells out.
  const list = products.listProducts();
  const p = list[n % list.length];
  return orders.placeOrder({
    idempotencyKey: key(),
    verificationToken: issuePhoneToken(`+9715066${String(++n).padStart(5, '0')}`),
    customer: { fullName: 'Noura Customer', email: 'buyer@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '1' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity }],
    paymentMethod: 'cod',
  }).order;
}
const vatRow = (id: string) => getDb().prepare('SELECT * FROM order_vat WHERE order_id = ?').get(id) as { vat_fils: number; total_fils: number; net_fils: number; lines: string } | undefined;
const fils = (aed: number) => Math.round(aed * 100);
function turnOn(over: Record<string, unknown> = {}) {
  return vat.saveVatSettings({ enabled: true, trn: TRN, effectiveFrom: dubaiToday(), legalName: 'Beautiful UAE Home Trading LLC', address: 'Shop 4, Marina Walk, Dubai', confirm: 'TURN ON VAT', ...over }, OWNER);
}
const turnOff = () => vat.saveVatSettings({ enabled: false }, OWNER);

test('VAT maths in whole fils: inclusive round(total × 5/105), exclusive 5% on top, half up', () => {
  assert.equal(money.vatInsideFils(10500), 500);
  assert.equal(money.vatInsideFils(100), 5, '4.76 → 5');
  assert.equal(money.vatInsideFils(1), 0);
  assert.equal(money.vatInsideFils(21), 1);
  assert.equal(money.vatInsideFils(49900), 2376, '499 AED: 23.7619 → 23.76');
  assert.equal(money.vatInsideFils(-10500), -500, 'a reversal');
  assert.equal(money.vatOnTopFils(10000), 500);
  assert.equal(money.vatOnTopFils(10010), 501, '500.5 → 501 (half up)');
  assert.equal(money.vatOnTopFils(10009), 500);
  assert.equal(money.vatOnTopFils(0), 0);
  // Against the exact fraction for every total up to AED 2,000: never more than half a fil off.
  for (let t = 0; t <= 200_000; t += 7) {
    const exact = (t * 5) / 105;
    assert.ok(Math.abs(money.vatInsideFils(t) - exact) <= 0.5 + 1e-9, String(t));
  }
});

test('several lines: VAT worked out once on the whole and shared so the lines add up exactly', () => {
  const lines = [
    { kind: 'item' as const, label: 'A', quantity: 2, amountFils: 33333 },
    { kind: 'item' as const, label: 'B', quantity: 1, amountFils: 19999 },
    { kind: 'delivery' as const, label: 'Delivery', quantity: 1, amountFils: 2500 },
    { kind: 'card_fee' as const, label: 'Card fee', quantity: 1, amountFils: 1954 },
  ];
  const total = 33333 + 19999 + 2500 + 1954;
  const b = vat.computeVat(lines, { rateBp: 500, inclusive: true });
  assert.equal(b.totalFils, total);
  assert.equal(b.vatFils, money.vatInsideFils(total));
  assert.equal(b.lines.reduce((s, l) => s + l.vatFils, 0), b.vatFils, 'line VAT adds up to the total VAT');
  assert.equal(b.lines.reduce((s, l) => s + l.netFils, 0), b.netFils);
  for (const l of b.lines) assert.equal(l.netFils + l.vatFils, l.totalFils);
  // Each line within a fil of its own exact share.
  for (const l of b.lines) assert.ok(Math.abs(l.vatFils - (l.totalFils * 5) / 105) < 1.01, l.label);
  const e = vat.computeVat(lines, { rateBp: 500, inclusive: false });
  assert.equal(e.netFils, total);
  assert.equal(e.vatFils, money.vatOnTopFils(total));
  assert.equal(e.totalFils, total + e.vatFils);
  assert.equal(e.lines.reduce((s, l) => s + l.totalFils, 0), e.totalFils);
  assert.deepEqual(vat.allocate([1, 1, 1], 2), [1, 1, 0], 'leftover fils go to the largest remainders, first first');
  assert.deepEqual(vat.allocate([10, 20], 0), [0, 0]);
});

test('off by default: no VAT on orders, a plain "Receipt" with no TRN, no VAT on the storefront', () => {
  assert.equal(vat.vatSettings().enabled, false);
  assert.equal(vat.checkoutVat(), null);
  const o = placeCod();
  assert.equal(vatRow(o.id), undefined);
  const view = orders.customerView(o);
  assert.equal(view.documentLabel, 'Receipt');
  assert.match(view.documentPath, new RegExp(`^/invoice/${o.id}\\.[A-Za-z0-9_-]{43}$`));
  const html = doc.orderDocumentHtml(o);
  assert.match(html, /<h1>Receipt<\/h1>/);
  assert.doesNotMatch(html, /\bVAT\b|\bTRN\b|Tax Invoice/i);
  assert.equal(vat.vatAddedPercent(), null);
  assert.equal(vat.vatInUse(), false);
});

test('switching on: a 15-digit TRN, a date not in the past, the typed confirmation; audited; TRN and date fixed while on', () => {
  const tomorrow = new Date(Date.now() + 4 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 4 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
  assert.equal(statusOf(() => turnOn({ trn: '12345' })), 400, 'not 15 digits');
  assert.equal(statusOf(() => turnOn({ trn: '111111111111111' })), 400, 'not a real TRN');
  assert.equal(statusOf(() => turnOn({ confirm: 'yes' })), 400, 'confirmation not typed');
  assert.equal(statusOf(() => turnOn({ effectiveFrom: yesterday })), 400, 'in the past');
  assert.equal(statusOf(() => turnOn({ effectiveFrom: '2026-02-30' })), 400);
  assert.equal(statusOf(() => vat.saveVatSettings({ enabled: true, trn: TRN, effectiveFrom: tomorrow, confirm: 'TURN ON VAT', ratePercent: 7 }, OWNER)), 400, 'the rate is 5%');
  assert.equal(statusOf(() => vat.saveVatSettings({ enabled: true, extra: 1 } as never, OWNER)), 400, 'allow-list');
  assert.equal(vat.vatSettings().enabled, false, 'nothing saved');
  // On from tomorrow: an order today has no VAT.
  const s = turnOn({ effectiveFrom: tomorrow, trn: '100-1234-5670-0003' });
  assert.equal(s.enabled, true);
  assert.equal(s.trn, TRN, 'dashes dropped');
  assert.equal(s.pricesIncludeVat, true, 'prices include VAT by default');
  const entry = auditLines().find((l) => l.action === 'vat.enabled');
  assert.ok(entry, 'audited');
  assert.equal(entry.details.by, OWNER);
  assert.equal(vat.checkoutVat(), null, 'not yet: before the effective date');
  const today = placeCod();
  assert.equal(vatRow(today.id), undefined, 'no VAT before the date');
  assert.equal(statusOf(() => vat.saveVatSettings({ trn: '100999999999993' }, OWNER)), 409, 'TRN fixed while on');
  assert.equal(statusOf(() => vat.saveVatSettings({ effectiveFrom: dubaiToday() }, OWNER)), 409, 'date fixed while on');
  turnOff();
  assert.ok(auditLines().some((l) => l.action === 'vat.disabled'));
});

let vatOrder: ReturnType<typeof placeCod>;
let beforeOrder: ReturnType<typeof placeCod>;

test('from the effective date: the breakdown is stored in fils on the server; earlier orders stay without VAT', () => {
  beforeOrder = placeCod();
  turnOn();
  vatOrder = placeCod(2);
  const row = vatRow(vatOrder.id)!;
  assert.ok(row, 'stored');
  assert.equal(row.total_fils, fils(vatOrder.total), 'prices include VAT: the total is unchanged');
  assert.equal(row.vat_fils, money.vatInsideFils(fils(vatOrder.total)));
  assert.equal(row.net_fils + row.vat_fils, row.total_fils);
  assert.equal(vatRow(beforeOrder.id), undefined, 'an earlier order is never rewritten');
  // Writing the earlier order again (a status change) still gives it no VAT.
  orders.updateOrderByAdmin(beforeOrder.id, { status: 'confirmed' }, OWNER);
  assert.equal(vatRow(beforeOrder.id), undefined);
  assert.equal(vat.invoiceFor(beforeOrder.id), null);
  assert.match(doc.orderDocumentHtml(orders.getOrder(beforeOrder.id)!), /<h1>Receipt<\/h1>/);
  assert.equal(orders.customerView(vatOrder).documentLabel, 'Tax invoice');
});

test('the tax invoice: issued once the order is a supply (confirmed), with everything the FTA asks for', () => {
  assert.equal(vat.invoiceFor(vatOrder.id), null, 'not yet: waiting for confirmation');
  const waiting = doc.orderDocumentHtml(orders.getOrder(vatOrder.id)!);
  assert.match(waiting, /Order summary/);
  assert.match(waiting, /issued here once your order is confirmed/);
  orders.updateOrderByAdmin(vatOrder.id, { status: 'confirmed' }, OWNER);
  const inv = vat.invoiceFor(vatOrder.id)!;
  assert.ok(inv);
  assert.match(inv.number, /^INV-\d{6}$/);
  const html = doc.orderDocumentHtml(orders.getOrder(vatOrder.id)!);
  assert.match(html, /<h1>Tax Invoice<\/h1>/);
  assert.ok(html.includes('Beautiful UAE Home Trading LLC'), 'supplier name');
  assert.ok(html.includes('Shop 4, Marina Walk, Dubai'), 'supplier address');
  assert.ok(html.includes(`TRN: <strong>${TRN}</strong>`), 'TRN');
  assert.ok(html.includes(inv.number), 'invoice number');
  assert.ok(html.includes('Total including VAT'));
  assert.ok(html.includes(`AED ${(inv.vatFils / 100).toFixed(2)}`), 'the VAT amount');
  assert.ok(html.includes('Noura Customer'), 'the customer’s name is fine');
  assert.doesNotMatch(html, /<script/i, 'no scripts');
  // Writing the order again changes nothing: one invoice per order.
  orders.updateOrderByAdmin(vatOrder.id, { adminNotes: 'again' }, OWNER);
  assert.equal(vat.invoiceFor(vatOrder.id)!.number, inv.number);
  assert.ok(auditLines().some((l) => l.action === 'vat.invoice_issued' && l.details.orderId === vatOrder.id));
});

test('the invoice series is gap-free: a rolled-back transaction does not use a number', () => {
  const a = placeCod();
  const b = placeCod();
  const last = getDb().prepare('SELECT MAX(seq) FROM vat_invoices').pluck().get() as number;
  assert.throws(() =>
    inTransaction(() => {
      vat.issueInvoice(a.id);
      throw new Error('the order change failed');
    })
  );
  assert.equal(vat.invoiceFor(a.id), null, 'rolled back with it');
  assert.equal(vat.issueInvoice(b.id).seq, last + 1, 'the next number is still the next one');
  assert.equal(vat.issueInvoice(a.id).seq, last + 2);
  assert.equal(vat.issueInvoice(a.id).seq, last + 2, 'asking again: the same invoice');
});

test('the invoice series is gap-free and has no doubles with several copies of the shop issuing at once', async () => {
  // 40 orders with a VAT breakdown, numbered by 4 processes at the same moment (each takes them all, in its own order).
  const ids = Array.from({ length: 40 }, () => placeCod().id);
  getDb().pragma('wal_checkpoint(FULL)');
  const script = `
    process.env.DATA_DIR = ${JSON.stringify(dir)};
    const m = await import('@/lib/server/vat');
    const vat = m.issueInvoice ? m : m.default;
    const ids = JSON.parse(process.argv[1]);
    const start = Number(process.argv[2]);
    while (Date.now() < start) await new Promise((r) => setTimeout(r, 2));
    for (const id of ids) vat.issueInvoice(id);
  `;
  const start = Date.now() + 1500;
  const runs = [0, 1, 2, 3].map((k) => {
    const order = k % 2 ? [...ids].reverse() : ids.slice(k * 5).concat(ids.slice(0, k * 5));
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(order), String(start)], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
  });
  await Promise.all(runs);
  const rows = getDb().prepare('SELECT seq, number, order_id FROM vat_invoices ORDER BY seq').all() as Array<{ seq: number; number: string; order_id: string }>;
  rows.forEach((r, i) => {
    assert.equal(r.seq, i + 1, 'no gaps');
    assert.equal(r.number, `INV-${String(i + 1).padStart(6, '0')}`);
  });
  for (const id of ids) assert.equal(rows.filter((r) => r.order_id === id).length, 1, `one invoice for ${id}`);
});

test('credit notes: a cancelled invoiced order is credited in full, linked to its invoice', () => {
  const o = placeCod();
  orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, OWNER);
  const inv = vat.invoiceFor(o.id)!;
  orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, OWNER);
  const notes = vat.creditNotesFor(o.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].number, /^CN-\d{6}$/);
  assert.equal(notes[0].invoiceNumber, inv.number);
  assert.equal(notes[0].reason, 'cancelled');
  assert.equal(notes[0].totalFils, inv.totalFils);
  assert.equal(notes[0].vatFils, inv.vatFils, 'the invoice’s own VAT, exactly');
  vat.syncVatDocuments(o.id);
  assert.equal(vat.creditNotesFor(o.id).length, 1, 'idempotent');
  assert.match(doc.orderDocumentHtml(orders.getOrder(o.id)!), new RegExp(`${notes[0].number}.*against ${inv.number}`));
  // Cancelled before it was ever confirmed: no invoice, so no credit note.
  const early = placeCod();
  orders.updateOrderByAdmin(early.id, { status: 'cancelled' }, OWNER);
  assert.equal(vat.invoiceFor(early.id), null);
  assert.equal(vat.creditNotesFor(early.id).length, 0);
});

test('credit notes follow card refunds from the ledger: partial, the rest, and a refund that failed afterwards', () => {
  const o = placeCod(3);
  const total = fils(o.total);
  // A live card payment taken (the columns Stripe's word sets).
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'paid', card_livemode = 1, paid_fils = ? WHERE id = ?").run(total, o.id);
  vat.syncVatDocuments(o.id);
  const inv = vat.invoiceFor(o.id)!;
  assert.ok(inv, 'a paid card order is invoiced');
  orders.noteRefundedSoFar(o.id, 5000);
  let notes = vat.creditNotesFor(o.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].reason, 'refund');
  assert.equal(notes[0].totalFils, 5000);
  assert.equal(notes[0].vatFils, money.vatInsideFils(5000), 'the VAT share of the refund');
  orders.noteRefundedSoFar(o.id, total);
  notes = vat.creditNotesFor(o.id);
  assert.equal(notes.length, 2);
  assert.equal(notes[1].totalFils, total - 5000);
  assert.equal(notes.reduce((s, c) => s + c.vatFils, 0), inv.vatFils, 'refunded in full: all the VAT credited, no fil lost');
  // The second refund failed afterwards: the credit comes back as a negative note.
  orders.noteRefundedSoFar(o.id, 5000);
  notes = vat.creditNotesFor(o.id);
  assert.equal(notes.length, 3);
  assert.equal(notes[2].reason, 'refund_reversed');
  assert.equal(notes[2].totalFils, -(total - 5000));
  assert.equal(notes.reduce((s, c) => s + c.totalFils, 0), 5000);
  // A Stripe test-mode payment is never invoiced.
  const t = placeCod();
  getDb().prepare("UPDATE orders SET payment_method = 'online_card', card_state = 'paid', card_livemode = 0 WHERE id = ?").run(t.id);
  vat.syncVatDocuments(t.id);
  assert.equal(vat.invoiceFor(t.id), null);
});

test('prices excluding VAT: 5% added on top at checkout, the total includes it, the storefront is told', () => {
  turnOff();
  turnOn({ pricesIncludeVat: false });
  assert.equal(vat.vatAddedPercent(), 5);
  const o = placeCod();
  const net = fils(o.subtotal) + fils(o.deliveryFee) + fils(o.codFee);
  assert.equal(fils(o.vatAdded ?? 0), money.vatOnTopFils(net));
  assert.equal(fils(o.total), net + money.vatOnTopFils(net));
  const row = vatRow(o.id)!;
  assert.equal(row.net_fils, net);
  assert.equal(row.total_fils, fils(o.total));
  vat.saveVatSettings({ pricesIncludeVat: true }, OWNER);
  assert.equal(vat.vatAddedPercent(), null);
});

test('expenses carry the VAT on the bill and the supplier TRN (checked), kept in their versions', () => {
  const e = ex.createExpense({ date: dubaiToday(), amount: '105.00', categoryId: 'stock', method: 'card', payee: 'Fabric House', vat: '5.00', supplierTrn: '100 2222 3333 4444' }, OWNER).expense;
  assert.equal(e.vatFils, 500);
  assert.equal(e.supplierTrn, '100222233334444');
  assert.equal(statusOf(() => ex.createExpense({ date: dubaiToday(), amount: '10', categoryId: 'stock', method: 'card', vat: '11' }, OWNER)), 400, 'VAT over the amount');
  assert.equal(statusOf(() => ex.createExpense({ date: dubaiToday(), amount: '10', categoryId: 'stock', method: 'card', supplierTrn: '123' }, OWNER)), 400, 'TRN not 15 digits');
  const noTrn = ex.createExpense({ date: dubaiToday(), amount: '21.00', categoryId: 'packaging', method: 'cash', vat: '1.00' }, OWNER).expense;
  assert.equal(noTrn.supplierTrn, undefined);
  const edited = ex.updateExpense(e.id, { version: e.version, vat: '4.50' }, OWNER);
  assert.equal(edited.vatFils, 450);
  assert.equal(ex.expenseVersions(e.id)[0].data.vatFils, 500, 'the earlier version kept');
  const removedVat = ex.updateExpense(noTrn.id, { version: noTrn.version, vat: '' }, OWNER);
  assert.equal(removedVat.vatFils, undefined, 'cleared');
  ex.updateExpense(noTrn.id, { version: removedVat.version, vat: '1.00' }, OWNER);
  // Without VAT fields an expense is as before.
  const plain = ex.createExpense({ date: dubaiToday(), amount: '12', categoryId: 'other', method: 'cash' }, OWNER).expense;
  assert.equal(plain.vatFils, undefined);
});

test('the VAT return helper: sales and output VAT, credit notes, input VAT from expenses; the CSV', () => {
  const today = dubaiToday();
  const r = vat.vatReturn(today, today);
  const db = getDb();
  const inv = db.prepare('SELECT COUNT(*) AS n, SUM(net_fils) AS net, SUM(vat_fils) AS v FROM vat_invoices WHERE issued_on = ?').get(today) as { n: number; net: number; v: number };
  const cn = db.prepare('SELECT COUNT(*) AS n, SUM(net_fils) AS net, SUM(vat_fils) AS v FROM vat_credit_notes WHERE issued_on = ?').get(today) as { n: number; net: number; v: number };
  assert.equal(r.sales.count, inv.n);
  assert.equal(r.sales.vatFils, inv.v);
  assert.equal(r.credits.count, cn.n);
  assert.equal(r.output.vatFils, inv.v - cn.v);
  assert.equal(r.output.netFils, inv.net - cn.net);
  assert.equal(r.input.count, 2);
  assert.equal(r.input.vatFils, 450 + 100);
  assert.equal(r.input.withoutTrn, 1);
  assert.equal(r.netVatFils, r.output.vatFils - r.input.vatFils);
  assert.equal(r.trn, TRN);
  assert.ok(r.notes.some((x) => /no supplier TRN/.test(x)));
  const csv = vat.vatReturnCsv(today, today);
  assert.ok(csv.startsWith('﻿section,document,date,reference,customer_or_supplier,trn,net_aed,vat_aed,total_aed,note\r\n'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.filter((l) => l.startsWith('tax_invoice,')).length, inv.n);
  assert.equal(lines.filter((l) => l.startsWith('credit_note,')).length, cn.n);
  assert.equal(lines.filter((l) => l.startsWith('expense,')).length, 2);
  assert.ok(lines.some((l) => l.startsWith('summary,Net VAT') && l.includes(`${(r.netVatFils / 100).toFixed(2)}`)));
  assert.ok(lines.some((l) => l.includes('100222233334444')));
  // Another period: nothing.
  const empty = vat.vatReturn('2020-01-01', '2020-03-31');
  assert.equal(empty.sales.count + empty.credits.count + empty.input.count, 0);
});

test('a backup keeps the VAT data and the accountant accounts, and the restore brings them back (the accountants revoked)', async () => {
  const staff = await import('@/lib/server/staffAuth');
  const invite = staff.inviteAccountant('ca@firm.test', 'Our CA', OWNER, OWNER);
  kvSet('vat:test-marker', 1);
  const result = await backup.createBackup();
  const target = path.join(os.tmpdir(), `buh-restore-vat-${Date.now()}`);
  execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]);
  const live = getDb();
  const restored = new Database(path.join(target, 'shop.db'), { readonly: true });
  try {
    for (const t of ['order_vat', 'vat_invoices', 'vat_credit_notes']) {
      assert.deepEqual(restored.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(), live.prepare(`SELECT * FROM ${t} ORDER BY 1`).all(), t);
    }
    assert.ok((restored.prepare('SELECT COUNT(*) FROM vat_invoices').pluck().get() as number) > 40);
    assert.equal(restored.prepare("SELECT data FROM kv WHERE key = 'vat:settings'").pluck().get(), live.prepare("SELECT data FROM kv WHERE key = 'vat:settings'").pluck().get());
    assert.deepEqual(restored.prepare('SELECT id, vat_fils, supplier_trn FROM expenses WHERE vat_fils IS NOT NULL ORDER BY id').all(), live.prepare('SELECT id, vat_fils, supplier_trn FROM expenses WHERE vat_fils IS NOT NULL ORDER BY id').all());
    // The account comes back, revoked by the restore (the backup may be older than a revoke): the owner re-invites.
    assert.deepEqual(restored.prepare('SELECT id, email, name FROM staff_accounts ORDER BY id').all(), live.prepare('SELECT id, email, name FROM staff_accounts ORDER BY id').all());
    assert.deepEqual(restored.prepare('SELECT status, revoked_by, setup_grant_hash FROM staff_accounts WHERE id = ?').get(invite.account.id), { status: 'revoked', revoked_by: 'restore', setup_grant_hash: null });
  } finally {
    restored.close();
  }
  // The restored folder has no staff-session epoch: an accountant's earlier session cookie can't work there.
  assert.equal(fs.existsSync(path.join(target, 'staff-session-state.json')), false);
  // The expenses CSV in the backup carries the new columns at the end.
  const csv = backup.openBackup(fs.readFileSync(result.file)).find((x) => x.name === 'expenses.csv')!.data.toString('utf8');
  assert.match(csv.split('\r\n')[0], /,vat_aed,supplier_trn$/);
});

test('migration 14 only adds (tables, indexes, columns)', () => {
  const src = fs.readFileSync('src/lib/server/db.ts', 'utf8');
  const start = src.indexOf('// 14: ');
  const m = src.slice(start, src.indexOf('];', start));
  const sql = m.slice(m.indexOf('db.exec(`') + 9, m.indexOf('`);'));
  const statements = sql.split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  assert.ok(statements.length >= 10);
  for (const s of statements) assert.match(s, /^(CREATE (TABLE|INDEX|UNIQUE INDEX) |ALTER TABLE \w+ ADD COLUMN )/, s);
});
