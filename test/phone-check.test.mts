/**
 * Settings → Phone check: "WhatsApp (free)" is the default for a new shop and for an existing one
 * (even with an SMS gateway saved). In WhatsApp mode checkout sends no code: the order is placed
 * with the number unverified and the WhatsApp confirmation awaited, capped per phone, per
 * connection and across the shop; an order not confirmed in time is cancelled (stock back once,
 * audited), except a confirmed one, a paid card order and a bank transfer with its screenshot. The
 * owner can confirm by phone call or take the sender's number (validated, history kept, audited),
 * and shipping an unconfirmed COD order takes an explicit, recorded "ship anyway". Without the
 * shop's WhatsApp number, orders are still taken, flagged "call the customer", never verified.
 * "SMS code" keeps today's checkout; the code routes refuse in WhatsApp mode.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { jsonRequest, tempDataDir } from './helpers.mjs';

const dir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY', 'SMS_WEBHOOK_URL', 'TWILIO_ACCOUNT_SID', 'INFOBIP_API_KEY']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const settings = await import('@/lib/server/settings');
const { dispatchOrder } = await import('@/lib/server/dispatch');
const { listProducts } = await import('@/lib/server/products');
const { issuePhoneToken } = await import('@/lib/server/phoneToken');
const { getDb } = await import('@/lib/server/db');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const publicRoute = await import('@/app/api/settings/public/route');
const otpSend = await import('@/app/api/otp/send/route');
const messages = await import('@/lib/bankMessages');
const wa = await import('@/lib/whatsappConfirm');
const { updateSettings } = settings;

const SHOP_WA = '+971501112233';
await updateSettings('bank', { bankName: 'Emirates NBD', accountName: 'BEAUTIFUL UAE HOME TEXTILES LLC', iban: 'AE070331234567890123456', accountNumber: '1012345678901', swiftCode: 'EBILAEAD' });

let n = 0;
const nextPhone = () => `+9715060${String(++n).padStart(5, '0')}`;
function place(over: Record<string, unknown> = {}, opts: { phone?: string; ip?: string; token?: boolean } = {}) {
  const p = listProducts()[0];
  const phone = opts.phone ?? nextPhone();
  return orders.placeOrder(
    {
      idempotencyKey: `pc-test-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...(opts.token ? { verificationToken: issuePhoneToken(phone) } : {}),
      customer: { fullName: 'Salma Test', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
      items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
      paymentMethod: 'cod',
      ...over,
    },
    { ip: opts.ip ?? `10.0.${n % 250}.${(n * 7) % 250}` }
  ).order;
}
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};
const codeOf = async (fn: () => unknown) => {
  try {
    await fn();
    return '';
  } catch (e) {
    return String((e as { details?: { code?: string } }).details?.code ?? '');
  }
};
const stockOf = (productId: string, sizeId: string) => (getDb().prepare('SELECT qty FROM product_stock WHERE product_id = ? AND size_id = ?').get(productId, sizeId) as { qty: number }).qty;
function auditEntries(): Array<{ action: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-.*\.jsonl$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
/** Cancel every open order, so each test starts under the caps. */
function closeOpen() {
  for (const o of orders.listOrders({ status: 'pending_confirmation', limit: 2000 })) orders.updateOrderByAdmin(o.id, { status: 'cancelled' }, 'test');
}
const due = (id: string) => getDb().prepare("UPDATE orders SET wa_cancel_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);

test('default: WhatsApp (free) for a fresh shop, and for an existing shop with an SMS gateway saved', async () => {
  assert.equal(settings.getSettings('phoneCheck').mode, 'whatsapp');
  assert.equal(settings.getSettings('phoneCheck').unconfirmedCancelHours, 24);
  assert.equal(settings.phoneCheckMode(), 'whatsapp');
  // An existing shop: SMS settings saved and switched on long ago (as an older version saved them), no Phone check saved yet.
  getDb()
    .prepare("INSERT INTO settings (key, data, updated_at) VALUES ('sms', ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data")
    .run(JSON.stringify({ provider: 'twilio', isEnabled: true, twilio: { accountSid: `AC${'0'.repeat(32)}`, authToken: 'secret', fromNumber: '+15005550006' } }), new Date().toISOString());
  settings._clearSettingsCache();
  assert.equal(settings.getSettings('sms').isEnabled, true);
  assert.equal(getDb().prepare("SELECT COUNT(*) FROM settings WHERE key = 'phoneCheck'").pluck().get(), 0, 'never saved');
  assert.equal(settings.phoneCheckMode(), 'whatsapp');
  assert.equal(settings.phoneCodesOn(), false, 'no codes: as if there were no gateway');
  const pub = await (await publicRoute.GET()).json();
  assert.deepEqual(pub.phoneVerification, { method: 'server', check: 'whatsapp', cancelHours: 24 });
  await updateSettings('sms', { isEnabled: false });
});

test('settings: the mode is allow-listed and the hours are a whole number from 2 to 168; saves keep history', async () => {
  for (const bad of [{ mode: 'email' }, { mode: '' }, { mode: null }, { unconfirmedCancelHours: 1 }, { unconfirmedCancelHours: 169 }, { unconfirmedCancelHours: 2.5 }, { unconfirmedCancelHours: 'soon' }, { unconfirmedCancelHours: -24 }]) {
    assert.equal(await status(() => updateSettings('phoneCheck', bad)), 400, JSON.stringify(bad));
  }
  assert.equal(settings.getSettings('phoneCheck').mode, 'whatsapp', 'nothing saved by the refused ones');
  await updateSettings('phoneCheck', { mode: 'sms_code', unconfirmedCancelHours: 2 });
  assert.deepEqual(settings.getSettings('phoneCheck'), { mode: 'sms_code', unconfirmedCancelHours: 2 });
  await updateSettings('phoneCheck', { mode: 'whatsapp', unconfirmedCancelHours: 168, extra: 'ignored' });
  assert.deepEqual(settings.getSettings('phoneCheck'), { mode: 'whatsapp', unconfirmedCancelHours: 168 }, 'unknown fields are dropped');
  assert.ok(settings.settingsHistory().some((v) => v.key === 'phoneCheck'), 'in Settings history');
  await updateSettings('phoneCheck', { unconfirmedCancelHours: 24 });
});

test('WhatsApp mode: no code needed; the number is checked like checkout’s; unverified, awaiting WhatsApp, cancels after the set hours', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA, confirmOrdersOnWhatsApp: false, holdUntilWhatsAppConfirmed: false });
  closeOpen();
  const before = Date.now();
  const o = place();
  assert.equal(o.customer.phoneVerified, false, 'never treated as verified');
  assert.equal(o.whatsappCheck?.status, 'awaiting', 'asked even with Store & contact’s switch off: it is the confirmation');
  const hours = (Date.parse(o.whatsappCheck!.cancelAt!) - before) / 3600_000;
  assert.ok(hours > 23.9 && hours < 24.1, `${hours}`);
  assert.equal(orders.customerView(o).whatsappCheck?.cancelAt, o.whatsappCheck!.cancelAt, 'the customer is told when');
  // Typed in any common form, stored as +971…; landlines and foreign numbers are refused.
  assert.equal(place({}, { phone: '050 606 1234' }).customer.phone, '+971506061234');
  assert.equal(await status(() => place({}, { phone: '04 234 5678' })), 400, 'a landline');
  assert.equal(await status(() => place({}, { phone: '+44 7700 900123' })), 400, 'international');
  // An order from a page from before (no number in the body, an expired code) is told to verify again.
  const p = listProducts()[0];
  const old = await status(() =>
    orders.placeOrder({ idempotencyKey: `pc-old-${Date.now()}-abcdefgh`, verificationToken: 'expired.token', customer: { fullName: 'A', emirate: 'Dubai', area: 'Marina', streetAddress: 'x', buildingVilla: 'y', flatVillaNo: '1' }, items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }], paymentMethod: 'cod' })
  );
  assert.equal(old, 401);
  // A number proved by a code (a page from before, during the update) still counts as verified.
  const proved = place({}, { token: true });
  assert.equal(proved.customer.phoneVerified, true);
  assert.equal(proved.whatsappCheck, undefined, 'and is not asked again');
  // Changing the hours applies to new orders.
  await updateSettings('phoneCheck', { unconfirmedCancelHours: 2 });
  const two = place();
  assert.ok(Math.abs(Date.parse(two.whatsappCheck!.cancelAt!) - Date.now() - 2 * 3600_000) < 60_000);
  await updateSettings('phoneCheck', { unconfirmedCancelHours: 24 });
});

test('WhatsApp mode: the code routes send nothing (no SMS can be pumped); SMS code mode: unchanged', async () => {
  _clearAllRateLimits();
  const send = (phone: string) => otpSend.POST(jsonRequest({ phone }, { origin: 'http://shop.test' }) as never);
  const res = await send('0501234567');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'phone_codes_off');
  await updateSettings('phoneCheck', { mode: 'sms_code' });
  try {
    const sms = await send('0501234568');
    assert.notEqual(sms.status, 409, 'SMS code mode sends as before');
    // And an order needs the code again.
    assert.equal(await status(() => place()), 401);
    assert.equal(place({}, { token: true }).customer.phoneVerified, true);
  } finally {
    await updateSettings('phoneCheck', { mode: 'whatsapp' });
  }
});

test('caps in WhatsApp mode: 2 open unconfirmed orders per phone, a cap per connection and across the shop (polite messages)', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA });
  closeOpen();
  const phone = nextPhone();
  place({}, { phone, ip: '10.9.9.1' });
  place({}, { phone, ip: '10.9.9.2' });
  assert.equal(await codeOf(() => place({}, { phone, ip: '10.9.9.3' })), 'unconfirmed_limit', 'a third for one phone');
  // Confirmed (on WhatsApp or by phone call): no longer counts.
  const first = orders.listOrders({ status: 'pending_confirmation' }).find((o) => o.customer.phone === phone)!;
  orders.checkWhatsApp(first.id, 'call', 'owner@shop.test');
  assert.equal(place({}, { phone, ip: '10.9.9.4' }).customer.phone, phone);

  closeOpen();
  const ip = '10.8.8.8';
  for (let i = 0; i < orders.UNCONFIRMED_LIMITS.perIp; i++) place({}, { ip });
  assert.equal(await codeOf(() => place({}, { ip })), 'unconfirmed_limit', 'per connection');
  assert.ok(place({}, { ip: '10.8.8.9' }).id, 'another connection is fine');

  closeOpen();
  const saved = orders.UNCONFIRMED_LIMITS.shop;
  orders.UNCONFIRMED_LIMITS.shop = 3;
  try {
    place();
    place();
    place();
    const err = await (async () => {
      try {
        place();
      } catch (e) {
        return e as { status: number; message: string; details: { code: string } };
      }
    })();
    assert.equal(err?.status, 429);
    assert.equal(err?.details.code, 'shop_busy');
    assert.match(err!.message, /lot of orders right now, sorry/);
    // A code-verified order is not held back by the WhatsApp caps.
    assert.ok(place({}, { token: true }).id);
  } finally {
    orders.UNCONFIRMED_LIMITS.shop = saved;
  }
  closeOpen();
});

test('auto-cancel: after the set hours an unconfirmed order is cancelled once, its piece back once, audited; a confirmed one stays', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA });
  closeOpen();
  const p = listProducts()[0];
  const size = p.profiles[0].id;
  const start = stockOf(p.id, size);
  const a = place();
  const kept = place();
  orders.checkWhatsApp(kept.id, 'confirmed', 'owner@shop.test');
  const later = place(); // not due yet
  assert.equal(stockOf(p.id, size), start - 3);
  due(a.id);
  due(kept.id);
  const before = auditEntries().length;
  assert.equal(orders.sweepUnconfirmedOrders(), 1);
  assert.equal(orders.sweepUnconfirmedOrders(), 0, 'once');
  assert.equal(orders.getOrder(a.id)!.status, 'cancelled');
  assert.equal(orders.getOrder(kept.id)!.status, 'pending_confirmation', 'confirmed: kept');
  assert.equal(orders.getOrder(later.id)!.status, 'pending_confirmation', 'not due yet');
  assert.equal(stockOf(p.id, size), start - 2, 'one piece back, once');
  const added = auditEntries().slice(before).filter((e) => e.action === 'order.auto_cancelled_unconfirmed');
  assert.equal(added.length, 1);
  assert.equal(added[0].details.orderId, a.id);
  assert.ok(orders.orderEvents(a.id).some((e) => e.event === 'auto_cancelled_unconfirmed'), 'in the order’s history');
  // A mismatch that was never sorted out is cancelled too.
  const m = place();
  orders.checkWhatsApp(m.id, 'mismatch', 'owner@shop.test');
  due(m.id);
  assert.equal(orders.sweepUnconfirmedOrders(), 1);
  assert.equal(orders.getOrder(m.id)!.status, 'cancelled');
  // Cancelled by the owner meanwhile: the sweep leaves it (and its stock) alone.
  const c = place();
  orders.updateOrderByAdmin(c.id, { status: 'cancelled' }, 'owner@shop.test');
  const afterCancel = stockOf(p.id, size);
  due(c.id);
  assert.equal(orders.sweepUnconfirmedOrders(), 0);
  assert.equal(stockOf(p.id, size), afterCancel, 'never put back twice');
  closeOpen();
});

test('auto-cancel exemptions: a bank transfer with its screenshot (or paid) and a paid card order; a bank transfer with neither is cancelled', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA });
  closeOpen();
  orders.RECEIPT_LIMITS.minFreeBytes = 0; // a test machine's disk may be nearly full
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const withShot = place({ paymentMethod: 'bank_transfer' });
  assert.ok(withShot.whatsappCheck?.cancelAt, 'a bank transfer is asked too');
  orders.uploadTransfer(withShot.id, PNG);
  const paid = place({ paymentMethod: 'bank_transfer' });
  orders.checkBankTransfer(paid.id, 'received', 'owner@shop.test');
  const neither = place({ paymentMethod: 'bank_transfer' });
  // A paid card order is trusted: card orders get no deadline at all; even one forced on is exempt.
  const card = place();
  getDb().prepare("UPDATE orders SET card_state = 'paid' WHERE id = ?").run(card.id);
  for (const o of [withShot, paid, neither, card]) due(o.id);
  assert.equal(orders.sweepUnconfirmedOrders(), 1);
  assert.equal(orders.getOrder(neither.id)!.status, 'cancelled');
  assert.equal(orders.getOrder(withShot.id)!.status, 'pending_confirmation');
  assert.equal(orders.getOrder(paid.id)!.status, 'pending_confirmation');
  assert.equal(orders.getOrder(card.id)!.status, 'pending_confirmation');
  assert.equal(orders.getOrder(withShot.id)!.whatsappCheck!.cancelAt, undefined, 'its deadline is cleared: the owner decides');
  assert.equal(orders.sweepUnconfirmedOrders(), 0);
  closeOpen();
});

test('"Confirmed by phone call": idempotent, audited, shown as such, and it stops the auto-cancel', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA });
  closeOpen();
  const o = place();
  const before = auditEntries().length;
  const first = orders.checkWhatsApp(o.id, 'call', 'owner@shop.test');
  assert.equal(first.changed, true);
  assert.equal(first.order.whatsappCheck!.status, 'confirmed');
  assert.equal(first.order.whatsappCheck!.method, 'call');
  assert.equal(first.order.whatsappCheck!.checkedBy, 'owner@shop.test');
  assert.equal(first.order.whatsappCheck!.cancelAt, undefined);
  const again = orders.checkWhatsApp(o.id, 'call', 'someone@shop.test');
  assert.equal(again.changed, false);
  assert.equal(orders.checkWhatsApp(o.id, 'confirmed', 'someone@shop.test').changed, false, 'already confirmed');
  assert.deepEqual(auditEntries().slice(before).map((e) => e.action), ['order.phone_call_confirmed']);
  due(o.id);
  assert.equal(orders.sweepUnconfirmedOrders(), 0);
  assert.equal(orders.getOrder(o.id)!.status, 'pending_confirmation');
  closeOpen();
});

test('"Use the number it came from": validated like checkout’s, the order’s phone changed, the old one kept in its history, audited, then confirmed', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA });
  closeOpen();
  const o = place({}, { phone: '+971506660001' });
  orders.checkWhatsApp(o.id, 'mismatch', 'owner@shop.test');
  assert.equal(await status(() => orders.checkWhatsApp(o.id, 'use_sender', 'owner@shop.test', { phone: '04 234 5678' })), 400, 'a landline');
  assert.equal(await status(() => orders.checkWhatsApp(o.id, 'use_sender', 'owner@shop.test', { phone: 'not a number' })), 400);
  assert.equal(await status(() => orders.checkWhatsApp(o.id, 'use_sender', 'owner@shop.test', {})), 400);
  assert.equal(orders.getOrder(o.id)!.customer.phone, '+971506660001', 'nothing changed by the refused ones');
  const before = auditEntries().length;
  const done = orders.checkWhatsApp(o.id, 'use_sender', 'owner@shop.test', { phone: '055 666 0002' });
  assert.equal(done.changed, true);
  assert.equal(done.order.customer.phone, '+971556660002');
  assert.equal(done.order.whatsappCheck!.status, 'confirmed');
  assert.equal(getDb().prepare('SELECT phone FROM orders WHERE id = ?').pluck().get(o.id), '+971556660002', 'the indexed column too');
  assert.ok(orders.lookupOrder(o.id, '+971556660002'), 'Track Order with the new number');
  const changed = orders.orderEvents(o.id).find((e) => e.event === 'phone_changed')!;
  assert.deepEqual(changed.detail, { from: '+971506660001', to: '+971556660002' });
  assert.deepEqual(auditEntries().slice(before).map((e) => e.action), ['order.phone_changed', 'order.whatsapp_confirmed']);
  assert.equal(orders.checkWhatsApp(o.id, 'use_sender', 'owner@shop.test', { phone: '+971556660002' }).changed, false, 'the same again: nothing');
  assert.equal(await status(() => orders.checkWhatsApp(o.id, 'use_sender', 'owner@shop.test', { phone: '+971556660003' })), 409, 'confirmed: no more changes');
  closeOpen();
});

test('shipping an unconfirmed COD order takes an explicit "ship anyway", recorded in its history and the audit; hold still blocks', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA, holdUntilWhatsAppConfirmed: false });
  closeOpen();
  const o = place();
  assert.equal(await codeOf(() => orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, 'owner@shop.test')), 'whatsapp_unconfirmed');
  assert.equal(await codeOf(() => dispatchOrder({ orderId: o.id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test' })), 'whatsapp_unconfirmed');
  assert.equal(orders.getOrder(o.id)!.courier.awbNumber, '', 'nothing booked');
  const before = auditEntries().length;
  const booked = await dispatchOrder({ orderId: o.id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test', shipUnconfirmed: true });
  assert.equal(booked.status, 200);
  const added = auditEntries().slice(before);
  assert.equal(added[0].action, 'order.ship_unconfirmed', 'recorded before the booking');
  assert.equal(added[0].details.orderId, o.id);
  assert.ok(orders.orderEvents(o.id).some((e) => e.event === 'ship_unconfirmed' && e.actor === 'owner@shop.test'));
  // By hand (status), with the same answer.
  const b = place();
  const confirmed = orders.updateOrderByAdmin(b.id, { status: 'confirmed', shipUnconfirmed: true }, 'owner@shop.test');
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(orders.orderEvents(b.id).some((e) => e.event === 'ship_unconfirmed'));
  // Confirmed (here by phone call): no question.
  const c = place();
  orders.checkWhatsApp(c.id, 'call', 'owner@shop.test');
  assert.equal(orders.updateOrderByAdmin(c.id, { status: 'confirmed' }, 'owner@shop.test').status, 'confirmed');
  // Cancelling never asks.
  const d = place();
  assert.equal(orders.updateOrderByAdmin(d.id, { status: 'cancelled' }, 'owner@shop.test').status, 'cancelled');
  // "Hold until confirmed" still blocks entirely, ship anyway or not.
  await updateSettings('store', { holdUntilWhatsAppConfirmed: true, confirmOrdersOnWhatsApp: true });
  const h = place();
  assert.equal(await codeOf(() => dispatchOrder({ orderId: h.id, provider: 'jeebly', rebook: false, actor: 'owner@shop.test', shipUnconfirmed: true })), 'whatsapp_hold');
  assert.equal(await codeOf(() => orders.updateOrderByAdmin(h.id, { status: 'confirmed', shipUnconfirmed: true }, 'owner@shop.test')), 'whatsapp_hold');
  await updateSettings('store', { holdUntilWhatsAppConfirmed: false, confirmOrdersOnWhatsApp: false });
  // A code-verified COD order (SMS code mode, or a page from before) is shipped as before.
  const v = place({}, { token: true });
  assert.equal(orders.updateOrderByAdmin(v.id, { status: 'confirmed' }, 'owner@shop.test').status, 'confirmed');
  closeOpen();
});

test('no WhatsApp number in WhatsApp mode: orders still taken, flagged "call the customer", never verified or auto-cancelled; a call confirms', async () => {
  await updateSettings('store', { whatsappNumber: '' });
  closeOpen();
  const o = place();
  assert.equal(o.customer.phoneVerified, false);
  assert.equal(o.whatsappCheck, undefined, 'nothing to tap');
  assert.equal(o.attention?.kind, 'call_customer');
  assert.match(o.attention!.text, /No WhatsApp number is set.*call them on \+9715/);
  assert.ok(!('attention' in orders.customerView(o)), 'the note is for the owner only');
  assert.equal(await codeOf(() => orders.updateOrderByAdmin(o.id, { status: 'confirmed' }, 'owner@shop.test')), 'whatsapp_unconfirmed', 'not treated as confirmed');
  assert.equal(orders.sweepUnconfirmedOrders(Date.now() + 400 * 3600_000), 0, 'never auto-cancelled: the customer could not confirm');
  const called = orders.checkWhatsApp(o.id, 'call', 'owner@shop.test').order;
  assert.equal(called.whatsappCheck!.status, 'confirmed');
  assert.equal(called.whatsappCheck!.method, 'call');
  assert.equal(called.attention, undefined, 'the flag is cleared');
  assert.equal(await status(() => orders.checkWhatsApp(place().id, 'confirmed', 'owner@shop.test')), 409, 'nothing was asked on WhatsApp');
  await updateSettings('store', { whatsappNumber: SHOP_WA });
  closeOpen();
});

test('customer reach: the bank-details email carries the "Confirm on WhatsApp" link while awaiting; the owner’s "Ask to confirm" message is safe', () => {
  const link = wa.confirmLink(SHOP_WA, 'BUH-261018-ABC234', '0427')!;
  const mail = messages.bankDetailsEmail({ orderId: 'BUH-261018-ABC234', total: 100, bank: settings.getSettings('bank'), firstName: 'Salma', confirmLink: link, cancelHours: 24 });
  assert.ok(mail.text.includes(link));
  assert.match(mail.text, /To confirm your order, tap to send us a WhatsApp message/);
  assert.match(mail.text, /Orders not confirmed within 24 hours are cancelled\./);
  assert.ok(!messages.bankDetailsEmail({ orderId: 'BUH-1', total: 1, bank: settings.getSettings('bank') }).text.includes('wa.me'), 'none without it');

  const ask = wa.askToConfirmMessage('BUH-261018-ABC234', messages.safeFirstName('http://evil.example Salma'), 'Beautiful UAE Home');
  assert.equal(ask, 'Hello Salma, please confirm your order BUH-261018-ABC234 from Beautiful UAE Home by replying YES. Thank you!');
  assert.match(wa.askToConfirmMessage('BUH-1', '', 'BEAUTIFUL UAE HOME'), /^Hello, please confirm your order BUH-1 from Beautiful UAE Home by replying YES\. Thank you!$/, 'a logo-style name reads normally');
  const l = wa.waMeLink('+971501234567', ask)!;
  assert.equal(new URL(l).searchParams.get('text'), ask);
  assert.equal(wa.cancelHoursOf('2026-10-18T10:00:00.000Z', '2026-10-19T10:00:00.000Z'), 24);
  assert.equal(wa.cancelHoursOf('2026-10-18T10:00:00.000Z', undefined), null);
  assert.equal(wa.timeLeft('2026-10-18T23:00:00.000Z', Date.parse('2026-10-18T10:00:00.000Z')), '13 h');
  assert.equal(wa.timeLeft('2026-10-18T10:30:00.000Z', Date.parse('2026-10-18T10:00:00.000Z')), '30 min');
});

test('rollback safety: an order placed with no code is plain JSON an older version reads (phoneVerified false, nothing new inside)', async () => {
  await updateSettings('store', { whatsappNumber: SHOP_WA });
  closeOpen();
  const o = place();
  const data = JSON.parse(getDb().prepare('SELECT data FROM orders WHERE id = ?').pluck().get(o.id) as string);
  assert.equal(data.customer.phone, o.customer.phone);
  assert.equal(data.customer.phoneVerified, false);
  assert.equal(data.status, 'pending_confirmation', 'a status every version knows');
  for (const k of ['whatsappCheck', 'card', 'bankTransfer', 'attention']) assert.ok(!(k in data), `${k} is in its own columns`);
  // Migration 11 only adds (columns and an index).
  const src = fs.readFileSync('src/lib/server/db.ts', 'utf8');
  const m11 = src.slice(src.indexOf('// 11 (phone check by WhatsApp)'), src.indexOf('];', src.indexOf('// 11 (phone check by WhatsApp)')));
  const statements = m11.slice(m11.indexOf('db.exec(`') + 9, m11.indexOf('`);')).split(';').map((s) => s.replace(/--.*$/gm, '').trim()).filter(Boolean);
  assert.equal(statements.length, 3);
  for (const s of statements) assert.match(s, /^(ALTER TABLE orders ADD COLUMN|CREATE INDEX)/, s);
  closeOpen();
});
