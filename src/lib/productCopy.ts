/**
 * "Write from photo": the parts of the suggested copy and how they make the product's full
 * description. Shared by the server (src/lib/server/aiWriting.ts, which checks and cuts every part)
 * and the editor (which lets the owner edit each part before using it).
 *
 * The full description is: the design paragraph, the comfort paragraph, a closing line, then the
 * highlights as a short list ("• …" lines), at most 1,200 characters (the shop keeps up to 4,000;
 * the product page shows the paragraphs and lines as written). Gift lines are kept apart, per
 * festival (src/lib/server/giftLines.ts).
 */

export const COPY_LIMITS = {
  title: 60,
  shortDescription: 140,
  design: 500,
  comfort: 400,
  closing: 160,
  highlight: 80,
  highlights: 5,
  giftLine: 160,
  description: 1200,
  colors: 4,
  motif: 80,
} as const;

export interface CopyParts {
  design: string;
  comfort: string;
  closing: string;
  highlights: string[] | string;
}

/** Cut at the end of a sentence (or a word) so the text stays within max. */
function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.endsWith('.') ? cut.length - 1 : -1);
  if (end > max * 0.5) return cut.slice(0, end + 1).trim();
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '').trim();
}

/** The highlights as typed (one per line, a leading bullet, dash or number taken off), empty ones dropped. */
export function highlightLines(v: string | string[]): string[] {
  const lines = Array.isArray(v) ? v : v.split('\n');
  return lines.map((l) => String(l).replace(/^\s*(?:[•·*\-–—]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Design, comfort and closing as paragraphs, then the highlights list, within max. */
export function composeDescription(p: CopyParts, max: number = COPY_LIMITS.description): string {
  const paragraphs = [p.design, p.comfort, p.closing].map((x) => x.trim()).filter(Boolean);
  let highlights = highlightLines(p.highlights).slice(0, COPY_LIMITS.highlights);
  const join = () => [paragraphs.join('\n\n'), highlights.map((h) => `• ${h}`).join('\n')].filter(Boolean).join('\n\n');
  let out = join();
  // Too long: highlights go from the end first, then the paragraphs are cut at a sentence.
  while (out.length > max && highlights.length > 0) {
    highlights = highlights.slice(0, -1);
    out = join();
  }
  return out.length > max ? cutText(out, max) : out;
}
