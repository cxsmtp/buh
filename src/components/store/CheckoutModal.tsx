'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { CartItem, Emirate, Order, PaymentMethod, PhoneVerificationConfig } from '@/types';
import { UAE_EMIRATES } from '@/data/initialData';
import { resolveArea, searchAreas, type UAEArea } from '@/data/uaeAreas';
import { cardFeeFils, cartFils, formatAed, percentText, toFils, vatOnTopFils } from '@/lib/money';
import { useShop } from '@/lib/client/shop';
import { postJson } from '@/lib/apiClient';
import { formatAccuracy, suggestAreaFromGps, UAE_KEY_LOCATIONS } from '@/lib/uaeLocations';
import { deliveryCheck } from '@/lib/delivery';
import { emirateFrom, walletAddress } from '@/lib/walletAddress';
import type { CardPay, CardResult, StartedCardOrder, WalletPayment } from './StripeCheckout';
import { AreaCombobox } from './AreaCombobox';
import { WhatsAppConfirm } from './WhatsAppConfirm';
import { cancelHoursOf, waMeLink } from '@/lib/whatsappConfirm';
import { askBankDetailsMessage } from '@/lib/bankMessages';
import { 
  X, 
  CheckCircle2, 
  Check, 
  Upload, 
  MessageCircle, 
  ArrowRight, 
  ShieldCheck, 
  Banknote, 
  Building2, 
  MapPin, 
  Navigation, 
  Crosshair, 
  Sparkles, 
  AlertCircle,
  Truck,
  CreditCard,
  Loader2
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { PALETTE } from '@/lib/design/tokens';
import { classifyPhone, PhoneVerification } from './PhoneVerification';
import type { PhotoOrderDraft } from './PhotoOrderSheet';
import { useT, useLocale, type Words } from '@/lib/i18n';
import { productTitle } from '@/lib/i18n/product';

// Stripe's fields: their own chunk, fetched only when checkout offers cards (never on the shop's first load).
const CardFields = dynamic(() => import('./StripeCheckout').then((m) => m.CardFields), {
  ssr: false,
  loading: () => <CardLoading />,
});
const ExpressCheckout = dynamic(() => import('./StripeCheckout').then((m) => m.ExpressCheckout), { ssr: false });

const WORDS = {
  cardLoading: { en: 'Loading the secure card form…', ar: 'جارٍ تحميل نموذج البطاقة الآمن…' },
  noGeo: { en: 'Geolocation is not supported by your browser.', ar: 'متصفحك لا يدعم تحديد الموقع.' },
  locOutside: { en: 'Your device’s location doesn’t look like the UAE (this happens with network or VPN locations). Please choose your emirate and area below.', ar: 'لا يبدو أن موقع جهازك داخل الإمارات (يحدث هذا مع مواقع الشبكة أو VPN). يرجى اختيار الإمارة والمنطقة أدناه.' },
  locKept: { en: ' Your address above is kept.', ar: ' احتفظنا بعنوانك أعلاه.' },
  locApprox: { en: 'Your device gave an approximate location ({accuracy}), so we saved it for the driver but didn’t guess your area.{rest}', ar: 'أعطى جهازك موقعاً تقريبياً ({accuracy})، فحفظناه للسائق دون تخمين منطقتك.{rest}' },
  locChooseIt: { en: ' Please choose it below.', ar: ' يرجى اختيارها أدناه.' },
  locUnknown: { en: 'Location saved for the driver.{rest}', ar: 'تم حفظ الموقع للسائق.{rest}' },
  locChooseArea: { en: ' Please choose your area below.', ar: ' يرجى اختيار منطقتك أدناه.' },
  locNear: { en: 'Location saved for the driver, in or near {place}, {emirate}. Please check the area below.', ar: 'تم حفظ الموقع للسائق، في {place}، {emirate} أو بالقرب منها. يرجى التأكد من المنطقة أدناه.' },
  locNearKept: { en: 'Location saved for the driver (near {place}, {emirate}).{kept}', ar: 'تم حفظ الموقع للسائق (بالقرب من {place}، {emirate}).{kept}' },
  locFailed: { en: 'We couldn’t get your location. No problem: choose your emirate and area below, and add a landmark for the driver.', ar: 'تعذّر تحديد موقعك. لا مشكلة: اختر الإمارة والمنطقة أدناه، وأضف معلماً قريباً للسائق.' },
  pinDropped: { en: 'Pin dropped on: {place}, {emirate} ({lat}°N, {lng}°E)', ar: 'تم تحديد الموقع على: {place}، {emirate} ({lat}°N، {lng}°E)' },
  emirateChanged: { en: 'Emirate changed to {emirate} for {area}.', ar: 'تم تغيير الإمارة إلى {emirate} لمنطقة {area}.' },
  notPlaced: { en: 'We could not place your order. Nothing was charged. Please try again.', ar: 'تعذّر إتمام طلبك ولم يُخصم أي مبلغ. يرجى المحاولة مرة أخرى.' },
  attemptClosed: { en: 'That payment attempt was closed and nothing was charged. Please tap Pay again.', ar: 'أُغلقت محاولة الدفع هذه ولم يُخصم أي مبلغ. يرجى الضغط على «ادفع» مرة أخرى.' },
  payFailed: { en: 'The payment did not go through.', ar: 'لم تتم عملية الدفع.' },
  notCharged: { en: '{reason} Nothing was charged.', ar: '{reason} لم يُخصم أي مبلغ.' },
  stoppedRetry: { en: '{reason} It was stopped, so you can try again.', ar: '{reason} تم إيقافها، ويمكنك المحاولة مرة أخرى.' },
  notConfirmed: { en: 'We couldn’t confirm the payment. Please check your connection; if your card was charged, your order is safe.', ar: 'تعذّر تأكيد الدفع. يرجى التحقق من اتصالك؛ وإن خُصم المبلغ من بطاقتك فطلبك محفوظ.' },
  stillNoReach: { en: 'We still couldn’t reach the shop. Please check your connection, then tap Check again.', ar: 'ما زال الوصول إلى المتجر متعذراً. يرجى التحقق من اتصالك ثم الضغط على «تحقق مرة أخرى».' },
  notTaken: { en: 'That payment was not taken: nothing was charged. Please try again.', ar: 'لم تتم عملية الدفع ولم يُخصم أي مبلغ. يرجى المحاولة مرة أخرى.' },
  notYet: { en: 'Stripe has not confirmed a payment for this order yet. You can tap Pay again: it continues the same order, so you are never charged twice.', ar: 'لم تؤكد Stripe الدفع لهذا الطلب بعد. يمكنك الضغط على «ادفع» مرة أخرى: سيكمل الطلب نفسه، فلن يُخصم منك مرتين أبداً.' },
  walletArea: { en: 'Your wallet gave us your address, but not an area we know. Please choose your area below, then tap the button again.', ar: 'أعطتنا محفظتك عنوانك، لكن دون منطقة نعرفها. يرجى اختيار منطقتك أدناه ثم الضغط على الزر مرة أخرى.' },
  walletAreaShort: { en: 'Please choose your area in checkout, then try again.', ar: 'يرجى اختيار منطقتك في صفحة الدفع ثم المحاولة مرة أخرى.' },
  walletPhone: { en: 'Couriers need a UAE mobile number: your wallet gave another one. Please type a UAE mobile below, then tap the button again.', ar: 'يحتاج المندوب إلى رقم جوال إماراتي، ومحفظتك أعطت رقماً آخر. يرجى كتابة رقم جوال إماراتي أدناه ثم الضغط على الزر مرة أخرى.' },
  walletPhoneShort: { en: 'Please add a UAE mobile number in checkout, then try again.', ar: 'يرجى إضافة رقم جوال إماراتي في صفحة الدفع ثم المحاولة مرة أخرى.' },
  noDeliver: { en: 'Sorry, we don’t deliver to that address yet.', ar: 'عذراً، لا نوصّل إلى هذا العنوان حالياً.' },
  walletVerify: { en: 'Please verify your UAE mobile number below (we send a code), then tap the button again.', ar: 'يرجى تأكيد رقم جوالك الإماراتي أدناه (نرسل لك رمزاً) ثم الضغط على الزر مرة أخرى.' },
  walletVerifyShort: { en: 'Please verify your mobile number in checkout, then try again.', ar: 'يرجى تأكيد رقم جوالك في صفحة الدفع ثم المحاولة مرة أخرى.' },
  fillAll: { en: 'Please fill in all mandatory delivery address fields.', ar: 'يرجى تعبئة جميع حقول عنوان التوصيل الإلزامية.' },
  cardOff: { en: 'Card payment is not available right now. Please choose another way to pay.', ar: 'الدفع بالبطاقة غير متاح حالياً. يرجى اختيار طريقة دفع أخرى.' },
  needMobileCourier: { en: 'Please enter your UAE mobile number for the courier.', ar: 'يرجى إدخال رقم جوالك الإماراتي للمندوب.' },
  verifyBeforePay: { en: 'Please verify your UAE mobile number with the SMS code before paying.', ar: 'يرجى تأكيد رقم جوالك الإماراتي برمز الرسالة النصية قبل الدفع.' },
  enterMobile: { en: 'Please enter your UAE mobile number (e.g. 50 123 4567).', ar: 'يرجى إدخال رقم جوالك الإماراتي (مثال: 50 123 4567).' },
  verifyBeforeOrder: { en: 'Please verify your UAE mobile number with the SMS code before placing your order.', ar: 'يرجى تأكيد رقم جوالك الإماراتي برمز الرسالة النصية قبل إتمام الطلب.' },
  stepPicturesAgreed: { en: 'Pictures and price agreed', ar: 'تم الاتفاق على الصور والسعر' },
  stepPhotosAdded: { en: 'Photos and agreed total added', ar: 'تمت إضافة الصور والمبلغ المتفق عليه' },
  stepPiece: { en: '{n} piece chosen', ar: 'تم اختيار {n} قطعة' },
  stepPieces: { en: '{n} pieces chosen', ar: 'تم اختيار {n} قطع' },
  stepAddress: { en: 'Delivery address added', ar: 'تمت إضافة عنوان التوصيل' },
  stepPayment: { en: 'Payment: {how}', ar: 'الدفع: {how}' },
  howCod: { en: 'cash on delivery', ar: 'الدفع عند الاستلام' },
  howCardPaid: { en: 'card, paid', ar: 'بطاقة، مدفوع' },
  howCard: { en: 'card', ar: 'بطاقة' },
  howBank: { en: 'bank transfer', ar: 'تحويل بنكي' },
  lastWaiting: { en: 'Last step · waiting for your Send', ar: 'الخطوة الأخيرة · بانتظار ضغطك على إرسال' },
  lastOneTap: { en: 'Last step · one tap', ar: 'الخطوة الأخيرة · ضغطة واحدة' },
  almostName: { en: 'Almost there, {name}', ar: 'اقتربنا يا {name}' },
  almost: { en: 'Almost there', ar: 'اقتربنا' },
  didSend: { en: 'Did you press {send} in WhatsApp? Your order {id} is confirmed once we get your message.', ar: 'هل ضغطت على {send} في واتساب؟ يتأكد طلبك {id} فور وصول رسالتك.' },
  sendWord: { en: 'Send', ar: 'إرسال' },
  oneTapLeft: { en: 'One tap left to confirm your order {id}.', ar: 'بقيت ضغطة واحدة لتأكيد طلبك {id}.' },
  done: { en: 'Done', ar: 'تم' },
  lastConfirm: { en: 'Last step: confirm on WhatsApp', ar: 'الخطوة الأخيرة: التأكيد عبر واتساب' },
  tapConfirmBank: { en: 'Tap to confirm & ask for bank details →', ar: 'اضغط للتأكيد وطلب بيانات الحساب البنكي ←' },
  tapConfirm: { en: 'Tap to confirm →', ar: 'اضغط للتأكيد ←' },
  tapConfirmBankAria: { en: 'Tap to confirm & ask for bank details on WhatsApp', ar: 'اضغط للتأكيد وطلب بيانات الحساب البنكي عبر واتساب' },
  tapConfirmAria: { en: 'Tap to confirm on WhatsApp', ar: 'اضغط للتأكيد عبر واتساب' },
  ctaOpenCancel: { en: 'Your order is confirmed once we get it. Please send it within {open} hours: orders not confirmed within {cancel} hours are cancelled.', ar: 'يتأكد طلبك فور وصول رسالتك. يرجى إرسالها خلال {open} ساعة: تُلغى الطلبات غير المؤكدة خلال {cancel} ساعة.' },
  ctaCancel: { en: 'Your order is confirmed once we get it. Orders not confirmed within {cancel} hours are cancelled.', ar: 'يتأكد طلبك فور وصول رسالتك. تُلغى الطلبات غير المؤكدة خلال {cancel} ساعة.' },
  ctaConfirmed: { en: 'Your order is confirmed once we get it.', ar: 'يتأكد طلبك فور وصول رسالتك.' },
  ctaWhy: { en: 'It shows us this number is yours, so your parcel reaches you.', ar: 'هكذا نتأكد أن الرقم لك، ليصلك طردك.' },
  lblNotTaken: { en: 'Payment not taken', ar: 'لم يتم الدفع' },
  lblReceived: { en: 'Order received', ar: 'تم استلام الطلب' },
  lblConfirmed: { en: 'Order confirmed', ar: 'تم تأكيد الطلب' },
  thanks: { en: 'Thank you for your order', ar: 'شكراً لطلبك' },
  prepared: { en: 'Your linens are being prepared with care in Dubai. We will send a tracking link as soon as they ship.', ar: 'نجهّز مفارشك بعناية في دبي، وسنرسل لك رابط التتبع فور شحنها.' },
  confirmBankWa: { en: 'Confirm & ask for bank details on WhatsApp', ar: 'التأكيد وطلب بيانات الحساب البنكي عبر واتساب' },
  photoAgreed: { en: 'We’ll prepare it as agreed.', ar: 'سنجهّزه كما اتفقنا.' },
  photoCheckCard: { en: 'We’ll check your photos and confirm on WhatsApp.', ar: 'سنراجع صورك ونؤكد عبر واتساب.' },
  photoCheckAmount: { en: 'We’ll check your photos and the amount (AED {amount}) and confirm on WhatsApp.', ar: 'سنراجع صورك والمبلغ (AED {amount}) ونؤكد عبر واتساب.' },
  photoShips: { en: ' Once it ships, Track Order with {id} and your phone number shows the courier’s tracking number.', ar: ' بعد الشحن، تتبّع طلبك بالرقم {id} ورقم هاتفك لترى رقم تتبع شركة الشحن.' },
  weCall: { en: 'We’ll call you on {phone} to confirm your order.', ar: 'سنتصل بك على {phone} لتأكيد طلبك.' },
  payingBank: { en: 'Paying by bank transfer', ar: 'الدفع بالتحويل البنكي' },
  bankTapAbove: { en: 'Tap “Confirm & ask for bank details on WhatsApp” above: we’ll send you our bank details in reply.', ar: 'اضغط على «التأكيد وطلب بيانات الحساب البنكي عبر واتساب» أعلاه، وسنرسل لك بياناتنا البنكية في الرد.' },
  bankMessage: { en: 'Message us on WhatsApp and we’ll send you our bank details. The message is already typed: just tap Send.', ar: 'راسلنا على واتساب وسنرسل لك بياناتنا البنكية. الرسالة مكتوبة مسبقاً: فقط اضغط «إرسال».' },
  bankEmail: { en: 'Email us at {email} and we’ll send you our bank details.', ar: 'راسلنا على {email} وسنرسل لك بياناتنا البنكية.' },
  bankContact: { en: 'We’ll contact you on {phone} with our bank details.', ar: 'سنتواصل معك على {phone} لإرسال بياناتنا البنكية.' },
  askBankWa: { en: 'Ask for bank details on WhatsApp', ar: 'اطلب بيانات الحساب البنكي عبر واتساب' },
  thenUpload: { en: 'Then upload your transfer screenshot', ar: 'ثم ارفع صورة إيصال التحويل' },
  useRef: { en: 'Please use {id} as the transfer reference.', ar: 'يرجى استخدام {id} كمرجع للتحويل.' },
  bankSentEmail: { en: 'We’ve sent our bank details to your email', ar: 'أرسلنا بياناتنا البنكية إلى بريدك الإلكتروني' },
  bankSendWa: { en: 'We’ll send you our bank details on WhatsApp', ar: 'سنرسل لك بياناتنا البنكية عبر واتساب' },
  bankPrivate: { en: '{how}, with a private link to upload your transfer screenshot. They are also on your order’s private page:', ar: '{how}، مع رابط خاص لرفع صورة إيصال التحويل. وتجدها أيضاً في صفحة طلبك الخاصة:' },
  upload: { en: 'Upload your transfer screenshot', ar: 'ارفع صورة إيصال التحويل' },
  orderNumber: { en: 'Order Number', ar: 'رقم الطلب' },
  destination: { en: 'Delivery Destination', ar: 'وجهة التوصيل' },
  gps: { en: 'GPS Coordinates', ar: 'إحداثيات GPS' },
  delivery: { en: 'Delivery', ar: 'التوصيل' },
  sameDay: { en: 'Same day', ar: 'في نفس اليوم' },
  standard: { en: 'Standard delivery', ar: 'التوصيل العادي' },
  paymentMode: { en: 'Payment Mode', ar: 'طريقة الدفع' },
  paidCard: { en: 'Paid by card{label}', ar: 'مدفوع بالبطاقة{label}' },
  cardOver: { en: 'The card payment did not go through: nothing was charged', ar: 'لم يتم الدفع بالبطاقة: لم يُخصم أي مبلغ' },
  confirming: { en: 'Payment is being confirmed…', ar: 'جارٍ تأكيد الدفع…' },
  codTotal: { en: 'Cash on Delivery (AED {total})', ar: 'الدفع عند الاستلام (AED {total})' },
  directBank: { en: 'Direct Bank Transfer', ar: 'تحويل بنكي مباشر' },
  cardFee: { en: 'Card payment fee', ar: 'رسوم الدفع بالبطاقة' },
  vat: { en: 'VAT', ar: 'ضريبة القيمة المضافة' },
  totalPaid: { en: 'Total Paid', ar: 'إجمالي المدفوع' },
  totalPayable: { en: 'Total Payable', ar: 'الإجمالي المستحق' },
  receipt: { en: 'Receipt', ar: 'الإيصال' },
  printable: { en: ' (printable)', ar: ' (للطباعة)' },
  sendWaUpdate: { en: 'Send WhatsApp Order Update', ar: 'إرسال تحديث الطلب عبر واتساب' },
  checkout: { en: 'Checkout', ar: 'إتمام الطلب' },
  headerSub: { en: '{standard} across the UAE · {pays}', ar: '{standard} في جميع أنحاء الإمارات · {pays}' },
  paysCard: { en: 'Card, Apple Pay, Google Pay or cash on delivery', ar: 'البطاقة أو Apple Pay أو Google Pay أو الدفع عند الاستلام' },
  paysCod: { en: 'Cash on delivery or bank transfer', ar: 'الدفع عند الاستلام أو التحويل البنكي' },
  closeCheckout: { en: 'Close checkout', ar: 'إغلاق صفحة الدفع' },
  yourOrder: { en: 'Your order', ar: 'طلبك' },
  yourPhotoOrder: { en: 'Your order from a photo', ar: 'طلبك من صورة' },
  fixedPrice: { en: 'Fixed price · ', ar: 'سعر ثابت · ' },
  photo: { en: 'photo', ar: 'صورة' },
  photos: { en: 'photos', ar: 'صور' },
  piece: { en: 'piece', ar: 'قطعة' },
  pieces: { en: 'pieces', ar: 'قطع' },
  bagItem: { en: '{n} item in your bag', ar: '{n} منتج في سلتك' },
  bagItems: { en: '{n} items in your bag', ar: '{n} منتجات في سلتك' },
  feeLine: { en: 'Card payment fee ({p}%) AED {x}', ar: 'رسوم الدفع بالبطاقة ({p}%) AED {x}' },
  vatLine: { en: 'VAT ({p}%) AED {x}', ar: 'ضريبة القيمة المضافة ({p}%) AED {x}' },
  totalDue: { en: 'Total Due', ar: 'الإجمالي المستحق' },
  inclSameDay: { en: 'incl. same-day AED {x}', ar: 'يشمل توصيل نفس اليوم AED {x}' },
  items: { en: 'Items', ar: 'المنتجات' },
  cardFeeP: { en: 'Card payment fee ({p}%)', ar: 'رسوم الدفع بالبطاقة ({p}%)' },
  vatP: { en: 'VAT ({p}%)', ar: 'ضريبة القيمة المضافة ({p}%)' },
  nameIn: { en: '{name} in {days}', ar: '{name} خلال {days}' },
  s1: { en: '1. Your details', ar: '1. بياناتك' },
  cardNoSms: { en: 'Card: no SMS code needed', ar: 'البطاقة: لا حاجة لرمز SMS' },
  mobileVerified: { en: 'Mobile Verified', ar: 'تم تأكيد الجوال' },
  mobileVerification: { en: 'UAE Mobile Verification', ar: 'تأكيد الجوال الإماراتي' },
  savedDetails: { en: 'Your details from last time are filled in.', ar: 'عبّأنا بياناتك من المرة السابقة.' },
  notYou: { en: 'Not you? Clear them', ar: 'لست أنت؟ امسحها' },
  fullName: { en: 'Full Name', ar: 'الاسم الكامل' },
  namePh: { en: 'e.g. Fatima Al Mansoori', ar: 'مثال: فاطمة المنصوري' },
  email: { en: 'Email address', ar: 'البريد الإلكتروني' },
  recommended: { en: '(recommended)', ar: '(ننصح به)' },
  emailWhy: { en: 'Not required, but we advise it: get your order confirmation and a link to track your order by email.', ar: 'غير إلزامي، لكننا ننصح به: يصلك تأكيد الطلب ورابط لتتبعه على بريدك الإلكتروني.' },
  s2: { en: '2. Delivery address', ar: '2. عنوان التوصيل' },
  locating: { en: 'Locating...', ar: 'جارٍ تحديد الموقع...' },
  useGps: { en: 'Use My GPS', ar: 'استخدم موقعي' },
  closeMap: { en: 'Close Map', ar: 'إغلاق الخريطة' },
  dropPin: { en: 'Drop Pin on Map', ar: 'حدّد موقعك على الخريطة' },
  pinSelector: { en: 'UAE Delivery Map Pin Selector', ar: 'تحديد موقع التوصيل في الإمارات' },
  tapCommunity: { en: 'Tap your community', ar: 'اختر منطقتك السكنية' },
  searchCommunities: { en: 'Search communities', ar: 'ابحث عن المناطق' },
  searchPh: { en: 'Search, e.g. Discovery Gardens, JLT, Yas', ar: 'ابحث، مثال: Discovery Gardens أو JLT أو Yas' },
  noPin: { en: 'No pin for that community yet. Type your area below, and use “Use My GPS” or a landmark for the driver.', ar: 'لا يوجد موقع محدد لهذه المنطقة بعد. اكتب منطقتك أدناه، واستخدم «استخدم موقعي» أو معلماً قريباً للسائق.' },
  selectedGps: { en: 'Selected GPS Coordinates:', ar: 'إحداثيات GPS المحددة:' },
  noneYet: { en: 'None yet', ar: 'لا يوجد بعد' },
  emirate: { en: 'Emirate', ar: 'الإمارة' },
  area: { en: 'Area / Neighborhood', ar: 'المنطقة / الحي' },
  areaPh: { en: 'e.g. Dubai Marina, Saadiyat, JVC', ar: 'مثال: Dubai Marina أو Saadiyat أو JVC' },
  street: { en: 'Street Address', ar: 'عنوان الشارع' },
  streetPh: { en: 'Street name, road, or community number', ar: 'اسم الشارع أو الطريق أو رقم المجمّع' },
  building: { en: 'Building / Villa Name', ar: 'اسم المبنى / الفيلا' },
  buildingPh: { en: 'e.g. Marina Gate 1 or Villa 24', ar: 'مثال: Marina Gate 1 أو فيلا 24' },
  flat: { en: 'Flat / Apartment / Villa #', ar: 'رقم الشقة / الفيلا' },
  flatPh: { en: 'e.g. Apt 1402 or Villa 24', ar: 'مثال: شقة 1402 أو فيلا 24' },
  landmark: { en: 'Nearest Landmark', ar: 'أقرب معلم' },
  landmarkWhy: { en: '(Crucial for courier driver pinpoint)', ar: '(مهم ليصل المندوب إليك بدقة)' },
  landmarkPh: { en: 'e.g. Near Spinneys, Behind Mall of the Emirates, Opposite Park', ar: 'مثال: قرب سبينيس، خلف مول الإمارات، مقابل الحديقة' },
  inclPrice: { en: ' · included in the price', ar: ' · مشمول في السعر' },
  inclAgreed: { en: ' · included in the agreed total', ar: ' · مشمول في المبلغ المتفق عليه' },
  speed: { en: 'Delivery speed', ar: 'سرعة التوصيل' },
  included: { en: ' · included', ar: ' · مشمول' },
  orderBefore: { en: 'Order before {cutoff}', ar: 'اطلب قبل {cutoff}' },
  s3: { en: '3. Payment', ar: '3. الدفع' },
  payment: { en: 'Payment', ar: 'الدفع' },
  cod: { en: 'Cash on delivery', ar: 'الدفع عند الاستلام' },
  codText: { en: 'Pay the courier in cash at your door, in any of the seven emirates.', ar: 'ادفع نقداً للمندوب عند بابك، في أي من الإمارات السبع.' },
  bank: { en: 'Bank transfer', ar: 'تحويل بنكي' },
  bankAskText: { en: 'Message us on WhatsApp for our bank details; we dispatch as soon as it arrives.', ar: 'راسلنا على واتساب لتصلك بياناتنا البنكية، ونشحن طلبك فور وصول التحويل.' },
  bankText: { en: 'Transfer to our UAE bank account; we dispatch as soon as it arrives.', ar: 'حوّل إلى حسابنا البنكي في الإمارات، ونشحن طلبك فور وصول التحويل.' },
  card: { en: 'Card', ar: 'بطاقة' },
  cardText: { en: 'Visa, Mastercard and more, paid securely through Stripe.', ar: 'فيزا وماستركارد وغيرها، بدفع آمن عبر Stripe.' },
  noSms: { en: ' No SMS code needed.', ar: ' لا حاجة لرمز SMS.' },
  cardFeeApplies: { en: ' A {p}% card fee applies.', ar: ' تُطبَّق رسوم بطاقة بنسبة {p}%.' },
  secured: { en: 'Secured by Stripe. Your card details go straight to Stripe, never to us.', ar: 'محمي بواسطة Stripe. تذهب بيانات بطاقتك مباشرة إلى Stripe ولا تصل إلينا أبداً.' },
  howBankWorks: { en: 'How bank transfer works', ar: 'كيف يتم التحويل البنكي' },
  bankHowAsk: { en: "After you order, tap “Ask for bank details on WhatsApp”: we'll reply with our bank details. You'll also get a private link to upload your transfer screenshot.", ar: 'بعد الطلب، اضغط على «اطلب بيانات الحساب البنكي عبر واتساب» وسنرد ببياناتنا البنكية. وسيصلك أيضاً رابط خاص لرفع صورة إيصال التحويل.' },
  bankHow: { en: "After you order, we'll send our bank details by email and WhatsApp, with a private link to upload your transfer screenshot.", ar: 'بعد الطلب، سنرسل بياناتنا البنكية عبر البريد الإلكتروني وواتساب، مع رابط خاص لرفع صورة إيصال التحويل.' },
  addEmail: { en: 'Add your email above to get them by email too.', ar: 'أضف بريدك الإلكتروني أعلاه لتصلك على البريد أيضاً.' },
  checkingStripe: { en: 'Checking with Stripe…', ar: 'جارٍ التحقق مع Stripe…' },
  checkAgain: { en: 'Check again', ar: 'تحقق مرة أخرى' },
  payingSecurely: { en: 'Paying securely…', ar: 'جارٍ الدفع بأمان…' },
  placing: { en: 'Placing your order…', ar: 'جارٍ إرسال طلبك…' },
  payAed: { en: 'Pay AED {total}', ar: 'ادفع AED {total}' },
  enterToPlace: { en: 'Enter your UAE mobile to place order', ar: 'أدخل رقم جوالك الإماراتي لإتمام الطلب' },
  verifyToPlace: { en: 'Verify your UAE mobile to place order', ar: 'أكّد رقم جوالك الإماراتي لإتمام الطلب' },
  placeOrder: { en: 'Place order · AED {total}', ar: 'إتمام الطلب · AED {total}' },
  deliveredDoor: { en: 'Delivered to your door, with a tracking link as soon as it ships.', ar: 'يصلك حتى باب بيتك، مع رابط تتبع فور شحنه.' },
  terms: { en: 'By placing your order you agree to our {link}.', ar: 'بإتمام طلبك فإنك توافق على {link}.' },
  termsLink: { en: 'Terms & Conditions', ar: 'الشروط والأحكام' },
} as const satisfies Words;

/** The emirates' names in Arabic (shown only; the value sent stays the English name). */
const EMIRATE_AR: Record<Emirate, string> = {
  Dubai: 'دبي',
  'Abu Dhabi': 'أبوظبي',
  Sharjah: 'الشارقة',
  Ajman: 'عجمان',
  'Umm Al Quwain': 'أم القيوين',
  'Ras Al Khaimah': 'رأس الخيمة',
  Fujairah: 'الفجيرة',
};

/** Text with {name} slots filled by React nodes (a bold word, an order number in mono). */
function slots(text: string, nodes: Record<string, React.ReactNode>): React.ReactNode {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name && name in nodes ? <React.Fragment key={i}>{nodes[name]}</React.Fragment> : part;
  });
}

/** "Loading the secure card form…" in the shop's language (shown while Stripe's chunk loads). */
function CardLoading() {
  const t = useT(WORDS);
  return <p className="text-[11px] text-ink-muted py-2">{t('cardLoading')}</p>;
}

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  /**
   * Checkout offers bank transfer (the shop's account is saved). The account itself is never on the
   * website: it is sent to the customer privately after the order (src/lib/server/bankPay.ts).
   */
  bankTransfer: boolean;
  /**
   * Bank transfer "on request" (Settings → Payments): no account is saved, so the customer asks
   * for the details on the shop's WhatsApp after ordering.
   */
  bankAskWhatsApp?: boolean;
  /** The server stored the order (it is shown confirmed only after that). */
  onOrderPlaced: (order: Order) => void;
  /** Reload the catalogue and the bag (prices changed on the server). */
  onPricesChanged: () => Promise<void>;
  /** Where international customers email (from the server's settings). */
  supportEmail?: string;
  /** Where the customer came from (Instagram, WhatsApp…), recorded on the order. */
  landing?: { source: string; campaign?: string } | null;
  /**
   * How phones are checked: Settings → Phone check "WhatsApp (free)" (check 'whatsapp': no code, the
   * customer confirms on WhatsApp after ordering), or an SMS code (the shop's own SMS, or Firebase).
   */
  phoneVerification?: PhoneVerificationConfig;
  /**
   * Card payments through the shop's Stripe account (Settings → Payments), when switched on.
   * phoneCheck: an SMS gateway is on, so a card order proves the phone with a code like any order.
   */
  card?: { publishableKey: string; phoneCheck?: boolean; cardFeePercent?: number } | null;
  /**
   * "Order from your photo": a piece agreed on WhatsApp instead of the bag (its photos, pieces and
   * the agreed amount). Paid on delivery or by transfer; the shop confirms the amount before it ships.
   */
  photoOrder?: PhotoOrderDraft | null;
}

/** A card order (paying is its own proof of the number). */
const paidByCardOrder = (order: Order) => order.paymentMethod === 'online_card';

/** Stripe.js's error types that mean the payment was refused, so nothing was charged (anything else: not known). */
const surelyNotCharged = (errorType?: string) => errorType === 'card_error' || errorType === 'validation_error';

/** A card order on the confirmation screen: paid only once the server has Stripe's word. */
type CardShown = { state: string; label?: string };

/** The customer's details from last time (this browser only; never the phone check). */
interface Draft {
  fullName?: string;
  phone?: string;
  email?: string;
  emirate?: Emirate;
  area?: string;
  streetAddress?: string;
  buildingVilla?: string;
  flatVillaNo?: string;
  landmark?: string;
}
const DRAFT_KEY = 'buh_checkout_details';

function readDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') as Record<string, unknown>;
    const out: Draft = {};
    for (const k of ['fullName', 'phone', 'email', 'area', 'streetAddress', 'buildingVilla', 'flatVillaNo', 'landmark'] as const) {
      if (typeof d[k] === 'string' && (d[k] as string).length <= 200) out[k] = d[k] as string;
    }
    if (typeof d.emirate === 'string' && (UAE_EMIRATES as readonly string[]).includes(d.emirate)) out.emirate = d.emirate as Emirate;
    return out;
  } catch {
    return {};
  }
}

/** Saves non-empty details; returns whether anything was saved. */
function writeDraft(d: Draft): boolean {
  const filled = Object.fromEntries(Object.entries(d).filter(([k, v]) => v && !(k === 'emirate' && v === 'Dubai' && !d.area)));
  try {
    if (Object.keys(filled).length) localStorage.setItem(DRAFT_KEY, JSON.stringify(filled));
    return Object.keys(filled).length > 0;
  } catch {
    return false;
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // nothing saved
  }
}

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
  isOpen,
  onClose,
  items,
  bankTransfer,
  bankAskWhatsApp = false,
  onOrderPlaced,
  onPricesChanged,
  supportEmail,
  landing,
  phoneVerification,
  card,
  photoOrder = null,
}) => {
  const t = useT(WORDS);
  const { locale } = useLocale();
  const emirateName = (em: Emirate) => (locale === 'ar' ? EMIRATE_AR[em] ?? em : em);
  // One checkout attempt = one order, even if "Confirm" is sent twice (double tap, retry). A card
  // attempt that didn't go through is closed (its pieces back on sale), and the next one is new.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  // Proof from the server that the phone passed SMS verification.
  const [phoneToken, setPhoneToken] = useState('');
  // Form State: what the customer typed last time is filled back in, so they carry on where they left off.
  const [draft] = useState(readDraft);
  const [fullName, setFullName] = useState(draft.fullName ?? '');
  const [phone, setPhone] = useState(draft.phone ?? '');
  const [email, setEmail] = useState(draft.email ?? '');
  const [emirate, setEmirate] = useState<Emirate>(draft.emirate ?? 'Dubai');
  const [area, setArea] = useState(draft.area ?? '');
  const [streetAddress, setStreetAddress] = useState(draft.streetAddress ?? '');
  const [buildingVilla, setBuildingVilla] = useState(draft.buildingVilla ?? '');
  const [flatVillaNo, setFlatVillaNo] = useState(draft.flatVillaNo ?? '');
  const [landmark, setLandmark] = useState(draft.landmark ?? '');
  const [hasSavedDetails, setHasSavedDetails] = useState(Object.keys(draft).length > 0);
  useEffect(() => {
    const timer = setTimeout(() => {
      writeDraft({ fullName, phone, email, emirate, area, streetAddress, buildingVilla, flatVillaNo, landmark });
    }, 300);
    return () => clearTimeout(timer);
  }, [fullName, phone, email, emirate, area, streetAddress, buildingVilla, flatVillaNo, landmark]);
  const forgetDetails = () => {
    clearDraft();
    setEmirate('Dubai');
    setFullName('');
    setPhone('');
    setEmail('');
    setArea('');
    setStreetAddress('');
    setBuildingVilla('');
    setFlatVillaNo('');
    setLandmark('');
    setHasSavedDetails(false);
  };

  // GPS Pin Drop State
  const [gpsCoordinates, setGpsCoordinates] = useState<{ lat: number; lng: number } | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [pinQuery, setPinQuery] = useState('');
  // Said once when choosing an area also changed the emirate.
  const [areaNote, setAreaNote] = useState('');

  // Customer Mobile OTP State
  const [isPhoneVerified, setIsPhoneVerified] = useState(false);

  // Delivery: decided by the address (the server checks again and charges any same-day fee).
  const { delivery: deliverySettings, vatAddedPercent = 0 } = useShop();
  // Same day is chosen for one address: changing the emirate or area goes back to standard.
  const [deliveryChoice, setDeliveryChoice] = useState<{ option: 'standard' | 'same_day'; key: string }>({ option: 'standard', key: '' });
  const setDeliveryOption = (option: 'standard' | 'same_day') => setDeliveryChoice({ option, key: `${emirate}|${area}` });
  const [locationProblem, setLocationProblem] = useState(false);

  // Payment Method
  // A deal link without cash on delivery starts on the first way to pay it offers.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(() => {
    const pays = photoOrder?.deal?.payments;
    if (!pays || pays.includes('cod')) return 'cod';
    if (card && pays.includes('online_card')) return 'online_card';
    if (bankTransfer && pays.includes('bank_transfer')) return 'bank_transfer';
    return pays[0] ?? 'cod';
  });
  // The card fee's percent the server gave when it refused a total (the owner changed it meanwhile).
  const [feePercentNow, setFeePercentNow] = useState<number | null>(null);

  // Submission State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<Order | null>(null);
  // The customer tapped "Confirm my order on WhatsApp" for this order (kept for this visit, so a
  // reload still says "in process"). Only shown after an order, in the browser.
  const [tappedNow, setTappedNow] = useState<string[]>([]);
  const wasTapped = (orderId: string) => {
    if (tappedNow.includes(orderId)) return true;
    try {
      return sessionStorage.getItem(`buh:wa-tapped:${orderId}`) === '1';
    } catch {
      return false;
    }
  };
  const markWaTapped = (orderId: string) => {
    setTappedNow((list) => [...list, orderId]);
    try {
      sessionStorage.setItem(`buh:wa-tapped:${orderId}`, '1');
    } catch {
      // A convenience only.
    }
  };
  const [submitError, setSubmitError] = useState('');

  // Card payments: Stripe's fields say when they can pay; the confirmation screen asks the server
  // (which asks Stripe) until the payment is confirmed.
  const cardPay = useRef<CardPay | null>(null);
  // The card order the server made for this attempt (shown once Stripe has the payment).
  const placed = useRef<Order | null>(null);
  const [cardReady, setCardReady] = useState(false);
  const onCardReady = useCallback((pay: CardPay | null) => {
    cardPay.current = pay;
    setCardReady(Boolean(pay));
  }, []);
  const [cardSecret, setCardSecret] = useState('');
  const [cardShown, setCardShown] = useState<CardShown | null>(null);
  const [walletNotice, setWalletNotice] = useState('');
  // A card try whose outcome is unknown (the connection dropped): kept, so "Check again" can ask the
  // server (which asks Stripe), and paying again continues the same order (never a second charge).
  const [cardCheck, setCardCheck] = useState<{ order: Order; secret: string } | null>(null);
  const [checkingCard, setCheckingCard] = useState(false);

  // Financial Calculations
  // In fils, like the server. Standard delivery and COD are free (same day adds Settings → Delivery's charge); the server is the source of truth and
  // refuses the order if its total differs from the one shown here (a price changed meanwhile).
  const delivery = deliveryCheck({ emirate, area }, deliverySettings);
  const sameDayChosen = deliveryChoice.option === 'same_day' && deliveryChoice.key === `${emirate}|${area}` && delivery.sameDay.available;
  // An order from a photo: the agreed total includes standard delivery (same day is extra), as on the server.
  const standardFils = photoOrder ? 0 : toFils(delivery.standard.fee);
  const deliveryFils = sameDayChosen ? toFils(delivery.sameDay.fee) : standardFils;
  const totalFils = (photoOrder ? photoOrder.amountFils : cartFils(items)) + deliveryFils;
  // The owner's deal link: only the ways to pay the owner allowed (the server refuses the others too).
  const dealPays = photoOrder?.deal?.payments;
  const codOffered = !dealPays || dealPays.includes('cod');
  const bankReady = bankTransfer && (!dealPays || dealPays.includes('bank_transfer'));
  const cardOffered = Boolean(card) && (!dealPays || dealPays.includes('online_card'));
  const shopWhatsApp = useShop().store.whatsappNumber.replace(/\D/g, '');
  const byCard = paymentMethod === 'online_card' && cardOffered;
  // Card payment fee (Settings → Payments): a percent of items + delivery, worked out like the server
  // does (whole fils, half up). The server works it out again and refuses a total that differs.
  const feePercent = feePercentNow ?? card?.cardFeePercent ?? 0;
  const cardFee = card ? cardFeeFils(totalFils, feePercent) : 0;
  // UAE VAT added on top (only with VAT on and prices excluding VAT; the server works it out again).
  const plainVatFils = vatAddedPercent ? vatOnTopFils(totalFils, vatAddedPercent) : 0;
  const cardVatFils = vatAddedPercent ? vatOnTopFils(totalFils + cardFee, vatAddedPercent) : 0;
  const cardTotalFils = totalFils + cardFee + cardVatFils;
  const payTotalFils = totalFils + plainVatFils;
  const shownVatFils = byCard ? cardVatFils : plainVatFils;
  const shownTotalFils = byCard ? cardTotalFils : payTotalFils;
  const grandTotal = formatAed(shownTotalFils);
  // With an SMS gateway on, a card order needs the phone code too (once per checkout).
  const cardNeedsCode = byCard && Boolean(card?.phoneCheck);
  const phoneOk = classifyPhone(phone).kind === 'uae';
  // Settings → Phone check "WhatsApp (free)": no code at all; the number (UAE mobile rules) is enough
  // to order, and the customer confirms with one WhatsApp message afterwards.
  const whatsappCheck = phoneVerification?.check === 'whatsapp';
  const phoneReady = whatsappCheck ? phoneOk : isPhoneVerified;

  // The confirmation screen of a card order: ask the server until Stripe has confirmed (or not).
  const confirmedId = confirmedOrder?.id;
  const waitingForCard = Boolean(confirmedId && cardSecret && cardShown && (cardShown.state === 'pending' || cardShown.state === 'failed'));
  useEffect(() => {
    if (!waitingForCard || !confirmedId) return;
    let tries = 0;
    let stopped = false;
    const ask = async () => {
      if (stopped) return;
      const { ok, data } = await postJson<{ card?: CardShown }>('/api/orders/payment', { orderId: confirmedId, clientSecret: cardSecret, action: 'check' });
      if (stopped) return;
      if (ok && data.card) setCardShown(data.card);
      if (++tries < 40 && !(ok && data.card && data.card.state !== 'pending' && data.card.state !== 'failed')) timer = setTimeout(ask, tries < 10 ? 1500 : 4000);
    };
    let timer = setTimeout(ask, 800);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waitingForCard, confirmedId, cardSecret]);



  // Escape closes checkout (not while an order is being saved).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, isSubmitting, onClose]);

  // Every hook must run on every render, so the early return comes after them all.
  if (!isOpen) return null;

  // Handler: GPS Current Location using Browser Geolocation
  const handleUseCurrentLocation = () => {
    if (!navigator.geolocation) {
      alert(t('noGeo'));
      return;
    }
    setIsLocating(true);
    setLocationNotice(null);

    setLocationProblem(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setIsLocating(false);
        const { latitude, longitude, accuracy } = pos.coords;
        // Laptops and many phones indoors report a Wi-Fi or network location (sometimes another country,
        // e.g. through a VPN). The pin is kept for the driver, but an area is only suggested from a
        // precise reading close to a community we know; otherwise the customer chooses it.
        const reading = suggestAreaFromGps(latitude, longitude, accuracy);
        if (reading.kind === 'outside') {
          setGpsCoordinates(null);
          setLocationProblem(true);
          setLocationNotice(t('locOutside'));
          return;
        }
        setGpsCoordinates({ lat: latitude, lng: longitude });
        const kept = area.trim() ? t('locKept') : '';
        if (reading.kind === 'approximate') {
          setLocationProblem(true);
          setLocationNotice(
            t('locApprox', { accuracy: formatAccuracy(reading.accuracyM), rest: kept || t('locChooseIt') })
          );
        } else if (reading.kind === 'unknown') {
          setLocationNotice(t('locUnknown', { rest: kept || t('locChooseArea') }));
        } else if (!area.trim()) {
          setEmirate(reading.location.emirate);
          setArea(reading.location.name);
          setAreaNote('');
          setLocationNotice(t('locNear', { place: reading.location.name, emirate: emirateName(reading.location.emirate) }));
        } else {
          // The customer already typed an area: never switch the emirate under it.
          setLocationNotice(t('locNearKept', { place: reading.location.name, emirate: emirateName(reading.location.emirate), kept }));
        }
      },
      () => {
        setIsLocating(false);
        setLocationProblem(true);
        setLocationNotice(t('locFailed'));
      },
      { timeout: 10000, enableHighAccuracy: true, maximumAge: 60_000 }
    );
  };

  // Handler: Select location preset or drop pin on map
  const handleSelectMapLocation = (loc: typeof UAE_KEY_LOCATIONS[0]) => {
    setGpsCoordinates({ lat: loc.lat, lng: loc.lng });
    setEmirate(loc.emirate);
    setArea(loc.name);
    setAreaNote('');
    setLocationProblem(false);
    setLocationNotice(t('pinDropped', { place: loc.name, emirate: emirateName(loc.emirate), lat: loc.lat.toFixed(4), lng: loc.lng.toFixed(4) }));
    setShowMapPicker(false);
  };

  // An area chosen from the list: in another emirate, the emirate follows it.
  const handlePickArea = (a: UAEArea) => {
    setArea(a.name);
    if (a.emirate !== emirate) {
      setEmirate(a.emirate);
      setAreaNote(t('emirateChanged', { emirate: emirateName(a.emirate), area: a.name }));
    } else {
      setAreaNote('');
    }
  };

  // Communities with a known centre, for "Drop pin": searchable like the area field.
  const pinMatches = pinQuery.trim()
    ? searchAreas(pinQuery, emirate, 200)
        .map((m) => UAE_KEY_LOCATIONS.find((l) => l.name === m.area.name && l.emirate === m.area.emirate))
        .filter((l): l is (typeof UAE_KEY_LOCATIONS)[number] => Boolean(l))
    : [...UAE_KEY_LOCATIONS.filter((l) => l.emirate === emirate), ...UAE_KEY_LOCATIONS.filter((l) => l.emirate !== emirate)];


  /** The order body as checkout has it now, with any details the wallet gave instead. */
  const orderBody = (method: PaymentMethod, over: { customer?: Partial<Record<'fullName' | 'phone' | 'email' | 'emirate' | 'area' | 'streetAddress' | 'buildingVilla' | 'flatVillaNo', string>>; deliveryOption?: 'standard' | 'same_day' } = {}) => ({
    idempotencyKey,
    // WhatsApp check, or a card without an SMS gateway: no code needed (a verified number is still sent when there is one).
    verificationToken: whatsappCheck || (method === 'online_card' && !card?.phoneCheck && !(isPhoneVerified && phoneToken)) ? undefined : phoneToken,
    customer: {
      fullName,
      email: email || undefined,
      emirate,
      area,
      streetAddress,
      buildingVilla,
      flatVillaNo,
      landmark: landmark || undefined,
      gpsCoordinates: gpsCoordinates || undefined,
      ...(method === 'online_card' || whatsappCheck ? { phone: classifyPhone(phone).e164 || phone } : {}),
      ...over.customer,
    },
    items: photoOrder
      ? []
      : items.map((item) => ({
          productId: item.product.id,
          profileId: item.selectedProfile.id,
          color: item.selectedColor,
          quantity: item.quantity,
        })),
    ...(photoOrder?.deal
      ? { deal: { token: photoOrder.deal.token } }
      : photoOrder
        ? { photo: { photos: photoOrder.photos, note: photoOrder.note, pieces: photoOrder.pieces, amount: photoOrder.amountFils / 100 } }
        : {}),
    paymentMethod: method,
    deliveryOption: photoOrder?.deal ? 'standard' : (over.deliveryOption ?? (sameDayChosen ? 'same_day' : 'standard')),
    // The total shown for this way of paying (a card order includes the card fee).
    expectedTotal: (method === 'online_card' ? cardTotalFils : payTotalFils) / 100,
    source: landing ?? undefined,
  });

  /** A refused order: reload prices or delivery if that was why, and say what happened. */
  const orderRefused = async (status: number, data: { message?: string; code?: string; cardFeePercent?: number }) => {
    if (status === 401) {
      // The phone check expired (30 minutes): verify again.
      setIsPhoneVerified(false);
      setPhoneToken('');
    }
    // A price changed since the bag was filled: reload it, so the new total is shown before confirming.
    if (status === 409 && data.code === 'price_changed') {
      // The card fee changed meanwhile: the server's percent, so the new total is shown.
      if (typeof data.cardFeePercent === 'number') setFeePercentNow(data.cardFeePercent);
      await onPricesChanged();
    }
    // Same-day closed while they were at checkout (past the cut-off): back to standard, total shown again.
    if (status === 409 && data.code === 'same_day_unavailable') setDeliveryOption('standard');
    return data.message || t('notPlaced');
  };

  /** Create the card order on the server (its prices, its total) and get Stripe's client secret for it. */
  const startCardOrder = async (over: Parameters<typeof orderBody>[1] = {}): Promise<StartedCardOrder> => {
    const { ok, status, data } = await postJson<{ order?: Order; payment?: { clientSecret?: string }; message?: string; code?: string; cardFeePercent?: number }>('/api/orders', orderBody('online_card', over));
    if (!ok || !data.order) {
      const message = await orderRefused(status, data);
      // Stripe could not be reached: that attempt is closed on the server, so the next is a new one.
      if (data.code === 'card_start_failed') setIdempotencyKey(crypto.randomUUID());
      return { ok: false, message };
    }
    placed.current = data.order;
    setCardCheck(null);
    if (data.order.card?.state === 'paid') return { ok: false, paid: true, orderId: data.order.id };
    if (data.order.card?.state === 'canceled' || data.order.status === 'cancelled') {
      // That attempt timed out and was closed (never paid): the next tap is a new one.
      setIdempotencyKey(crypto.randomUUID());
      return { ok: false, message: t('attemptClosed') };
    }
    return { ok: true, orderId: data.order.id, clientSecret: data.payment?.clientSecret };
  };

  /** Stripe has the payment (or it didn't go through): show the confirmation, or close that attempt. */
  const cardFinished = async (result: CardResult) => {
    const order = placed.current && placed.current.id === result.orderId ? placed.current : null;
    if (!result.ok && order && result.clientSecret) {
      // Declined, the customer closed 3-D Secure, or the connection dropped: stop that payment so its
      // pieces go back on sale (if Stripe says it was paid after all, it counts as paid).
      const declined = surelyNotCharged(result.errorType);
      const { ok, data } = await postJson<{ card?: CardShown; status?: string }>('/api/orders/payment', { orderId: order.id, clientSecret: result.clientSecret, action: 'abandon' });
      if (ok && data.card?.state === 'paid') return showConfirmed(order, result.clientSecret, data.card);
      if (ok && (data.card?.state === 'canceled' || data.status === 'cancelled')) {
        // Stopped at Stripe: this attempt is over, the next one is new.
        setIdempotencyKey(crypto.randomUUID());
        setCardCheck(null);
        setSubmitError(t(declined ? 'notCharged' : 'stoppedRetry', { reason: result.message || t('payFailed') }));
        return;
      }
      // Not known whether it went through (offline, or Stripe still busy with it): keep this attempt,
      // so paying again continues the same order and the same payment, never a second one.
      setCardCheck({ order, secret: result.clientSecret });
      setSubmitError(
        declined
          ? t('notCharged', { reason: result.message || t('payFailed') })
          : t('notConfirmed')
      );
      return;
    }
    if (!result.ok && order && order.card?.state === 'paid') return showConfirmed(order, '', order.card);
    if (!result.ok || !order) {
      if (result.message) setSubmitError(result.message);
      return;
    }
    showConfirmed(order, result.clientSecret || '', order.card ?? { state: 'pending' });
  };

  /** "Check again": the server asks Stripe what happened to the payment that could not be confirmed. */
  const checkCardAgain = async () => {
    if (!cardCheck || checkingCard) return;
    setCheckingCard(true);
    const { ok, data } = await postJson<{ card?: CardShown; status?: string }>('/api/orders/payment', { orderId: cardCheck.order.id, clientSecret: cardCheck.secret, action: 'check' });
    setCheckingCard(false);
    if (!ok || !data.card) return setSubmitError(t('stillNoReach'));
    if (data.card.state === 'paid') return showConfirmed(cardCheck.order, cardCheck.secret, data.card);
    if (data.card.state === 'canceled' || data.status === 'cancelled') {
      setIdempotencyKey(crypto.randomUUID());
      setCardCheck(null);
      return setSubmitError(t('notTaken'));
    }
    setSubmitError(t('notYet'));
  };

  const showConfirmed = (order: Order, secret: string, shown: CardShown | null) => {
    setCardCheck(null);
    setSubmitError('');
    setConfirmedOrder(order);
    setCardSecret(secret);
    setCardShown(shown);
    onOrderPlaced(order);
    if (!whatsappPending(order)) celebrate();
  };

  /** Apple Pay / Google Pay gave the customer's details: fill checkout with them, and pay if nothing is missing. */
  const payFromWallet = async ({ contact, deliveryOption }: WalletPayment): Promise<StartedCardOrder & { reason?: 'invalid_shipping_address' | 'address_unserviceable' | 'fail' }> => {
    const w = walletAddress(contact);
    setWalletNotice('');
    setSubmitError('');
    // What the wallet gave fills checkout (the customer sees it, and can correct it).
    if (w.fullName) setFullName(w.fullName);
    if (w.email) setEmail(w.email);
    if (w.streetAddress) setStreetAddress(w.streetAddress);
    if (w.buildingVilla) setBuildingVilla(w.buildingVilla);
    if (w.flatVillaNo) setFlatVillaNo(w.flatVillaNo);
    const walletEmirate = w.emirate ?? emirate;
    if (w.emirate) setEmirate(w.emirate);
    // The area: the wallet's, or the one chosen in checkout for the same emirate. Never a guess.
    const typed = area.trim() ? resolveArea(area, walletEmirate) : null;
    const chosenArea = w.area ?? (typed && typed.emirate === walletEmirate ? typed.name : null);
    if (w.area) setArea(w.area);
    if (!chosenArea) {
      setWalletNotice(t('walletArea'));
      setTimeout(() => document.getElementById('checkout-area')?.focus(), 50);
      return { ok: false, reason: 'invalid_shipping_address', message: t('walletAreaShort') };
    }
    // The phone: the wallet's if it is a UAE mobile, else the one typed in checkout.
    const walletPhone = classifyPhone(w.phone);
    const mobile = walletPhone.kind === 'uae' ? walletPhone.e164 : classifyPhone(phone).kind === 'uae' ? classifyPhone(phone).e164 : '';
    if (walletPhone.kind === 'uae') setPhone(walletPhone.e164);
    if (!mobile) {
      setWalletNotice(t('walletPhone'));
      setTimeout(() => document.getElementById('checkout-phone')?.focus(), 50);
      return { ok: false, reason: 'fail', message: t('walletPhoneShort') };
    }
    if (!deliveryCheck({ emirate: walletEmirate, area: chosenArea }, deliverySettings).serviceable) {
      return { ok: false, reason: 'address_unserviceable', message: t('noDeliver') };
    }
    // With an SMS gateway on, the phone is proved with a code first (once: a number already verified
    // in this checkout is used as it is).
    const verified = card?.phoneCheck ? (isPhoneVerified && phoneToken ? classifyPhone(phone).e164 : '') : mobile;
    if (!verified) {
      setWalletNotice(t('walletVerify'));
      setTimeout(() => document.getElementById('checkout-phone')?.focus(), 50);
      return { ok: false, reason: 'fail', message: t('walletVerifyShort') };
    }
    return startCardOrder({
      customer: {
        fullName: w.fullName || fullName,
        email: w.email || email || '',
        phone: verified,
        emirate: walletEmirate,
        area: chosenArea,
        streetAddress: w.streetAddress || streetAddress,
        buildingVilla: w.buildingVilla || buildingVilla,
        flatVillaNo: w.flatVillaNo || flatVillaNo,
      },
      deliveryOption,
    });
  };

  /** The order still waits for the customer's WhatsApp message (its "last step"). */
  const whatsappPending = (order: Order) => Boolean(order.whatsappCheck && shopWhatsApp && order.whatsappCheck.status !== 'confirmed');

  const celebrate = () => {
    try {
      // A light shower of gold (none for people who asked their device for less motion).
      confetti({
        particleCount: 36,
        spread: 60,
        startVelocity: 28,
        scalar: 0.8,
        origin: { y: 0.55 },
        colors: [PALETTE.gold, PALETTE['gold-light'], PALETTE.ivory, PALETTE['rose']],
        disableForReducedMotion: true,
      });
    } catch {
      // ignore
    }
  };

  // Submit Order: the server checks the phone proof, prices, stock and totals.
  const handleSubmitOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (!fullName || !phone || !area || !streetAddress || !buildingVilla || !flatVillaNo) {
      alert(t('fillAll'));
      return;
    }

    // Card switched off while checkout was open: say so (never quietly another way to pay).
    if (paymentMethod === 'online_card' && !card) {
      setSubmitError(t('cardOff'));
      return;
    }
    // Card: the courier still needs a UAE mobile, but no SMS code (paying is the proof).
    if (byCard) {
      if (!phoneOk) {
        document.getElementById('checkout-phone')?.focus();
        alert(t('needMobileCourier'));
        return;
      }
      if (cardNeedsCode && !(isPhoneVerified && phoneToken)) {
        document.getElementById('checkout-phone')?.focus();
        alert(t('verifyBeforePay'));
        return;
      }
      if (!cardPay.current) return;
      setSubmitError('');
      setIsSubmitting(true);
      const result = await cardPay.current(() => startCardOrder());
      await cardFinished(result);
      setIsSubmitting(false);
      return;
    }

    // WhatsApp check: a UAE mobile is enough (no code). Otherwise only a verified UAE mobile number.
    if (whatsappCheck ? !phoneOk : !isPhoneVerified || !phoneToken) {
      document.getElementById('checkout-phone')?.focus();
      alert(t(whatsappCheck ? 'enterMobile' : 'verifyBeforeOrder'));
      return;
    }

    setSubmitError('');
    setIsSubmitting(true);
    const { ok, status, data } = await postJson<{ order?: Order; message?: string; code?: string; cardFeePercent?: number }>('/api/orders', orderBody(paymentMethod));
    setIsSubmitting(false);

    if (!ok || !data.order) {
      setSubmitError(await orderRefused(status, data));
      return;
    }
    setConfirmedOrder(data.order);
    onOrderPlaced(data.order);
    // Confetti only when nothing is left to do (not while the WhatsApp step is still open).
    if (!whatsappPending(data.order)) celebrate();
  };

  // SUCCESS CONFIRMATION SCREEN
  if (confirmedOrder) {
    const askWhatsApp = Boolean(confirmedOrder.whatsappCheck && shopWhatsApp);
    // WhatsApp check: the message is the order's confirmation (with the hours before an unconfirmed one is cancelled).
    const cancelHours = cancelHoursOf(confirmedOrder.createdAt, confirmedOrder.whatsappCheck?.cancelAt) ?? (whatsappCheck && confirmedOrder.whatsappCheck?.cancelAt ? phoneVerification?.cancelHours ?? null : null);
    // The order still needs the customer's WhatsApp message (Settings → Phone check "WhatsApp (free)":
    // every cash-on-delivery and bank-transfer order no code proved; or the shop holds orders until it).
    const awaitingConfirmation =
      askWhatsApp && confirmedOrder.whatsappCheck?.status !== 'confirmed' && (Boolean(confirmedOrder.whatsappCheck?.hold) || Boolean(cancelHours) || (whatsappCheck && !confirmedOrder.customer.phoneVerified));
    const openHours = cancelHoursOf(confirmedOrder.createdAt, confirmedOrder.whatsappCheck?.openBy);
    const waTapped = wasTapped(confirmedOrder.id);
    // Every order asked to confirm on WhatsApp gets the "last step" page until the message has come.
    const lastStep = askWhatsApp && confirmedOrder.whatsappCheck?.status !== 'confirmed';
    const firstName = confirmedOrder.customer.fullName.trim().split(/\s+/)[0] ?? '';
    const pieceCount = confirmedOrder.items.reduce((n, i) => n + i.quantity, 0);
    // WhatsApp check without the shop's number: nothing to tap, the shop calls instead.
    const weCall = whatsappCheck && !askWhatsApp && !confirmedOrder.customer.phoneVerified && !paidByCardOrder(confirmedOrder);
    const paidByCard = confirmedOrder.paymentMethod === 'online_card';
    const cardPaid = paidByCard && cardShown?.state === 'paid';
    const cardOver = paidByCard && (cardShown?.state === 'canceled' || cardShown?.state === 'refunded');
    const byTransfer = confirmedOrder.paymentMethod === 'bank_transfer';
    const payPath = confirmedOrder.bankTransfer?.payPath;
    // Bank transfer "on request": the customer asks the shop's WhatsApp for the details. While the
    // order waits for its WhatsApp confirmation, that one message (with its code) asks for them too,
    // so there is one button; with no WhatsApp number, the support email.
    const bankOnRequest = byTransfer && confirmedOrder.bankDetailsBy === 'whatsapp';
    const confirmAsks = bankOnRequest && askWhatsApp && confirmedOrder.whatsappCheck?.status !== 'confirmed';
    const askBankLink = bankOnRequest && !confirmAsks ? waMeLink(shopWhatsApp, askBankDetailsMessage(confirmedOrder.id, confirmedOrder.total)) : null;
    const doneSteps = [
      confirmedOrder.photoOrder?.fixedPrice ? t('stepPicturesAgreed') : confirmedOrder.photoOrder ? t('stepPhotosAdded') : t(pieceCount === 1 ? 'stepPiece' : 'stepPieces', { n: pieceCount }),
      t('stepAddress'),
      t('stepPayment', { how: t(confirmedOrder.paymentMethod === 'cod' ? 'howCod' : paidByCard ? (cardPaid ? 'howCardPaid' : 'howCard') : 'howBank') }),
    ];
    const whatsappMessage = encodeURIComponent(
      `Hello Beautiful UAE Home! I have placed Order #${confirmedOrder.id} (${confirmedOrder.customer.fullName}) for AED ${confirmedOrder.total}. Payment method: ${confirmedOrder.paymentMethod === 'cod' ? 'Cash on Delivery' : paidByCard ? 'Card' : 'Bank Transfer'}. ${byTransfer ? 'Please send me the bank details.' : 'Please confirm dispatch.'}`
    );

    return (
      <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-scrim/45 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="order-confirmed-title">
        <div className="bg-surface sm:rounded-3xl max-w-lg w-full h-[100dvh] sm:h-auto sm:max-h-[92dvh] flex flex-col border border-line pt-safe sm:pt-0 overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-6 text-center space-y-5">
          {lastStep ? (
            // Still to do: the WhatsApp message (it proves the number is the customer's). A checklist of
            // what is done, and one open box: the last step, the glowing button. No confetti until then.
            <div data-testid="order-last-step" className="space-y-4 text-start">
              <div className="text-center">
                <span data-testid="order-last-step-label" className="label-caps text-gold-deep font-semibold">
                  {t(waTapped ? 'lastWaiting' : 'lastOneTap')}
                </span>
                <h2 id="order-confirmed-title" className="font-serif text-3xl text-ink mt-2">
                  {firstName ? t('almostName', { name: firstName }) : t('almost')}
                </h2>
                <p className="text-[13px] text-ink-soft mt-1.5 leading-relaxed">
                  {waTapped ? (
                    slots(t('didSend'), { send: <strong>{t('sendWord')}</strong>, id: <span className="font-mono">{confirmedOrder.id}</span> })
                  ) : (
                    slots(t('oneTapLeft'), { id: <span className="font-mono">{confirmedOrder.id}</span> })
                  )}
                </p>
              </div>
              <ul className="space-y-2" aria-label={t('done')}>
                {doneSteps.map((step) => (
                  <li key={step} className="flex items-center gap-2.5 p-3 rounded-xl bg-ivory text-sm text-ink">
                    <span className="w-6 h-6 rounded-full bg-success text-paper flex items-center justify-center shrink-0">
                      <Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden="true" />
                    </span>
                    {step}
                  </li>
                ))}
              </ul>
              <section aria-labelledby="last-step-title" className="rounded-2xl border-2 border-dashed border-gold bg-ivory p-3 space-y-3">
                <h3 id="last-step-title" className="flex items-center gap-2 text-sm font-bold text-ink">
                  <span className="w-6 h-6 rounded-full border-2 border-gold-deep shrink-0" aria-hidden="true" />
                  {t('lastConfirm')}
                </h3>
                <WhatsAppConfirm
                  lead
                  glow
                  tapped={waTapped}
                  onTapped={() => markWaTapped(confirmedOrder.id)}
                  orderId={confirmedOrder.id}
                  phone={confirmedOrder.customer.phone}
                  check={confirmedOrder.whatsappCheck!}
                  bankDetails={byTransfer}
                  cancelHours={cancelHours}
                  openHours={openHours}
                  buttonLabel={t(confirmAsks ? 'tapConfirmBank' : 'tapConfirm')}
                  ariaLabel={t(confirmAsks ? 'tapConfirmBankAria' : 'tapConfirmAria')}
                />
                <p data-testid="order-last-step-cta" className="text-xs text-ink-soft text-center leading-relaxed">
                  {awaitingConfirmation
                    ? cancelHours
                      ? openHours && openHours < cancelHours
                        ? t('ctaOpenCancel', { open: openHours, cancel: cancelHours })
                        : t('ctaCancel', { cancel: cancelHours })
                      : t('ctaConfirmed')
                    : t('ctaWhy')}
                </p>
              </section>
            </div>
          ) : (
            <>
              <div className="w-14 h-14 rounded-full border border-gold text-gold-deep flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-7 h-7" strokeWidth={1.25} />
              </div>

              <div>
                <span className="label-caps text-gold-deep">{t(cardOver ? 'lblNotTaken' : paidByCard && !cardPaid ? 'lblReceived' : weCall ? 'lblReceived' : 'lblConfirmed')}</span>
                <h2 id="order-confirmed-title" className="font-serif text-3xl text-ink mt-2">
                  {t('thanks')}
                </h2>
                <p className="text-[13px] text-ink-soft mt-2 leading-relaxed">
                  {t('prepared')}
                </p>
              </div>

              {/* Confirm on WhatsApp (Settings → Store & contact): optional here (the order goes ahead either way). */}
              {askWhatsApp && <WhatsAppConfirm orderId={confirmedOrder.id} phone={confirmedOrder.customer.phone} check={confirmedOrder.whatsappCheck!} bankDetails={byTransfer} cancelHours={cancelHours} openHours={cancelHoursOf(confirmedOrder.createdAt, confirmedOrder.whatsappCheck?.openBy)} {...(confirmAsks ? { buttonLabel: t('confirmBankWa') } : {})} />}
            </>
          )}
          {confirmedOrder.photoOrder && (
            <p role="status" data-testid="photo-order-next" className="text-xs text-ink-soft bg-ivory border border-line rounded-xl px-3 py-2 text-start">
              {confirmedOrder.photoOrder.fixedPrice ? t('photoAgreed') : confirmedOrder.paymentMethod === 'online_card' ? t('photoCheckCard') : t('photoCheckAmount', { amount: formatAed(toFils(confirmedOrder.total)) })}
              {slots(t('photoShips'), { id: <span className="font-mono">{confirmedOrder.id}</span> })}
            </p>
          )}
          {weCall && (
            <p role="status" className="text-xs text-ink-soft bg-ivory border border-line rounded-xl px-3 py-2">
              {slots(t('weCall'), { phone: <span className="font-mono">{confirmedOrder.customer.phone}</span> })}
            </p>
          )}

          {/* Bank transfer "on request": one big button to ask for the details on the shop's WhatsApp
              (the confirmation's button above while it waits), or the support email without a number. */}
          {bankOnRequest && (
            <section aria-labelledby="transfer-ask" data-testid="bank-ask-section" className="rounded-2xl border border-line bg-ivory p-4 space-y-3 text-start">
              <h3 id="transfer-ask" className="text-sm font-semibold text-ink">{t('payingBank')}</h3>
              <p className="text-xs text-ink-soft leading-relaxed break-anywhere">
                {confirmAsks ? (
                  t('bankTapAbove')
                ) : askBankLink ? (
                  t('bankMessage')
                ) : supportEmail ? (
                  slots(t('bankEmail'), {
                    email: <a className="font-semibold text-ink underline" href={`mailto:${supportEmail}?subject=${encodeURIComponent(`Bank details for order ${confirmedOrder.id}`)}`}>{supportEmail}</a>,
                  })
                ) : (
                  slots(t('bankContact'), { phone: <span className="font-mono">{confirmedOrder.customer.phone}</span> })
                )}
              </p>
              {askBankLink && (
                <a
                  data-testid="bank-ask-whatsapp"
                  href={askBankLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full min-h-12 bg-whatsapp hover:brightness-110 text-paper font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
                >
                  <MessageCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
                  <span>{t('askBankWa')}</span>
                </a>
              )}
              {payPath && (
                <a
                  href={payPath}
                  target="_blank"
                  rel="noopener"
                  className="w-full min-h-11 border border-line-strong bg-surface hover:bg-sand text-ink font-semibold text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                >
                  <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{t('thenUpload')}</span>
                </a>
              )}
              <p className="text-[11px] text-ink-muted text-center">{slots(t('useRef'), { id: <span className="font-mono">{confirmedOrder.id}</span> })}</p>
            </section>
          )}

          {/* Bank transfer: the details come privately (email, WhatsApp, the order's own page), never on the website. */}
          {byTransfer && payPath && !bankOnRequest && (
            <section aria-labelledby="transfer-next" className="rounded-2xl border border-line bg-ivory p-4 space-y-3 text-start">
              <h3 id="transfer-next" className="text-sm font-semibold text-ink">{t('payingBank')}</h3>
              <p className="text-xs text-ink-soft leading-relaxed">
                {t('bankPrivate', { how: t(confirmedOrder.customer.email ? 'bankSentEmail' : 'bankSendWa') })}
              </p>
              <a
                href={payPath}
                target="_blank"
                rel="noopener"
                className="w-full min-h-12 bg-ink hover:bg-ink-2 text-ivory font-semibold text-sm py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
              >
                <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>{t('upload')}</span>
              </a>
              <p className="text-[11px] text-ink-muted text-center">{slots(t('useRef'), { id: <span className="font-mono">{confirmedOrder.id}</span> })}</p>
            </section>
          )}

          {/* Order Details Card */}
          <div className="bg-ivory rounded-2xl p-4 text-start border border-line space-y-2 text-xs">
            <div className="flex justify-between items-center pb-2 border-b border-line">
              <span className="text-ink-muted font-medium">{t('orderNumber')}</span>
              <span className="font-mono text-sm text-ink break-anywhere text-end">{confirmedOrder.id}</span>
            </div>

            <div className="flex justify-between items-center">
              <span className="text-ink-muted font-medium">{t('destination')}</span>
              <span className="text-ink text-end break-anywhere">{emirateName(confirmedOrder.customer.emirate)} ({confirmedOrder.customer.area})</span>
            </div>

            {confirmedOrder.customer.gpsCoordinates && (
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-ink-muted font-medium">{t('gps')}</span>
                <span className="font-mono text-success bg-success-soft px-2 py-0.5 rounded border border-success-line">
                  {confirmedOrder.customer.gpsCoordinates.lat.toFixed(4)}°N, {confirmedOrder.customer.gpsCoordinates.lng.toFixed(4)}°E
                </span>
              </div>
            )}

            <div className="flex justify-between items-center">
              <span className="text-ink-muted font-medium">{t('delivery')}</span>
              <span className="text-gold-deep flex items-center gap-1">
                <span>{confirmedOrder.deliveryOption === 'same_day' ? `${deliverySettings.sameDayName || t('sameDay')} (AED ${confirmedOrder.deliveryFee})` : `${deliverySettings.standardName || t('standard')}, ${confirmedOrder.courier.serviceability?.deliverySpeed || deliverySettings.standardDays}${confirmedOrder.deliveryFee ? ` (AED ${confirmedOrder.deliveryFee})` : ''}`}</span>
              </span>
            </div>


            <div className="flex justify-between items-center gap-3">
              <span className="text-ink-muted font-medium">{t('paymentMode')}</span>
              {paidByCard ? (
                <span data-testid="card-payment-status" role="status" aria-live="polite" className={`font-semibold text-end break-anywhere ${cardPaid ? 'text-success' : cardOver ? 'text-danger' : 'text-ink'}`}>
                  {cardPaid ? (
                    t('paidCard', { label: cardShown?.label ? ` · ${cardShown.label}` : '' })
                  ) : cardOver ? (
                    t('cardOver')
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> {t('confirming')}
                    </span>
                  )}
                </span>
              ) : (
                <span className="font-semibold text-ink capitalize">
                  {confirmedOrder.paymentMethod === 'cod' ? t('codTotal', { total: confirmedOrder.total }) : t('directBank')}
                </span>
              )}
            </div>

            {Boolean(confirmedOrder.cardFee) && (
              <div data-testid="confirmed-card-fee" className="flex justify-between items-center">
                <span className="text-ink-muted font-medium">{t('cardFee')}{confirmedOrder.cardFeePercent ? ` (${percentText(confirmedOrder.cardFeePercent)}%)` : ''}</span>
                <span className="text-ink">AED {formatAed(toFils(confirmedOrder.cardFee ?? 0))}</span>
              </div>
            )}

            {Boolean(confirmedOrder.vatAdded) && (
              <div data-testid="confirmed-vat" className="flex justify-between items-center">
                <span className="text-ink-muted font-medium">{t('vat')}</span>
                <span className="text-ink">AED {formatAed(toFils(confirmedOrder.vatAdded ?? 0))}</span>
              </div>
            )}

            <div className="flex justify-between items-center pt-2 border-t border-line">
              <span className="font-semibold text-ink">{t(cardPaid ? 'totalPaid' : 'totalPayable')}</span>
              <span className="font-semibold text-base text-ink">AED {formatAed(toFils(confirmedOrder.total))}</span>
            </div>
            {confirmedOrder.documentPath && (
              <a href={confirmedOrder.documentPath} target="_blank" rel="noopener noreferrer" data-testid="order-document-link" className="inline-flex min-h-11 items-center text-xs font-semibold text-ink underline">
                {confirmedOrder.documentLabel || t('receipt')}{t('printable')}
              </a>
            )}
          </div>

          </div>
          {/* WhatsApp Direct Notification, and Done: always on the screen */}
          <div className="shrink-0 border-t border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] flex flex-col sm:flex-row gap-2">
            {/* The shop's WhatsApp number from Settings → Store & contact (hidden when none is set). */}
            {/* Not for a bank transfer "on request": its own WhatsApp button above is the one to tap. */}
            {shopWhatsApp && !askWhatsApp && !bankOnRequest && (
              <a
                href={`https://wa.me/${shopWhatsApp}?text=${whatsappMessage}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 bg-whatsapp hover:brightness-110 text-paper font-medium text-xs py-3 px-4 rounded-xl flex items-center justify-center gap-2 transition-all"
              >
                <MessageCircle className="w-4 h-4" />
                <span>{t('sendWaUpdate')}</span>
              </a>
            )}

            <button
              onClick={onClose}
              className="bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.04em] text-sm py-3 px-6 rounded-xl transition-colors"
            >
              {t('done')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-scrim/45 p-0 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <div className="bg-surface text-ink w-full max-w-xl sm:rounded-3xl h-[100dvh] sm:h-auto sm:max-h-[92dvh] flex flex-col overflow-hidden border border-line pt-safe sm:pt-0 sheet-up sm:[animation-name:sheet-fade]">
        
        {/* Header */}
        <div className="shrink-0 px-4 py-3 border-b border-line flex items-center justify-between gap-3 bg-surface">
          <div className="min-w-0">
            <h2 id="checkout-title" className="font-serif text-2xl text-ink leading-tight">
              {t('checkout')}
            </h2>
            <p className="text-[11px] text-ink-muted tracking-[0.02em]">
              {t('headerSub', { standard: deliverySettings.standardName || t('standard'), pays: t(card ? 'paysCard' : 'paysCod') })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('closeCheckout')}
            className="shrink-0 w-10 h-10 -me-1.5 flex items-center justify-center text-ink rounded-full hover:bg-sand transition-colors"
          >
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>

        {/* Scrollable Form */}
        <form onSubmit={handleSubmitOrder} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-6">
          {/* Order Summary Strip */}
          <div className="bg-ivory rounded-2xl p-3 border border-line flex items-center justify-between text-xs">
            {photoOrder ? (
              <div data-testid="checkout-photo-summary" className="min-w-0">
                <span className="font-semibold text-ink">{t(photoOrder.deal ? 'yourOrder' : 'yourPhotoOrder')}</span>
                <div className="text-[10px] text-ink-soft mt-0.5 break-anywhere">
                  {photoOrder.deal ? t('fixedPrice') : `${photoOrder.photos.length} ${t(photoOrder.photos.length === 1 ? 'photo' : 'photos')} · `}{photoOrder.pieces} {t(photoOrder.pieces === 1 ? 'piece' : 'pieces')}
                  {photoOrder.note ? ` · ${photoOrder.note.length > 60 ? `${photoOrder.note.slice(0, 59)}…` : photoOrder.note}` : ''}
                </div>
              </div>
            ) : (
            <div>
              <span className="font-semibold text-ink">{t(items.length === 1 ? 'bagItem' : 'bagItems', { n: items.length })}</span>
              <div className="text-[10px] text-ink-soft mt-0.5">
                {items.map((i) => `${i.quantity}x ${i.product.productType === 'simple' ? i.selectedProfile.name : i.selectedProfile.name.split(' ')[0]}`).join(' • ')}
              </div>
            </div>
            )}
            <div className="text-end">
              {byCard && cardFee > 0 && (
                <span data-testid="card-fee-line" className="text-[11px] text-ink-soft block">
                  {t('feeLine', { p: percentText(feePercent), x: formatAed(cardFee) })}
                </span>
              )}
              {shownVatFils > 0 && (
                <span data-testid="vat-line" className="text-[11px] text-ink-soft block">
                  {t('vatLine', { p: percentText(vatAddedPercent), x: formatAed(shownVatFils) })}
                </span>
              )}
              <span className="text-[10px] text-ink-muted block">{t('totalDue')}</span>
              <span id="checkout-total" className="text-base font-semibold text-ink">AED {grandTotal}</span>
              {sameDayChosen && <span className="text-[10px] text-ink-muted block">{t('inclSameDay', { x: formatAed(deliveryFils) })}</span>}
            </div>
          </div>

          {/* Apple Pay / Google Pay / Link: the wallet fills in name, phone and address (only with card payments on) */}
          {card && (
            <ExpressCheckout
              publishableKey={card.publishableKey}
              amountFils={cardTotalFils}
              shippingRate={sameDayChosen ? { id: 'same_day', displayName: delivery.sameDay.name, amount: deliveryFils } : { id: 'standard', displayName: t('nameIn', { name: delivery.standard.name, days: deliverySettings.standardDays }), amount: deliveryFils }}
              lineItems={cardFee > 0 || cardVatFils > 0 ? [{ name: t('items'), amount: totalFils - deliveryFils }, ...(cardFee > 0 ? [{ name: t('cardFeeP', { p: percentText(feePercent) }), amount: cardFee }] : []), ...(cardVatFils > 0 ? [{ name: t('vatP', { p: percentText(vatAddedPercent) }), amount: cardVatFils }] : [])] : undefined}
              servesEmirate={(state, city) => {
                const em = emirateFrom(state) ?? emirateFrom(city);
                return !em || deliverySettings.emirates.includes(em);
              }}
              onWallet={payFromWallet}
              onDone={(r) => void cardFinished(r)}
            />
          )}
          {walletNotice && (
            <p role="alert" className="text-[11px] p-2.5 rounded-xl border bg-warning-soft text-warning border-warning-line font-semibold">
              {walletNotice}
            </p>
          )}

          {/* Section 1: Contact Details & Customer OTP Verification */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-line pb-1.5">
              <h3 className="label-caps text-ink flex items-center gap-1.5">
                <span>{t('s1')}</span>
              </h3>
              {whatsappCheck ? null : byCard && !cardNeedsCode && !isPhoneVerified ? (
                <span className="text-[10px] text-ink-soft bg-sand px-2 py-0.5 rounded-full border border-line">{t('cardNoSms')}</span>
              ) : isPhoneVerified ? (
                <span className="text-[10px] font-semibold text-success bg-success-soft px-2.5 py-0.5 rounded-full flex items-center gap-1 border border-success-line">
                  <Check className="w-3 h-3 text-success" />
                  <span>{t('mobileVerified')}</span>
                </span>
              ) : (
                <span className="text-[10px] text-warning bg-warning-soft px-2 py-0.5 rounded-full border border-warning-line">
                  {t('mobileVerification')}
                </span>
              )}
            </div>

            {hasSavedDetails && (
              <p className="text-[11px] text-ink-muted">
                {t('savedDetails')}{' '}
                <button type="button" className="underline font-semibold" onClick={forgetDetails}>
                  {t('notYou')}
                </button>
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-ink font-semibold mb-1">
                  {t('fullName')} <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder={t('namePh')}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <PhoneVerification
                supportEmail={supportEmail}
                verification={phoneVerification}
                codeOptional={byCard && !cardNeedsCode}
                whatsapp={whatsappCheck}
                phone={phone}
                onPhoneChange={setPhone}
                verified={isPhoneVerified}
                onVerifiedChange={(verified, token) => {
                  setIsPhoneVerified(verified);
                  setPhoneToken(verified ? token || '' : '');
                }}
                orderSummary={items
                  .map((i) => `- ${i.quantity} x ${productTitle(i.product, locale)} (${[i.selectedProfile.name, i.selectedColor].filter(Boolean).join(', ')})`)
                  .join('\n')}
              />

              <div className="sm:col-span-2">
                <label htmlFor="checkout-email" className="block text-ink font-semibold mb-1">
                  {t('email')} <span className="text-gold-deep font-semibold">{t('recommended')}</span>
                </label>
                <input
                  id="checkout-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="name@domain.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-describedby="checkout-email-why"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-base sm:text-xs"
                />
                <p id="checkout-email-why" className="text-[11px] text-ink-muted mt-1 leading-relaxed">
                  {t('emailWhy')}
                </p>
              </div>
            </div>
          </div>

          {/* Section 2: UAE Delivery Address with GPS Pin Drop & Map Selector */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-1.5">
              <h3 className="label-caps text-ink flex items-center gap-1.5">
                <span>{t('s2')}</span>
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUseCurrentLocation}
                  disabled={isLocating}
                  className="text-[11px] font-semibold text-ink bg-warning-soft hover:bg-warning-line border border-warning-line px-2.5 py-1 rounded-lg flex items-center gap-1 whitespace-nowrap transition-colors"
                >
                  <Navigation className={`w-3 h-3 text-warning ${isLocating ? 'animate-spin' : ''}`} />
                  <span>{t(isLocating ? 'locating' : 'useGps')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowMapPicker(!showMapPicker)}
                  className="text-[11px] font-semibold text-ink bg-surface hover:bg-sand border border-line-strong px-2.5 py-1 rounded-lg flex items-center gap-1 whitespace-nowrap transition-colors"
                >
                  <MapPin className="w-3 h-3 text-gold" />
                  <span>{t(showMapPicker ? 'closeMap' : 'dropPin')}</span>
                </button>
              </div>
            </div>

            {/* GPS Location Notice Pill */}
            {locationNotice && (
              <div role="status" className={`text-[11px] p-2.5 rounded-xl border ${locationProblem ? 'bg-warning-soft text-warning border-warning-line' : 'bg-success-soft text-success border-success-line'}`}>
                <span className="font-semibold">{locationNotice}</span>
              </div>
            )}

            {/* INTERACTIVE UAE MAP PIN DROP SELECTOR */}
            {showMapPicker && (
              <div className="bg-gradient-to-b from-ivory to-sand p-3.5 rounded-2xl border border-line-strong space-y-3 animate-in fade-in-50 text-xs">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Crosshair className="w-4 h-4 text-gold" />
                    <strong className="text-ink text-xs">{t('pinSelector')}</strong>
                  </div>
                  <span className="text-[11px] text-ink-soft">{t('tapCommunity')}</span>
                </div>

                <input
                  type="search"
                  aria-label={t('searchCommunities')}
                  placeholder={t('searchPh')}
                  value={pinQuery}
                  onChange={(e) => setPinQuery(e.target.value)}
                  onKeyDown={(e) => {
                    // Escape clears the search first; a second Escape closes checkout.
                    if (e.key === 'Escape' && pinQuery) e.stopPropagation();
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold text-xs"
                />

                {/* Quick Presets for Popular UAE Communities */}
                <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto p-1 bg-surface rounded-xl border border-line">
                  {pinMatches.length === 0 && (
                    <p className="p-1.5 text-[11px] text-ink-soft">{t('noPin')}</p>
                  )}
                  {pinMatches.map((loc) => {
                    const isSelected = area === loc.name;
                    return (
                      <button
                        key={`${loc.emirate}|${loc.name}`}
                        type="button"
                        onClick={() => handleSelectMapLocation(loc)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1 ${
                          isSelected
                            ? 'bg-ink text-paper '
                            : 'bg-ivory text-ink-soft hover:bg-warning-soft hover:text-warning border border-line'
                        }`}
                      >
                        <MapPin className={`w-3 h-3 ${isSelected ? 'text-gold-light' : 'text-gold'}`} />
                        <span>{loc.name}</span>
                        <span className="text-[10px]">({emirateName(loc.emirate)})</span>
                      </button>
                    );
                  })}
                </div>

                {/* Visual UAE Coordinate Display */}
                <div className="bg-surface p-2.5 rounded-xl border border-line flex items-center justify-between text-[11px]">
                  <span className="text-ink-muted font-medium">{t('selectedGps')}</span>
                  <span className="font-mono font-semibold text-ink">
                    {gpsCoordinates
                      ? `${gpsCoordinates.lat.toFixed(4)}°N, ${gpsCoordinates.lng.toFixed(4)}°E`
                      : t('noneYet')}
                  </span>
                </div>
              </div>
            )}

            {/* Address Input Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label htmlFor="checkout-emirate" className="block text-ink font-semibold mb-1">
                  {t('emirate')} <span className="text-danger">*</span>
                </label>
                <select
                  id="checkout-emirate"
                  value={emirate}
                  onChange={(e) => {
                    setEmirate(e.target.value as Emirate);
                    setAreaNote('');
                  }}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                >
                  {UAE_EMIRATES.map((em) => (
                    <option key={em} value={em}>
                      {emirateName(em)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="checkout-area" className="block text-ink font-semibold mb-1">
                  {t('area')} <span className="text-danger">*</span>
                </label>
                <AreaCombobox
                  id="checkout-area"
                  required
                  emirate={emirate}
                  placeholder={t('areaPh')}
                  value={area}
                  onChange={(text) => {
                    setArea(text);
                    setAreaNote('');
                  }}
                  onPick={handlePickArea}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
                {areaNote && (
                  <p role="status" className="mt-1 text-[11px] text-ink-soft">
                    {areaNote}
                  </p>
                )}
              </div>

              <div className="sm:col-span-2">
                <label className="block text-ink font-semibold mb-1">
                  {t('street')} <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder={t('streetPh')}
                  value={streetAddress}
                  onChange={(e) => setStreetAddress(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <div>
                <label className="block text-ink font-semibold mb-1">
                  {t('building')} <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder={t('buildingPh')}
                  value={buildingVilla}
                  onChange={(e) => setBuildingVilla(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <div>
                <label className="block text-ink font-semibold mb-1">
                  {t('flat')} <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder={t('flatPh')}
                  value={flatVillaNo}
                  onChange={(e) => setFlatVillaNo(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-ink font-semibold mb-1">
                  {t('landmark')} <span className="text-ink-muted font-normal">{t('landmarkWhy')}</span>
                </label>
                <input
                  type="text"
                  placeholder={t('landmarkPh')}
                  value={landmark}
                  onChange={(e) => setLandmark(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted font-medium focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
                />
              </div>
            </div>

            {/* Delivery: from the address; the courier is chosen behind the scenes */}
            <div className={`p-3.5 rounded-2xl border text-xs space-y-2.5 ${delivery.serviceable ? 'bg-success-soft/80 border-success-line' : 'bg-danger-soft border-danger-line'}`} role="status" aria-live="polite">
              <div className="flex items-center gap-2">
                {delivery.serviceable ? (
                  <span className="w-6 h-6 rounded-full bg-success text-paper flex items-center justify-center shrink-0"><Check className="w-4 h-4" /></span>
                ) : (
                  <AlertCircle className="w-5 h-5 text-danger shrink-0" />
                )}
                <div>
                  <div className={`font-semibold ${delivery.serviceable ? 'text-success' : 'text-danger'}`}>{delivery.message}</div>
                  {delivery.serviceable && <div className="text-ink-soft">{t('nameIn', { name: delivery.standard.name, days: delivery.days })}{photoOrder?.deal ? t('inclPrice') : photoOrder ? t('inclAgreed') : standardFils > 0 ? ` · AED ${formatAed(standardFils)}` : ''}</div>}
                </div>
              </div>
              {delivery.serviceable && deliverySettings.sameDayEnabled && !photoOrder?.deal && (
                <fieldset className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  <legend className="sr-only">{t('speed')}</legend>
                  <label className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer ${!sameDayChosen ? 'border-ink bg-surface' : 'border-line bg-surface/60'}`}>
                    <input type="radio" name="delivery-option" className="mt-0.5" checked={!sameDayChosen} onChange={() => setDeliveryOption('standard')} />
                    <span>
                      <strong className="block text-ink">{delivery.standard.name}{photoOrder ? t('included') : standardFils > 0 ? ` · AED ${formatAed(standardFils)}` : ''}</strong>
                      <span className="text-ink-muted">{delivery.days}</span>
                    </span>
                  </label>
                  <label className={`flex items-start gap-2 p-2.5 rounded-xl border ${delivery.sameDay.available ? 'cursor-pointer' : 'opacity-60'} ${sameDayChosen ? 'border-ink bg-surface' : 'border-line bg-surface/60'}`}>
                    <input type="radio" name="delivery-option" className="mt-0.5" checked={sameDayChosen} disabled={!delivery.sameDay.available} onChange={() => setDeliveryOption('same_day')} />
                    <span>
                      <strong className="block text-ink">{delivery.sameDay.name} · {standardFils > 0 ? '' : '+'}AED {formatAed(toFils(delivery.sameDay.fee))}</strong>
                      <span className="text-ink-muted">{delivery.sameDay.available ? t('orderBefore', { cutoff: delivery.sameDay.cutoff }) : delivery.sameDay.reason}</span>
                    </span>
                  </label>
                </fieldset>
              )}
            </div>
          </div>

          {/* Section 3: Payment Method Selection */}
          <div className="space-y-3">
            <h3 className="label-caps text-ink flex items-center gap-1.5 border-b border-line pb-2">
              <span>{t('s3')}</span>
            </h3>

            <div role="radiogroup" aria-label={t('payment')} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Option 1: Cash On Delivery */}
              {codOffered && <button
                type="button"
                role="radio"
                aria-checked={paymentMethod === 'cod'}
                onClick={() => setPaymentMethod('cod')}
                className={`text-start p-3.5 rounded-2xl border transition-colors min-w-0 ${
                  paymentMethod === 'cod'
                    ? 'border-ink bg-ivory ring-1 ring-ink text-ink'
                    : 'border-line bg-surface text-ink hover:border-line-strong'
                }`}
              >
                <span className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <Banknote className="w-5 h-5 shrink-0 text-gold-deep" strokeWidth={1.5} />
                    <span className="text-sm">{t('cod')}</span>
                  </span>
                  {paymentMethod === 'cod' && <Check className="w-4 h-4 shrink-0 text-ink" />}
                </span>
                <span className="block text-[11px] leading-relaxed text-ink-soft">
                  {t('codText')}
                </span>
              </button>}

              {/* Option 2: Bank transfer (only once the shop's real account is entered) */}
              {bankReady && <button
                type="button"
                role="radio"
                aria-checked={paymentMethod === 'bank_transfer'}
                onClick={() => setPaymentMethod('bank_transfer')}
                className={`text-start p-3.5 rounded-2xl border transition-colors min-w-0 ${
                  paymentMethod === 'bank_transfer'
                    ? 'border-ink bg-ivory ring-1 ring-ink text-ink'
                    : 'border-line bg-surface text-ink hover:border-line-strong'
                }`}
              >
                <span className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <Building2 className="w-5 h-5 shrink-0 text-gold-deep" strokeWidth={1.5} />
                    <span className="text-sm">{t('bank')}</span>
                  </span>
                  {paymentMethod === 'bank_transfer' && <Check className="w-4 h-4 shrink-0 text-ink" />}
                </span>
                <span data-testid="bank-option-text" className="block text-[11px] leading-relaxed text-ink-soft break-anywhere">
                  {t(bankAskWhatsApp ? 'bankAskText' : 'bankText')}
                </span>
              </button>}

              {/* Option 3: Card through Stripe (only when switched on in Settings → Payments) */}
              {card && cardOffered && <button
                type="button"
                role="radio"
                aria-checked={paymentMethod === 'online_card'}
                onClick={() => setPaymentMethod('online_card')}
                className={`text-start p-3.5 rounded-2xl border transition-colors min-w-0 ${
                  paymentMethod === 'online_card'
                    ? 'border-ink bg-ivory ring-1 ring-ink text-ink'
                    : 'border-line bg-surface text-ink hover:border-line-strong'
                }`}
              >
                <span className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="flex items-center gap-2 min-w-0">
                    <CreditCard className="w-5 h-5 shrink-0 text-gold-deep" strokeWidth={1.5} />
                    <span className="text-sm">{t('card')}</span>
                  </span>
                  {paymentMethod === 'online_card' && <Check className="w-4 h-4 shrink-0 text-ink" />}
                </span>
                <span className="block text-[11px] leading-relaxed text-ink-soft">
                  {t('cardText')}{card.phoneCheck ? '' : t('noSms')}
                  {cardFeeFils(10000, feePercent) > 0 ? t('cardFeeApplies', { p: percentText(feePercent) }) : ''}
                </span>
              </button>}
            </div>

            {/* Card: Stripe's own fields (the number never touches this shop) */}
            {byCard && card && cardOffered && (
              <div className="rounded-2xl border border-line bg-surface p-3 min-w-0">
                <CardFields publishableKey={card.publishableKey} amountFils={cardTotalFils} onReady={onCardReady} />
                <p className="mt-2 text-[10px] text-ink-muted flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-gold" aria-hidden="true" /> {t('secured')}
                </p>
              </div>
            )}

            {/* Bank transfer: the account is never shown on the website; it is sent privately after the order. */}
            {paymentMethod === 'bank_transfer' && bankReady && (
              <div data-testid="bank-transfer-note" className="bg-ivory rounded-2xl p-4 border border-line space-y-1.5 animate-in fade-in-50 text-xs">
                <p className="font-semibold text-ink flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 shrink-0 text-gold" aria-hidden="true" />
                  <span>{t('howBankWorks')}</span>
                </p>
                {bankAskWhatsApp ? (
                  <p className="text-ink-soft leading-relaxed">
                    {t('bankHowAsk')}
                  </p>
                ) : (
                  <>
                    <p className="text-ink-soft leading-relaxed">
                      {t('bankHow')}
                    </p>
                    {!email && <p className="text-[11px] text-ink-muted leading-relaxed">{t('addEmail')}</p>}
                  </>
                )}
              </div>
            )}
          </div>

          </div>
          {/* The order button: always on the screen, above the keyboard and the home bar */}
          <div className="shrink-0 border-t border-line bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-1.5">
            {submitError && (
              <p role="alert" className="text-[11px] text-danger bg-danger-soft border border-danger-line rounded-lg px-2.5 py-1.5 font-medium">
                {submitError}
              </p>
            )}
            {cardCheck && (
              <button
                type="button"
                onClick={() => void checkCardAgain()}
                disabled={checkingCard}
                className="w-full text-xs font-semibold text-ink border border-line-strong bg-surface hover:bg-sand rounded-xl py-2 disabled:opacity-60"
              >
                {t(checkingCard ? 'checkingStripe' : 'checkAgain')}
              </button>
            )}
            <p data-testid="checkout-terms" className="text-[10px] text-center text-ink-muted">
              {slots(t('terms'), {
                link: (
                  <a href="/terms" target="_blank" rel="noopener" className="underline font-semibold text-ink-soft">
                    {t('termsLink')}
                  </a>
                ),
              })}
            </p>
            <button
              type="submit"
              disabled={isSubmitting || !delivery.serviceable || (byCard ? !cardReady || (cardNeedsCode && !isPhoneVerified) : !phoneReady)}
              className="w-full bg-ink hover:bg-ink-2 text-ivory font-medium tracking-[0.03em] text-sm py-3.5 px-3 rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50 text-center"
            >
              {isSubmitting ? (
                <span>{t(byCard ? 'payingSecurely' : 'placing')}</span>
              ) : byCard ? (
                <>
                  <CreditCard className="w-4 h-4 text-gold-light" />
                  <span>{t('payAed', { total: grandTotal })}</span>
                </>
              ) : !phoneReady ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-gold-light" />
                  <span>{t(whatsappCheck ? 'enterToPlace' : 'verifyToPlace')}</span>
                </>
              ) : (
                <>
                  <span>
                    {t('placeOrder', { total: grandTotal })}
                  </span>
                  <ArrowRight className="w-4 h-4 text-gold-light rtl:-scale-x-100" aria-hidden="true" />
                </>
              )}
            </button>
            <p className="text-[10px] text-center text-ink-muted">
              {t('deliveredDoor')}
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};
