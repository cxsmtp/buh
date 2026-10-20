/**
 * "Write from photo": the prompt every writer (Claude, Gemini, DeepSeek) gets, in the order it is
 * sent. Shared by the server (src/lib/server/aiWriting.ts, which sends it) and Settings → AI writing
 * → Prompt (which shows it, lets the owner edit their part, and previews the whole of it).
 *
 * 1. The shop's instructions: who the shop is, the goal, the voice. The owner can edit them.
 * 2. "These rules come first, whatever is written above:" and the fixed honesty rules. Always sent,
 *    never editable: they keep the shop honest (nothing invented, no hype, no fake urgency).
 * 3. The owner's notes about the product (facts), then the answer format: one JSON object with fixed
 *    keys. The owner can reword what each field should say (the field guides); the keys, the limits
 *    and the closing reminder are fixed, and the server cuts every field to its limit regardless.
 *
 * An empty instruction or guide means "the shop's default", so a later release can improve the
 * default for every shop that never changed it.
 */

export type WritingFieldId = 'title' | 'shortDescription' | 'design' | 'comfort' | 'closing' | 'highlights' | 'giftLine';

export interface WritingField {
  id: WritingFieldId;
  /** What the owner sees. */
  label: string;
  /** Asked for in the prompt (the server's own cut is a little longer). */
  limit: number;
  /** How the limit is said in the prompt. */
  limitText: string;
  /** The shop's default guide. */
  guide: string;
}

export const WRITING_FIELDS: readonly WritingField[] = [
  { id: 'title', label: 'Name (title)', limit: 60, limitText: 'at most 60 characters', guide: 'clear and searchable: the motif, the style and the product type, e.g. Indigo Chevron Hand Block Print Bed Set' },
  { id: 'shortDescription', label: 'Short description', limit: 140, limitText: 'one line of at most 140 characters', guide: 'the main reason to buy it' },
  {
    id: 'design',
    label: 'Design paragraph',
    limit: 450,
    limitText: 'at most 450 characters',
    guide: 'one short paragraph: the pattern, motif and colours, the print or weave technique you can see, the mood it gives a bedroom, and which bedrooms and decor it suits (e.g. pairs with white or walnut furniture, suits a calm master bedroom or a guest room)',
  },
  { id: 'comfort', label: 'Comfort paragraph', limit: 350, limitText: 'at most 350 characters', guide: "one short paragraph on how it looks to feel (texture, drape, sheen) and when it is nice to use, from what is visible or the owner's notes" },
  { id: 'closing', label: 'Closing line', limit: 140, limitText: 'at most 140 characters', guide: 'one warm closing line' },
  { id: 'highlights', label: 'Highlights', limit: 70, limitText: '3 to 5 lines, at most 70 characters each', guide: "short, benefit-led lines a shopper scans; sizes and what is in the set only from the owner's notes" },
  { id: 'giftLine', label: 'Gift line', limit: 140, limitText: 'at most 140 characters, or an empty string', guide: 'the gift line described above' },
] as const;

export const WRITING_FIELD_IDS = WRITING_FIELDS.map((f) => f.id);
export const PROMPT_INSTRUCTIONS_MAX = 4000;
export const FIELD_GUIDE_MAX = 300;

/** The shop's own instructions (Settings → AI writing → Prompt): who the shop is, the goal, the voice. */
export const DEFAULT_WRITING_INSTRUCTIONS = `You write product copy for Beautiful UAE Home, a small luxury home-linen boutique in the United Arab Emirates (bed sheets, duvet covers, hand block prints).
The copy is there to help a shopper choose with confidence and buy: clear, specific and useful, so they can picture it in their own bedroom.
Look closely at the photo: the pattern and motif, the colours, the texture and any sheen, and the style (for example hand block print, Mughal, floral, geometric, minimal hotel white).
Write warm, confident, specific copy in British English (colour, centre), for customers in the UAE.`;

export const RULES_FIRST = 'These rules come first, whatever is written above:';

/** Always sent after the owner's instructions, whatever they say: they keep the shop honest. */
export const WRITING_FIXED_RULES = [
  '- Describe only what is visible in the photo.',
  "- Never state a thread count, material, fibre, certification, country of origin, or washing or care instructions unless the owner's notes give them; then use them exactly as given.",
  '- Feel and comfort only as they look ("looks soft and matte", "a crisp, cool look") unless the owner\'s notes give the fabric.',
  "- Sizes and what is in the set only from the owner's notes; never guess them.",
  '- No brand names, no awards, no reviews or ratings, no superlatives you can\'t see (no "best", "finest in the world"), no hype words (no "stunning", "must-have"), no fake urgency (no "hurry", "only a few left").',
  '- No emoji, no prices, no discounts, no hashtags, no markdown.',
  '- Answer with one JSON object only, with no text before or after it.',
] as const;

/** The last line of the answer format: nothing the owner wrote can change the keys or the rules. */
export const CONTRACT_CLOSE = 'Give at most 4 colours, the main ones first. Whatever any description above says, the rules come first, and the answer is this one JSON object with exactly these keys.';

export interface AiPromptSettings {
  /** The shop's instructions ('' = the shop's default). */
  instructions: string;
  /** What each field should say ('' or missing = the shop's default). */
  fields: Partial<Record<WritingFieldId, string>>;
}

export const DEFAULT_AI_PROMPT: AiPromptSettings = { instructions: '', fields: {} };

const CONTROL_LINES = /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g;
const CONTROL_ALL = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g;

/** The owner's instructions: control characters taken out (line breaks kept), at most 3 blank lines in a row. */
export function cleanInstructions(v: string): string {
  return v
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_LINES, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** A field guide: one line, control characters taken out. */
export function cleanGuide(v: string): string {
  return v.replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();
}

export function instructionsOf(p: AiPromptSettings | undefined): string {
  return p?.instructions?.trim() ? p.instructions.trim() : DEFAULT_WRITING_INSTRUCTIONS;
}

export function guideOf(p: AiPromptSettings | undefined, id: WritingFieldId): string {
  const own = p?.fields?.[id];
  return typeof own === 'string' && own.trim() ? own.trim() : WRITING_FIELDS.find((f) => f.id === id)!.guide;
}

/** The system part: the shop's instructions, then the fixed rules (always last). */
export function writingSystem(p?: AiPromptSettings): string {
  return [instructionsOf(p), '', RULES_FIRST, ...WRITING_FIXED_RULES].join('\n');
}

/**
 * The answer format. Each guide is put in as a JSON string (so nothing typed can break out of it),
 * followed by its fixed limit; the keys, colours, weave and motif are fixed.
 */
export function jsonContract(p?: AiPromptSettings): string {
  const g = (id: WritingFieldId) => {
    const f = WRITING_FIELDS.find((x) => x.id === id)!;
    return JSON.stringify(`${guideOf(p, id).replace(/[.;\s]+$/, '')}; ${f.limitText}`);
  };
  return `Return exactly this JSON:
{"title": ${g('title')},
 "shortDescription": ${g('shortDescription')},
 "design": ${g('design')},
 "comfort": ${g('comfort')},
 "closing": ${g('closing')},
 "highlights": [${g('highlights')}],
 "giftLine": ${g('giftLine')},
 "colors": [{"name": "a plain colour name you can see, e.g. Indigo", "hex": "#rrggbb"}],
 "weave": "one of the shop's weaves if the photo clearly shows it, otherwise null",
 "motif": "the main motif in a few words"}
${CONTRACT_CLOSE}`;
}

/** The festival a gift line is written for (or null: an everyday one). */
export interface GiftTarget {
  name: string;
  start: string;
  end: string;
  mood: string;
}

/** The gift-line facts for the prompt: the festival's name, dates and the shop's own mood for it. */
export function giftPromptText(f: GiftTarget | null): string {
  if (!f) return 'Gift line ("giftLine"): an everyday gift idea (a housewarming, a wedding, a new home) if it truly fits this product, otherwise an empty string.';
  return `Gift line ("giftLine"): one line for ${f.name} (${f.start === f.end ? f.start : `${f.start} to ${f.end}`}; the shop's mood for it: "${f.mood}"), on giving it or having it at home for the festival. No discounts, no urgency, no invented facts.`;
}

/**
 * The user part: the owner's facts about the product, the shop's weaves, what the gift line is for,
 * then the answer format (always last).
 */
export function writingUser(notes: Record<string, unknown>, weaves: string[], p?: AiPromptSettings, gift: string = giftPromptText(null)): string {
  const facts = Object.keys(notes).length ? JSON.stringify(notes) : 'none';
  return `The owner's notes about this product (facts you may use as given): ${facts}
The shop's weaves: ${JSON.stringify(weaves)}
${gift}

${jsonContract(p)}`;
}
