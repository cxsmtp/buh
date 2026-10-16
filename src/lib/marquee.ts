/**
 * The announcement bar's lines (Settings → Store & contact). Few and short, so it reads calmly:
 * at most three, each up to 60 characters, no emoji. Shared by the bar, the settings card (its
 * counter and preview) and the server (which refuses longer ones).
 */

export const MARQUEE_MAX_ITEMS = 3;
export const MARQUEE_MAX_CHARS = 60;

export const DEFAULT_MARQUEE = ['Free delivery across the UAE in 1–2 days', 'Cash on delivery', 'Handmade in small batches'];

/** What the bar said before BUH-02.07 (long, with emoji): shops still showing it get the new lines. */
export const LEGACY_MARQUEE = [
  '🌟 Exclusive UAE Edition: Handprinted & Machine-Printed Artisan Block Linens',
  '⚡ Express Delivery across Dubai, Abu Dhabi, Sharjah & all 7 Emirates within 24-48 Hours',
  '🚚 Doorstep Cash on Delivery (COD) & Instant Emirates NBD Bank Transfer Supported',
  '✨ Tailored 40cm Deep Pocket Bed Sheets engineered for UAE Master Bed Mattresses',
  '🌿 100% Breathable Egyptian Giza Cotton & Pure Flax Linens for Arabian Comfort',
];

/** Emoji and pictographs (with their joiners and variation selectors), which the bar never shows. */
const PICTOGRAPHS = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

export function stripEmoji(s: string): string {
  return s.replace(PICTOGRAPHS, '').replace(/\s{2,}/g, ' ').trim();
}

/** Shorten to the limit at a word, with an ellipsis. */
function shorten(s: string): string {
  if (s.length <= MARQUEE_MAX_CHARS) return s;
  const cut = s.slice(0, MARQUEE_MAX_CHARS - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 30 ? cut.slice(0, at) : cut).replace(/[\s,;:·•-]+$/, '')}…`;
}

/** The lines the bar shows: no emoji, at most three, each within the limit. */
export function marqueeItems(messages: string[] | undefined): string[] {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === LEGACY_MARQUEE.length && list.every((m, i) => m === LEGACY_MARQUEE[i])) return [...DEFAULT_MARQUEE];
  return list
    .map((m) => (typeof m === 'string' ? shorten(stripEmoji(m)) : ''))
    .filter(Boolean)
    .slice(0, MARQUEE_MAX_ITEMS);
}

/** Why a set of lines can't be saved, or null. */
export function marqueeProblem(messages: string[]): string | null {
  const lines = messages.map((m) => stripEmoji(m));
  if (lines.filter(Boolean).length > MARQUEE_MAX_ITEMS) return `Up to ${MARQUEE_MAX_ITEMS} announcements, so the bar stays calm.`;
  const long = lines.findIndex((m) => m.length > MARQUEE_MAX_CHARS);
  if (long >= 0) return `Announcement ${long + 1} is ${lines[long].length} characters; please keep it to ${MARQUEE_MAX_CHARS} or fewer.`;
  return null;
}
