/**
 * The customer's PDF invoice (asked by the owner: once the order is confirmed and dispatched, an
 * option to send the invoice to the customer, a PDF, as per UAE law, an electronic invoice; trade
 * licence fields optional). One per order, numbered INV-<year>-<6 digits> in order of issue and
 * never reused; only once the order is confirmed; the same invoice when asked again; audited; its
 * content kept as issued; "not a tax invoice" while the shop isn't VAT-registered; the PDF has the
 * seller (legal name, optional trade licence), the customer (Arabic names too), the lines and the
 * total; emailed with the PDF attached; kept in the backup.
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
const { listProducts } = await import('@/lib/server/products');
const { getSettings, updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');
const backup = await import('@/lib/server/backup');

const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
await updateSettings('store', { whatsappNumber: '+971501234567', storeAddress: 'Shop 12, Al Fahidi Street, Bur Dubai', supportEmail: 'hello@shop.test' });

let n = 0;
function place(over: Record<string, unknown> = {}) {
  _clearAllRateLimits();
  const p = listProducts()[0];
  return orders.placeOrder(
    {
      idempotencyKey: `invoice-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      customer: { fullName: 'فاطمة Al Mansoori', phone: `+9715099${String(n).padStart(5, '0')}`, email: 'fatima@example.com', emirate: 'Dubai', area: 'Marina', streetAddress: 'Marina Walk', buildingVilla: 'Marina Gate 1', flatVillaNo: '1402' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...over,
    },
    { ip: `10.7.${n}.1` }
  ).order;
}
const confirmed = () => {
  const o = place();
  orders.checkWhatsApp(o.id, 'confirmed', OWNER);
  return o;
};
/** As if the order had been cancelled (the column and the order's data). */
const cancel = (id: string) => getDb().prepare("UPDATE orders SET status = 'cancelled', data = json_set(data, '$.status', 'cancelled') WHERE id = ?").run(id);
const audits = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> }));

/** The text a PDF shows (each font's ToUnicode map applied to its glyph strings), for checking. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const streams: string[] = [];
  const re = /stream\n([\s\S]*?)\nendstream/g;
  for (let m; (m = re.exec(raw)); ) {
    try {
      streams.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      // a font file
    }
  }
  const map = new Map<string, string>();
  for (const s of streams.filter((x) => x.includes('beginbfchar'))) {
    for (const m of s.matchAll(/<([0-9a-f]{4})> <([0-9a-f]+)>/g)) map.set(m[1], String.fromCharCode(...(m[2].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16))));
  }
  return streams
    .filter((s) => s.includes(' Tj ET'))
    .flatMap((s) => [...s.matchAll(/<([0-9a-f]*)> Tj/g)].map((m) => (m[1].match(/.{4}/g) ?? []).map((g) => map.get(g) ?? '?').join('')))
    .join('\n');
}

test('the trade licence fields are optional (empty by default), cut to their length like every settings text', async () => {
  const s = getSettings('store');
  assert.equal(s.legalName, '');
  assert.equal(s.tradeLicenceNumber, '');
  assert.equal(s.tradeLicenceAuthority, '');
  await updateSettings('store', { tradeLicenceNumber: 'x'.repeat(50) });
  assert.equal(getSettings('store').tradeLicenceNumber, 'x'.repeat(40));
  await assert.rejects(updateSettings('store', { legalName: 5 }), (e: { status?: number }) => e.status === 400);
  await updateSettings('store', { tradeLicenceNumber: '' });
});

test('only once the order is confirmed; numbered in order of issue, never twice; the same invoice when asked again; audited', () => {
  const waiting = place();
  assert.throws(() => invoices.issueOrderInvoice(waiting.id, OWNER), (e) => code(e) === 'invoice_not_yet');
  const a = confirmed();
  const b = confirmed();
  const year = new Date().getUTCFullYear();
  const first = invoices.issueOrderInvoice(a.id, OWNER);
  assert.equal(first.created, true);
  assert.match(first.invoice.number, new RegExp(`^INV-(${year}|${year + 1})-000001$`));
  const second = invoices.issueOrderInvoice(b.id, OWNER);
  assert.equal(second.invoice.number, first.invoice.number.replace(/000001$/, '000002'));
  const again = invoices.issueOrderInvoice(a.id, OWNER);
  assert.equal(again.created, false);
  assert.equal(again.invoice.number, first.invoice.number);
  assert.equal((getDb().prepare('SELECT COUNT(*) FROM invoices').pluck().get() as number), 2);
  assert.equal(audits().filter((x) => x.action === 'invoice.issued').length, 2);
  assert.match(first.invoice.pdfPath, new RegExp(`^/invoice/${a.id}\\.[A-Za-z0-9_-]{43}/pdf$`));
  // A cancelled order gets none.
  const c = confirmed();
  cancel(c.id);
  assert.throws(() => invoices.issueOrderInvoice(c.id, OWNER), (e) => code(e) === 'invoice_not_yet');
});

test('the PDF: seller (legal name, trade licence when set), customer, lines, total, "not a tax invoice"; kept as issued; a cancelled order’s says so', async () => {
  await updateSettings('store', { legalName: 'Beautiful Home Trading L.L.C', tradeLicenceNumber: '1234567', tradeLicenceAuthority: 'Dubai DET' });
  const o = confirmed();
  const { invoice } = invoices.issueOrderInvoice(o.id, OWNER);
  const made = invoices.invoicePdf(o.id)!;
  assert.equal(made.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(made.pdf.subarray(-6).toString(), /%%EOF/);
  const text = pdfText(made.pdf);
  for (const want of ['INVOICE', 'Electronic invoice', invoice.number, 'Beautiful Home Trading L.L.C', 'Trade licence: 1234567 (Dubai DET)', 'Bill to', 'Al Mansoori', 'Marina Gate 1', o.id, `AED ${o.total.toFixed(2)}`, 'Not applicable', 'not registered for VAT', 'This is not a tax invoice', 'valid without a signature']) {
    assert.ok(text.includes(want), `${want} in:\n${text}`);
  }
  assert.ok(/[ﹰ-﻿]/.test(text), 'the Arabic name is drawn (joined forms)');
  // Changing the settings later does not change an invoice already issued.
  await updateSettings('store', { legalName: 'Another Name LLC', tradeLicenceNumber: '' });
  assert.ok(pdfText(invoices.invoicePdf(o.id)!.pdf).includes('Beautiful Home Trading L.L.C'));
  // Optional: without a trade licence, no trade licence line on a new invoice.
  const p = confirmed();
  invoices.issueOrderInvoice(p.id, OWNER);
  const plain = pdfText(invoices.invoicePdf(p.id)!.pdf);
  assert.ok(!plain.includes('Trade licence'));
  assert.ok(plain.includes('Another Name LLC'));
  cancel(p.id);
  assert.ok(pdfText(invoices.invoicePdf(p.id)!.pdf).includes('This order was cancelled after this invoice was issued'));
  assert.equal(invoices.invoicePdf('BUH-000000-NONE00'), null);
  await updateSettings('store', { legalName: '' });
});

test('a long order runs onto a second page with its header again', () => {
  const o = confirmed();
  const row = getDb().prepare('SELECT data FROM orders WHERE id = ?').get(o.id) as { data: string };
  const data = JSON.parse(row.data);
  data.items = Array.from({ length: 40 }, (_, i) => ({ ...data.items[0], title: `Bedsheet set number ${i + 1} with a rather long name to wrap onto two lines in the table`, totalPrice: 100, unitPrice: 100, quantity: 1 }));
  getDb().prepare('UPDATE orders SET data = ? WHERE id = ?').run(JSON.stringify(data), o.id);
  invoices.issueOrderInvoice(o.id, OWNER);
  const text = pdfText(invoices.invoicePdf(o.id)!.pdf);
  assert.ok(text.includes('page 2'));
  assert.ok(text.split('\n').filter((l) => l === 'Description').length >= 2);
  assert.ok(text.includes('Bedsheet set number 40'));
});

test('emailed to the customer with the PDF attached (and its private link); noted and audited; no email: said so', async () => {
  const { SMTPServer } = await import('smtp-server');
  const { simpleParser } = await import('mailparser');
  const raws: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _s, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        raws.push(raw);
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test', NEXT_PUBLIC_APP_URL: 'https://beautifuluaehome.com' });
  try {
    const o = confirmed();
    const r = await invoices.emailInvoice(o.id, OWNER);
    assert.equal(r.emailed, true);
    assert.ok(r.invoice.emailedAt);
    assert.equal(r.invoice.emailedTo, 'fatima@example.com');
    const m = await simpleParser(raws[0]);
    assert.match(m.subject ?? '', new RegExp(`Your invoice ${r.invoice.number} for order ${o.id}`));
    assert.match(m.text ?? '', /attached as a PDF/);
    assert.ok((m.text ?? '').includes(`https://beautifuluaehome.com/invoice/${o.id}.`), 'its private link');
    const att = (m as unknown as { attachments: Array<{ contentType: string; filename?: string; content: Buffer }> }).attachments[0];
    assert.equal(att.contentType, 'application/pdf');
    assert.equal(att.filename, `Invoice-${r.invoice.number}.pdf`);
    assert.equal(att.content.subarray(0, 5).toString(), '%PDF-');
    assert.ok(audits().some((x) => x.action === 'invoice.emailed' && x.details?.orderId === o.id));
    // No email on the order: nothing sent, said so (the invoice is still made, for WhatsApp).
    const noMail = place({ customer: { fullName: 'No Mail', phone: '+971509900111', emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' } });
    orders.checkWhatsApp(noMail.id, 'confirmed', OWNER);
    const none = await invoices.emailInvoice(noMail.id, OWNER);
    assert.equal(none.emailed, false);
    assert.equal(none.reason, 'no_email');
    assert.ok(none.invoice.number);
    assert.equal(raws.length, 1);
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
  }
});

test('the invoices are in the backup and come back with the restore', async () => {
  const o = confirmed();
  const { invoice } = invoices.issueOrderInvoice(o.id, OWNER);
  const result = await backup.createBackup();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-restore-invoice-'));
  fs.rmSync(target, { recursive: true });
  const out = execFileSync(process.execPath, ['scripts/restore-backup.mjs', result.file, target]).toString();
  assert.match(out, /Integrity check: ok/);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(target, 'shop.db'), { readonly: true });
  assert.equal((db.prepare('SELECT number FROM invoices WHERE order_id = ?').get(o.id) as { number: string }).number, invoice.number);
  db.close();
  fs.rmSync(target, { recursive: true, force: true });
});
