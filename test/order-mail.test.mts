/**
 * The customer's order emails (src/lib/server/orderMail.ts, src/lib/orderMessages.ts), against a
 * local mail server: "your order is in process" when a cash-on-delivery order is placed, with the
 * one last step (Confirm on WhatsApp) while it waits; "your order is confirmed" once the shop has
 * confirmed it (on WhatsApp, by phone call, or by moving it on). Once each per order, never for a
 * cancelled order or one without an email, within a daily share per address; noted on the order's
 * history, the address masked in the log. The Track Order link opens the order.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const { emailOrder } = await import('@/lib/server/orderMail');
const { listProducts } = await import('@/lib/server/products');
const { updateSettings } = await import('@/lib/server/settings');
const { _clearAllRateLimits } = await import('@/lib/server/rateLimit');
const messages = await import('@/lib/orderMessages');

await updateSettings('brand', { storeName: 'Beautiful UAE Home' });
await updateSettings('store', { whatsappNumber: '+971501234567' });

let n = 0;
function place(over: Record<string, unknown> = {}, email: string | null = 'layla@example.com') {
  _clearAllRateLimits();
  const p = listProducts()[0];
  const phone = `+9715060${String(++n).padStart(5, '0')}`;
  return orders.placeOrder({
    idempotencyKey: `mail-test-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    customer: { fullName: 'Layla Test', phone, ...(email ? { email } : {}), emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
    ...over,
  }, { ip: `10.0.${n}.1` }).order;
}

async function withMailServer(fn: (mails: Array<{ to: string; subject: string; text: string }>) => Promise<void>) {
  const { SMTPServer } = await import('smtp-server');
  const { simpleParser } = await import('mailparser');
  const raws: Array<{ to: string; raw: string }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        raws.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.server.address() as { port: number }).port;
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false', SMTP_REQUIRE_TLS: 'false', SMTP_FROM: 'shop@shop.test', BACKUP_EMAIL: 'owner@shop.test', NEXT_PUBLIC_APP_URL: 'https://beautifuluaehome.com' });
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const read = async () => {
    mails.length = 0;
    for (const r of raws) {
      const m = await simpleParser(r.raw);
      mails.push({ to: r.to, subject: m.subject ?? '', text: m.text ?? '' });
    }
    return mails;
  };
  try {
    await fn(new Proxy(mails, { get: (t, k) => (k === 'read' ? read : Reflect.get(t, k)) }) as typeof mails);
  } finally {
    server.close();
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_TLS', 'SMTP_FROM', 'BACKUP_EMAIL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
  }
}
type Box = Array<{ to: string; subject: string; text: string }> & { read: () => Promise<Array<{ to: string; subject: string; text: string }>> };

test('the words: "in process" with the one last step (confirm on WhatsApp) while it waits, "confirmed" with what happens next; the name can’t carry a link', () => {
  const base = { orderId: 'BUH-261023-ABC234', total: 245, firstName: 'Layla evil.com Test', shopName: 'Beautiful UAE Home', paymentMethod: 'cod' as const, lines: ['1 × Palm & Rose Hand Block Print Bed Set (King)'], trackLink: 'https://beautifuluaehome.com/?open=track&order=BUH-261023-ABC234' };
  const waiting = messages.orderReceivedEmail({ ...base, confirmLink: 'https://wa.me/971501234567?text=x', cancelHours: 24 });
  assert.equal(waiting.subject, 'One last step to confirm your order BUH-261023-ABC234');
  assert.match(waiting.text, /^Hello Layla,/);
  assert.doesNotMatch(waiting.text, /evil\.com/);
  assert.match(waiting.text, /is in process/);
  assert.match(waiting.text, /One last step: please confirm it on WhatsApp/);
  assert.match(waiting.text, /https:\/\/wa\.me\/971501234567/);
  assert.match(waiting.text, /not confirmed within 24 hours are cancelled/);
  assert.match(waiting.text, /Total: AED 245/);
  assert.match(waiting.text, /Payment: Cash on delivery/);
  assert.match(waiting.text, /\?open=track&order=BUH-261023-ABC234/);
  const plain = messages.orderReceivedEmail(base);
  assert.equal(plain.subject, 'Your order BUH-261023-ABC234 is in process');
  assert.doesNotMatch(plain.text, /One last step/);
  const cod = messages.orderConfirmedEmail(base);
  assert.equal(cod.subject, 'Your order BUH-261023-ABC234 is confirmed');
  assert.match(cod.text, /pay in cash when it is delivered/);
  assert.match(messages.orderConfirmedEmail({ ...base, paymentMethod: 'bank_transfer' }).text, /as soon as your bank transfer arrives/);
  assert.match(messages.orderReceivedEmail({ ...base, trackLink: undefined }).text, /Track Order/);
});

test('cash on delivery: "in process" once when placed (with the WhatsApp link while it waits), "confirmed" once when the shop confirms; nothing without an email, for a card order or a cancelled one', async () => {
  await withMailServer(async (box) => {
    const mails = box as Box;
    const o = place();
    assert.equal(o.whatsappCheck?.status, 'awaiting', 'this shop asks on WhatsApp');
    assert.equal(await emailOrder(o.id, 'received'), 'sent');
    assert.equal(await emailOrder(o.id, 'received'), 'skipped', 'once per order');
    await Promise.all([emailOrder(o.id, 'received'), emailOrder(o.id, 'received')]);
    // Not confirmed yet: no "confirmed" email.
    assert.equal(await emailOrder(o.id, 'confirmed'), 'skipped');
    let got = await mails.read();
    assert.equal(got.length, 1);
    assert.equal(got[0].to, 'layla@example.com');
    assert.equal(got[0].subject, `One last step to confirm your order ${o.id}`);
    assert.match(got[0].text, new RegExp(`code%20${o.whatsappCheck!.code}|code ${o.whatsappCheck!.code}`));
    assert.ok(got[0].text.includes(`https://beautifuluaehome.com/?open=track&order=${o.id}`));
    assert.ok(orders.orderEvents(o.id).some((e) => e.event === 'received_emailed'), 'noted on the order');

    // The shop confirms it on WhatsApp: "confirmed", once.
    orders.checkWhatsApp(o.id, 'confirmed', 'owner@shop.test');
    assert.equal(await emailOrder(o.id, 'confirmed'), 'sent');
    assert.equal(await emailOrder(o.id, 'confirmed'), 'skipped');
    got = await mails.read();
    assert.equal(got.length, 2);
    assert.equal(got[1].subject, `Your order ${o.id} is confirmed`);
    assert.match(got[1].text, /pay in cash when it is delivered/);

    // By phone call: also "confirmed".
    const call = place();
    orders.checkWhatsApp(call.id, 'call', 'owner@shop.test');
    assert.equal(await emailOrder(call.id, 'confirmed'), 'sent');

    // No email, a card order, a cancelled order: nothing.
    assert.equal(await emailOrder(place({}, null).id, 'received'), 'skipped');
    const cancelled = place();
    orders.updateOrderByAdmin(cancelled.id, { status: 'cancelled' }, 'owner@shop.test');
    assert.equal(await emailOrder(cancelled.id, 'received'), 'skipped');
  });
});

test('a daily share per address: an address typed at checkout can’t be flooded', async () => {
  await withMailServer(async (box) => {
    const mails = box as Box;
    let sent = 0;
    for (let i = 0; i < orders.ORDER_EMAIL_LIMITS.perAddress + 2; i++) {
      const o = place({}, 'someone@example.com');
      if ((await emailOrder(o.id, 'received')) === 'sent') sent++;
    }
    assert.equal(sent, orders.ORDER_EMAIL_LIMITS.perAddress);
    assert.equal((await mails.read()).filter((m) => m.to === 'someone@example.com').length, orders.ORDER_EMAIL_LIMITS.perAddress);
  });
});
