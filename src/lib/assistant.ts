import type { AssistantEntry, AssistantSettings, BedProfileMeasurement } from '@/types';
import { DEFAULT_ASSISTANT } from '@/data/catalogDefaults';

/**
 * The shop assistant's brain: it answers only from what the owner wrote in
 * Settings → Chat assistant (and, if allowed, the size presets), never makes
 * anything up, and hands over to a person whenever it isn't sure. Pure, so it
 * runs the same in tests and on the server.
 */

export type Reply =
  | { kind: 'answer'; text: string; entryId: string }
  | { kind: 'smalltalk'; text: string }
  | { kind: 'handover'; reason: 'asked' | 'unsure' };

const STOP = new Set(
  'a an and are as at be but by can could do does for from have how i if in is it its me my of on or our please so that the their them there this to us was we what when where which who why will with would you your yours hi hello hey'.split(' ')
);

const SIZE_WORDS = new Set(['size', 'measurement', 'measure', 'dimension', 'cm', 'inch', 'fit', 'mattress', 'length', 'width', 'big', 'pocket', 'depth', 'deep']);
const PERSON = /\b(human|person|someone|somebody|agent|staff|owner|manager|real|call me|talk to|speak to|whatsapp me|contact me)\b/;
const GREETING = /^(hi|hello|hey|salam|salaam|assalam[ou] ?alaikum|marhaba|good (morning|afternoon|evening))\b[\s!.]*$/;
/** Things only a person can promise: made-to-measure, bulk, wholesale. */
const BESPOKE = /\b(custom|customi[sz]ed?|bespoke|made to (measure|order)|tailor(ed)?|round bed|special size|bulk|wholesale|hotel order)\b/;
/** A problem with an order: a person, never a stock answer. */
const COMPLAINT = /\b(charged|overcharged|double charged|refund|late|delayed|not (arrived|received|delivered)|(didn|hasn|haven|hasnt|didnt|havent)t? (arrive|come|received?)|missing|damaged|broken|torn|stain(ed)?|wrong (item|size|colou?r|product)|complain|complaint|cancel|my order|order (no|number|#)?\s*\d{3,}|tracking|where is my)\b/;
const THANKS = /^(thanks?|thank you|thx|shukran|ok(ay)?( thanks?)?|great|perfect|got it)\b[\s!.]*$/;

export function normalise(text: string): string {
  return foldArabic(text.toLowerCase()).replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s.x×-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// ── Arabic ──────────────────────────────────────────────────────────────────
//
// A question typed in Arabic is understood by topic (delivery, payment, returns, care, offers,
// sizes) and answered from the same entries and size presets as an English one: the owner's own
// answer when it is written in Arabic; the Arabic of an answer the shop started with, while the
// owner has not changed it; otherwise the owner's answer as written, under one short Arabic line
// (their words are never translated by guesswork). Anything else goes to a person, as in English.

const ARABIC = /[\u0600-\u06FF]/;
export const isArabicText = (text: string) => ARABIC.test(text);

/** Arabic as people type it, made comparable: no vowel marks or stretching, one form of alef, ya and ta marbuta. */
function foldArabic(text: string): string {
  if (!ARABIC.test(text)) return text;
  return text
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Whether the folded text has one of these words. Arabic joins "the", "and", "for" to a word, so a word counts inside a longer one; ' x ' means the whole word only. */
const hasAny = (n: string, list: readonly string[]) => {
  const padded = ` ${n} `;
  return list.some((w) => padded.includes(w));
};

const AR_PERSON = ['موظف', 'شخص', 'انسان', 'بشري', 'خدمه العملاء', 'اكلم', 'اتكلم مع', 'اتحدث مع', 'التحدث مع', 'كلموني', 'اتصلوا', 'اتصل بي', 'المدير', 'صاحب المتجر', 'صاحب المحل'];
const AR_BESPOKE = ['تفصيل', 'مخصص', 'حسب الطلب', 'مقاس خاص', 'بالجمله', 'جمله', 'كميه كبيره', 'فندق', 'فنادق', 'سرير دائري'];
/** A problem with an order (and where it is): a person, as in English. */
const AR_COMPLAINT = ['استرداد', 'استرجاع المبلغ', 'استرجاع فلوس', 'رجعوا فلوس', 'ارجاع المبلغ', 'خصم من', 'انخصم', 'سحبتوا', 'متاخر', 'تاخر', 'لم يصل', 'لم تصل', 'ما وصل', 'ما وصلت', 'ما استلمت', 'لم استلم', 'ناقص', 'تالف', 'مكسور', 'ممزق', 'بقعه', 'مقاس غلط', 'لون غلط', 'منتج غلط', 'خطا في', 'شكوي', 'الغاء', 'الغي', 'طلبي', 'طلبيتي', 'رقم الطلب', 'تتبع', 'وين الطلب', 'اين الطلب'];
const AR_GREETING = /^(مرحبا|اهلا|اهلين|هلا|هاي|سلام|السلام عليكم|السلام عليكم ورحمه الله وبركاته|صباح الخير|مساء الخير)( بكم| وسهلا)?$/;
const AR_THANKS = /^(شكرا|شكرا لك|شكرا جزيلا|مشكور|مشكورين|يعطيك العافيه|تسلم|تسلمين|تمام|ممتاز|اوكي|طيب)( شكرا)?$/;

/** The topics, each with the words an Arabic question uses and the English words its entry is found by. */
const AR_TOPICS: ReadonlyArray<{ words: readonly string[]; seed: string }> = [
  { words: ['توصيل', 'توصل', 'يوصل', 'شحن', 'مندوب', 'كم يوم'], seed: 'delivery deliver shipping courier how long' },
  { words: ['دفع', 'كاش', 'نقدا', 'نقدي', 'بطاقه', 'فيزا', 'تحويل', 'بنك', 'عند الاستلام'], seed: 'pay payment cash card bank transfer' },
  { words: ['ارجاع', 'استرجاع', 'ارجع', 'استبدال', 'تبديل', 'ابدل', 'استبدل'], seed: 'return exchange swap' },
  { words: ['غسل', 'غسيل', 'اغسل', 'تنظيف', 'كوي', ' كي ', 'مكواه', 'عنايه', 'ينكمش', 'يبهت'], seed: 'wash care clean iron' },
  { words: ['خصم', 'خصومات', 'عروض', 'تخفيض', 'كوبون', 'كود', 'ارخص'], seed: 'discount offer sale coupon code' },
];
const AR_SIZE_WORDS = ['مقاس', 'قياس', 'ابعاد', 'حجم', ' سم ', 'مرتبه', 'عمق', 'عميق'];
/** Size names as written in Arabic → the word the owner's presets use. */
const AR_SIZE_NAMES: ReadonlyArray<[readonly string[], string]> = [
  [['سوبر'], 'super'],
  [['كينج', 'كنج', 'كينغ'], 'king'],
  [['كوين'], 'queen'],
  [['سينجل', 'مفرد'], 'single'],
  [['دبل', 'مزدوج'], 'double'],
  [['توين'], 'twin'],
];

const AR = {
  hello: 'مرحباً! كيف أستطيع مساعدتك؟',
  welcome: 'عفواً! هل أستطيع مساعدتك في شيء آخر؟',
  ownersWords: 'هذا جواب المتجر (بالإنجليزية):',
} as const;

/** The Arabic of the words the shop starts with (used only while the owner has not changed them). */
const DEFAULT_AR: { greeting: string; answers: Record<string, string> } = {
  greeting: 'مرحباً! أستطيع مساعدتك في المقاسات والتوصيل والدفع والعناية. اسألني أي شيء، أو اضغط «تحدث مع موظف».',
  answers: {
    delivery: 'نوصّل إلى باب منزلك. تظهر في صفحة إتمام الطلب مدة التوصيل وأي رسوم لعنوانك قبل أن تطلب، ويصلك رقم التتبع فور استلام شركة الشحن للطلب.',
    payment: 'يمكنك الدفع نقداً عند الاستلام. وتظهر في صفحة إتمام الطلب طرق الدفع الأخرى المتاحة، مثل البطاقة أو التحويل البنكي.',
    discounts: 'أسعارنا هي أقل ما نستطيع تقديمه. نعلن عن عروض المواسم في شريط المتجر وعلى إنستغرام. للطلبات بالجملة، اضغط «تحدث مع موظف».',
    care: 'كإرشاد عام للقطن المطبوع: يُغسل بماء بارد وبلطف بمنظف خفيف، بعيداً عن الألوان الأخرى في الغسلات الأولى، ويُجفف في الظل. إذا كان على القطعة ملصق عناية فاتبعه. لست متأكداً من قطعة؟ اضغط «تحدث مع موظف».',
    returns: 'إذا وصلتك قطعة تالفة أو غير صحيحة، راسلنا خلال 48 ساعة مع صورة وسنعالج الأمر. اضغط «تحدث مع موظف» وسنتابع معك.',
  },
};

/** The assistant's greeting in the customer's language: the owner's own as written; the one the shop starts with, in Arabic for an Arabic visitor. */
export function greetingFor(greeting: string, locale: 'en' | 'ar'): string {
  return locale === 'ar' && greeting === DEFAULT_ASSISTANT.greeting ? DEFAULT_AR.greeting : greeting;
}

/** An entry's answer for an Arabic question (see above). */
function arabicAnswer(entry: AssistantEntry): string {
  if (isArabicText(entry.answer)) return entry.answer;
  const start = DEFAULT_ASSISTANT.entries.find((e) => e.id === entry.id);
  const ours = DEFAULT_AR.answers[entry.id];
  if (start && ours && start.answer === entry.answer) return ours;
  return `${AR.ownersWords}\n${entry.answer}`;
}

function arabicSizeAnswer(n: string, all: BedProfileMeasurement[]): string | null {
  const named = AR_SIZE_NAMES.filter(([ws]) => hasAny(n, ws)).map(([, en]) => en);
  // The same choice of sizes as an English question, then said in Arabic (the measurements are the owner's).
  const sizes = all.filter((s) => /\d/.test(s.mattressSize));
  // Names typed in English inside an Arabic question ("مقاس king") count too.
  const picked = pickSizes(`${named.join(' ')} ${n}`, sizes);
  if ((!hasAny(n, AR_SIZE_WORDS) && !picked.length) || !sizes.length) return null;
  if (picked.length && picked.length <= 2) {
    const detail = (s: BedProfileMeasurement) =>
      [
        `${s.name}:`,
        `• المرتبة ${s.mattressSize}`,
        s.fittedSheet && `• الشرشف بمطاط ${s.fittedSheet}`,
        s.flatSheet && `• الشرشف المسطح ${s.flatSheet}`,
        s.pillowcases && `• أكياس الوسائد ${s.pillowcases}`,
        s.duvetCover && `• غطاء اللحاف ${s.duvetCover}`,
      ]
        .filter(Boolean)
        .join('\n');
    return `${picked.map(detail).join('\n\n')}\n\nكل منتج يوضح المقاسات المتوفرة له.`;
  }
  return `مقاساتنا (حسب المرتبة):\n${sizes.map((s) => `• ${s.name}: ${s.mattressSize}`).join('\n')}\n\nاسألني عن مقاس معيّن (مثلاً «مقاس كينج») لمعرفة قياسات الشرشف وأكياس الوسائد. تحتاج مقاساً غير موجود؟ اضغط «تحدث مع موظف».`;
}

function arabicReply(text: string, n: string, settings: Pick<AssistantSettings, 'entries' | 'answerSizes' | 'greeting'>, sizes: BedProfileMeasurement[]): Reply {
  if (hasAny(n, AR_PERSON)) return { kind: 'handover', reason: 'asked' };
  if (hasAny(n, AR_BESPOKE) || hasAny(n, AR_COMPLAINT)) return { kind: 'handover', reason: 'unsure' };
  if (AR_GREETING.test(n)) return { kind: 'smalltalk', text: settings.greeting ? greetingFor(settings.greeting, 'ar') : AR.hello };
  if (AR_THANKS.test(n)) return { kind: 'smalltalk', text: AR.welcome };
  // The owner's own entries first (they may have Arabic keywords), then the topic the question is about.
  const seed = AR_TOPICS.filter((t) => hasAny(n, t.words)).map((t) => t.seed).join(' ');
  let best: AssistantEntry | null = null;
  let bestScore = 0;
  for (const e of settings.entries) {
    const s = Math.max(score(e, text), seed ? score(e, seed) : 0);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  if (best && bestScore >= 2) return { kind: 'answer', text: arabicAnswer(best), entryId: best.id };
  const sizeText = settings.answerSizes ? arabicSizeAnswer(n, sizes) : null;
  if (sizeText) return { kind: 'answer', text: sizeText, entryId: 'sizes' };
  return { kind: 'handover', reason: 'unsure' };
}

/** Words, lightly stemmed (sizes → size, washing → wash), stop words dropped. */
export function words(text: string): string[] {
  return normalise(text)
    .split(/[\s.-]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

/** How well an entry fits: keywords count double; a keyword phrase must appear whole. */
export function score(entry: AssistantEntry, text: string): number {
  const n = ` ${normalise(text)} `;
  const ws = new Set(words(text));
  let s = 0;
  for (const k of entry.keywords) {
    const kn = normalise(k);
    if (!kn) continue;
    if (kn.includes(' ') ? n.includes(` ${kn} `) : ws.has(stem(kn))) s += 2;
  }
  for (const w of new Set(words(entry.question))) if (ws.has(w)) s += 1;
  return s;
}

/** The size(s) named: most matching words, then the fewest extra ones ("king" is King, not Super King). */
function pickSizes(text: string, sizes: BedProfileMeasurement[]): BedProfileMeasurement[] {
  const ws = new Set(words(text));
  const ranked = sizes
    .map((s) => {
      const own = [...new Set(words(`${s.name} ${s.id}`))].filter((w) => !SIZE_WORDS.has(w) && w.length > 2 && !['bed', 'most', 'popular'].includes(w));
      return { s, hits: own.filter((w) => ws.has(w)).length, extra: own.filter((w) => !ws.has(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.extra - b.extra);
  return ranked.filter((x) => x.hits === ranked[0]?.hits && x.extra === ranked[0]?.extra).map((x) => x.s);
}

function sizeAnswer(text: string, all: BedProfileMeasurement[]): string | null {
  const ws = new Set(words(text));
  const asksSize = [...ws].some((w) => SIZE_WORDS.has(w));
  // Only presets with real measurements (a "custom" preset is a person's job).
  const sizes = all.filter((s) => /\d/.test(s.mattressSize));
  const named = pickSizes(text, sizes);
  if ((!asksSize && !named.length) || !sizes.length) return null;
  if (named.length && named.length <= 2) {
    const detail = (s: BedProfileMeasurement) =>
      [
        `${s.name}:`,
        `• mattress ${s.mattressSize}`,
        s.fittedSheet && `• fitted sheet ${s.fittedSheet}`,
        s.flatSheet && `• flat sheet ${s.flatSheet}`,
        s.pillowcases && `• pillowcases ${s.pillowcases}`,
        s.duvetCover && `• duvet cover ${s.duvetCover}`,
      ]
        .filter(Boolean)
        .join('\n');
    return `${named.map(detail).join('\n\n')}\n\nEach product shows which sizes it comes in.`;
  }
  return `Our sizes (by mattress):\n${sizes.map((s) => `• ${s.name}: ${s.mattressSize}`).join('\n')}\n\nAsk me about one (e.g. "king size") for the sheet and pillowcase measurements. Need a size that isn't listed? Tap "Talk to a person".`;
}

export function reply(text: string, settings: Pick<AssistantSettings, 'entries' | 'answerSizes' | 'greeting'>, sizes: BedProfileMeasurement[]): Reply {
  const n = normalise(text);
  if (!n) return { kind: 'handover', reason: 'unsure' };
  if (isArabicText(n)) return arabicReply(text, n, settings, sizes);
  if (PERSON.test(n)) return { kind: 'handover', reason: 'asked' };
  if (BESPOKE.test(n) || COMPLAINT.test(n)) return { kind: 'handover', reason: 'unsure' };
  if (GREETING.test(n)) return { kind: 'smalltalk', text: settings.greeting || 'Hello! How can I help?' };
  if (THANKS.test(n)) return { kind: 'smalltalk', text: 'You’re welcome! Anything else I can help with?' };

  let best: AssistantEntry | null = null;
  let bestScore = 0;
  for (const e of settings.entries) {
    const s = score(e, text);
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
  }
  // Measurements come from the size presets (always up to date) unless an entry fits better.
  const sizes_ = settings.answerSizes ? sizeAnswer(text, sizes) : null;
  // An answer the owner wrote (returns, care…) beats the size table; sizes answer the rest.
  if (best && bestScore >= 2) return { kind: 'answer', text: best.answer, entryId: best.id };
  if (sizes_) return { kind: 'answer', text: sizes_, entryId: 'sizes' };
  return { kind: 'handover', reason: 'unsure' };
}
