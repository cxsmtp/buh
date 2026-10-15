import type { AssistantEntry, AssistantSettings, BedProfileMeasurement } from '@/types';

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
  return text.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s.x×-]/gu, ' ').replace(/\s+/g, ' ').trim();
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

function sizeAnswer(text: string, all: BedProfileMeasurement[]): string | null {
  const ws = new Set(words(text));
  const asksSize = [...ws].some((w) => SIZE_WORDS.has(w));
  // Only presets with real measurements (a "custom" preset is a person's job).
  const sizes = all.filter((s) => /\d/.test(s.mattressSize));
  // The size(s) named: most matching words, then the fewest extra ones ("king" is King, not Super King).
  const ranked = sizes
    .map((s) => {
      const own = [...new Set(words(`${s.name} ${s.id}`))].filter((w) => !SIZE_WORDS.has(w) && w.length > 2 && !['bed', 'most', 'popular'].includes(w));
      return { s, hits: own.filter((w) => ws.has(w)).length, extra: own.filter((w) => !ws.has(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.extra - b.extra);
  const named = ranked.filter((x) => x.hits === ranked[0]?.hits && x.extra === ranked[0]?.extra).map((x) => x.s);
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
