/**
 * The shop's Terms & Conditions (asked by the owner: "the standard rules to protect my business from
 * every aspect possible… we don't accept returns as these are personalised products and hygiene is
 * of prime importance"), in English and UAE Arabic.
 *
 * Written to protect the business as far as UAE law allows: no returns or exchanges for change of
 * mind (personal, hygiene-sensitive and made-to-order goods), with the narrow, time-limited remedy for
 * faulty, damaged or wrong items that the UAE Consumer Protection Law (Federal Law No. 15 of 2020)
 * does not let a seller exclude; a clause the law forbids would weaken the rest. Not legal advice:
 * the owner should have a UAE lawyer review it. The seller's details come from Settings.
 *
 * {legal}, {licence}, {address}, {contact}, {site} are filled in by the page.
 */

export interface TermsSection {
  id: string;
  title: { en: string; ar: string };
  body: { en: string[]; ar: string[] };
}

export const TERMS_UPDATED = '2026-11-05';

export const TERMS: TermsSection[] = [
  {
    id: 'who',
    title: { en: '1. Who we are', ar: '١. من نحن' },
    body: {
      en: [
        'This shop is run by {legal}{licence}{address}. You can reach us at {contact}.',
        'These Terms apply to every order placed with us: on {site}, through a private order or deal link we send you, or arranged with us on WhatsApp or Instagram.',
      ],
      ar: [
        'يدير هذا المتجر {legal}{licence}{address}. يمكنك التواصل معنا عبر {contact}.',
        'تسري هذه الشروط على كل طلب يُقدَّم لدينا: عبر {site}، أو عبر رابط طلب أو عرض خاص نرسله إليك، أو بالاتفاق معنا عبر واتساب أو إنستغرام.',
      ],
    },
  },
  {
    id: 'agreement',
    title: { en: '2. Agreeing to these Terms', ar: '٢. الموافقة على هذه الشروط' },
    body: {
      en: [
        'By placing an order you confirm that you have read and accept these Terms, that you are at least 18 years old (or order with a parent’s or guardian’s consent), and that the details you give us (name, mobile number, address, email) are true and yours to give.',
        'We may update these Terms from time to time. The version shown on this page when you place your order applies to that order.',
      ],
      ar: [
        'بإتمام طلبك فإنك تؤكد أنك قرأت هذه الشروط ووافقت عليها، وأن عمرك ١٨ عاماً على الأقل (أو أنك تطلب بموافقة ولي أمرك)، وأن البيانات التي تقدمها (الاسم ورقم الجوال والعنوان والبريد الإلكتروني) صحيحة ويحق لك تقديمها.',
        'قد نحدّث هذه الشروط من وقت لآخر، وتسري على طلبك النسخة المنشورة في هذه الصفحة وقت تقديمه.',
      ],
    },
  },
  {
    id: 'products',
    title: { en: '3. Our products', ar: '٣. منتجاتنا' },
    body: {
      en: [
        'Many of our pieces are hand block-printed or finished by hand. Small differences in colour, print placement, line sharpness, texture and shade between pieces, and between a piece and its photos, are the nature of handcraft and are not defects.',
        'Colours look different on different screens and in different light. Measurements are given in good faith and may vary by about 2–3 cm; please check your mattress size and depth before ordering.',
        'Some photos are styled pictures (for example a piece shown on a bed in a bedroom) to help you imagine it at home; the piece you receive is the one named and described, in the size you choose. Bedding, props and furniture shown around it are not included unless the description says so.',
        'Stock is limited and many designs are one of a kind. If a piece turns out to be unavailable after you order, we will tell you and refund anything you have paid for it, or offer you an alternative.',
      ],
      ar: [
        'كثير من قطعنا مطبوعة يدوياً بالقوالب الخشبية أو مُشطّبة يدوياً، لذا فإن الفروقات البسيطة في اللون وموضع الطبعة ودقة الخطوط والملمس والدرجة بين قطعة وأخرى، أو بين القطعة وصورها، هي من طبيعة العمل اليدوي ولا تُعدّ عيباً.',
        'تختلف الألوان بين الشاشات وباختلاف الإضاءة. نذكر المقاسات بحسن نية وقد تختلف بنحو ٢–٣ سم، لذا يُرجى التأكد من مقاس المرتبة وعمقها قبل الطلب.',
        'بعض الصور منسّقة (مثل عرض القطعة على سرير في غرفة نوم) لمساعدتك على تخيّلها في منزلك، والقطعة التي تستلمها هي المذكورة باسمها ووصفها وبالمقاس الذي تختاره. ولا تشمل القطعة ما يظهر حولها من مفارش أو إكسسوارات أو أثاث ما لم يُذكر ذلك في الوصف.',
        'الكميات محدودة وكثير من التصاميم فريدة. إذا تبيّن بعد طلبك أن القطعة غير متوفرة فسنبلغك ونردّ لك ما دفعته مقابلها، أو نعرض عليك بديلاً.',
      ],
    },
  },
  {
    id: 'prices',
    title: { en: '4. Prices and payment', ar: '٤. الأسعار والدفع' },
    body: {
      en: [
        'Prices are in UAE dirhams (AED). The total you pay is the one shown at checkout (or in your deal link), including any delivery charge, cash-on-delivery or card fee shown there. Where VAT applies it is shown separately.',
        'If a price is shown wrongly because of an obvious error, we may cancel the order (even after confirming it) and refund anything you paid, or offer you the piece at the correct price.',
        'You can pay by cash on delivery (the exact amount to the courier), by bank transfer (we prepare your order once the money has reached our account) or by card through Stripe (your card details go to Stripe, never to us). We will never ask for your card details on WhatsApp, by phone or by email.',
        'If you dispute a card payment with your bank for an order we delivered as described, we will share the delivery records with the bank, and we may decline future orders.',
      ],
      ar: [
        'الأسعار بالدرهم الإماراتي (AED). المبلغ الذي تدفعه هو المعروض عند إتمام الطلب (أو في رابط العرض الخاص بك)، بما في ذلك أي رسوم توصيل أو رسوم دفع عند الاستلام أو رسوم بطاقة تظهر هناك. وتُعرض ضريبة القيمة المضافة بشكل منفصل عند تطبيقها.',
        'إذا ظهر سعر خاطئ بسبب خطأ واضح، فيحق لنا إلغاء الطلب (حتى بعد تأكيده) ورد ما دفعته، أو عرض القطعة عليك بالسعر الصحيح.',
        'يمكنك الدفع نقداً عند الاستلام (المبلغ المحدد للمندوب)، أو بالتحويل البنكي (نجهّز طلبك بعد وصول المبلغ إلى حسابنا)، أو بالبطاقة عبر Stripe (تذهب بيانات بطاقتك إلى Stripe ولا تصل إلينا أبداً). لن نطلب منك بيانات بطاقتك أبداً عبر واتساب أو الهاتف أو البريد الإلكتروني.',
        'إذا اعترضت لدى بنكك على دفعة بالبطاقة لطلب سلّمناه كما هو موصوف، فسنقدّم سجلات التوصيل إلى البنك، ويحق لنا رفض طلباتك المستقبلية.',
      ],
    },
  },
  {
    id: 'orders',
    title: { en: '5. Your order and our confirmation', ar: '٥. طلبك وتأكيدنا له' },
    body: {
      en: [
        'Placing an order is an offer to buy. A contract is made when we confirm your order (on WhatsApp, by phone, by email, or by sending it to the courier). Orders that ask you to confirm on WhatsApp and are not confirmed in the time shown are cancelled automatically.',
        'We may decline or cancel an order, and refund anything paid, for example if a piece is unavailable, the address cannot be served, details are incomplete or appear false, or an order looks fraudulent or abusive (including repeated refusal of cash-on-delivery parcels).',
        'If you ask us to change a confirmed order (an extra piece, another size), the new total is agreed with you before dispatch. With your agreement, money already paid on a cancelled order can be applied to another of your orders instead of being refunded.',
      ],
      ar: [
        'تقديم الطلب هو عرض للشراء، ويُبرم العقد عند تأكيدنا للطلب (عبر واتساب أو الهاتف أو البريد الإلكتروني أو بتسليمه إلى شركة الشحن). والطلبات التي تتطلب تأكيدك عبر واتساب ولا تُؤكَّد خلال المدة المعروضة تُلغى تلقائياً.',
        'يحق لنا رفض أي طلب أو إلغاؤه مع رد ما دُفع، كأن تكون القطعة غير متوفرة، أو يتعذر التوصيل إلى العنوان، أو تكون البيانات ناقصة أو غير صحيحة، أو يبدو الطلب احتيالياً أو مسيئاً (ومن ذلك تكرار رفض استلام طلبات الدفع عند الاستلام).',
        'إذا طلبت تعديل طلب مؤكَّد (قطعة إضافية أو مقاس آخر) فنتفق معك على المبلغ الجديد قبل الشحن. ويمكن، بموافقتك، احتساب مبلغ مدفوع على طلب مُلغى لصالح طلب آخر لك بدلاً من ردّه.',
      ],
    },
  },
  {
    id: 'custom',
    title: { en: '6. Personalised and made-to-order pieces', ar: '٦. القطع المخصّصة والمصنوعة حسب الطلب' },
    body: {
      en: [
        'Pieces we arrange or make specially for you (an order from your photo, a private deal link, a custom size or set) are prepared for you alone. Once you have confirmed such an order it cannot be cancelled or changed, and the price agreed is final.',
      ],
      ar: [
        'القطع التي نجهّزها أو نصنعها خصيصاً لك (طلب من صورتك، أو رابط عرض خاص، أو مقاس أو طقم مخصّص) تُعدّ لك وحدك، ولا يمكن إلغاؤها أو تعديلها بعد تأكيدك للطلب، ويكون السعر المتفق عليه نهائياً.',
      ],
    },
  },
  {
    id: 'delivery',
    title: { en: '7. Delivery', ar: '٧. التوصيل' },
    body: {
      en: [
        'We deliver across the seven emirates through courier partners. Delivery times (for example 1–2 working days, or same day where offered) are estimates; we are not responsible for delays caused by the courier, weather, public holidays, road closures or events outside our control, but we will help you follow your parcel.',
        'Please give a complete address and a mobile number that can be reached. If delivery fails because of a wrong address, an unreachable number or refusal, we may charge the cost of delivering again, and a cash-on-delivery order that is refused without a valid reason (a damaged or wrong piece) may mean we no longer offer you cash on delivery.',
        'Please check the outside of your parcel when it arrives and tell the courier and us at once about any visible damage. The parcel is your responsibility once it has been delivered to your address or to the person who receives it there.',
      ],
      ar: [
        'نوصل إلى الإمارات السبع عبر شركات الشحن الشريكة. مدد التوصيل (مثل يوم إلى يومي عمل، أو في اليوم نفسه حيث يتوفر ذلك) تقديرية، ولسنا مسؤولين عن التأخير الناتج عن شركة الشحن أو الطقس أو العطل الرسمية أو إغلاق الطرق أو أي ظروف خارجة عن إرادتنا، لكننا سنساعدك على تتبع شحنتك.',
        'يُرجى تقديم عنوان كامل ورقم جوال يمكن الوصول إليه. إذا تعذّر التوصيل بسبب عنوان خاطئ أو رقم لا يرد أو رفض الاستلام، فيحق لنا احتساب تكلفة إعادة التوصيل، وقد يؤدي رفض طلب الدفع عند الاستلام دون سبب مقبول (قطعة تالفة أو خاطئة) إلى عدم إتاحة الدفع عند الاستلام لك مستقبلاً.',
        'يُرجى فحص الطرد من الخارج عند وصوله وإبلاغ المندوب وإبلاغنا فوراً بأي تلف ظاهر. وتنتقل مسؤولية الطرد إليك بمجرد تسليمه إلى عنوانك أو إلى الشخص الذي يستلمه هناك.',
      ],
    },
  },
  {
    id: 'returns',
    title: { en: '8. No returns or exchanges', ar: '٨. لا إرجاع ولا استبدال' },
    body: {
      en: [
        'Bed linen is a personal, hygiene-sensitive product, and many of our pieces are personalised or made to order. For the health and safety of every customer, we do not accept returns, exchanges or refunds for change of mind, a size or colour ordered by mistake, a different expectation of colour or print, or once the packaging has been opened, the piece has been used, washed or altered, or its tags have been removed.',
        'This does not affect your rights for a damaged, faulty or wrong piece, set out in section 9.',
      ],
      ar: [
        'مفارش الأسرّة منتجات شخصية ترتبط بالنظافة الصحية، وكثير من قطعنا مخصّصة أو مصنوعة حسب الطلب. وحرصاً على صحة وسلامة جميع عملائنا، لا نقبل الإرجاع أو الاستبدال أو استرداد المبلغ بسبب تغيير الرأي، أو طلب مقاس أو لون عن طريق الخطأ، أو اختلاف التوقعات بشأن اللون أو الطبعة، أو بعد فتح التغليف، أو استخدام القطعة أو غسلها أو تعديلها، أو إزالة بطاقاتها.',
        'لا يؤثر ذلك على حقوقك في حال استلام قطعة تالفة أو معيبة أو خاطئة، وفق ما يرد في البند ٩.',
      ],
    },
  },
  {
    id: 'faulty',
    title: { en: '9. A damaged, faulty or wrong piece', ar: '٩. القطعة التالفة أو المعيبة أو الخاطئة' },
    body: {
      en: [
        'If a piece arrives damaged, faulty or different from what you ordered, tell us within 48 hours of delivery on WhatsApp or by email, with your order number, clear photos of the piece and the label, and, where you can, a video of opening the parcel. Keep the piece unused and unwashed in its original packaging with its tags.',
        'We will look at it (we may arrange for it to be collected) and, if the fault is confirmed, replace it with the same or an equivalent piece or refund its price and its delivery charge. A refund goes back the way you paid: to your card (banks usually take 5–10 working days to show it) or, for cash on delivery, by bank transfer to an account in your name, within 14 days of our confirming it.',
        'Not covered: the natural differences of handcraft described in section 3; wear; damage from misuse, washing or ironing against the care label, alterations or accidents; stains or marks after use; and a size or colour chosen by mistake.',
      ],
      ar: [
        'إذا وصلتك قطعة تالفة أو معيبة أو مختلفة عمّا طلبت، فأبلغنا خلال ٤٨ ساعة من التسليم عبر واتساب أو البريد الإلكتروني، مع رقم الطلب وصور واضحة للقطعة والبطاقة، وإن أمكن مقطع فيديو لفتح الطرد. ويُرجى الاحتفاظ بالقطعة دون استخدام أو غسل وفي تغليفها الأصلي مع بطاقاتها.',
        'سنفحصها (وقد نرتّب استلامها منك)، وإذا ثبت العيب نستبدلها بقطعة مماثلة أو معادلة، أو نردّ ثمنها ورسوم توصيلها. ويُرد المبلغ بطريقة الدفع نفسها: إلى بطاقتك (تستغرق البنوك عادةً ٥–١٠ أيام عمل لإظهاره)، أو في حال الدفع عند الاستلام بتحويل بنكي إلى حساب باسمك، وذلك خلال ١٤ يوماً من تأكيدنا للعيب.',
        'لا يشمل ذلك: الفروقات الطبيعية للعمل اليدوي الواردة في البند ٣، والاستهلاك المعتاد، والتلف الناتج عن سوء الاستخدام أو الغسل أو الكي بخلاف تعليمات العناية أو التعديل أو الحوادث، والبقع أو العلامات بعد الاستخدام، والمقاس أو اللون الذي اختير خطأً.',
      ],
    },
  },
  {
    id: 'cancel',
    title: { en: '10. Cancelling an order', ar: '١٠. إلغاء الطلب' },
    body: {
      en: [
        'You can cancel an order free of charge on WhatsApp before we have handed it to the courier, except a personalised or made-to-order piece (section 6). Once it is with the courier it can no longer be cancelled; section 8 then applies. Anything you have paid on a cancelled order is refunded the way you paid, or, with your agreement, applied to another order.',
      ],
      ar: [
        'يمكنك إلغاء طلبك مجاناً عبر واتساب قبل تسليمه إلى شركة الشحن، باستثناء القطع المخصّصة أو المصنوعة حسب الطلب (البند ٦). وبعد تسليمه إلى شركة الشحن لا يمكن إلغاؤه ويسري عندها البند ٨. ويُرد أي مبلغ دفعته على طلب مُلغى بطريقة الدفع نفسها، أو يُحتسب بموافقتك لصالح طلب آخر.',
      ],
    },
  },
  {
    id: 'care',
    title: { en: '11. Caring for your pieces', ar: '١١. العناية بالقطع' },
    body: {
      en: [
        'Please follow the care label. Wash hand block-printed pieces separately in cold water for the first few washes, as natural dyes may release a little colour; dry them in the shade and iron on the reverse.',
      ],
      ar: [
        'يُرجى اتباع تعليمات العناية على البطاقة. اغسل القطع المطبوعة يدوياً منفصلةً بماء بارد في الغسلات الأولى، فقد تفقد الأصباغ الطبيعية قليلاً من لونها، وجففها في الظل واكوِها من الجهة الخلفية.',
      ],
    },
  },
  {
    id: 'links',
    title: { en: '12. Your private links', ar: '١٢. روابطك الخاصة' },
    body: {
      en: [
        'Links we send you for paying, tracking, an invoice or a deal are private to your order. Please do not share them; anyone with the link can see what it shows. Deal links work for one order and expire.',
      ],
      ar: [
        'الروابط التي نرسلها إليك للدفع أو التتبع أو الفاتورة أو العرض الخاص مخصّصة لطلبك، فيُرجى عدم مشاركتها؛ إذ يستطيع أي شخص لديه الرابط رؤية محتواه. وروابط العروض الخاصة صالحة لطلب واحد ولها مدة صلاحية.',
      ],
    },
  },
  {
    id: 'liability',
    title: { en: '13. Our responsibility', ar: '١٣. مسؤوليتنا' },
    body: {
      en: [
        'As far as the law allows, our responsibility for an order is limited to the amount you paid for it, and we are not responsible for indirect or consequential loss (such as loss of profit or opportunity).',
        'Nothing in these Terms limits any right you have, or any responsibility we have, that cannot be limited under UAE law, including the Consumer Protection Law (Federal Law No. 15 of 2020).',
      ],
      ar: [
        'في الحدود التي يسمح بها القانون، تقتصر مسؤوليتنا عن أي طلب على المبلغ الذي دفعته مقابله، ولا نتحمّل المسؤولية عن الخسائر غير المباشرة أو التبعية (مثل فوات الربح أو الفرصة).',
        'لا يحدّ أي شيء في هذه الشروط من أي حق لك أو مسؤولية علينا لا يجوز تقييدها بموجب قوانين دولة الإمارات، بما في ذلك قانون حماية المستهلك (القانون الاتحادي رقم ١٥ لسنة ٢٠٢٠).',
      ],
    },
  },
  {
    id: 'force',
    title: { en: '14. Events outside our control', ar: '١٤. الظروف الخارجة عن إرادتنا' },
    body: {
      en: [
        'We are not responsible for a delay or failure caused by events outside our reasonable control, such as severe weather, floods, outages of courier or payment services, government action or public emergencies. We will keep you informed and, if your order cannot be fulfilled, refund anything you paid.',
      ],
      ar: [
        'لسنا مسؤولين عن أي تأخير أو إخفاق ناتج عن ظروف خارجة عن سيطرتنا المعقولة، مثل الأحوال الجوية القاسية أو الفيضانات أو تعطّل خدمات الشحن أو الدفع أو الإجراءات الحكومية أو حالات الطوارئ العامة. وسنبقيك على اطلاع، وإذا تعذّر تنفيذ طلبك نردّ لك ما دفعته.',
      ],
    },
  },
  {
    id: 'ip',
    title: { en: '15. Our designs, photos and words', ar: '١٥. تصاميمنا وصورنا ونصوصنا' },
    body: {
      en: [
        'Our designs, photos, videos, product names and texts belong to us. They may not be copied, reused or sold, for example to list or sell copies of our pieces, without our written permission. Buying for resale in quantity needs our written agreement.',
      ],
      ar: [
        'تصاميمنا وصورنا ومقاطع الفيديو وأسماء المنتجات والنصوص ملك لنا، ولا يجوز نسخها أو إعادة استخدامها أو بيعها، كاستخدامها لعرض أو بيع نسخ من قطعنا، دون إذن كتابي منا. ويتطلب الشراء بكميات بغرض إعادة البيع موافقة كتابية منا.',
      ],
    },
  },
  {
    id: 'privacy',
    title: { en: '16. Your information', ar: '١٦. بياناتك' },
    body: {
      en: [
        'We use your name, mobile number, address and email to confirm, deliver and support your order, and share them only with those who help us do so (our courier and, for card payments, Stripe). We keep order records as long as UAE law requires (for example for accounting) and handle them in line with the UAE Personal Data Protection Law (Federal Decree-Law No. 45 of 2021).',
        'We send offers only if you have agreed to receive them. You can ask us on WhatsApp or by email to see or correct your details, or to delete what the law does not require us to keep.',
      ],
      ar: [
        'نستخدم اسمك ورقم جوالك وعنوانك وبريدك الإلكتروني لتأكيد طلبك وتوصيله وخدمتك، ولا نشاركها إلا مع من يساعدنا في ذلك (شركة الشحن، وStripe لمدفوعات البطاقات). ونحتفظ بسجلات الطلبات للمدة التي يفرضها القانون الإماراتي (مثل أغراض المحاسبة)، ونتعامل معها وفقاً لقانون حماية البيانات الشخصية الإماراتي (المرسوم بقانون اتحادي رقم ٤٥ لسنة ٢٠٢١).',
        'لا نرسل العروض إلا بموافقتك. ويمكنك أن تطلب منا عبر واتساب أو البريد الإلكتروني الاطلاع على بياناتك أو تصحيحها، أو حذف ما لا يلزمنا القانون بالاحتفاظ به.',
      ],
    },
  },
  {
    id: 'law',
    title: { en: '17. Law and disputes', ar: '١٧. القانون وتسوية النزاعات' },
    body: {
      en: [
        'These Terms are governed by the laws of the United Arab Emirates. If something goes wrong, please contact us first: we will try to resolve it with you within 14 days. Any dispute not resolved this way is for the competent courts of the United Arab Emirates.',
        'These Terms are in English and Arabic. If the two differ, the English text applies to the extent the law allows.',
      ],
      ar: [
        'تخضع هذه الشروط لقوانين دولة الإمارات العربية المتحدة. إذا واجهتك أي مشكلة فتواصل معنا أولاً، وسنسعى إلى حلّها معك خلال ١٤ يوماً. وأي نزاع لا يُحل بهذه الطريقة تختص به المحاكم المختصة في دولة الإمارات العربية المتحدة.',
        'صدرت هذه الشروط باللغتين الإنجليزية والعربية، وفي حال وجود اختلاف بينهما يُعتمد النص الإنجليزي في الحدود التي يسمح بها القانون.',
      ],
    },
  },
];
