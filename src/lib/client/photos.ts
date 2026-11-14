/**
 * Photo sizes for the shop, so a phone downloads a photo the size of the card instead of the
 * original. Photos hosted on Unsplash can be asked for at any width. The shop's own uploaded photos
 * (/api/images/…, up to 1600 px) come in three smaller widths as well, made by the server on the
 * first request (src/lib/server/imageVariants.ts); the original is offered as the largest.
 */

const RESIZABLE = /^https:\/\/images\.unsplash\.com\//;
/** One of the shop's own stored photos (no query: a link that already asks for a width is left alone). */
const OWN = /^\/api\/images\/[a-f0-9]{64}\.(png|jpg|webp)$/;
/** The widths the server makes (the same list as IMAGE_WIDTHS there). */
export const OWN_WIDTHS = [240, 540, 1080];
/** What the original is offered as: uploads are shrunk to at most this wide when the owner adds them. */
const OWN_FULL = 1600;

function ownSources(url: string, widths: number[]): { src: string; srcSet?: string } {
  const want = Math.max(...widths);
  // Small pictures (a search row, a round chip): the smallest copy that covers them, nothing bigger.
  const top = OWN_WIDTHS.find((w) => w >= want);
  const made = top ? OWN_WIDTHS.filter((w) => w <= top) : OWN_WIDTHS;
  const srcSet = [...made.map((w) => `${url}?w=${w} ${w}w`), ...(top ? [] : [`${url} ${OWN_FULL}w`])].join(', ');
  return { src: top ? `${url}?w=${top}` : url, srcSet };
}

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
  if (url && OWN.test(url)) return ownSources(url, widths);
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
