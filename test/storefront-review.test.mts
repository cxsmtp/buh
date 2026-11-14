/**
 * The storefront review's fixes, below the browser:
 * - #4: the small-bag limit of an order whose phone no code proved is published in
 *   /api/settings/public, and the bag's own check agrees with the server's refusal;
 * - #5: several strangers behind one shared mobile address can each place an order (the cap per
 *   connection is roomy), while the cap per phone stays;
 * - #6: the delivery box and the server's order refusals carry a code and values, and their Arabic
 *   is built from those; the English built from them is word for word the server's own text;
 * - #3: a failed chunk reloads the page once, never in a loop;
 * - #11: the ways to pay and where the shop delivers are said from settings, and the chat's
 *   starting answers make no fixed promise about fabric, hand work or hours;
 * - #14: the Terms page's canonical is the shop's full address (NEXT_PUBLIC_APP_URL), or left out.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { tempDataDir } from './helpers.mjs';

tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY', 'SMS_WEBHOOK_URL', 'TWILIO_ACCOUNT_SID', 'INFOBIP_API_KEY', 'APP_URL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const { updateSettings } = await import('@/lib/server/settings');
const { listProducts } = await import('@/lib/server/products');
const { getDb } = await import('@/lib/server/db');
const publicRoute = await import('@/app/api/settings/public/route');
const { deliveryCheck } = await import('@/lib/delivery');
const { DEFAULT_DELIVERY, DEFAULT_ASSISTANT } = await import('@/data/catalogDefaults');
const words = await import('@/components/store/checkoutWords');
const chunk = await import('@/lib/client/chunkReload');

await updateSettings('store', { whatsappNumber: '+971501112233' });

const ARABIC = /[؀-ۿ]/;
let n = 0;
const nextPhone = () => `+9715061${String(++n).padStart(5, '0')}`;
const body = (over: Record<string, unknown> = {}, phone = nextPhone()) => {
  const p = listProducts()[0];
  return {
    idempotencyKey: `sr-test-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    customer: { fullName: 'Salma Test', phone, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
    ...over,
  };
};
const place = (over: Record<string, unknown> = {}, opts: { phone?: string; ip?: string } = {}) => orders.placeOrder(body(over, opts.phone), { ip: opts.ip ?? `10.1.${n % 250}.${(n * 7) % 250}` }).order;
type Refusal = { status: number; message: string; details: Record<string, unknown> };
function refusal(fn: () => unknown): Refusal {
  try {
    fn();
  } catch (e) {
    return e as Refusal;
  }
  throw new Error('the order was not refused');
}
/** Orders still waiting are closed, so one test's orders don't count in the next. */
const closeOpen = () => getDb().prepare("UPDATE orders SET status = 'cancelled' WHERE status = 'pending_confirmation'").run();

test('#5: five strangers behind one shared mobile address can all order; the cap per connection is a fifth of the shop’s, and each phone keeps its own cap', () => {
  closeOpen();
  assert.equal(orders.UNCONFIRMED_LIMITS.perIp, 12);
  assert.equal(orders.UNCONFIRMED_LIMITS.perPhone, 2, 'the cap per phone is unchanged');
  assert.ok(orders.UNCONFIRMED_LIMITS.perIp * 5 <= orders.UNCONFIRMED_LIMITS.shop, 'one address can never fill the shop’s cap');
  const ip = '94.200.10.20';
  // Before the fix the fifth was refused ("Several orders from this connection…").
  for (let i = 0; i < 5; i++) assert.ok(place({}, { ip }).id, `stranger ${i + 1}`);
  for (let i = 5; i < orders.UNCONFIRMED_LIMITS.perIp; i++) place({}, { ip });
  const r = refusal(() => place({}, { ip }));
  assert.equal(r.status, 429);
  assert.equal(r.details.code, 'unconfirmed_limit');
  assert.equal(r.details.scope, 'connection');
  assert.match(r.message, /Several orders from this connection are waiting/);
  // One phone still gets two, whatever the address.
  closeOpen();
  const phone = nextPhone();
  place({}, { phone, ip: '94.200.10.21' });
  place({}, { phone, ip: '94.200.10.22' });
  const mine = refusal(() => place({}, { phone, ip: '94.200.10.23' }));
  assert.equal(mine.details.code, 'unconfirmed_limit');
  assert.equal(mine.details.scope, 'phone');
  closeOpen();
});

test('#4: the small-bag limit is published for the bag, and the bag’s check agrees with the server’s refusal', async () => {
  closeOpen();
  const pub = await (await publicRoute.GET()).json();
  assert.deepEqual(pub.bagLimit, { applies: 'all', perItem: orders.MAX_UNVERIFIED_CARD_QTY, lines: orders.MAX_UNVERIFIED_CARD_LINES }, 'Phone check "WhatsApp": every order');
  const p = listProducts()[0];
  const line = (quantity: number, profile = 0, product = p) => ({ product: { id: product.id }, selectedProfile: { id: product.profiles[profile].id }, quantity });
  assert.equal(words.bagOverLimit([line(2)], pub.bagLimit), null);
  assert.equal(words.bagOverLimit([line(3)], pub.bagLimit), 'each');
  // Two lines of the same size (two colours) count together, as on the server.
  assert.equal(words.bagOverLimit([line(2), line(1)], pub.bagLimit), 'each');
  assert.equal(words.bagOverLimit([line(1)], null), null, 'no limit published: none applied');

  const three = refusal(() => place({ items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 3 }] }));
  assert.equal(three.details.code, 'unconfirmed_bag_limit');
  assert.deepEqual([three.details.limit, three.details.max], ['each', 2]);
  // What the bag says before checkout is what the server would say after the form.
  assert.equal(words.bagLimitMessage('each', pub.bagLimit, false, 'en'), three.message);
  assert.match(words.bagLimitMessage('each', pub.bagLimit, false, 'ar'), ARABIC);

  const all = listProducts().flatMap((prod) => prod.profiles.map((pr) => ({ productId: prod.id, profileId: pr.id, quantity: 1 })));
  assert.ok(all.length >= 6, 'the test shop has six sizes to put in a bag');
  const six = refusal(() => place({ items: all.slice(0, 6) }));
  assert.deepEqual([six.details.code, six.details.limit, six.details.max], ['unconfirmed_bag_limit', 'lines', 5]);
  assert.equal(words.bagLimitMessage('lines', pub.bagLimit, false, 'en'), six.message);
  assert.equal(words.bagOverLimit(all.slice(0, 6).map((l) => ({ product: { id: l.productId }, selectedProfile: { id: l.profileId }, quantity: 1 })), pub.bagLimit), 'lines');

  // "SMS code" with no card payments: every order proves its phone, so no small bag.
  await updateSettings('phoneCheck', { mode: 'sms_code' });
  assert.equal((await (await publicRoute.GET()).json()).bagLimit, null);
  await updateSettings('phoneCheck', { mode: 'whatsapp' });
});

test('#6: the delivery box has a code and values; its Arabic is built from them, its English is unchanged', () => {
  const noon = Date.UTC(2026, 10, 11, 8, 0); // a Wednesday, 12:00 in the UAE
  const s = { ...DEFAULT_DELIVERY, sameDayEnabled: true, notServed: ['Hatta'] };
  const ok = deliveryCheck({ emirate: 'Dubai', area: 'Dubai Marina' }, s, noon);
  assert.equal(ok.message, 'We deliver to Dubai Marina, Dubai');
  assert.equal(ok.code, 'delivers');
  assert.equal(words.deliveryMessage(ok, 'en'), ok.message);
  const ar = words.deliveryMessage(ok, 'ar');
  assert.match(ar, /نوصّل إلى/);
  assert.match(ar, /دبي/, 'the emirate in Arabic');
  assert.match(ar, /Dubai Marina/, 'the area as the customer chose it');
  assert.doesNotMatch(ar, /We deliver/);

  const no = deliveryCheck({ emirate: 'Dubai', area: 'Hatta' }, s, noon);
  assert.equal(no.code, 'not_served');
  assert.equal(words.deliveryMessage(no, 'en'), no.message);
  assert.match(words.deliveryMessage(no, 'ar'), /عذراً/);
  const none = deliveryCheck({ emirate: '', area: '' }, s, noon);
  assert.equal(none.code, 'choose_emirate');
  assert.equal(words.deliveryMessage(none, 'en'), none.message);

  // Same day: only some emirates, never on a Sunday, not after the cut-off.
  const reason = (c: ReturnType<typeof deliveryCheck>, locale: 'en' | 'ar') => words.sameDayReason(c.sameDay.reasonCode, { emirates: s.sameDayEmirates, cutoff: c.sameDay.cutoff }, locale);
  const sharjah = deliveryCheck({ emirate: 'Sharjah', area: 'Al Nahda' }, s, noon);
  assert.equal(sharjah.sameDay.reasonCode, 'emirates');
  assert.equal(reason(sharjah, 'en'), sharjah.sameDay.reason);
  assert.match(reason(sharjah, 'ar'), /دبي/);
  const sunday = deliveryCheck({ emirate: 'Dubai', area: 'Dubai Marina' }, s, Date.UTC(2026, 10, 15, 6, 0));
  assert.equal(sunday.sameDay.reasonCode, 'sunday');
  assert.equal(sunday.sameDay.reason, 'Same-day delivery is not offered on Sundays; Monday is the earliest.');
  assert.equal(reason(sunday, 'en'), sunday.sameDay.reason);
  assert.match(reason(sunday, 'ar'), /الأحد/);
  const late = deliveryCheck({ emirate: 'Dubai', area: 'Dubai Marina' }, s, Date.UTC(2026, 10, 11, 12, 0));
  assert.equal(late.sameDay.reasonCode, 'cutoff');
  assert.equal(reason(late, 'en'), late.sameDay.reason);
  assert.match(reason(late, 'ar'), /13:00/);
  assert.equal(ok.sameDay.reasonCode, undefined, 'offered: no reason');
  assert.equal(reason(ok, 'ar'), '');

  // The names the shop starts with are said in Arabic; a name the owner typed is kept as typed.
  assert.equal(words.deliveryName('standard', DEFAULT_DELIVERY, 'en'), 'Standard delivery');
  assert.equal(words.deliveryName('sameDay', DEFAULT_DELIVERY, 'en'), 'Same day');
  assert.match(words.deliveryName('standard', DEFAULT_DELIVERY, 'ar'), ARABIC);
  assert.match(words.deliveryName('sameDay', DEFAULT_DELIVERY, 'ar'), ARABIC);
  assert.match(words.deliveryName('standard', { standardName: '', sameDayName: '' }, 'ar'), ARABIC);
  assert.equal(words.deliveryName('standard', { standardName: 'Door to door', sameDayName: 'Rocket' }, 'ar'), 'Door to door');
  assert.equal(words.deliveryName('sameDay', { standardName: 'Door to door', sameDayName: 'Rocket' }, 'en'), 'Rocket');
});

test('#6: every refusal a customer can meet at checkout has a code; the English built from it is the server’s own text, and there is Arabic for it', async () => {
  closeOpen();
  const p = listProducts()[0];
  const size = p.profiles[0];
  const seen: Refusal[] = [];
  const check = (what: string, fn: () => unknown, code: string) => {
    const r = refusal(fn);
    assert.equal(r.details.code, code, what);
    assert.equal(words.refusalText(r.details, 'en'), r.message, `${what}: the English is the server's`);
    const ar = words.refusalText(r.details, 'ar');
    assert.ok(ar && ARABIC.test(ar), `${what}: said in Arabic`);
    seen.push(r);
    return { r, ar: ar! };
  };

  check('another emirate', () => place({ customer: { ...body().customer, emirate: 'Muscat' } }), 'bad_emirate');
  check('a wrong email', () => place({ customer: { ...body().customer, email: 'not-an-email' } }), 'bad_email');
  check('an empty bag', () => place({ items: [] }), 'bag_empty');
  check('no such way of paying', () => place({ paymentMethod: 'cheque' }), 'bad_payment');
  await updateSettings('payments', { bankTransferMode: 'off' });
  check('bank transfer switched off', () => place({ paymentMethod: 'bank_transfer' }), 'bank_unavailable');
  await updateSettings('payments', { bankTransferMode: 'ask_whatsapp' });
  check('card switched off', () => place({ paymentMethod: 'online_card' }), 'card_unavailable');
  check('too many of one size for an unconfirmed number', () => place({ items: [{ productId: p.id, profileId: size.id, quantity: 3 }] }), 'unconfirmed_bag_limit');
  check('too many lines', () => place({ items: Array.from({ length: 21 }, () => ({ productId: p.id, profileId: size.id, quantity: 1 })) }), 'bag_lines_limit');
  check('a quantity of 0', () => place({ items: [{ productId: p.id, profileId: size.id, quantity: 0 }] }), 'bad_quantity');
  check('a product that is gone', () => place({ items: [{ productId: 'no-such-product', profileId: size.id, quantity: 1 }] }), 'item_unavailable');
  check('a size that is gone', () => place({ items: [{ productId: p.id, profileId: 'no-such-size', quantity: 1 }] }), 'size_unavailable');
  const price = check('a total that changed', () => place({ expectedTotal: 1 }), 'price_changed');
  assert.match(price.ar, new RegExp(String(price.r.details.total)), 'the new total is in the Arabic too');

  // An area the shop does not deliver to.
  await updateSettings('delivery', { ...DEFAULT_DELIVERY, notServed: ['Hatta'], sameDayEnabled: true });
  const away = check('an area not served', () => place({ customer: { ...body().customer, area: 'Hatta' } }), 'not_delivered');
  assert.match(away.ar, /Hatta/);
  assert.match(away.ar, /دبي/);
  // Same day asked for where it is not offered.
  const sd = check('same day in another emirate', () => place({ deliveryOption: 'same_day', customer: { ...body().customer, emirate: 'Sharjah', area: 'Al Nahda' } }), 'same_day_unavailable');
  assert.equal(sd.r.details.reason, 'emirates');
  await updateSettings('delivery', DEFAULT_DELIVERY);

  // Sold out, and only one left.
  getDb().prepare('UPDATE product_stock SET qty = 1 WHERE product_id = ? AND size_id = ?').run(p.id, size.id);
  const left = check('more than is left', () => place({ items: [{ productId: p.id, profileId: size.id, quantity: 2 }] }), 'only_left');
  assert.equal(left.r.details.left, 1);
  getDb().prepare('UPDATE product_stock SET qty = 0 WHERE product_id = ? AND size_id = ?').run(p.id, size.id);
  const gone = check('sold out', () => place({ items: [{ productId: p.id, profileId: size.id, quantity: 1 }] }), 'sold_out');
  // The product's Arabic name is used when the bag knows it.
  assert.match(words.refusalText(gone.r.details, 'ar', (id) => (id === p.id ? 'طقم الياسمين' : undefined)) ?? '', /طقم الياسمين/);
  getDb().prepare('UPDATE product_stock SET qty = 50 WHERE product_id = ? AND size_id = ?').run(p.id, size.id);

  // The same checkout sent again for something else (the review's #2): refused with a code, never another order's "thank you".
  const first = body();
  orders.placeOrder(first, { ip: '10.3.3.3' });
  check('the same checkout, another way of paying', () => orders.placeOrder({ ...first, items: [{ ...first.items[0], quantity: 2 }] }, { ip: '10.3.3.3' }), 'checkout_changed');
  // Too many waiting for one phone.
  closeOpen();
  const phone = nextPhone();
  place({}, { phone });
  place({}, { phone });
  check('a third unconfirmed order for one phone', () => place({}, { phone }), 'unconfirmed_limit');
  closeOpen();

  // A refusal without a code we know: the server's own message is shown (never a blank).
  assert.equal(words.refusalText({ code: 'something_new' }, 'ar'), null);
  assert.equal(words.refusalText({}, 'ar'), null);
  assert.ok(seen.length >= 17);
});

test('#3: a piece of the shop that could not be fetched reloads the page once, never in a loop', () => {
  const failed = Object.assign(new Error('Loading chunk 123 failed.\n(error: https://shop.test/_next/static/chunks/123.js)'), { name: 'ChunkLoadError' });
  assert.equal(chunk.isChunkLoadError(failed), true);
  assert.equal(chunk.isChunkLoadError(new Error('Failed to load chunk /_next/static/chunks/0abc.js from module 42')), true);
  assert.equal(chunk.isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://shop.test/x.js')), true);
  assert.equal(chunk.isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')")), false, 'a bug is not a missing chunk');
  assert.equal(chunk.isChunkLoadError(null), false);
  assert.equal(chunk.isChunkLoadError('boom'), false);

  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const t0 = 1_800_000_000_000;
  assert.equal(chunk.mayReloadNow(storage, t0), true, 'the first time: reload');
  assert.equal(chunk.mayReloadNow(storage, t0 + 2_000), false, 'it failed again right after the reload: show the page with the button');
  assert.equal(chunk.mayReloadNow(storage, t0 + 59_000), false);
  assert.equal(chunk.mayReloadNow(storage, t0 + 5 * 60_000), true, 'much later (another update): once more');
  assert.equal(chunk.mayReloadNow(null, t0), false, 'no storage to remember in: never by itself');
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
  assert.equal(chunk.mayReloadNow(blocked, t0), false);
  // The storefront has its own error pages (there was only the hub's).
  for (const f of ['src/app/error.tsx', 'src/app/global-error.tsx']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /^'use client';/, f);
    assert.match(src, /reloadOnceForChunk\(error\)/, f);
    assert.match(src, /window\.location\.reload\(\)/, `${f} offers Reload`);
  }
});

test('#11: the ways to pay and where the shop delivers come from settings; nothing fixed about hand work, fabric or hours', () => {
  assert.equal(words.payWays({ card: false, bank: false }, 'en'), 'Cash on delivery');
  assert.equal(words.payWays({ card: false, bank: true }, 'en'), 'Cash on delivery or bank transfer');
  assert.equal(words.payWays({ card: true, bank: false }, 'en'), 'Card or cash on delivery');
  assert.equal(words.payWays({ card: true, bank: true }, 'en'), 'Card, cash on delivery or bank transfer');
  assert.equal(words.payWays({ card: true, bank: true, cod: false }, 'en', false), 'card or bank transfer');
  assert.doesNotMatch(words.payWays({ card: false, bank: false }, 'ar'), /التحويل البنكي/, 'no bank transfer promised when it is off');
  assert.match(words.payWays({ card: false, bank: true }, 'ar'), /التحويل البنكي/);
  assert.equal(words.servedPlaces(DEFAULT_DELIVERY.emirates, 'en'), 'all seven emirates');
  assert.equal(words.servedPlaces(['Dubai', 'Sharjah', 'Ajman'], 'en'), 'Dubai, Sharjah and Ajman');
  assert.equal(words.servedPlaces(['Dubai'], 'en'), 'Dubai');
  assert.match(words.servedPlaces(['Dubai', 'Sharjah'], 'ar'), /دبي و.*الشارقة/);

  // The pages no longer say these whatever the settings.
  const shop = fs.readFileSync('src/components/ShopApp.tsx', 'utf8');
  assert.doesNotMatch(shop, /slow handcraft|Made slowly|مصنوع يدوياً/);
  assert.doesNotMatch(shop, /with cash on delivery or bank transfer/);
  const bag = fs.readFileSync('src/components/store/CartDrawer.tsx', 'utf8');
  assert.doesNotMatch(bag, /Cash on delivery or bank transfer|all seven emirates/);
  const checkout = fs.readFileSync('src/components/store/CheckoutModal.tsx', 'utf8');
  assert.doesNotMatch(checkout, /Apple Pay, Google Pay or cash|prepared with care in Dubai|any of the seven emirates/);
  assert.doesNotMatch(checkout, /\balert\(/, 'checkout says problems on the page, never in a pop-up');
  const layout = fs.readFileSync('src/app/layout.tsx', 'utf8');
  assert.doesNotMatch(layout, /Egyptian cotton|Direct Bank Transfer|Trading LLC|express delivery/i);
  // The chat's starting answers.
  const answers = DEFAULT_ASSISTANT.entries.map((e) => e.answer).join('\n');
  assert.doesNotMatch(answers, /handmade|24 to 48 hours|Hand-block-printed cotton:|all seven emirates/);
  assert.doesNotMatch(fs.readFileSync('src/lib/server/chat.ts', 'utf8'), /usually replies within a few minutes/);
});

test('#14: the Terms page’s canonical is the shop’s full address (NEXT_PUBLIC_APP_URL), and is left out without it', async () => {
  const page = await import('@/app/terms/page');
  delete process.env.NEXT_PUBLIC_APP_URL;
  const without = await page.generateMetadata();
  assert.equal(without.alternates, undefined, 'no relative /terms for the framework to complete with its own address');
  process.env.NEXT_PUBLIC_APP_URL = 'https://beautifuluaehome.com';
  try {
    const withUrl = await page.generateMetadata();
    assert.deepEqual(withUrl.alternates, { canonical: 'https://beautifuluaehome.com/terms' });
  } finally {
    delete process.env.NEXT_PUBLIC_APP_URL;
  }
});
