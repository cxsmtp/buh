/**
 * Arabic for the invoice PDF (a customer's name, "فاتورة"): letters take their joined forms
 * (Unicode Arabic Presentation Forms, which the bundled font draws), lam + alef become one, and a
 * run of right-to-left text is laid out right to left inside an otherwise left-to-right line.
 * Enough for names and short labels; not a full shaping engine.
 */

/** [isolated, final, initial, medial]; 0 = the letter joins only to the letter before it. */
const FORMS: Record<number, [number, number, number, number]> = {
  0x0621: [0xfe80, 0, 0, 0],
  0x0622: [0xfe81, 0xfe82, 0, 0],
  0x0623: [0xfe83, 0xfe84, 0, 0],
  0x0624: [0xfe85, 0xfe86, 0, 0],
  0x0625: [0xfe87, 0xfe88, 0, 0],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  0x0627: [0xfe8d, 0xfe8e, 0, 0],
  0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  0x0629: [0xfe93, 0xfe94, 0, 0],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  0x062f: [0xfea9, 0xfeaa, 0, 0],
  0x0630: [0xfeab, 0xfeac, 0, 0],
  0x0631: [0xfead, 0xfeae, 0, 0],
  0x0632: [0xfeaf, 0xfeb0, 0, 0],
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0],
  0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  0x0648: [0xfeed, 0xfeee, 0, 0],
  0x0649: [0xfeef, 0xfef0, 0, 0],
  0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  0x067e: [0xfb56, 0xfb57, 0xfb58, 0xfb59],
  0x0686: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d],
  0x0698: [0xfb8a, 0xfb8b, 0, 0],
  0x06a9: [0xfb8e, 0xfb8f, 0xfb90, 0xfb91],
  0x06af: [0xfb92, 0xfb93, 0xfb94, 0xfb95],
  0x06cc: [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff],
};
/** Lam + alef: [isolated, final]. */
const LAM_ALEF: Record<number, [number, number]> = { 0x0622: [0xfef5, 0xfef6], 0x0623: [0xfef7, 0xfef8], 0x0625: [0xfef9, 0xfefa], 0x0627: [0xfefb, 0xfefc] };
const TATWEEL = 0x0640;

const isMark = (c: number) => (c >= 0x064b && c <= 0x065f) || c === 0x0670;
export const isArabic = (c: number) => (c >= 0x0600 && c <= 0x06ff) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff);
const joinsNext = (c: number) => c === TATWEEL || Boolean(FORMS[c]?.[2]);
const joinsPrev = (c: number) => c === TATWEEL || Boolean(FORMS[c]?.[1]);

/** Joined forms, in logical order. */
function shape(cps: number[]): number[] {
  const out: number[] = [];
  // The neighbours that join, skipping marks.
  const prevLetter = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (!isMark(cps[j])) return cps[j];
    return 0;
  };
  const nextIndex = (i: number) => {
    for (let j = i + 1; j < cps.length; j++) if (!isMark(cps[j])) return j;
    return -1;
  };
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    const forms = FORMS[c];
    if (!forms) {
      out.push(c);
      continue;
    }
    const before = prevLetter(i);
    const linkedBefore = before !== 0 && joinsNext(before) && joinsPrev(c);
    const ni = nextIndex(i);
    // Lam + alef: one glyph.
    if (c === 0x0644 && ni >= 0 && LAM_ALEF[cps[ni]]) {
      out.push(LAM_ALEF[cps[ni]][linkedBefore ? 1 : 0]);
      for (let j = i + 1; j < ni; j++) out.push(cps[j]);
      i = ni;
      continue;
    }
    const after = ni >= 0 ? cps[ni] : 0;
    const linkedAfter = after !== 0 && joinsNext(c) && joinsPrev(after);
    const [iso, fin, ini, med] = forms;
    out.push(linkedBefore && linkedAfter ? med || fin || iso : linkedBefore ? fin || iso : linkedAfter ? ini || iso : iso);
  }
  return out;
}

/**
 * The code points of one line in the order to draw them left to right: Arabic joined, and each
 * right-to-left run (Arabic letters, with the spaces and marks between them) reversed in place.
 * Digits and Latin letters keep their order.
 */
export function visualLine(text: string): number[] {
  const cps = Array.from(text, (ch) => ch.codePointAt(0)!);
  if (!cps.some(isArabic)) return cps;
  const shaped = shape(cps);
  const out: number[] = [];
  let i = 0;
  while (i < shaped.length) {
    if (!isArabic(shaped[i])) {
      out.push(shaped[i++]);
      continue;
    }
    // A right-to-left run: Arabic, plus spaces and neutral punctuation followed by more Arabic.
    let j = i;
    while (j < shaped.length) {
      if (isArabic(shaped[j])) {
        j++;
        continue;
      }
      let k = j;
      while (k < shaped.length && (shaped[k] === 0x20 || shaped[k] === 0x2d || shaped[k] === 0x2e)) k++;
      if (k < shaped.length && k > j && isArabic(shaped[k])) j = k;
      else break;
    }
    out.push(...shaped.slice(i, j).reverse());
    i = j;
  }
  return out;
}
