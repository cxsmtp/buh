/**
 * The shop's one palette. Every colour on the storefront, in checkout, the chat, the Admin Hub,
 * the offline page, the app icon and the installed app's title bar comes from here.
 *
 * The same values are declared once more as CSS variables in src/app/globals.css (`@theme`), which
 * is what the pages use (`bg-ivory`, `text-ink`, `border-line`…); a test checks the two agree, and
 * another that no component uses a colour outside them.
 *
 * - Warm ivory and sand, like undyed linen, so photographs of printed cotton lead.
 * - Ink is a deep aubergine-charcoal rather than black or navy: it reads as near-black for text
 *   (over 13:1 on ivory) but is warm, so it sits with the gold and the linen instead of fighting
 *   them, and it carries a quiet hint of the plum used in block-print dyes.
 * - One accent, champagne gold, for rings, hairlines, ornaments and text on ink; a deeper antique
 *   gold carries gold text on light backgrounds (5:1 on ivory).
 * - One muted secondary, dusty rose, used sparingly (a sale mark, festive ornaments).
 * - Success, warning and danger are muted sage, ochre and brick, each with a soft tint and a line.
 */
export const PALETTE = {
  ivory: '#faf6ef',
  surface: '#fffdf9',
  sand: '#f2ebdf',
  'sand-deep': '#e8decd',
  line: '#e5dac9',
  'line-strong': '#cbbba3',
  ink: '#2b2127',
  'ink-2': '#43353d',
  'ink-soft': '#5a4c53',
  'ink-muted': '#6a5c62',
  gold: '#c2a36b',
  'gold-light': '#e6d5b0',
  'gold-deep': '#82612c',
  rose: '#c49a98',
  'rose-soft': '#f4e8e5',
  'rose-deep': '#8a5659',
  success: '#3d6a4e',
  'success-soft': '#eaf1ea',
  'success-line': '#c8dacb',
  warning: '#85601c',
  'warning-soft': '#f7eedb',
  'warning-line': '#e8d3a6',
  danger: '#9a3e39',
  'danger-soft': '#f7e6e2',
  'danger-line': '#e7c3bc',
  /** WhatsApp's own green, only on the WhatsApp button (people look for it). */
  whatsapp: '#1f7a47',
} as const;

export type Token = keyof typeof PALETTE;

/** The installed app's title bar and the phone's status bar. */
export const THEME_COLOR = PALETTE.ink;
/** Behind the app while it opens. */
export const APP_BACKGROUND_COLOR = PALETTE.ivory;
