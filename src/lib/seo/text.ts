/**
 * Search-snippet text: plain, browser-safe helpers shared by the shop's pages (titles,
 * descriptions) and the Admin Hub's Google-style preview, so both count characters the same way.
 *
 * Google shows about 60 characters of a title and about 155 of a description; longer ones are cut
 * by Google itself, so the shop keeps its own within those where it can (a whole word, a whole
 * sentence) instead of letting a sentence be chopped mid-word.
 */

export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 155;
/** Below these, a snippet says too little (a health check, not a rule). */
export const TITLE_MIN = 15;
export const DESCRIPTION_MIN = 50;

/** What an owner may type for an SEO field: one line, no markup or control characters. */
export function cleanSeoText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Markdown-ish product text (headings, bold, bullets, links) as one plain line. */
export function plainText(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`#>~]+/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut at the last whole word that fits (no half words); `ellipsis` adds "…" when cut. */
export function cutAtWord(s: string, max: number, ellipsis = false): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const room = ellipsis ? max - 1 : max;
  const cut = t.slice(0, room + 1);
  const at = cut.lastIndexOf(' ');
  const out = (at > room * 0.5 ? cut.slice(0, at) : t.slice(0, room)).replace(/[\s,;:–—|·-]+$/, '').trim();
  return ellipsis ? `${out}…` : out;
}

/**
 * A description of at most `max` characters: whole sentences while they fit; when even the first
 * one is longer, it is cut at a word with "…".
 */
export function fitDescription(text: string, max = DESCRIPTION_MAX): string {
  const t = plainText(text);
  if (t.length <= max) return t;
  const sentences = t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [t];
  let out = '';
  for (const s of sentences) {
    const next = `${out}${out ? ' ' : ''}${s.trim()}`;
    if (next.length > max) break;
    out = next;
  }
  return out || cutAtWord(t, max, true);
}

/** "Name | Shop" when it fits in 60 characters, else the name alone (cut at a word if need be). */
export function fitTitle(name: string, shop: string, max = TITLE_MAX): string {
  const n = cleanSeoText(name, 300);
  const both = shop ? `${n} | ${shop}` : n;
  if (both.length <= max) return both;
  return cutAtWord(n, max);
}

/**
 * Google's site-verification and Bing's msvalidate.01 codes: the content="…" value only (people
 * often paste the whole <meta> tag, so that is accepted and the value taken from it). Letters,
 * digits, - and _ (Google's are base64url, Bing's hex), 8–100 characters. Anything else: null.
 */
export function verificationCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return '';
  const fromTag = /content\s*=\s*["']([^"']*)["']/i.exec(s);
  if (fromTag) s = fromTag[1].trim();
  return /^[A-Za-z0-9_-]{8,100}$/.test(s) ? s : null;
}

/** Problems Google's snippet would have, in plain words (the Admin Hub's health checks). */
export function snippetProblems(s: { title: string; description: string }): string[] {
  const out: string[] = [];
  if (s.title.length > TITLE_MAX) out.push('Title too long');
  else if (s.title.length < TITLE_MIN) out.push('Title too short');
  if (!s.description) out.push('Missing description');
  else if (s.description.length > DESCRIPTION_MAX) out.push('Description too long');
  else if (s.description.length < DESCRIPTION_MIN) out.push('Description too short');
  return out;
}
