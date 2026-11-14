/**
 * The storefront gaps the review's first round of fixes left open, below the browser:
 * - Arabic: every customer-facing refusal of the order, phone-check, chat, tracking and upload
 *   routes carries a code (and values), and the shop says the Arabic from those; the English is
 *   the server's own sentence, word for word;
 * - the chat: its notices are in the customer's language (the page says which; allow-listed), and
 *   an Arabic question about delivery, payment, returns, care, offers or sizes is answered from the
 *   same entries and size presets, never with an invented translation of the owner's words; a
 *   problem with an order still goes to a person;
 * - messages to the shop name the shop as Settings → Brand does;
 * - the shop's own photos come in smaller widths (allow-listed, never bigger than the original,
 *   kept in a cache folder that is not in the backup and stays under its cap), with the original's
 *   headers; photo cards get a srcset;
 * - canonicals, the sitemap and robots.txt are never built from an unknown Host header.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { jsonRequest, tempDataDir } from './helpers.mjs';
import { makePng } from './fixtures/png.mjs';

const dataDir = tempDataDir();
delete process.env.BACKUP_PASSPHRASE;
for (const k of ['SMTP_HOST', 'SMTP_PORT', 'BACKUP_EMAIL', 'TRUST_PROXY', 'SMS_WEBHOOK_URL', 'TWILIO_ACCOUNT_SID', 'INFOBIP_API_KEY', 'APP_URL', 'NEXT_PUBLIC_APP_URL']) delete process.env[k];
const orders = await import('@/lib/server/orders');
const { updateSettings, getSettings } = await import('@/lib/server/settings');
const { listProducts } = await import('@/lib/server/products');
const { translate } = await import('@/lib/i18n');
const server = await import('@/components/store/serverWords');
const refusals = await import('@/components/store/checkoutWords');
const { reply, greetingFor } = await import('@/lib/assistant');
const chat = await import('@/lib/server/chat');
const { DEFAULT_ASSISTANT, DEFAULT_CATALOG, DEFAULT_STORE } = await import('@/data/catalogDefaults');
const otp = await import('@/lib/otpService');
const images = await import('@/lib/server/images');
const variants = await import('@/lib/server/imageVariants');
const imageRoute = await import('@/app/api/images/[name]/route');
const photos = await import('@/lib/client/photos');
const shop = await import('@/lib/client/shop');
const { imageDimensions } = await import('@/lib/server/imageInput');
const { enforceLimit } = await import('@/lib/server/guard');
const { firebaseErrorMessage } = await import('@/lib/firebasePhoneClient');

await updateSettings('store', { whatsappNumber: '+971501112233' });

const ARABIC = /[؀-ۿ]/;
const LATIN_WORD = /[A-Za-z]{4,}/;
/** Arabic text with the values' isolation marks taken out. */
const plain = (s: string) => s.replace(/[⁨⁩]/g, '');
type Refusal = { status: number; message: string; details: Record<string, unknown> };
function refusal(fn: () => unknown): Refusal {
  try {
    fn();
  } catch (e) {
    return e as Refusal;
  }
  throw new Error('not refused');
}
let n = 0;
const body = (over: Record<string, unknown> = {}) => {
  const p = listProducts()[0];
  return {
    idempotencyKey: `gaps-test-${++n}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    customer: { fullName: 'Salma Test', phone: `+9715062${String(n).padStart(5, '0')}`, emirate: 'Dubai', area: 'Marina', streetAddress: 'Walk 1', buildingVilla: 'Tower', flatVillaNo: '7' },
    items: [{ productId: p.id, profileId: p.profiles[0].id, quantity: 1 }],
    paymentMethod: 'cod',
    ...over,
  };
};
/** What the shop shows for a refusal, as checkout does: the order's own words first, then the general ones. */
const shown = (r: Refusal, locale: 'en' | 'ar') =>
  (locale === 'ar' ? refusals.refusalText(r.details, 'ar') : null) || server.serverSaid({ status: r.status, data: { ...r.details, message: r.message } }, locale, locale === 'ar' ? 'تعذّر إرسال الطلب.' : 'Not placed.');

// ── 1. Arabic for what the server says ───────────────────────────────────────

test('a box left empty at checkout: the server names the box by code, Arabic names it in Arabic, English is unchanged', () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ fullName: '' }, 'Full name is required.', 'الاسم الكامل'],
    [{ area: '' }, 'Area is required.', 'المنطقة'],
    [{ streetAddress: '   ' }, 'Street address is required.', 'عنوان الشارع'],
    [{ buildingVilla: '' }, 'Building / villa is required.', 'المبنى / الفيلا'],
    [{ flatVillaNo: '' }, 'Flat / villa number is required.', 'رقم الشقة / الفيلا'],
  ];
  for (const [patch, english, arabicField] of cases) {
    const b = body();
    const r = refusal(() => orders.placeOrder({ ...b, customer: { ...b.customer, ...patch } }, { ip: '10.9.0.1' }));
    assert.equal(r.status, 400);
    assert.equal(r.message, english, 'the English is as it always was');
    assert.equal(r.details.code, 'field_required');
    assert.equal(shown(r, 'en'), english);
    const ar = plain(shown(r, 'ar'));
    assert.ok(ar.includes(arabicField), `${english} → ${ar}`);
    assert.ok(!LATIN_WORD.test(ar), `no English left: ${ar}`);
  }
  const long = body();
  const tooLong = refusal(() => orders.placeOrder({ ...long, customer: { ...long.customer, landmark: 'x'.repeat(300) } }, { ip: '10.9.0.1' }));
  assert.equal(tooLong.message, 'Landmark is too long.');
  assert.equal(tooLong.details.code, 'field_too_long');
  assert.ok(plain(shown(tooLong, 'ar')).includes('علامة مميزة') && !LATIN_WORD.test(plain(shown(tooLong, 'ar'))));
  // A box the shop has no Arabic name for: a plain Arabic line, never the English name.
  const unknown = plain(server.serverSaid({ status: 400, data: { code: 'field_required', field: 'Line 3 product', message: 'Line 3 product is required.' } }, 'ar', 'x'));
  assert.ok(ARABIC.test(unknown) && !LATIN_WORD.test(unknown), unknown);
});

test('"too many" refusals carry a code and the wait; Arabic says so, English is the route’s own sentence', () => {
  let r: Refusal | null = null;
  for (let i = 0; i < 3; i++) {
    try {
      enforceLimit('gaps-test:orders:1.2.3.4', 2, 60 * 60 * 1000, 'Too many orders from this connection. Please try again later.');
    } catch (e) {
      r = e as Refusal;
    }
  }
  assert.ok(r, 'the third try is refused');
  assert.equal(r!.status, 429);
  assert.equal(r!.message, 'Too many orders from this connection. Please try again later.');
  assert.equal(r!.details.code, 'rate_limited');
  assert.ok(Number(r!.details.retryAfterSec) > 0);
  assert.equal(shown(r!, 'en'), r!.message);
  const ar = plain(shown(r!, 'ar'));
  assert.ok(ARABIC.test(ar) && !LATIN_WORD.test(ar), ar);
  assert.match(ar, /دقيقة/, 'a long wait is said in minutes');
  // A 429 with no code of its own is still said in Arabic; so is a dropped connection.
  assert.ok(ARABIC.test(server.serverSaid({ status: 429, data: { message: 'Too many requests.' } }, 'ar', 'x')));
  assert.equal(server.serverSaid({ status: 0, data: { code: 'offline', message: 'Could not reach the server. Check your connection and try again.' } }, 'en', 'x'), 'Could not reach the server. Check your connection and try again.');
  assert.ok(ARABIC.test(server.serverSaid({ status: 0, data: { code: 'offline', message: 'Could not reach the server.' } }, 'ar', 'x')));
});

test('the English built from each code is the server’s own sentence; an answer with no known code falls back to the screen’s Arabic line, never to English', () => {
  // The server's sentences, as written in its code today.
  const same: Array<[string, Record<string, unknown>, string]> = [
    ['card_start_failed', {}, 'Card payment could not be started. Nothing was charged. Please try again, or choose Cash on Delivery.'],
    ['card_closed', {}, 'This card payment can no longer be started. Please start checkout again.'],
    ['track_link_invalid', {}, 'This tracking link is not valid. Please check it, or use your order number and phone number.'],
    ['order_no_match', {}, 'No order matches that order number and phone number.'],
    ['otp_none', {}, 'No verification code is waiting for this number. Please request a new code.'],
    ['otp_expired', {}, 'The verification code has expired. Please request a new code.'],
    ['otp_attempts', {}, 'Too many incorrect attempts. Please request a new code.'],
    ['phone_not_mobile', {}, 'Please enter a UAE mobile number starting with 50, 52, 54, 55, 56 or 58.'],
    ['phone_codes_off', {}, 'We now confirm orders on WhatsApp: no code is needed. Please reload the page and place your order.'],
    ['chat_empty', {}, 'Type a message.'],
    ['chat_ended', {}, 'This chat has ended. Start a new one.'],
    ['chat_full', {}, 'This chat is full. Please start a new one, or message us on WhatsApp.'],
    ['chat_off', {}, 'Chat is not available right now. Please message us on WhatsApp or by email.'],
    ['pay_closed', {}, 'This order is already paid or closed: nothing more to upload.'],
    ['image_type', {}, 'Upload a PNG, JPEG or WebP image.'],
    ['receipt_too_large', {}, 'The receipt is too large (max 5 MB).'],
    ['photo_orders_off', {}, 'Orders from a photo are not taken right now. Please message us on WhatsApp.'],
    ['photo_missing', {}, 'Add at least one photo of the piece you want.'],
    ['deal_closed', {}, 'This link has expired or was already used. Please message us on WhatsApp for a new one.'],
  ];
  for (const [code, values, english] of same) {
    assert.equal(server.serverCodeText({ status: 400, data: { code, ...values } }, 'en'), english, code);
    const ar = plain(server.serverCodeText({ status: 400, data: { code, ...values } }, 'ar') ?? '');
    assert.ok(ARABIC.test(ar), `${code} has Arabic`);
    assert.ok(!/[A-Za-z]{4,}/.test(ar.replace(/PNG|JPEG|WebP|PDF/g, '')), `${code}: no English left: ${ar}`);
  }
  // Every word has both languages.
  for (const [key, w] of Object.entries(server.SERVER_WORDS)) assert.ok(w.en && ARABIC.test(w.ar), key);
  // Unknown code: English shows the server's words; Arabic the screen's own line.
  const odd = { status: 400, data: { code: 'something_new', message: 'A brand new refusal.' } };
  assert.equal(server.serverSaid(odd, 'en', 'Fallback.'), 'A brand new refusal.');
  assert.equal(server.serverSaid(odd, 'ar', 'تعذّر الإرسال.'), 'تعذّر الإرسال.');
  assert.equal(server.serverSaid({ status: 500, data: {} }, 'en', 'Fallback.'), 'Fallback.');
});

test('the real routes answer with those codes: chat, order lookup, the phone check, a card that cannot start', async () => {
  const chatRoute = await import('@/app/api/chat/route');
  const empty = await chatRoute.POST(jsonRequest({ message: '   ' }, { origin: 'http://shop.test' }));
  assert.equal(empty.status, 400);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.code, 'chat_empty');
  assert.equal(emptyBody.message, 'Type a message.');

  const lookup = await import('@/app/api/orders/lookup/route');
  const none = await lookup.POST(jsonRequest({ orderId: 'BUH-NOPE-1', phone: '0501234567' }, { origin: 'http://shop.test' }));
  assert.equal(none.status, 404);
  assert.deepEqual(await none.json(), { found: false, code: 'order_no_match', message: 'No order matches that order number and phone number.' });
  const badLink = await lookup.POST(jsonRequest({ token: 'not-a-token' }, { origin: 'http://shop.test' }));
  assert.equal((await badLink.json()).code, 'track_link_invalid');
  const noNumber = await lookup.POST(jsonRequest({ phone: '0501234567' }, { origin: 'http://shop.test' }));
  const noNumberBody = await noNumber.json();
  assert.equal(noNumberBody.code, 'field_required');
  assert.equal(noNumberBody.message, 'Order number is required.');
  assert.ok(plain(server.serverSaid({ status: 400, data: noNumberBody }, 'ar', 'x')).includes('رقم الطلب'));

  // The phone check: wrong number, wrong code, asking again too soon.
  assert.equal(refusal(() => otp.validatePhone('12')).details.code, 'phone_invalid');
  assert.equal(refusal(() => otp.validatePhone('+971 4 123 4567')).details.code, 'phone_not_mobile');
  const abroad = refusal(() => otp.validatePhone('+44 7700 900123'));
  assert.equal(abroad.details.code, 'phone_not_uae');
  assert.ok(String(abroad.message).includes(String(abroad.details.email)), 'the email in the sentence is the one sent as a value');
  assert.equal(server.serverCodeText({ status: 400, data: abroad.details }, 'en'), abroad.message);
  const noCode = otp.verifyRealSmsOtp('+971501234567', '123456');
  assert.equal(noCode.code, 'otp_none');
  const first = await otp.sendRealSmsOtp('+971501234568', { gateways: {}, ip: null });
  assert.equal(first.success, true, 'the test stand-in gives a code');
  const wrong = otp.verifyRealSmsOtp('+971501234568', first.devOtpCode === '000000' ? '111111' : '000000');
  assert.equal(wrong.code, 'otp_wrong');
  assert.equal(server.serverCodeText({ data: wrong }, 'en')!.replace('attempts', 'attempts'), wrong.message.replace(/attempt\b/, 'attempts'));
  assert.match(plain(server.serverCodeText({ data: wrong }, 'ar')!), new RegExp(`${wrong.left}`));
  const soon = (await otp.sendRealSmsOtp('+971501234568', { gateways: {}, ip: null }).then(
    () => null,
    (e) => e as Refusal
  )) as Refusal | null;
  assert.ok(soon, 'a second code within 30 seconds is refused');
  assert.equal(soon.details.code, 'otp_wait');
  assert.equal(server.serverCodeText({ status: 429, data: soon.details }, 'en'), soon.message);
  assert.match(plain(server.serverCodeText({ status: 429, data: soon.details }, 'ar')!), /ثانية/);

  // Firebase's own problems are said in the customer's language too.
  const fb = firebaseErrorMessage({ code: 'auth/too-many-requests' }, 'orders@example.com', 'ar');
  assert.ok(ARABIC.test(fb) && fb.includes('orders@example.com') && !LATIN_WORD.test(fb.replace('orders@example.com', '')), fb);
  assert.equal(firebaseErrorMessage({ code: 'auth/code-expired' }, 'orders@example.com'), 'That code has expired. Please tap “Resend code” for a new one.');
});

// ── 2. The chat in Arabic ────────────────────────────────────────────────────

test('an Arabic question is answered from the same entries: delivery, payment, returns, care, offers; the shop’s starting answers in Arabic, the owner’s own words as written', () => {
  const sizes = DEFAULT_CATALOG.sizes;
  const topic = (q: string) => reply(q, DEFAULT_ASSISTANT, sizes);
  const cases: Array<[string, string]> = [
    ['كم يستغرق التوصيل؟', 'delivery'],
    ['هل توصلون إلى أبوظبي', 'delivery'],
    ['كم مدة الشحن', 'delivery'],
    ['كيف أدفع؟', 'payment'],
    ['هل يوجد دفع عند الاستلام', 'payment'],
    ['هل أستطيع الدفع بالبطاقة؟', 'payment'],
    ['هل يمكن الاستبدال', 'returns'],
    ['ما هي سياسة الإرجاع', 'returns'],
    ['كيف أغسله؟', 'care'],
    ['طريقة الغسيل والعناية', 'care'],
    ['هل يوجد خصم؟', 'discounts'],
    ['عندكم كوبون أو عروض', 'discounts'],
  ];
  for (const [q, id] of cases) {
    const a = topic(q);
    assert.equal(a.kind, 'answer', q);
    assert.equal((a as { entryId: string }).entryId, id, q);
    const text = (a as { text: string }).text;
    assert.ok(ARABIC.test(text) && !LATIN_WORD.test(text), `the shop's starting answer is said in Arabic: ${q} → ${text}`);
  }
  // The owner changed an answer (English only): their words exactly, under one short Arabic line.
  const ownersAnswer = 'We deliver in 3 days with our own driver.';
  const owned = { ...DEFAULT_ASSISTANT, entries: DEFAULT_ASSISTANT.entries.map((e) => (e.id === 'delivery' ? { ...e, answer: ownersAnswer } : e)) };
  const a = reply('كم يستغرق التوصيل؟', owned, sizes) as { kind: string; text: string };
  assert.equal(a.kind, 'answer');
  const [firstLine, ...rest] = a.text.split('\n');
  assert.ok(ARABIC.test(firstLine), 'a short Arabic line first');
  assert.equal(rest.join('\n'), ownersAnswer, 'then the owner’s words, untouched');
  // The owner wrote an answer in Arabic (with an Arabic keyword): shown as it is, no extra line.
  const arabicOwn = { ...DEFAULT_ASSISTANT, entries: [...DEFAULT_ASSISTANT.entries, { id: 'gift', question: 'هل يوجد تغليف هدايا؟', keywords: ['تغليف', 'هدية'], answer: 'نعم، نغلّف الهدايا مجاناً.' }] };
  assert.deepEqual(reply('هل عندكم تغليف هدايا', arabicOwn, sizes), { kind: 'answer', text: 'نعم، نغلّف الهدايا مجاناً.', entryId: 'gift' });
  // English questions answer exactly as before.
  assert.deepEqual(reply('How long does delivery take?', DEFAULT_ASSISTANT, sizes), { kind: 'answer', text: DEFAULT_ASSISTANT.entries[0].answer, entryId: 'delivery' });
});

test('Arabic sizes come from the size presets; greetings and thanks are answered; a person, a made-to-measure request and a problem with an order still go to the team', () => {
  const sizes = DEFAULT_CATALOG.sizes;
  const all = reply('ما هي المقاسات المتوفرة؟', DEFAULT_ASSISTANT, sizes) as { kind: string; text: string; entryId: string };
  assert.equal(all.entryId, 'sizes');
  for (const s of sizes.filter((x) => /\d/.test(x.mattressSize))) assert.ok(all.text.includes(s.mattressSize), `the preset's own measurement: ${s.name}`);
  assert.ok(ARABIC.test(all.text));
  const king = sizes.find((s) => /king/i.test(s.name) && !/super/i.test(s.name));
  if (king) {
    const one = reply('كم مقاس الكينج؟', DEFAULT_ASSISTANT, sizes) as { text: string; entryId: string };
    assert.equal(one.entryId, 'sizes');
    assert.ok(one.text.includes(king.mattressSize) && one.text.includes('المرتبة'), one.text);
    const mixed = reply('مقاس king كم؟', DEFAULT_ASSISTANT, sizes) as { text: string };
    assert.ok(mixed.text.includes(king.mattressSize), 'a size named in English inside an Arabic question');
  }
  assert.equal(reply('ما هي المقاسات', { ...DEFAULT_ASSISTANT, answerSizes: false }, sizes).kind, 'handover', 'sizes switched off: a person');

  const hello = reply('السلام عليكم', DEFAULT_ASSISTANT, sizes) as { kind: string; text: string };
  assert.equal(hello.kind, 'smalltalk');
  assert.ok(ARABIC.test(hello.text) && !LATIN_WORD.test(hello.text), 'the greeting the shop starts with, in Arabic');
  assert.equal((reply('مرحبا', { ...DEFAULT_ASSISTANT, greeting: 'Welcome to Noor Linen!' }, sizes) as { text: string }).text, 'Welcome to Noor Linen!', 'the owner’s own greeting, as written');
  assert.equal(reply('شكراً', DEFAULT_ASSISTANT, sizes).kind, 'smalltalk');
  assert.equal(greetingFor(DEFAULT_ASSISTANT.greeting, 'en'), DEFAULT_ASSISTANT.greeting);
  assert.equal(greetingFor('My own hello', 'ar'), 'My own hello');

  assert.deepEqual(reply('أريد التحدث مع موظف', DEFAULT_ASSISTANT, sizes), { kind: 'handover', reason: 'asked' });
  for (const q of ['أين طلبي؟', 'لم يصل الطلب حتى الآن', 'أريد استرداد المبلغ', 'وصلني المنتج تالف', 'أريد إلغاء الطلب', 'كيف أتتبع الشحنة رقم الطلب 12345', 'هل يوجد تفصيل حسب الطلب', 'هل القماش قطن عضوي من جايبور؟']) {
    assert.deepEqual(reply(q, DEFAULT_ASSISTANT, sizes), { kind: 'handover', reason: 'unsure' }, `${q}: a person, not a stock answer or a guess`);
  }
});

test('the chat’s notices are in the customer’s language: the page’s (allow-listed), else the language the chat is in; English is word for word as before', async () => {
  await updateSettings('assistant', { ...getSettings('assistant'), waitSeconds: 60 });
  const T0 = Date.parse('2026-10-15T10:00:00Z');
  const system = (v: { messages: Array<{ author: string; body: string }> }) => v.messages.filter((m) => m.author === 'system').map((m) => m.body);

  // English, as it always was.
  const en = chat.startChat({ message: 'Is the fabric organic cotton from Jaipur?', locale: 'en' }, T0);
  assert.deepEqual(system(en), ['I’m not sure about that one, so I’ve passed your question to the team. We will reply here as soon as we can. So we can get back to you even if you leave, please add your phone number or email below.']);
  const enThanks = chat.customerContact(en.id, en.token, { name: 'Layla Hassan', contact: '0501234567' }, 0, T0 + 1000, 'en');
  assert.equal(system(enThanks).pop(), 'Thank you, Layla. If you leave before we reply, we’ll get back to you at +971501234567.');
  const enWait = chat.customerPoll(en.id, en.token, 0, T0 + 61_000, 'en');
  assert.equal(system(enWait).pop(), 'Thank you for waiting. Everyone is busy for a moment, but your message is with us and we’ll get back to you at +971501234567 as soon as we can. You can close this page.');

  // An Arabic page: the greeting the shop starts with, the hand-over, the thanks and the wait, all in Arabic.
  const ar = chat.startChat({ message: 'Is the fabric organic cotton from Jaipur?', locale: 'ar' }, T0);
  assert.ok(ARABIC.test(ar.messages[0].body) && ar.messages[0].author === 'bot', 'the starting greeting in Arabic');
  assert.equal(system(ar).length, 1);
  assert.ok(ARABIC.test(system(ar)[0]) && !LATIN_WORD.test(system(ar)[0]), system(ar)[0]);
  const person = chat.startChat({ message: 'hello', locale: 'ar' }, T0);
  const asked = chat.customerAskPerson(person.id, person.token, 0, T0 + 500, 'ar');
  assert.ok(ARABIC.test(system(asked)[0]) && !LATIN_WORD.test(system(asked)[0]));
  const arThanks = chat.customerContact(ar.id, ar.token, { name: 'ليلى حسن', contact: '0501234567' }, 0, T0 + 1000, 'ar');
  const thanks = system(arThanks).pop()!;
  assert.ok(ARABIC.test(thanks) && thanks.includes('ليلى') && thanks.includes('+971501234567') && !LATIN_WORD.test(thanks), thanks);
  // The server's own check (every 30 seconds) knows no page: it keeps the language the chat is in.
  assert.equal(chat.sweepChats(T0 + 61_000) >= 1, true);
  const waited = system(chat.customerPoll(ar.id, ar.token, 0, T0 + 62_000)).pop()!;
  assert.ok(ARABIC.test(waited) && waited.includes('+971501234567') && !LATIN_WORD.test(waited), waited);

  // A question typed in Arabic on an English page (or by an older page that sends no language): Arabic notice.
  const typed = chat.startChat({ message: 'هل القماش قطن عضوي من جايبور؟' }, T0);
  assert.ok(ARABIC.test(system(typed)[0]));
  // Anything but "en" or "ar" is ignored (never stored, never trusted).
  assert.equal(chat.chatLocale('ar'), 'ar');
  for (const bad of ['fr', 'AR', '<script>', 5, null, { a: 1 }]) assert.equal(chat.chatLocale(bad), undefined);
  const odd = chat.startChat({ message: 'Is the fabric organic cotton from Jaipur?', locale: '"><script>' }, T0);
  assert.match(system(odd)[0], /^I’m not sure about that one/);
  // An Arabic topic question gets its answer, not a hand-over.
  const answered = chat.startChat({ message: 'كم يستغرق التوصيل؟', locale: 'ar' }, T0);
  assert.equal(answered.status, 'bot');
  assert.equal(system(answered).length, 0);
});

// ── 3. The shop's name ───────────────────────────────────────────────────────

test('messages a customer sends the shop name it as Settings → Brand does, never a fixed name', () => {
  assert.equal(shop.helloShop('Noor Linen'), 'Hello Noor Linen');
  assert.equal(shop.helloShop(''), 'Hello');
  assert.equal(shop.helloShop(undefined), 'Hello');
  assert.equal(shop.whatsappGreeting(DEFAULT_STORE, 'Noor Linen'), 'Hello Noor Linen! I have a question about your bed linen.');
  assert.equal(shop.whatsappGreeting(DEFAULT_STORE, 'Beautiful UAE Home'), DEFAULT_STORE.whatsappGreeting, 'the same words for the shop’s first name');
  assert.equal(shop.whatsappGreeting({ ...DEFAULT_STORE, whatsappGreeting: 'Hi, a question please' }, 'Noor Linen'), 'Hi, a question please', 'the owner’s own greeting is kept');
  for (const f of fs.readdirSync('src/components/store')) {
    const source = fs.readFileSync(path.join('src/components/store', f), 'utf8');
    assert.ok(!/Hello Beautiful UAE Home/.test(source), `${f} greets the shop by a fixed name`);
  }
});

// ── 4. Photo widths ──────────────────────────────────────────────────────────

/** A picture as detailed as a photo (so a smaller copy is lighter, as with real photos): the same every run. */
const stripes = (w: number, h: number) => {
  let seed = w * 31 + h;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
  return makePng(w, h, (x, y) => [(x * 7 + next()) % 256, (y * 5 + next()) % 256, ((x + y) * 3 + next()) % 256]);
};
const store = (png: Buffer) => images.saveImageBytes(png, 'image/png').url.split('/').pop()!;
const get = (name: string, query = '') => imageRoute.GET(new Request(`http://shop.test/api/images/${name}${query}`), { params: Promise.resolve({ name }) });

test('a stored photo is served at 240, 540 and 1080 px: made once, never bigger than the original, with the original’s headers; other widths are the original', async () => {
  const original = stripes(1600, 900);
  const name = store(original);
  const full = await get(name);
  assert.equal(full.status, 200);
  assert.equal(Buffer.from(await full.arrayBuffer()).equals(original), true);
  for (const w of [240, 540, 1080]) {
    const res = await get(name, `?w=${w}`);
    assert.equal(res.status, 200);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(imageDimensions(bytes), { width: w, height: Math.round((900 * w) / 1600) }, `${w} px wide, same shape`);
    assert.ok(bytes.length < original.length, 'lighter than the original');
    for (const h of ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy']) assert.equal(res.headers.get(h), full.headers.get(h), h);
    assert.equal(res.headers.get('content-type'), 'image/png');
    // Kept in the cache folder, named by the original's hash and the width.
    const kept = path.join(dataDir, 'cache', 'images', `${name.slice(0, 64)}-w${w}.png`);
    assert.ok(fs.existsSync(kept), kept);
    assert.equal(fs.readFileSync(kept).equals(bytes), true);
  }
  // The second request reads the kept copy (the resizer is not asked again).
  let calls = 0;
  variants._setImageResizer(async () => {
    calls++;
    return Buffer.from('x');
  });
  try {
    const again = await get(name, '?w=540');
    assert.deepEqual(imageDimensions(Buffer.from(await again.arrayBuffer())), { width: 540, height: 304 });
    assert.equal(calls, 0);
  } finally {
    variants._setImageResizer(undefined);
  }
  // Widths that are not on the list: the original, and nothing new in the cache.
  const before = fs.readdirSync(path.join(dataDir, 'cache', 'images')).length;
  for (const q of ['?w=541', '?w=5000', '?w=0', '?w=-540', '?w=540px', '?w=1e3', '?w=', '?w=540&w=1080x', '?width=540']) {
    const res = await get(name, q);
    assert.equal(res.status, 200, q);
    if (q !== '?w=540&w=1080x') assert.equal(Buffer.from(await res.arrayBuffer()).equals(original), true, `${q}: the original`);
  }
  assert.equal(fs.readdirSync(path.join(dataDir, 'cache', 'images')).length, before);
  for (const v of ['240', '540', '1080']) assert.equal(variants.variantWidth(v), Number(v));
  for (const v of ['541', '', null, undefined, '54000', ' 540', '540 ', '0540x']) assert.equal(variants.variantWidth(v), null, String(v));
});

test('a small photo is never made bigger; unknown names and path tricks are not found; no resizer means the original, not an error', async () => {
  const small = stripes(400, 300);
  const name = store(small);
  for (const w of [540, 1080]) {
    const res = await get(name, `?w=${w}`);
    assert.equal(Buffer.from(await res.arrayBuffer()).equals(small), true, `asked for ${w}: the 400 px original as it is`);
    assert.ok(!fs.existsSync(path.join(dataDir, 'cache', 'images', `${name.slice(0, 64)}-w${w}.png`)), 'nothing kept for it');
  }
  const down = await get(name, '?w=240');
  assert.deepEqual(imageDimensions(Buffer.from(await down.arrayBuffer())), { width: 240, height: 180 });

  for (const bad of ['nope.png', `${'a'.repeat(64)}.png`, `..%2F..%2Fshop.db`, `${'a'.repeat(64)}.svg`, `${name}/../x`]) {
    assert.equal((await get(bad, '?w=540')).status, 404, bad);
    assert.equal(await variants.readImageVariant(bad, 540), null, bad);
  }
  assert.equal(await variants.readImageVariant(name, 541 as 540), null, 'a width off the list is refused below the route too');

  // The resizer is missing, or cannot read the photo: the original, and nothing kept.
  const other = store(stripes(1200, 800));
  for (const broken of [null, async () => Promise.reject(new Error('cannot read'))]) {
    variants._setImageResizer(broken);
    try {
      const res = await get(other, '?w=540');
      assert.equal(res.status, 200);
      assert.deepEqual(imageDimensions(Buffer.from(await res.arrayBuffer())), { width: 1200, height: 800 });
      assert.ok(!fs.existsSync(path.join(dataDir, 'cache', 'images', `${other.slice(0, 64)}-w540.png`)));
    } finally {
      variants._setImageResizer(undefined);
    }
  }
  // A copy that comes out no lighter than the original: the original is sent, and it is not tried again on each request.
  const heavy = store(stripes(900, 600));
  let tries = 0;
  variants._setImageResizer(async (bytes) => {
    tries++;
    return Buffer.concat([bytes, bytes]);
  });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await get(heavy, '?w=540');
      assert.deepEqual(imageDimensions(Buffer.from(await res.arrayBuffer())), { width: 900, height: 600 });
    }
    assert.equal(tries, 1);
    assert.equal(fs.statSync(path.join(dataDir, 'cache', 'images', `${heavy.slice(0, 64)}-w540.png`)).size, 0, 'an empty file marks it');
  } finally {
    variants._setImageResizer(undefined);
  }
  // …also after a restart (the mark is on disk).
  const afterRestart = await get(heavy, '?w=540');
  assert.deepEqual(imageDimensions(Buffer.from(await afterRestart.arrayBuffer())), { width: 900, height: 600 });

  // Two requests for the same copy at once: made once.
  let made = 0;
  const real = (await import('sharp')).default;
  variants._setImageResizer(async (bytes, width) => {
    made++;
    return real(bytes).resize({ width }).png().toBuffer();
  });
  try {
    const [a, b] = await Promise.all([get(other, '?w=540'), get(other, '?w=540')]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(made, 1);
  } finally {
    variants._setImageResizer(undefined);
  }
});

test('the copies live in DATA_DIR/cache (not in the photos folder), stay under their cap, are not in a backup, and are made again after the folder is deleted', async () => {
  const name = store(stripes(1500, 1000));
  await get(name, '?w=540');
  const dir = path.join(dataDir, 'cache', 'images');
  assert.equal(variants.variantsDir(), dir);
  assert.ok(fs.readdirSync(dir).length >= 1);
  for (const f of fs.readdirSync(path.join(dataDir, 'images'))) assert.match(f, /^[a-f0-9]{64}\.(png|jpg|webp)$/, 'the photos folder holds originals only');

  // The cap: the oldest copies go first.
  const tmp = fs.mkdtempSync(path.join(dataDir, 'cap-'));
  for (let i = 0; i < 10; i++) {
    const f = path.join(tmp, `f${i}.png`);
    fs.writeFileSync(f, Buffer.alloc(1000));
    fs.utimesSync(f, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
  }
  variants._trimImageCache(tmp, 5000);
  assert.deepEqual(fs.readdirSync(tmp).sort(), ['f6.png', 'f7.png', 'f8.png', 'f9.png'], 'trimmed to under four fifths of the cap, newest kept');
  fs.rmSync(tmp, { recursive: true });

  // Not in the backup; the originals are.
  const backup = await import('@/lib/server/backup');
  const result = await backup.createBackup();
  const names = backup.openBackup(fs.readFileSync(result.file)).map((e) => e.name);
  assert.ok(names.some((f) => f.includes(name)), 'the original photo is in the backup');
  assert.ok(!names.some((f) => /cache|-w\d+\./.test(f)), `no cached copy in the backup: ${names.filter((f) => /cache|-w\d+\./.test(f)).join(', ')}`);

  // Deleted: made again on the next request.
  fs.rmSync(path.join(dataDir, 'cache'), { recursive: true });
  const again = await get(name, '?w=540');
  assert.deepEqual(imageDimensions(Buffer.from(await again.arrayBuffer())), { width: 540, height: 360 });
  assert.ok(fs.existsSync(path.join(dir, `${name.slice(0, 64)}-w540.png`)));
});

test('photo cards offer the smaller widths: a srcset for the shop’s own photos, the original as the largest; small pictures ask for the smallest only', () => {
  const url = `/api/images/${'ab'.repeat(32)}.jpg`;
  const card = photos.photoSources(url);
  assert.equal(card.src, url, 'the plain address stays the original');
  assert.equal(card.srcSet, `${url}?w=240 240w, ${url}?w=540 540w, ${url}?w=1080 1080w, ${url} 1600w`);
  assert.deepEqual(photos.OWN_WIDTHS, [...variants.IMAGE_WIDTHS], 'the page asks only for widths the server makes');
  const thumb = photos.photoSources(url, [96, 160]);
  assert.deepEqual(thumb, { src: `${url}?w=240`, srcSet: `${url}?w=240 240w` });
  const zoom = photos.photoSources(url, [720, 1080, 1440, 2048]);
  assert.ok(zoom.srcSet!.endsWith(`${url} 1600w`), 'the zoom view can still reach the original');
  // Other addresses are untouched: an outside photo, one that already asks for a width, the logo's data.
  assert.deepEqual(photos.photoSources('https://example.com/a.jpg'), { src: 'https://example.com/a.jpg' });
  assert.deepEqual(photos.photoSources(`${url}?w=540`), { src: `${url}?w=540` });
  assert.deepEqual(photos.photoSources(''), { src: '' });
  assert.match(photos.photoSources('https://images.unsplash.com/photo-1?x=1').srcSet!, /w=540/);
  // The pages that show product photos give sizes with the srcset.
  for (const f of ['src/components/store/ProductCard.tsx', 'src/components/store/PhotoCarousel.tsx', 'src/components/store/PhotoZoom.tsx', 'src/components/seo/LandingPage.tsx']) {
    const source = fs.readFileSync(f, 'utf8');
    assert.match(source, /srcSet=\{/, f);
    assert.match(source, /sizes=\{/, f);
  }
});

// ── 6. Addresses for search engines ──────────────────────────────────────────

test('the words every page starts with make no fixed claim the settings could make untrue', () => {
  const home = fs.readFileSync('src/app/page.tsx', 'utf8');
  assert.ok(!/fitted for deep|all the UAE|Dubai, Abu Dhabi, Sharjah/.test(home), 'no mattress fit or list of emirates before the settings load');
  assert.ok(!/gifts: bedsheets/.test(home), 'the festival link names the festival only');
  const landing = fs.readFileSync('src/components/seo/LandingPage.tsx', 'utf8');
  assert.ok(!/on their way/.test(landing), 'an empty category promises nothing');
  assert.ok(translate({ a: { en: 'x', ar: 'y' } }, 'a', 'ar') === 'y');
});
