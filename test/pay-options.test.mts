/**
 * The owner's request: "For credit card payments please add a 3.5% payment fee at the end. I also
 * don't see a bank transfer option which lets people drop a message asking for bank account details."
 *
 * Card payment fee (Settings → Payments, default 3.5%): worked out on the server in whole fils (half
 * up) on items + delivery, card orders only; part of the total Stripe is asked for and the webhook
 * expects; a browser total without it (or tampered) is refused; refunds give back what was charged;
 * the reports count it as income. Bank transfer "on request": with no account saved but the shop's
 * WhatsApp number, checkout offers it; the customer asks on WhatsApp (the confirmation's link), no
 * bank details are emailed, and the hub's reply carries "[your bank details]" until one is saved.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { jsonRequest, tempDataDir } from './helpers.mjs';
import { startStripeMock, TEST_KEYS, type StripeMock } from './stripe-mock.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY']) delete process.env[k];
process.env.CARD_SWEEP_DISABLED = '1';
const mock: StripeMock = await startStripeMock();
process.env.BUH_TEST_STRIPE_API = mock.url;
after(() => mock.close());

const money = await import('@/lib/money');
const orders = await import('@/lib/server/orders');
const payments = await import('@/lib/server/payments');
const settings = await import('@/lib/server/settings');
const reports = await import('@/lib/server/reports');
const { readZip } = await import('@/lib/server/zip');
const { listProducts } = await import('@/lib/server/products');
const { getDb } = await import('@/lib/server/db');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { emailBankDetails } = await import('@/lib/server/bankMail');
const { createBackup } = await import('@/lib/server/backup');
const ordersRoute = await import('@/app/api/orders/route');
const webhookRoute = await import('@/app/api/stripe/webhook/route');
const publicRoute = await import('@/app/api/settings/public/route');
const messages = await import('@/lib/bankMessages');

const ORIGIN = 'http://shop.test';
const SHOP_WA = '+971 50 123 4567';
const BANK = { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' };
const NO_BANK = { bankName: '', accountName: '', iban: '', accountNumber: '', swiftCode: '', branch: '', instructions: '' };

const keysOn = () => settings.updateSettings('payments', { cardEnabled: true, stripePublishableKey: TEST_KEYS.publishable, stripeSecretKey: TEST_KEYS.secret, stripeWebhookSecret: TEST_KEYS.webhook });
const product = () => listProducts()[0];
const priceFils = () => Math.round(product().price * 100) + Math.round((product().profiles[0].priceDelta || 0) * 100);
const intentOf = (orderId: string) => [...mock.intents.values()].find((p) => p.metadata.orderId === orderId)!;
const audits = () =>
  fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { action: string; details: Record<string, unknown> }));

let n = 0;
function body(paymentMethod: string, over: Record<string, unknown> = {}) {
  const p = product();
  const phone = `+9715051${String(++n).padStart(5, '0')}`;
  return {
    idempotencyKey: `payopt-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...(paymentMethod === 'online_card' ? {} : { verificationToken: issuePhoneToken(phone) }),
    customer: { fullName: 'Mariam Test', phone, email: 'mariam@example.com', emirate: 'Dubai', area: 'Dubai Marina', streetAddress: 'Marina Walk', buildingVilla: 'Tower 1', flatVillaNo: 'Apt 4' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod,
    ...over,
  };
}
async function post(b: Record<string, unknown>) {
  // Not a card: placed directly (the route's after() email needs a request scope); same checks.
  if (b.paymentMethod !== 'online_card') {
    try {
      return { status: 201, data: { order: orders.customerView(orders.placeOrder(b).order) } as Awaited<ReturnType<typeof viaRoute>>['data'] };
    } catch (e) {
      const err = e as { status?: number; message?: string; details?: Record<string, unknown> };
      return { status: err.status ?? 500, data: { message: err.message, ...(err.details ?? {}) } as Awaited<ReturnType<typeof viaRoute>>['data'] };
    }
  }
  return viaRoute(b);
}
async function viaRoute(b: Record<string, unknown>) {
  const res = await ordersRoute.POST(jsonRequest(b, { origin: ORIGIN }) as never);
  return { status: res.status, data: (await res.json()) as { order?: { id: string; total: number; cardFee?: number; cardFeePercent?: number; bankDetailsBy?: string; subtotal: number; deliveryFee: number; bankTransfer?: { payPath?: string } }; payment?: { clientSecret: string }; code?: string; total?: number; cardFeePercent?: number; message?: string } };
}
async function webhook(e: { body: string; signature: string }) {
  const res = await webhookRoute.POST(new Request('http://shop.test/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': e.signature }, body: e.body }));
  return res.status;
}

test('the fee in fils: half up, integer maths, 0 and odd amounts', () => {
  const f = money.cardFeeFils;
  assert.equal(f(10_000, 3.5), 350, 'AED 100 → AED 3.50');
  assert.equal(f(100, 3.5), 4, '3.5 fils rounds up to 4');
  assert.equal(f(101, 3.5), 4, '3.535 → 4');
  assert.equal(f(13, 3.5), 0, '0.455 → 0');
  assert.equal(f(9_999, 3.5), 350, '349.965 → 350');
  assert.equal(f(14_286, 3.5), 500, '500.01 → 500');
  assert.equal(f(29_997, 3.5), 1_050, '1049.895 → 1050');
  assert.equal(f(49_000, 2.25), 1_103, '1102.5 → 1103 (half up)');
  assert.equal(f(12_345, 0), 0, '0 turns it off');
  assert.equal(f(12_345, -1), 0);
  assert.equal(f(0, 3.5), 0);
  assert.equal(f(12_345, Number.NaN), 0);
  assert.equal(money.percentText(3.5), '3.5');
  assert.equal(money.percentText(2.25), '2.25');
});

test('Settings → Payments: defaults (3.5%, bank as the details allow), old saved settings, and validation', async () => {
  // Saved by an older version (no fee, no bank choice): today's defaults fill them in.
  getDb().prepare("INSERT OR REPLACE INTO settings (key, data, updated_at) VALUES ('payments', ?, ?)").run(JSON.stringify({ cardEnabled: false, stripePublishableKey: '' }), new Date().toISOString());
  settings._clearSettingsCache();
  const p = settings.getSettings('payments');
  assert.equal(p.cardFeePercent, 3.5);
  assert.equal(p.bankTransferMode, 'default');
  assert.equal(settings.cardFeePercent(), 3.5);

  for (const bad of [-1, 10.01, 3.555, 'abc', true, '12']) {
    await assert.rejects(settings.updateSettings('payments', { cardFeePercent: bad }), (e: { status?: number; message?: string }) => e.status === 400 && /Card payment fee/.test(e.message ?? ''), String(bad));
  }
  await assert.rejects(settings.updateSettings('payments', { bankTransferMode: 'everything' }), (e: { status?: number }) => e.status === 400);
  await settings.updateSettings('payments', { cardFeePercent: '2.25' });
  assert.equal(settings.getSettings('payments').cardFeePercent, 2.25, 'a typed number is read');
  await settings.updateSettings('payments', { cardFeePercent: 0 });
  assert.equal(settings.cardFeePercent(), 0, '0: no fee');
  await settings.updateSettings('payments', { cardFeePercent: 10 });
  assert.equal(settings.cardFeePercent(), 10);
  await settings.updateSettings('payments', { cardFeePercent: 3.5, bankTransferMode: 'default' });
  // Leaving the fields out keeps them.
  await settings.updateSettings('payments', { cardEnabled: false });
  assert.equal(settings.getSettings('payments').cardFeePercent, 3.5);
});

test('a fee change is audited, from and to', async () => {
  const before = payments.paymentOptions();
  await settings.updateSettings('payments', { cardFeePercent: 2.5 });
  payments.auditPaymentOptions(before, 'owner@shop.test');
  const entry = audits().filter((a) => a.action === 'settings.payment_options_changed').at(-1)!;
  assert.deepEqual(entry.details.from, { cardFeePercent: 3.5, bankTransferMode: 'default' });
  assert.deepEqual(entry.details.to, { cardFeePercent: 2.5, bankTransferMode: 'default' });
  assert.equal(entry.details.by, 'owner@shop.test');
  const count = audits().filter((a) => a.action === 'settings.payment_options_changed').length;
  payments.auditPaymentOptions(payments.paymentOptions(), 'owner@shop.test');
  assert.equal(audits().filter((a) => a.action === 'settings.payment_options_changed').length, count, 'no change: nothing logged');
  await settings.updateSettings('payments', { cardFeePercent: 3.5 });
});

test('a card order: the server adds the fee (items + delivery), Stripe is asked for total + fee, and a total without it is refused', async () => {
  await settings.updateSettings('bank', BANK);
  await keysOn();
  const pub = await (await publicRoute.GET()).json();
  assert.equal(pub.payments.cardFeePercent, 3.5, 'checkout is told the percent');
  const base = priceFils();
  const fee = money.cardFeeFils(base, 3.5);
  assert.ok(fee > 0);

  // The browser's total without the fee: refused, nothing reserved; the answer carries the right total and percent.
  const left = await post(body('online_card', { expectedTotal: base / 100 }));
  assert.equal(left.status, 409);
  assert.equal(left.data.code, 'price_changed');
  assert.equal(left.data.total, (base + fee) / 100);
  assert.equal(left.data.cardFeePercent, 3.5);
  // A fee or total from the browser is never read: a smaller fee is refused too.
  const tampered = await post(body('online_card', { cardFee: 0, total: base / 100, expectedTotal: (base + fee - 1) / 100 }));
  assert.equal(tampered.status, 409);

  const ok = await post(body('online_card', { cardFee: 0, expectedTotal: (base + fee) / 100 }));
  assert.equal(ok.status, 201, ok.data.message);
  const o = ok.data.order!;
  assert.equal(o.cardFee, fee / 100);
  assert.equal(o.cardFeePercent, 3.5);
  assert.equal(o.total, (base + fee) / 100);
  assert.equal(Math.round(o.subtotal * 100) + Math.round(o.deliveryFee * 100) + fee, Math.round(o.total * 100));
  const pi = intentOf(o.id);
  assert.equal(pi.amount, base + fee, 'the PaymentIntent is total + fee, in fils');

  // The webhook expects total + fee: the amount without the fee is a mismatch, never paid.
  const short = mock.event('payment_intent.succeeded', { ...pi, status: 'succeeded', amount: base, amount_received: base });
  assert.equal(await webhook(short), 200);
  assert.equal(orders.getOrder(o.id)!.card!.state, 'pending');
  assert.ok(audits().some((a) => a.action === 'payment.mismatch' && a.details.orderId === o.id && a.details.expectedFils === base + fee));
  const paid = mock.succeed(pi.id);
  assert.equal(await webhook(mock.event('payment_intent.succeeded', paid)), 200);
  const after = orders.getOrder(o.id)!;
  assert.equal(after.card!.state, 'paid');
  assert.equal(after.card!.paidAmount, (base + fee) / 100);
  assert.equal(after.cardFee, fee / 100, 'kept on the order');
});

test('cash on delivery and bank transfer: no fee; card with 0%: no fee', async () => {
  const base = priceFils();
  for (const m of ['cod', 'bank_transfer']) {
    const r = await post(body(m, { expectedTotal: base / 100 }));
    assert.equal(r.status, 201, `${m}: ${r.data.message}`);
    assert.equal(r.data.order!.cardFee, undefined, m);
    assert.equal(r.data.order!.total, base / 100, m);
  }
  // A card-style total on a COD order is refused (the fee is not added there).
  const fee = money.cardFeeFils(base, 3.5);
  assert.equal((await post(body('cod', { expectedTotal: (base + fee) / 100 }))).status, 409);
  await settings.updateSettings('payments', { cardFeePercent: 0 });
  try {
    const r = await post(body('online_card', { expectedTotal: base / 100 }));
    assert.equal(r.status, 201, r.data.message);
    assert.equal(r.data.order!.cardFee, undefined);
    assert.equal(intentOf(r.data.order!.id).amount, base);
  } finally {
    await settings.updateSettings('payments', { cardFeePercent: 3.5 });
  }
});

async function paidCardOrder() {
  const base = priceFils();
  const fee = money.cardFeeFils(base, 3.5);
  const r = await post(body('online_card', { expectedTotal: (base + fee) / 100 }));
  assert.equal(r.status, 201, r.data.message);
  const id = r.data.order!.id;
  const pi = mock.succeed(intentOf(id).id);
  assert.equal(await webhook(mock.event('payment_intent.succeeded', pi)), 200);
  assert.equal(orders.getOrder(id)!.card!.state, 'paid');
  return { id, pi, base, fee };
}

test('refunds: a full refund gives back the total with the fee; a partial one only what is left, never more than charged', async () => {
  const full = await paidCardOrder();
  assert.equal(orders.refundableFils(orders.getOrder(full.id)!), full.base + full.fee);
  const r = await payments.refundCardOrder(full.id, 'owner@shop.test', full.base + full.fee);
  assert.equal(r.outcome, 'refunded');
  const call = mock.requests.filter((x) => x.path === '/v1/refunds' && x.body.get('payment_intent') === full.pi.id);
  assert.equal(call.length, 1);
  assert.equal(call[0].body.get('amount'), String(full.base + full.fee), 'the fee is refunded too');
  assert.equal(orders.getOrder(full.id)!.card!.state, 'refunded');

  const part = await paidCardOrder();
  const { charge } = mock.dashboardRefund(part.pi.id, 1000);
  assert.equal(await webhook(mock.event('charge.refunded', charge)), 200);
  const left = part.base + part.fee - 1000;
  assert.equal(orders.refundableFils(orders.getOrder(part.id)!), left);
  await assert.rejects(payments.refundCardOrder(part.id, 'owner@shop.test', part.base + part.fee), /is left to refund/, 'more than is left: refused');
  const r2 = await payments.refundCardOrder(part.id, 'owner@shop.test', left);
  assert.equal(r2.outcome, 'refunded');
  const refunded = mock.requests.filter((x) => x.path === '/v1/refunds' && x.body.get('payment_intent') === part.pi.id);
  assert.equal(refunded.at(-1)!.body.get('amount'), String(left));
});

test('the reports: card fees are income ("Card fees" in the summary, card_fee_aed in sales.csv); the backup keeps them', async () => {
  const { id, fee } = await paidCardOrder();
  // A live-mode payment (test-mode ones are not counted as sales).
  getDb().prepare('UPDATE orders SET card_livemode = 1 WHERE id = ?').run(id);
  const from = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const report = reports.buildReport(from, to);
  assert.equal(report.sales.cardFeeFils, fee, 'only counted card orders: this one');
  const result = await reports.writeAccountantZip(from, to, 'Beautiful UAE Home');
  const zip = readZip(fs.readFileSync(result.file));
  const sales = zip.get('sales.csv')!.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const header = sales[0].split(',');
  // A column of its own, after the earlier ones (so they keep their place); the VAT columns come after it.
  const at = header.indexOf('card_fee_aed');
  assert.equal(at, 24);
  assert.deepEqual(header.slice(at + 1), ['vat_aed', 'total_excl_vat_aed']);
  const row = sales.find((l) => l.includes(id))!;
  assert.equal(row.split(',').at(at - header.length), (fee / 100).toFixed(2));
  const others = sales.slice(1).filter((l) => l && !l.includes('online_card') && !l.includes('Card'));
  assert.ok(others.length > 0);
  for (const l of others) assert.equal(l.split(',').at(at - header.length), '0.00', 'no fee on cash on delivery or bank transfer');
  const summary = zip.get('summary.csv')!.toString('utf8');
  assert.match(summary, /Card fees[^\n]*,(\d+\.\d\d)/);
  assert.ok(summary.includes((fee / 100).toFixed(2)));
  assert.match(zip.get('README.txt')!.toString('utf8'), /card_fee_aed/);

  const backup = await createBackup();
  const csv = backup.csv.find((c) => c.name === 'orders.csv')!.data.toString('utf8');
  assert.match(csv.split(/\r?\n/)[0], /card_fee_aed,card_fee_percent,bank_details_by/);
  assert.ok(csv.split(/\r?\n/).some((l) => l.startsWith(id) && l.endsWith(`,${fee / 100},3.5,`)), 'the order’s fee and percent');
});

test('bank transfer on request: offered with no account but a WhatsApp number; hidden with neither; send_details needs the account', async () => {
  await settings.updateSettings('bank', NO_BANK);
  await settings.updateSettings('store', { whatsappNumber: '' });
  assert.equal(settings.bankTransferMode(), null, 'neither: off');
  let pub = await (await publicRoute.GET()).json();
  assert.equal(pub.bankTransfer, false);
  assert.equal((await post(body('bank_transfer'))).status, 400, 'refused when not offered');

  await settings.updateSettings('store', { whatsappNumber: SHOP_WA });
  assert.equal(settings.bankTransferMode(), 'ask_whatsapp', 'default: the WhatsApp number is enough');
  pub = await (await publicRoute.GET()).json();
  assert.equal(pub.bankTransfer, true);
  assert.equal(pub.bankTransferMode, 'ask_whatsapp');
  assert.equal(JSON.stringify(pub).includes('AE07'), false);

  await settings.updateSettings('payments', { bankTransferMode: 'send_details' });
  assert.equal(settings.bankTransferMode(), 'ask_whatsapp', 'send details, but the account was deleted: asked on WhatsApp, not switched off');
  await settings.updateSettings('store', { whatsappNumber: '' });
  assert.equal(settings.bankTransferMode(), null, 'send details, no account and no WhatsApp number: off');
  await settings.updateSettings('store', { whatsappNumber: SHOP_WA });
  await settings.updateSettings('bank', BANK);
  assert.equal(settings.bankTransferMode(), 'send_details');
  await settings.updateSettings('payments', { bankTransferMode: 'default' });
  assert.equal(settings.bankTransferMode(), 'send_details', 'default: an account saved sends it automatically');
  await settings.updateSettings('payments', { bankTransferMode: 'ask_whatsapp' });
  assert.equal(settings.bankTransferMode(), 'ask_whatsapp', 'chosen: asked on WhatsApp even with an account');
  await settings.updateSettings('payments', { bankTransferMode: 'off' });
  assert.equal(settings.bankTransferMode(), null);
  assert.equal((await (await publicRoute.GET()).json()).bankTransfer, false);
  await settings.updateSettings('payments', { bankTransferMode: 'default' });
  await settings.updateSettings('bank', NO_BANK);
});

test('bank transfer on request: the order is placed awaiting payment with its private link; the WhatsApp ask has the right number and text; no bank details are emailed', async () => {
  await settings.updateSettings('bank', NO_BANK);
  await settings.updateSettings('store', { whatsappNumber: SHOP_WA });
  const r = await post(body('bank_transfer'));
  assert.equal(r.status, 201, r.data.message);
  const o = orders.getOrder(r.data.order!.id)!;
  assert.equal(o.paymentMethod, 'bank_transfer');
  assert.equal(o.paymentStatus, 'pending');
  assert.equal(o.bankDetailsBy, 'whatsapp');
  assert.equal(r.data.order!.bankDetailsBy, 'whatsapp', 'the confirmation knows');
  assert.equal(o.bankTransfer!.state, 'awaiting');
  assert.ok(o.bankTransfer!.payPath, 'the private upload link still works');
  assert.equal(o.cardFee, undefined);

  const text = messages.askBankDetailsMessage(o.id, o.total);
  assert.equal(text, `Hello, I placed order ${o.id} for AED ${o.total}. Please send your bank details so I can pay by transfer.`);
  const { waMeLink } = await import('@/lib/whatsappConfirm');
  const link = waMeLink(SHOP_WA, text)!;
  assert.ok(link.startsWith('https://wa.me/971501234567?text='));
  assert.equal(decodeURIComponent(link.split('?text=')[1]), text);

  // The owner's reply: "[your bank details]" with none saved; the account once saved.
  const reply = messages.bankDetailsReply({ orderId: o.id, total: o.total, bank: settings.getSettings('bank'), firstName: 'Mariam' });
  assert.ok(reply.includes(messages.BANK_DETAILS_PLACEHOLDER));
  assert.ok(reply.includes(`Reference: ${o.id}`));
  const withAccount = messages.bankDetailsReply({ orderId: o.id, total: o.total, bank: { ...NO_BANK, ...BANK }, firstName: 'Mariam' });
  assert.ok(withAccount.includes('Emirates NBD') && !withAccount.includes(messages.BANK_DETAILS_PLACEHOLDER));

  // The email: no account (none saved), only "message us on WhatsApp" with the link.
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
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test', NEXT_PUBLIC_APP_URL: 'https://beautifuluaehome.com' });
  try {
    assert.equal(await emailBankDetails(o.id), 'sent');
    assert.equal(mails.length, 1);
    const { simpleParser } = await import('mailparser');
    const parsed = await simpleParser(mails[0]);
    assert.notEqual(parsed.subject, `Bank details for your order ${o.id}`, 'not the bank details email');
    const textBody = parsed.text ?? '';
    // Phone check "WhatsApp" (the default) still waits for this order: its one link is the confirmation, asking for the details.
    assert.equal(o.whatsappCheck?.status, 'awaiting');
    assert.match(textBody, /To confirm it and get our bank details/);
    assert.ok(textBody.includes(messages.bankAskLink(SHOP_WA, o)!.href), 'the WhatsApp link (with the code)');
    assert.ok(!textBody.includes(link), 'not the ask without the code');
    assert.ok(textBody.includes(`https://beautifuluaehome.com${o.bankTransfer!.payPath}`), 'the private upload link');
    assert.ok(!/IBAN|Account name/.test(textBody), 'no account details');
    // Once per order, like the details email.
    assert.equal(await emailBankDetails(o.id), 'skipped');
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
  }

  // Mark payment received works as today.
  const { order: paid, changed } = orders.checkBankTransfer(o.id, 'received', 'owner@shop.test');
  assert.equal(changed, true);
  assert.equal(paid.bankTransfer!.state, 'paid');
  assert.equal(paid.bankDetailsBy, 'whatsapp');
});

// ── Review fixes: one confirming WhatsApp ask, no number, restore, the hub reply ─────────────────

/** Mails sent through a local SMTP server while `run` runs. */
async function captureMail(run: () => Promise<void>): Promise<string[]> {
  const { SMTPServer } = await import('smtp-server');
  const { simpleParser } = await import('mailparser');
  const raw: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, cb) {
      let r = '';
      stream.on('data', (c) => (r += c));
      stream.on('end', () => {
        raw.push(r);
        cb();
      });
    },
  });
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test', NEXT_PUBLIC_APP_URL: 'https://beautifuluaehome.com' });
  try {
    await run();
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
  }
  return Promise.all(raw.map(async (r) => (await simpleParser(r)).text ?? ''));
}

test('on request, phone check WhatsApp: the one link is the confirmation (code + "send me the bank details"); the email carries it; the hub reply asks for YES', async () => {
  await settings.updateSettings('bank', NO_BANK);
  await settings.updateSettings('store', { whatsappNumber: SHOP_WA });
  assert.equal(settings.phoneCheckMode(), 'whatsapp', 'the default');
  const r = await post(body('bank_transfer', { verificationToken: undefined }));
  assert.equal(r.status, 201, r.data.message);
  const o = orders.getOrder(r.data.order!.id)!;
  assert.equal(o.bankDetailsBy, 'whatsapp');
  assert.equal(o.whatsappCheck?.status, 'awaiting');
  const { confirmLink, waMeLink } = await import('@/lib/whatsappConfirm');
  const confirm = confirmLink(SHOP_WA, o.id, o.whatsappCheck!.code, { bankDetails: true })!;
  assert.deepEqual(messages.bankAskLink(SHOP_WA, o), { href: confirm, confirms: true });
  assert.match(decodeURIComponent(confirm), new RegExp(`code ${o.whatsappCheck!.code}, and please send me the bank details`));
  // Confirmed: the plain ask.
  assert.deepEqual(messages.bankAskLink(SHOP_WA, { ...o, whatsappCheck: { ...o.whatsappCheck!, status: 'confirmed' } }), { href: waMeLink(SHOP_WA, messages.askBankDetailsMessage(o.id, o.total)), confirms: false });
  assert.equal(messages.bankAskLink('', o), null, 'no number: nothing to tap');

  const [mail] = await captureMail(async () => assert.equal(await emailBankDetails(o.id), 'sent'));
  assert.ok(mail.includes(confirm), 'the email’s link confirms the order (with its code)');
  assert.match(mail, /To confirm it and get our bank details/);
  assert.ok(!mail.includes(waMeLink(SHOP_WA, messages.askBankDetailsMessage(o.id, o.total))!), 'not the plain ask (no code)');
  assert.ok(!/IBAN|Account name/.test(mail));
  const withHours = messages.bankRequestEmail({ orderId: o.id, total: o.total, confirmLink: confirm, cancelHours: 24 });
  assert.match(withHours.text, /Orders not confirmed within 24 hours are cancelled\./);

  // The hub's reply to an order still waiting for its WhatsApp confirmation asks for it too.
  const reply = messages.bankDetailsReply({ orderId: o.id, total: o.total, bank: NO_BANK, askConfirm: true });
  assert.ok(reply.includes(messages.BANK_DETAILS_PLACEHOLDER) && /reply YES to confirm your order/.test(reply));
  assert.match(messages.bankDetailsReply({ orderId: o.id, total: o.total, bank: { ...NO_BANK, ...BANK }, askConfirm: true }), /Emirates NBD[\s\S]*reply YES to confirm your order/);
  assert.ok(!/reply YES/.test(messages.bankDetailsReply({ orderId: o.id, total: o.total, bank: NO_BANK })), 'not once confirmed');
  orders.checkBankTransfer(o.id, 'received', 'owner@shop.test');
});

test('on request with no WhatsApp number: the email says "reply to this email"; the number can’t be cleared while such orders wait for payment', async () => {
  await settings.updateSettings('bank', NO_BANK);
  await settings.updateSettings('store', { whatsappNumber: SHOP_WA, supportEmail: 'hello@shop.test' });
  await settings.updateSettings('payments', { bankTransferMode: 'default' });
  // Earlier on-request orders are paid; this one waits.
  getDb().prepare("UPDATE orders SET bank_state = 'paid' WHERE json_extract(data, '$.bankDetailsBy') = 'whatsapp'").run();
  assert.equal(settings.openOnRequestTransfers(), 0);
  const r = await post(body('bank_transfer'));
  assert.equal(r.status, 201, r.data.message);
  const o = orders.getOrder(r.data.order!.id)!;
  assert.equal(settings.openOnRequestTransfers(), 1);
  await assert.rejects(settings.updateSettings('store', { whatsappNumber: '' }), (e: { status?: number; message?: string }) => e.status === 400 && /1 bank-transfer order is waiting for payment/.test(e.message ?? ''));
  assert.equal(settings.getSettings('store').whatsappNumber, '+971501234567', 'kept');
  await settings.updateSettings('store', { whatsappNumber: '+971 50 765 4321' }, {});
  assert.equal(settings.getSettings('store').whatsappNumber, '+971507654321', 'changing it is fine');

  // The number is gone anyway (the order was placed, then the shop moved to sending details, then
  // the account was deleted): the email still goes, asking for a reply instead of showing nothing.
  getDb().prepare("UPDATE settings SET data = json_set(data, '$.whatsappNumber', '') WHERE key = 'store'").run();
  settings._clearSettingsCache();
  const [mail] = await captureMail(async () => assert.equal(await emailBankDetails(o.id), 'sent'));
  assert.match(mail, /reply to this email and we will send you our bank details/);
  assert.ok(!mail.includes('wa.me'));
  assert.ok(mail.includes(`https://beautifuluaehome.com${o.bankTransfer!.payPath}`));

  // Paid: the number may be cleared.
  await settings.updateSettings('store', { whatsappNumber: SHOP_WA });
  orders.checkBankTransfer(o.id, 'received', 'owner@shop.test');
  assert.equal(settings.openOnRequestTransfers(), 0);
  await settings.updateSettings('store', { whatsappNumber: '' });
  assert.equal(settings.getSettings('store').whatsappNumber, '');
  await settings.updateSettings('store', { whatsappNumber: SHOP_WA });
});

test('restoring a payments version from before the fee and bank choice keeps today’s fee and choice', async () => {
  await settings.updateSettings('payments', { cardFeePercent: 2.5, bankTransferMode: 'ask_whatsapp' });
  const id = (getDb().prepare("INSERT INTO settings_history (key, data, saved_at) VALUES ('payments', ?, ?)").run(JSON.stringify({ cardEnabled: false, stripePublishableKey: '' }), new Date().toISOString()).lastInsertRowid) as number;
  await settings.restoreSettingsVersion(id, 'owner@shop.test');
  assert.equal(settings.getSettings('payments').cardFeePercent, 2.5, 'not reset to 3.5');
  assert.equal(settings.getSettings('payments').bankTransferMode, 'ask_whatsapp', 'not reset to default');
  // A version that has them puts them back.
  const id2 = (getDb().prepare("INSERT INTO settings_history (key, data, saved_at) VALUES ('payments', ?, ?)").run(JSON.stringify({ cardEnabled: false, stripePublishableKey: '', cardFeePercent: 1, bankTransferMode: 'off' }), new Date().toISOString()).lastInsertRowid) as number;
  await settings.restoreSettingsVersion(id2, 'owner@shop.test');
  assert.equal(settings.getSettings('payments').cardFeePercent, 1);
  assert.equal(settings.getSettings('payments').bankTransferMode, 'off');
  await settings.updateSettings('payments', { cardFeePercent: 3.5, bankTransferMode: 'default' });
});
