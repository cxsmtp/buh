import type { CartItem, DeliverySettings, Emirate } from '@/types';
import type { DeliveryCheck } from '@/lib/delivery';
import { DEFAULT_DELIVERY } from '@/data/catalogDefaults';
import { translate, type Locale, type Words } from '@/lib/i18n';

/**
 * Words the bag and checkout share, in English and UAE Arabic, kept outside the components so
 * they can be tested: what the delivery box says (src/lib/delivery.ts gives a code and values),
 * why the server refused an order (src/lib/server/orders.ts gives a code and values), the ways to
 * pay and where we deliver (from the shop's settings, never a fixed claim), and the small-bag limit.
 * The English here is word for word what the server and delivery.ts say (test/storefront-review.test.mts).
 */

/** The emirates' names in Arabic (shown only; the value sent stays the English name). */
export const EMIRATE_AR: Record<Emirate, string> = {
  Dubai: 'دبي',
  'Abu Dhabi': 'أبوظبي',
  Sharjah: 'الشارقة',
  Ajman: 'عجمان',
  'Umm Al Quwain': 'أم القيوين',
  'Ras Al Khaimah': 'رأس الخيمة',
  Fujairah: 'الفجيرة',
};
export const emirateLabel = (em: string, locale: Locale) => (locale === 'ar' ? EMIRATE_AR[em as Emirate] ?? em : em);

/** "A, B or C" / «أ أو ب أو ج». */
function orList(names: string[], locale: Locale): string {
  if (locale === 'ar') return names.join(' أو ');
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? '';
}
const commaList = (names: string[], locale: Locale) => names.join(locale === 'ar' ? '، ' : ', ');
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── Delivery ────────────────────────────────────────────────────────────────

export const DELIVERY_WORDS = {
  standard: { en: 'Standard delivery', ar: 'التوصيل العادي' },
  sameDay: { en: 'Same day', ar: 'في نفس اليوم' },
  delivers: { en: 'We deliver to {where}', ar: 'نوصّل إلى {where}' },
  chooseEmirate: { en: 'Choose your emirate.', ar: 'اختر إمارتك.' },
  notServed: { en: 'Sorry, we don’t deliver to {where} yet. Message us and we’ll see what we can do.', ar: 'عذراً، لا نوصّل إلى {where} حالياً. راسلنا وسنرى ما يمكننا فعله.' },
  sdEmirates: { en: 'Same-day delivery is for {emirates}.', ar: 'التوصيل في نفس اليوم متاح في {emirates}.' },
  sdSunday: { en: 'Same-day delivery is not offered on Sundays; Monday is the earliest.', ar: 'لا يتوفر التوصيل في نفس اليوم أيام الأحد؛ أقرب موعد هو يوم الاثنين.' },
  sdCutoff: { en: 'Same-day delivery is for orders before {cutoff}; tomorrow is the earliest now.', ar: 'التوصيل في نفس اليوم للطلبات قبل {cutoff}؛ أقرب موعد الآن هو الغد.' },
  sdDeal: { en: 'This order’s price includes standard delivery; same-day delivery is not offered for it.', ar: 'سعر هذا الطلب يشمل التوصيل العادي؛ التوصيل في نفس اليوم غير متاح له.' },
  sdOff: { en: 'Same-day delivery is not available for this order. Choose standard delivery.', ar: 'التوصيل في نفس اليوم غير متاح لهذا الطلب. اختر التوصيل العادي.' },
  allSeven: { en: 'all seven emirates', ar: 'الإمارات السبع' },
} as const satisfies Words;

/**
 * What a delivery option is called: the owner's own name for it (Settings → Delivery) as typed; the
 * name the shop starts with ("Standard delivery", "Same day"), or none, in the customer's language.
 */
export function deliveryName(kind: 'standard' | 'sameDay', settings: Pick<DeliverySettings, 'standardName' | 'sameDayName'>, locale: Locale): string {
  const own = (kind === 'standard' ? settings.standardName : settings.sameDayName)?.trim();
  const start = kind === 'standard' ? DEFAULT_DELIVERY.standardName : DEFAULT_DELIVERY.sameDayName;
  return own && own !== start ? own : translate(DELIVERY_WORDS, kind, locale);
}

const whereText = (where: { area?: string; emirate?: string }, locale: Locale) => commaList([where.area?.trim() ?? '', where.emirate ? emirateLabel(where.emirate, locale) : ''].filter(Boolean), locale);

/** The delivery box's first line: "We deliver to Al Barsha, Dubai", or why not. */
export function deliveryMessage(check: Pick<DeliveryCheck, 'code' | 'where'>, locale: Locale): string {
  if (check.code === 'choose_emirate') return translate(DELIVERY_WORDS, 'chooseEmirate', locale);
  return translate(DELIVERY_WORDS, check.code === 'delivers' ? 'delivers' : 'notServed', locale, { where: whereText(check.where, locale) });
}

/** Why same day is not offered for this address right now ('' when it is, or when it is switched off). */
export function sameDayReason(reason: string | undefined, v: { emirates?: readonly string[]; cutoff?: string }, locale: Locale): string {
  if (reason === 'emirates') return translate(DELIVERY_WORDS, 'sdEmirates', locale, { emirates: commaList((v.emirates ?? []).map((e) => emirateLabel(e, locale)), locale) });
  if (reason === 'sunday') return translate(DELIVERY_WORDS, 'sdSunday', locale);
  if (reason === 'cutoff') return translate(DELIVERY_WORDS, 'sdCutoff', locale, { cutoff: v.cutoff ?? '' });
  if (reason === 'deal') return translate(DELIVERY_WORDS, 'sdDeal', locale);
  if (reason === 'off') return translate(DELIVERY_WORDS, 'sdOff', locale);
  return '';
}

/** Where the shop delivers, from Settings → Delivery: "all seven emirates", or the emirates by name. */
export function servedPlaces(emirates: readonly string[], locale: Locale): string {
  if (new Set(emirates).size >= 7) return translate(DELIVERY_WORDS, 'allSeven', locale);
  const names = emirates.map((e) => emirateLabel(e, locale));
  return locale === 'ar' ? names.join(' و') : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}

// ── Ways to pay ─────────────────────────────────────────────────────────────

const PAY_WORDS = {
  card: { en: 'card', ar: 'البطاقة' },
  cod: { en: 'cash on delivery', ar: 'الدفع عند الاستلام' },
  bank: { en: 'bank transfer', ar: 'التحويل البنكي' },
} as const satisfies Words;

/** The ways to pay this shop offers now: "Cash on delivery or bank transfer" (only what is switched on). */
export function payWays(ways: { card?: boolean; bank?: boolean; cod?: boolean }, locale: Locale, capitalised = true): string {
  const list = orList(
    [ways.card ? translate(PAY_WORDS, 'card', locale) : '', ways.cod === false ? '' : translate(PAY_WORDS, 'cod', locale), ways.bank ? translate(PAY_WORDS, 'bank', locale) : ''].filter(Boolean),
    locale
  );
  return capitalised ? capital(list) : list;
}

// ── The small bag (an order whose phone no code proved) ─────────────────────

export interface BagLimit {
  /** all: every order (Phone check "WhatsApp"); card: card orders only. */
  applies: 'all' | 'card';
  perItem: number;
  lines: number;
}

/** Is this bag over the limit, and how (as the server counts: lines, and pieces per product and size)? */
export function bagOverLimit(items: Array<Pick<CartItem, 'quantity'> & { product: { id: string }; selectedProfile: { id: string } }>, limit: Pick<BagLimit, 'perItem' | 'lines'> | null | undefined): 'lines' | 'each' | null {
  if (!limit) return null;
  if (items.length > limit.lines) return 'lines';
  const perItem = new Map<string, number>();
  for (const i of items) perItem.set(`${i.product.id}|${i.selectedProfile.id}`, (perItem.get(`${i.product.id}|${i.selectedProfile.id}`) ?? 0) + i.quantity);
  return [...perItem.values()].some((q) => q > limit.perItem) ? 'each' : null;
}

export const BAG_LIMIT_WORDS = {
  note: { en: 'Up to {each} of each item and {lines} different items per order.', ar: 'حتى {each} من كل منتج و{lines} منتجات مختلفة في الطلب الواحد.' },
  noteCard: { en: 'Paying by card: up to {each} of each item and {lines} different items per order.', ar: 'عند الدفع بالبطاقة: حتى {each} من كل منتج و{lines} منتجات مختلفة في الطلب الواحد.' },
  overEach: { en: 'At most {max} of each item per order until we have confirmed your number. For more, please message us on WhatsApp.', ar: 'بحد أقصى {max} من كل منتج في الطلب إلى أن نؤكد رقمك. للمزيد، يرجى مراسلتنا على واتساب.' },
  overLines: { en: 'At most {max} different items per order until we have confirmed your number. For more, please message us on WhatsApp.', ar: 'بحد أقصى {max} منتجات مختلفة في الطلب إلى أن نؤكد رقمك. للمزيد، يرجى مراسلتنا على واتساب.' },
  cardEach: { en: 'Paying by card, at most {max} of each item per order. For more, place a second order, or choose Cash on Delivery.', ar: 'عند الدفع بالبطاقة، بحد أقصى {max} من كل منتج في الطلب. للمزيد، قدّم طلباً ثانياً أو اختر الدفع عند الاستلام.' },
  cardLines: { en: 'Paying by card, at most {max} different items per order. For more, place a second order, or choose Cash on Delivery.', ar: 'عند الدفع بالبطاقة، بحد أقصى {max} منتجات مختلفة في الطلب. للمزيد، قدّم طلباً ثانياً أو اختر الدفع عند الاستلام.' },
} as const satisfies Words;

/** The refusal the server would give for this bag, said before the form is filled. */
export function bagLimitMessage(over: 'lines' | 'each', limit: Pick<BagLimit, 'perItem' | 'lines'>, card: boolean, locale: Locale): string {
  const key = card ? (over === 'each' ? 'cardEach' : 'cardLines') : over === 'each' ? 'overEach' : 'overLines';
  return translate(BAG_LIMIT_WORDS, key, locale, { max: over === 'each' ? limit.perItem : limit.lines });
}

// ── Why the server refused an order ─────────────────────────────────────────

export const REFUSAL_WORDS = {
  phone_check_expired: { en: 'Please verify your UAE mobile number again (the code check has expired).', ar: 'يرجى تأكيد رقم جوالك الإماراتي مرة أخرى (انتهت صلاحية التحقق بالرمز).' },
  checkout_reference_used: { en: 'This checkout reference was already used.', ar: 'تم استخدام مرجع هذا الطلب من قبل.' },
  checkout_changed: { en: 'Your order changed since the first try. Please confirm again.', ar: 'تغيّر طلبك منذ المحاولة الأولى. يرجى التأكيد مرة أخرى.' },
  bad_emirate: { en: 'Please choose one of the seven Emirates.', ar: 'يرجى اختيار إحدى الإمارات السبع.' },
  bad_email: { en: 'Please check the email address.', ar: 'يرجى التحقق من البريد الإلكتروني.' },
  bad_payment: { en: 'Choose Cash on Delivery, Bank Transfer or Card.', ar: 'اختر الدفع عند الاستلام أو التحويل البنكي أو البطاقة.' },
  bank_unavailable: { en: 'Bank transfer is not available right now. Please choose Cash on Delivery.', ar: 'التحويل البنكي غير متاح حالياً. يرجى اختيار الدفع عند الاستلام.' },
  bag_empty: { en: 'Your bag is empty.', ar: 'حقيبتك فارغة.' },
  bag_lines_limit: { en: 'At most {max} lines per order.', ar: 'بحد أقصى {max} منتجات في الطلب الواحد.' },
  bad_quantity: { en: 'Line {line}: quantity must be 1 to {max}.', ar: 'المنتج رقم {line}: يجب أن تكون الكمية من 1 إلى {max}.' },
  product_qty_limit: { en: 'At most {max} of one product per order.', ar: 'بحد أقصى {max} من المنتج الواحد في الطلب.' },
  no_room: { en: 'We can’t take the photos right now, sorry. Please send them on WhatsApp instead.', ar: 'عذراً، لا يمكننا استلام الصور الآن. يرجى إرسالها عبر واتساب.' },
  open_orders_limit: { en: "You already have {count} orders waiting for confirmation. We'll call you shortly, or contact us to add to them.", ar: 'لديك {count} طلبات بانتظار التأكيد. سنتصل بك قريباً، أو تواصل معنا للإضافة إليها.' },
  unconfirmed_phone: { en: 'You already have {max} orders waiting for your WhatsApp confirmation. Please confirm them first (tap “Confirm on WhatsApp”), or contact us.', ar: 'لديك {max} طلبات بانتظار تأكيدك عبر واتساب. يرجى تأكيدها أولاً (اضغط «التأكيد عبر واتساب»)، أو تواصل معنا.' },
  unconfirmed_connection: { en: 'Several orders from this connection are waiting for their WhatsApp confirmation. Please confirm them first, or contact us.', ar: 'هناك عدة طلبات من هذا الاتصال بانتظار التأكيد عبر واتساب. يرجى تأكيدها أولاً، أو تواصل معنا.' },
  shop_busy: { en: 'We’re receiving a lot of orders right now, sorry. Please try again in a little while, or message us on WhatsApp.', ar: 'عذراً، نستقبل طلبات كثيرة الآن. يرجى المحاولة بعد قليل، أو راسلنا على واتساب.' },
  popular_piece: { en: 'This piece is very popular right now — please message us on WhatsApp and we’ll reserve it for you.', ar: 'هذه القطعة مطلوبة جداً الآن — يرجى مراسلتنا على واتساب وسنحجزها لك.' },
  card_unpaid_limit: { en: 'Too many card payments are waiting to be finished. Please finish or close the other checkout, or choose Cash on Delivery.', ar: 'هناك عمليات دفع بالبطاقة كثيرة لم تكتمل. يرجى إكمال أو إغلاق عملية الدفع الأخرى، أو اختيار الدفع عند الاستلام.' },
  card_busy: { en: 'Card checkout is very busy right now, sorry. Please try again in a few minutes, or choose Cash on Delivery.', ar: 'عذراً، الدفع بالبطاقة مزدحم جداً الآن. يرجى المحاولة بعد دقائق، أو اختيار الدفع عند الاستلام.' },
  item_unavailable: { en: 'An item in your bag is no longer available. Please remove it and try again.', ar: 'أحد المنتجات في حقيبتك لم يعد متوفراً. يرجى إزالته والمحاولة مرة أخرى.' },
  size_option: { en: '{title}: that option is no longer offered.', ar: '{title}: هذا الخيار لم يعد متوفراً.' },
  size_bed: { en: '{title}: that bed size is no longer offered.', ar: '{title}: مقاس السرير هذا لم يعد متوفراً.' },
  colour_unavailable: { en: '{title}: that colour is no longer offered.', ar: '{title}: هذا اللون لم يعد متوفراً.' },
  only_left: { en: '{title} ({size}): only {left} left.', ar: '{title} ({size}): بقي {left} فقط.' },
  sold_out: { en: '{title} ({size}) has just sold out.', ar: '{title} ({size}) نفد للتو.' },
  price_changed: { en: 'Prices have changed since you opened checkout: your total is now AED {total}. Please check your bag and confirm again.', ar: 'تغيّرت الأسعار منذ فتحت صفحة الدفع: إجمالي طلبك الآن AED {total}. يرجى مراجعة حقيبتك والتأكيد مرة أخرى.' },
  deal_payment: { en: 'This way of paying is not offered for this order. Please choose another.', ar: 'طريقة الدفع هذه غير متاحة لهذا الطلب. يرجى اختيار طريقة أخرى.' },
  card_unavailable: { en: 'Card payment is not available right now. Please choose Cash on Delivery.', ar: 'الدفع بالبطاقة غير متاح حالياً. يرجى اختيار الدفع عند الاستلام.' },
  card_unavailable_photo: { en: 'Card payment is not available for orders from a photo. Please choose Cash on Delivery or Bank Transfer.', ar: 'الدفع بالبطاقة غير متاح للطلبات من صورة. يرجى اختيار الدفع عند الاستلام أو التحويل البنكي.' },
} as const satisfies Words;

type Refusal = { code?: unknown } & Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/**
 * The server's refusal of an order in the customer's language, from its code and values
 * (null: a refusal with no code we know; show the server's own message).
 * titleOf: the product's name in that language, when the bag knows it.
 */
export function refusalText(data: Refusal, locale: Locale, titleOf?: (productId: string) => string | undefined): string | null {
  const code = typeof data.code === 'string' ? data.code : '';
  const say = (key: keyof typeof REFUSAL_WORDS, vars?: Record<string, string | number>) => translate(REFUSAL_WORDS, key, locale, vars);
  const title = (titleOf && typeof data.productId === 'string' ? titleOf(data.productId) : undefined) ?? str(data.title);
  switch (code) {
    case 'not_delivered':
      return deliveryMessage({ code: 'not_served', where: { area: str(data.area), emirate: (str(data.emirate) || undefined) as Emirate | undefined } }, locale);
    case 'same_day_unavailable':
      return sameDayReason(str(data.reason), { emirates: Array.isArray(data.emirates) ? data.emirates.map(str) : [], cutoff: str(data.cutoff) }, locale) || null;
    case 'card_bag_limit':
    case 'unconfirmed_bag_limit':
      if (data.limit !== 'lines' && data.limit !== 'each') return null;
      return bagLimitMessage(data.limit, { perItem: Number(data.max), lines: Number(data.max) }, code === 'card_bag_limit', locale);
    case 'unconfirmed_limit':
      return data.scope === 'phone' ? say('unconfirmed_phone', { max: str(data.max) }) : data.scope === 'connection' ? say('unconfirmed_connection') : null;
    case 'size_unavailable':
      return say(data.kind === 'option' ? 'size_option' : 'size_bed', { title });
    case 'colour_unavailable':
      return say('colour_unavailable', { title });
    case 'only_left':
      return say('only_left', { title, size: str(data.size), left: str(data.left) });
    case 'sold_out':
      return say('sold_out', { title, size: str(data.size) });
    case 'card_unavailable':
      return say(data.photo ? 'card_unavailable_photo' : 'card_unavailable');
    case 'bag_lines_limit':
    case 'product_qty_limit':
      return say(code, { max: str(data.max) });
    case 'bad_quantity':
      return say('bad_quantity', { line: str(data.line), max: str(data.max) });
    case 'open_orders_limit':
      return say('open_orders_limit', { count: str(data.count) });
    case 'price_changed':
      return say('price_changed', { total: str(data.total) });
    default:
      return code in REFUSAL_WORDS ? say(code as keyof typeof REFUSAL_WORDS) : null;
  }
}
