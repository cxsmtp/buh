/**
 * Photo sizes for the shop. Photos hosted on Unsplash (the starter catalogue) can be asked for at
 * any width, so phones download a photo the size of the card instead of a 1200 px original.
 * Uploaded photos (/api/images/…) are already shrunk when the owner adds them and are used as is.
 */

const RESIZABLE = /^https:\/\/images\.unsplash\.com\//;

function withWidth(url: string, width: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set('w', String(width));
    if (!u.searchParams.has('auto')) u.searchParams.set('auto', 'format');
    if (!u.searchParams.has('fit')) u.searchParams.set('fit', 'crop');
    return u.toString();
  } catch {
    return url;
  }
}

/** src and srcSet for an <img>: srcSet only where the host can resize. */
export function photoSources(url: string, widths: number[] = [360, 540, 720, 1080]): { src: string; srcSet?: string } {
  if (!url || !RESIZABLE.test(url)) return { src: url };
  return {
    src: withWidth(url, widths[Math.min(1, widths.length - 1)]),
    srcSet: widths.map((w) => `${withWidth(url, w)} ${w}w`).join(', '),
  };
}

/** The card photo in the shop's grid: half the screen on phones, a third or a quarter on wider ones. */
export const CARD_SIZES = '(min-width: 1280px) 300px, (min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw';
/** A photo in the product sheet: the whole screen on phones, half the dialog on wider screens. */
export const SHEET_SIZES = '(min-width: 1024px) 520px, (min-width: 640px) 50vw, 100vw';
