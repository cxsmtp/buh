/**
 * Shipping labels as a PDF (BUH-02.39.00, asked by the owner: remote printing by email takes only A4,
 * so "two labels can be printed on A4" and cut in half): A4 landscape with two A5 labels side by side
 * and a dashed cut line; A5 and 4 × 6 one per page; the AWB, cash to collect and address on each;
 * which orders (booked, not dispatched; cancelled refused); "Email to printer" sends the PDF to the
 * printer's address only when one is set and email works, and audits it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const labels = await import('@/lib/server/labelPdf');
const { listProducts } = await import('@/lib/server/products');
const { updateSettings, getSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const { getDb } = await import('@/lib/server/db');

const OWNER = 'owner@shop.test';
const code = (e: unknown) => (e as { details?: { code?: string } }).details?.code;
const status = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function booked(awb = `JB${String(77000 + ++n)}`, over: Record<string, unknown> = {}) {
  _clearAllRateLimits();
  const p = listProducts()[0];
  const o = orders.placeOrder(
    {
      idempotencyKey: `labels-${++n}-${Date.now()}`,
      customer: { fullName: `Mariam Label ${n}`, phone: `+9715066${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Jumeirah Village Circle', streetAddress: 'District 12', buildingVilla: 'Bloom Towers', flatVillaNo: `${n}04` },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...over,
    },
    { ip: `10.8.${n}.1` }
  ).order;
  orders.updateOrderByAdmin(o.id, { status: 'confirmed', shipUnconfirmed: true }, OWNER);
  if (awb) getDb().prepare(`UPDATE orders SET data = json_set(data, '$.courier.awbNumber', ?, '$.courier.provider', 'jeebly') WHERE id = ?`).run(awb, o.id);
  return orders.getOrder(o.id)!;
}

/** Pages (their MediaBox), the text drawn and the drawing operators of a PDF. */
function parse(pdf: Buffer) {
  const raw = pdf.toString('latin1');
  const boxes = [...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const streams: string[] = [];
  for (const m of raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    try {
      streams.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
    } catch {
      // not deflated
    }
  }
  const map = new Map<string, string>();
  for (const s of streams) for (const m of s.matchAll(/<([0-9a-f]{4})> <([0-9a-f]{4,8})>/g)) map.set(m[1], String.fromCodePoint(...(m[2].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16))));
  const pages = streams.filter((s) => s.includes(' Tj ET'));
  const text = pages.map((s) => [...s.matchAll(/<([0-9a-f]*)> Tj/g)].map((m) => (m[1].match(/.{4}/g) ?? []).map((g) => map.get(g) ?? '?').join('')).join('\n'));
  return { boxes, pages, text };
}
const ctx = { shopName: 'Beautiful UAE Home', pickup: getSettings('courier').jeebly };

test('asked: A4 holds two A5 labels side by side (landscape) with a dashed cut line; three labels → two sheets', () => {
  const a = booked();
  const b = booked();
  const c = booked();
  const pdf = labels.labelsPdf([a, b, c], 'a4', ctx);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const { boxes, pages, text } = parse(pdf);
  assert.deepEqual(boxes, [[841.89, 595.28], [841.89, 595.28]], 'A4 landscape, two sheets');
  assert.match(pages[0], /\[[\d.]+ [\d.]+\] 0 d/, 'a dashed line');
  assert.match(pages[0], /420\.9\d* [\d.]+ m 420\.9\d* [\d.]+ l/, 'down the middle of the sheet');
  assert.ok(text[0].includes(a.courier.awbNumber) && text[0].includes(b.courier.awbNumber), 'two labels on the first sheet');
  assert.ok(text[1].includes(c.courier.awbNumber) && !text[1].includes(a.courier.awbNumber), 'the third on the second');
  assert.match(text[0], /cut/i);
  for (const o of [a, b]) {
    assert.ok(text[0].includes(o.id));
    assert.ok(text[0].includes(o.customer.fullName));
    assert.ok(text[0].includes(`AED ${o.total.toFixed(2)}`), 'the cash to collect');
  }
});

test('A5 and 4 × 6: one label a page, at the paper size; no cut line', () => {
  const a = booked();
  const b = booked();
  const a5 = parse(labels.labelsPdf([a, b], 'a5', ctx));
  assert.deepEqual(a5.boxes, [[419.53, 595.28], [419.53, 595.28]]);
  assert.ok(a5.text[0].includes(a.courier.awbNumber) && a5.text[1].includes(b.courier.awbNumber));
  assert.doesNotMatch(a5.text.join('\n'), /cut here/i);
  const x46 = parse(labels.labelsPdf([a], '4x6', ctx));
  assert.deepEqual(x46.boxes, [[288, 432]]);
});

test('which labels: booked and not dispatched, oldest first; ids checked; cancelled and unknown refused', async () => {
  const none = booked('');
  const waiting = await labels.ordersForLabels(undefined);
  assert.ok(waiting.length >= 1 && waiting.every((o) => o.status === 'confirmed' && o.courier.awbNumber));
  assert.ok(!waiting.some((o) => o.id === none.id), 'no AWB: no label yet');
  const times = waiting.map((o) => o.createdAt);
  assert.deepEqual(times, [...times].sort(), 'oldest first');
  const a = booked();
  assert.deepEqual((await labels.ordersForLabels(`${a.id},${a.id}`)).map((o) => o.id), [a.id], 'once each');
  assert.equal(await status(() => labels.ordersForLabels(['../etc'])), 400);
  assert.equal(await status(() => labels.ordersForLabels(['BUH-000000-NOPE00'])), 404);
  assert.equal(await status(() => labels.ordersForLabels(Array.from({ length: 41 }, () => a.id))), 400);
  getDb().prepare(`UPDATE orders SET status = 'cancelled', data = json_set(data, '$.status', 'cancelled') WHERE id = ?`).run(a.id);
  assert.equal(await status(() => labels.ordersForLabels([a.id])), 409);
  assert.ok(!(await labels.ordersForLabels(undefined)).some((o) => o.id === a.id), 'not in the batch');
});

test('Email to printer: refused without a printer address, without email set up; sent with the A4 PDF and audited', async () => {
  const a = booked();
  const b = booked();
  await assert.rejects(labels.emailLabels([a], 'a4', OWNER), (e) => code(e) === 'no_printer');
  await updateSettings('courier', { printerEmail: 'not an email' }).then(
    () => assert.fail('a bad address is refused'),
    () => undefined
  );
  await updateSettings('courier', { printerEmail: 'printer@print.example.com', labelPaper: 'a4' });
  assert.equal(getSettings('courier').labelPaper, 'a4');
  await assert.rejects(labels.emailLabels([a], 'a4', OWNER), (e) => code(e) === 'email_off', 'nothing claimed without email');
  await assert.rejects(labels.emailLabels([], 'a4', OWNER), (e) => code(e) === 'no_labels');

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
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test' });
  try {
    const r = await labels.emailLabels([a, b], 'a4', OWNER);
    assert.deepEqual(r, { to: 'printer@print.example.com', count: 2 });
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'printer@print.example.com', 'only to the printer');
    const { simpleParser } = await import('mailparser');
    const parsed = await simpleParser(mails[0].raw);
    const atts = (parsed as unknown as { attachments: Array<{ contentType: string; filename?: string; content: Buffer }> }).attachments;
    assert.equal(atts.length, 1);
    const att = atts[0];
    assert.equal(att.contentType, 'application/pdf');
    assert.equal(att.filename, 'Labels-2.pdf');
    assert.deepEqual(parse(att.content).boxes, [[841.89, 595.28]], 'one A4 sheet with both labels');
    assert.match(parsed.text ?? '', /cut in half/);
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL']) delete process.env[k];
  }
  const audit = fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details?: Record<string, unknown> }))
    .filter((x) => x.action === 'labels.emailed_to_printer');
  assert.equal(audit.length, 1, 'audited once (the refusals sent nothing)');
  assert.deepEqual(audit[0].details?.orders, [a.id, b.id]);
});
