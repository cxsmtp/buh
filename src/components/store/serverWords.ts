import { translate, type Locale, type Words } from '@/lib/i18n';

/**
 * What the server answered, in the customer's language. The server's messages are written in
 * English; each also carries a code (and the values inside it), and the shop says the Arabic from
 * that. English is the server's own sentence, word for word. In Arabic an answer with no code we
 * know is said with the screen's own plain "that did not work" line, never left in English.
 * (Order refusals with products and prices in them: refusalText in checkoutWords.ts.)
 */

export const SERVER_WORDS = {
  offline: { en: 'Could not reach the server. Check your connection and try again.', ar: 'تعذّر الاتصال بالخادم. تحقق من اتصالك وحاول مرة أخرى.' },
  rate_limited: { en: 'Too many tries. Please wait a little, then try again.', ar: 'محاولات كثيرة. يرجى الانتظار قليلاً ثم المحاولة مرة أخرى.' },
  rate_limited_wait: { en: 'Too many tries. Please try again in {minutes} min.', ar: 'محاولات كثيرة. يرجى المحاولة بعد {minutes} دقيقة.' },
  bad_request: { en: 'That could not be sent. Please reload the page and try again.', ar: 'تعذّر الإرسال. يرجى تحديث الصفحة والمحاولة مرة أخرى.' },
  // A field the form sent empty, too long or not as text: the field by name when we know it.
  field_required: { en: '{field} is required.', ar: '{field}: هذه الخانة مطلوبة.' },
  field_too_long: { en: '{field} is too long.', ar: '{field}: النص طويل جداً.' },
  field_text: { en: '{field} must be text.', ar: '{field}: يرجى كتابة نص.' },
  field_required_any: { en: 'Please fill in every required box.', ar: 'يرجى تعبئة كل الخانات المطلوبة.' },
  field_too_long_any: { en: 'One of the boxes has too much text. Please shorten it.', ar: 'إحدى الخانات نصها طويل جداً. يرجى اختصاره.' },
  // Photos and screenshots
  image_type: { en: 'Upload a PNG, JPEG or WebP image.', ar: 'يرجى رفع صورة بصيغة PNG أو JPEG أو WebP.' },
  image_too_large: { en: 'The image is too large.', ar: 'حجم الصورة كبير جداً.' },
  image_invalid: { en: 'The file is not a valid PNG, JPEG or WebP image.', ar: 'الملف ليس صورة صالحة بصيغة PNG أو JPEG أو WebP.' },
  receipt_too_large: { en: 'The receipt is too large (max 5 MB).', ar: 'حجم الإيصال كبير جداً (الحد الأقصى 5 ميغابايت).' },
  receipt_invalid: { en: 'The receipt is not a valid PDF.', ar: 'الإيصال ليس ملف PDF صالحاً.' },
  no_room: { en: 'We can’t take the photos right now, sorry. Please send them on WhatsApp instead.', ar: 'عذراً، لا يمكننا استلام الصور الآن. يرجى إرسالها عبر واتساب.' },
  pay_closed: { en: 'This order is already paid or closed: nothing more to upload.', ar: 'هذا الطلب مدفوع أو مغلق: لا حاجة لرفع أي شيء آخر.' },
  // An order from a photo
  photo_orders_off: { en: 'Orders from a photo are not taken right now. Please message us on WhatsApp.', ar: 'لا نستقبل الطلبات من صورة حالياً. يرجى مراسلتنا عبر واتساب.' },
  photo_missing: { en: 'Add at least one photo of the piece you want.', ar: 'أضف صورة واحدة على الأقل للقطعة التي تريدها.' },
  photo_too_many: { en: 'At most {max} photos.', ar: 'بحد أقصى {max} صور.' },
  photo_pieces: { en: 'Pieces: a whole number from 1 to {max}.', ar: 'عدد القطع: رقم صحيح من 1 إلى {max}.' },
  amount_invalid: { en: 'Type the amount in AED, e.g. 350.', ar: 'اكتب المبلغ بالدرهم، مثلاً 350.' },
  amount_range: { en: 'The amount: from AED {min} to AED {max}.', ar: 'المبلغ: من AED {min} إلى AED {max}.' },
  deal_closed: { en: 'This link has expired or was already used. Please message us on WhatsApp for a new one.', ar: 'انتهت صلاحية هذا الرابط أو سبق استخدامه. يرجى مراسلتنا عبر واتساب للحصول على رابط جديد.' },
  // Card payments that could not start
  card_start_failed: { en: 'Card payment could not be started. Nothing was charged. Please try again, or choose Cash on Delivery.', ar: 'تعذّر بدء الدفع بالبطاقة. لم يُخصم أي مبلغ. حاول مرة أخرى أو اختر الدفع عند الاستلام.' },
  card_closed: { en: 'This card payment can no longer be started. Please start checkout again.', ar: 'لم يعد بالإمكان بدء هذا الدفع بالبطاقة. يرجى بدء إتمام الطلب من جديد.' },
  // Track Order
  track_link_invalid: { en: 'This tracking link is not valid. Please check it, or use your order number and phone number.', ar: 'رابط التتبع هذا غير صالح. يرجى التحقق منه، أو استخدم رقم الطلب ورقم الهاتف.' },
  order_no_match: { en: 'No order matches that order number and phone number.', ar: 'لا يوجد طلب يطابق رقم الطلب ورقم الهاتف.' },
  // The phone check
  phone_invalid: { en: 'Please provide a valid phone number (e.g. +971 50 123 4567)', ar: 'يرجى إدخال رقم هاتف صحيح (مثلاً ‎+971 50 123 4567)' },
  phone_not_uae: { en: 'Online checkout verifies UAE mobile numbers only. For international orders, please email {email}.', ar: 'الطلب عبر الموقع يتحقق من أرقام الجوال الإماراتية فقط. للطلبات الدولية، يرجى مراسلتنا على {email}.' },
  phone_not_mobile: { en: 'Please enter a UAE mobile number starting with 50, 52, 54, 55, 56 or 58.', ar: 'يرجى إدخال رقم جوال إماراتي يبدأ بـ 50 أو 52 أو 54 أو 55 أو 56 أو 58.' },
  phone_codes_off: { en: 'We now confirm orders on WhatsApp: no code is needed. Please reload the page and place your order.', ar: 'نؤكد الطلبات الآن عبر واتساب: لا حاجة إلى رمز. يرجى تحديث الصفحة وإتمام طلبك.' },
  otp_wait: { en: 'Please wait {seconds} seconds before requesting another SMS.', ar: 'يرجى الانتظار {seconds} ثانية قبل طلب رسالة نصية أخرى.' },
  otp_too_many: { en: 'Too many codes requested. Please try again later.', ar: 'طُلبت رموز كثيرة. يرجى المحاولة لاحقاً.' },
  otp_too_many_number: { en: 'Too many codes requested for this number. Please try again later.', ar: 'طُلبت رموز كثيرة لهذا الرقم. يرجى المحاولة لاحقاً.' },
  otp_busy: { en: 'Phone verification is busy right now. Please try again shortly.', ar: 'خدمة تأكيد الهاتف مشغولة الآن. يرجى المحاولة بعد قليل.' },
  otp_unavailable: { en: 'Phone verification is not available right now. Please try again shortly, or email {email} to order.', ar: 'خدمة تأكيد الهاتف غير متاحة الآن. يرجى المحاولة بعد قليل، أو راسلنا على {email} للطلب.' },
  otp_send_failed: { en: 'We could not send the SMS just now. Please try again in a minute, or email {email} to order.', ar: 'تعذّر إرسال الرسالة النصية الآن. يرجى المحاولة بعد دقيقة، أو راسلنا على {email} للطلب.' },
  otp_none: { en: 'No verification code is waiting for this number. Please request a new code.', ar: 'لا يوجد رمز تحقق بانتظار هذا الرقم. يرجى طلب رمز جديد.' },
  otp_expired: { en: 'The verification code has expired. Please request a new code.', ar: 'انتهت صلاحية رمز التحقق. يرجى طلب رمز جديد.' },
  otp_attempts: { en: 'Too many incorrect attempts. Please request a new code.', ar: 'محاولات خاطئة كثيرة. يرجى طلب رمز جديد.' },
  otp_wrong: { en: 'Incorrect verification code ({left} attempts remaining).', ar: 'رمز التحقق غير صحيح (المحاولات المتبقية: {left}).' },
  otp_unconfirmed: { en: 'We could not confirm your number. Please request a new code.', ar: 'تعذّر تأكيد رقمك. يرجى طلب رمز جديد.' },
  // The chat
  chat_empty: { en: 'Type a message.', ar: 'اكتب رسالة.' },
  chat_contact: { en: 'Please check the phone number or email.', ar: 'يرجى التحقق من رقم الهاتف أو البريد الإلكتروني.' },
  chat_ended: { en: 'This chat has ended. Start a new one.', ar: 'انتهت هذه الدردشة. ابدأ دردشة جديدة.' },
  chat_full: { en: 'This chat is full. Please start a new one, or message us on WhatsApp.', ar: 'هذه الدردشة ممتلئة. يرجى بدء دردشة جديدة، أو راسلنا عبر واتساب.' },
  chat_off: { en: 'Chat is not available right now. Please message us on WhatsApp or by email.', ar: 'الدردشة غير متاحة الآن. يرجى مراسلتنا عبر واتساب أو البريد الإلكتروني.' },
} as const satisfies Words;

/** The checkout form's boxes, as the server names them, in Arabic. */
const FIELD_AR: Record<string, string> = {
  'Full name': 'الاسم الكامل',
  Phone: 'رقم الهاتف',
  'Phone number': 'رقم الهاتف',
  Emirate: 'الإمارة',
  Area: 'المنطقة',
  'Street address': 'عنوان الشارع',
  'Building / villa': 'المبنى / الفيلا',
  'Flat / villa number': 'رقم الشقة / الفيلا',
  Landmark: 'علامة مميزة',
  Email: 'البريد الإلكتروني',
  'Payment method': 'طريقة الدفع',
  'Transfer reference': 'مرجع التحويل',
  'What it is': 'وصف القطعة',
  'Order number': 'رقم الطلب',
  'Verification code': 'رمز التحقق',
};

export interface ServerAnswer {
  status?: number;
  data: object;
}

const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** The Arabic for an answer's code and values, or null when it has none we know. */
export function serverCodeText(answer: ServerAnswer, locale: Locale): string | null {
  const { status } = answer;
  const data = answer.data as Record<string, unknown>;
  const say = (key: keyof typeof SERVER_WORDS, vars?: Record<string, string | number>) => translate(SERVER_WORDS, key, locale, vars);
  if (status === 0) return say('offline');
  const code = typeof data.code === 'string' ? data.code : '';
  switch (code) {
    case 'rate_limited': {
      const wait = Number(data.retryAfterSec);
      return wait > 90 ? say('rate_limited_wait', { minutes: Math.ceil(wait / 60) }) : say('rate_limited');
    }
    case 'field_required':
    case 'field_too_long':
    case 'field_text': {
      const field = FIELD_AR[text(data.field)];
      if (locale === 'ar' && !field) return say(code === 'field_too_long' ? 'field_too_long_any' : 'field_required_any');
      return say(code, { field: locale === 'ar' ? field : text(data.field) });
    }
    case 'photo_too_many':
    case 'photo_pieces':
      return say(code, { max: text(data.max) });
    case 'amount_range':
      return say('amount_range', { min: text(data.min), max: text(data.max) });
    case 'phone_not_uae':
    case 'otp_unavailable':
    case 'otp_send_failed':
      return say(code, { email: text(data.email) });
    case 'otp_wait':
      return say('otp_wait', { seconds: text(data.retryAfterSec) });
    case 'otp_wrong':
      return say('otp_wrong', { left: text(data.left) });
    default:
      if (code && code in SERVER_WORDS) return say(code as keyof typeof SERVER_WORDS);
      // Refused for "too many" with no code of its own.
      return status === 429 ? say('rate_limited') : null;
  }
}

/**
 * What to show for an answer that was not a success. English: the server's own words (else the
 * screen's fallback). Arabic: from the code; with none we know, the screen's fallback (in Arabic).
 */
export function serverSaid(answer: ServerAnswer, locale: Locale, fallback: string): string {
  if (locale !== 'ar') return text((answer.data as { message?: unknown }).message) || fallback;
  return serverCodeText(answer, locale) || fallback;
}
