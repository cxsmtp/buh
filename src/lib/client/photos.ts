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
export function photoSources(url: string, widths: number[] = PHOTO_WIDTHS): { src: string; srcSet?: string } {
  if (!url || !RESIZABLE.test(url)) return { src: url };
  return {
    src: withWidth(url, widths[Math.min(1, widths.length - 1)]),
    srcSet: widths.map((w) => `${withWidth(url, w)} ${w}w`).join(', '),
  };
}

/**
 * The widths offered to the browser, which picks the smallest that is sharp on the screen: 412 px
 * phones at 2.6x (most Androids) take the 1080, a 375 px iPhone at 3x too, a 2-across card 540.
 */
export const PHOTO_WIDTHS = [360, 540, 720, 828, 1080, 1440];

/**
 * How wide a feed photo is on screen. Phones: the whole screen (one photo per row, the default) or
 * half of it (the grid); tablets two across, then three; computers four in a 1280 px column. Phones held sideways: two across.
 */
export function feedSizes(layout: 'one' | 'grid'): string {
  return `(min-width: 1280px) 300px, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, ${layout === 'one' ? '100vw' : '50vw'}`;
}
/** The card photo in the shop's grid (two across on phones). */
export const CARD_SIZES = feedSizes('grid');
/** A photo in the product sheet: the whole screen on phones and portrait tablets, half the dialog side by side. */
export const SHEET_SIZES = '(min-width: 1024px) 520px, (min-width: 768px) and (orientation: landscape) 50vw, (min-width: 640px) 576px, 100vw';
/** Full screen (the zoom view): sharp at twice the size when zoomed in. */
export const ZOOM_SIZES = '200vw';
