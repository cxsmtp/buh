import { PALETTE, type Token } from './tokens';

/**
 * The shop's looks (Settings → Look). Each look is the same set of tokens (src/lib/design/tokens.ts)
 * in a light and a dark variant, so every page keeps its classes (bg-ivory, text-ink, border-line…)
 * and only the values change. The device chooses light or dark (prefers-color-scheme), unless the
 * owner fixes one.
 *
 * In the dark variants every token keeps its role: the surfaces (ivory, surface, sand) are the dark
 * ones and the inks (ink … ink-muted) the light ones, so a primary button (bg-ink text-paper) is a
 * pearl button with dark lettering, and `paper` (white in the light looks) is the deepest shade.
 * Status colours (success, warning, danger) become light enough to read on the dark surfaces, and
 * their soft tints become dark.
 *
 * Inside an ink panel (bg-ink, bg-ink-2) in a dark variant, the golds that read on the light-mode
 * dark panel would be too pale on the pearl one: `onInk` holds the deeper golds used there; and on
 * a gold badge (bg-gold) the ink lettering stays dark (`onGold`).
 *
 * "Ivory & Gold" light is exactly PALETTE: the shop's look before looks existed.
 */

export type Palette = Record<Token, string>;

export interface LookVariant {
  colors: Palette;
  /** Golds inside an ink panel (bg-ink, bg-ink-2): only differs in dark variants. */
  onInk?: { gold: string; 'gold-light': string };
  /** Ink lettering on a gold badge (bg-gold): only differs in dark variants. */
  onGold?: string;
}

export interface LookPreset {
  id: LookPresetId;
  name: string;
  /** One line for the admin. */
  description: string;
  light: LookVariant;
  dark: LookVariant;
}

export const LOOK_PRESET_IDS = [
  'ivory-gold',
  'noir-champagne',
  'pearl-emerald',
  'sand-rose',
  // The bright looks with a Dubai feel: opt-in; the default stays Ivory & Gold.
  'jumeirah-azure',
  'civic-gold',
  'digital-skyline',
  'palm-fresh',
] as const;
export type LookPresetId = (typeof LOOK_PRESET_IDS)[number];

export const LOOK_MODES = ['system', 'light', 'dark'] as const;
export type LookMode = (typeof LOOK_MODES)[number];

export const MODE_LABELS: Record<LookMode, string> = {
  system: 'Match the device',
  light: 'Always light',
  dark: 'Always dark',
};

export const DEFAULT_LOOK_PRESET: LookPresetId = 'ivory-gold';
export const DEFAULT_LOOK_MODE: LookMode = 'system';

export const LOOK_PRESETS: Record<LookPresetId, LookPreset> = {
  'ivory-gold': {
    id: 'ivory-gold',
    name: 'Ivory & Gold',
    description: 'Warm ivory and linen with aubergine ink and antique gold; at night, deep aubergine with champagne.',
    light: { colors: { ...PALETTE } },
    dark: {
      colors: {
        ivory: '#1a1418',
        surface: '#221a1f',
        sand: '#2a2127',
        'sand-deep': '#352a31',
        line: '#3b2f36',
        'line-strong': '#5e4d57',
        ink: '#f3ece1',
        'ink-2': '#e6dccf',
        'ink-soft': '#d2c5b8',
        'ink-muted': '#bcada4',
        gold: '#c9ad78',
        'gold-light': '#e6d5b0',
        'gold-deep': '#d6bb85',
        rose: '#c49a98',
        'rose-soft': '#3a2629',
        'rose-deep': '#e0b5b2',
        success: '#9fcdaa',
        'success-soft': '#1d2d23',
        'success-line': '#34503d',
        warning: '#e2be7a',
        'warning-soft': '#302616',
        'warning-line': '#5a4627',
        danger: '#efa198',
        'danger-soft': '#3a1f1d',
        'danger-line': '#64352f',
        whatsapp: '#5ec98a',
        paper: '#140f12',
        scrim: '#050404',
      },
      onInk: { gold: '#7d5c27', 'gold-light': '#6b4e20' },
      onGold: '#140f12',
    },
  },
  'noir-champagne': {
    id: 'noir-champagne',
    name: 'Noir & Champagne',
    description: 'Pearl white and black-espresso with champagne; at night, near-black with pearl lettering.',
    light: {
      colors: {
        ivory: '#f7f5f1',
        surface: '#fdfcfa',
        sand: '#efebe4',
        'sand-deep': '#e4ded4',
        line: '#e2dcd2',
        'line-strong': '#c4bbad',
        ink: '#1c1917',
        'ink-2': '#33302c',
        'ink-soft': '#4f4a44',
        'ink-muted': '#635d56',
        gold: '#bfa77a',
        'gold-light': '#e7dcc4',
        'gold-deep': '#7b6136',
        rose: '#bfa3a0',
        'rose-soft': '#f3eae8',
        'rose-deep': '#81585a',
        success: '#3b6550',
        'success-soft': '#e9f0eb',
        'success-line': '#c6d8cc',
        warning: '#80601f',
        'warning-soft': '#f5eedf',
        'warning-line': '#e4d4ad',
        danger: '#963f3a',
        'danger-soft': '#f6e7e4',
        'danger-line': '#e5c4be',
        whatsapp: '#1f7a47',
        paper: '#ffffff',
        scrim: '#1c1917',
      },
    },
    dark: {
      colors: {
        ivory: '#121110',
        surface: '#1a1917',
        sand: '#222020',
        'sand-deep': '#2c2a28',
        line: '#33302d',
        'line-strong': '#57524c',
        ink: '#f4f1ea',
        'ink-2': '#e5e0d6',
        'ink-soft': '#cfc8bb',
        'ink-muted': '#b5ada0',
        gold: '#cdb68a',
        'gold-light': '#e7dcc4',
        'gold-deep': '#d8c294',
        rose: '#bfa3a0',
        'rose-soft': '#33282a',
        'rose-deep': '#dcbcb9',
        success: '#9fcbb0',
        'success-soft': '#1a2a21',
        'success-line': '#33493b',
        warning: '#dfc07f',
        'warning-soft': '#2c2416',
        'warning-line': '#55462a',
        danger: '#eda39b',
        'danger-soft': '#361e1c',
        'danger-line': '#5f3530',
        whatsapp: '#5ec98a',
        paper: '#0e0d0c',
        scrim: '#050404',
      },
      onInk: { gold: '#76602f', 'gold-light': '#655228' },
      onGold: '#0e0d0c',
    },
  },
  'pearl-emerald': {
    id: 'pearl-emerald',
    name: 'Pearl & Emerald',
    description: 'Pearl and soft celadon with deep emerald and brass; at night, forest-black with brass.',
    light: {
      colors: {
        ivory: '#f6f6f1',
        surface: '#fcfcf9',
        sand: '#ecefe8',
        'sand-deep': '#dfe4db',
        line: '#dde2d8',
        'line-strong': '#b9c2b3',
        ink: '#17271f',
        'ink-2': '#2a3a32',
        'ink-soft': '#44534b',
        'ink-muted': '#56645c',
        gold: '#b59a5e',
        'gold-light': '#e3d7b5',
        'gold-deep': '#2d5e4a',
        rose: '#bf9d98',
        'rose-soft': '#f3e9e6',
        'rose-deep': '#84585a',
        success: '#2f6449',
        'success-soft': '#e6f0e9',
        'success-line': '#c3d8c9',
        warning: '#7e5e1c',
        'warning-soft': '#f5eedb',
        'warning-line': '#e3d2a5',
        danger: '#963d38',
        'danger-soft': '#f6e6e2',
        'danger-line': '#e5c3bc',
        whatsapp: '#1f7a47',
        paper: '#ffffff',
        scrim: '#17271f',
      },
    },
    dark: {
      colors: {
        ivory: '#0f1714',
        surface: '#151f1b',
        sand: '#1c2722',
        'sand-deep': '#25312b',
        line: '#2c3a33',
        'line-strong': '#4a5c53',
        ink: '#eef2ea',
        'ink-2': '#dde5da',
        'ink-soft': '#c4cfc4',
        'ink-muted': '#a9b6ab',
        gold: '#c8ae74',
        'gold-light': '#e3d7b5',
        'gold-deep': '#8fcfb0',
        rose: '#bf9d98',
        'rose-soft': '#30252a',
        'rose-deep': '#dcb8b4',
        success: '#9bd0b0',
        'success-soft': '#16291f',
        'success-line': '#2e4b3b',
        warning: '#dcbf7c',
        'warning-soft': '#2a2416',
        'warning-line': '#52452a',
        danger: '#eda39b',
        'danger-soft': '#341e1c',
        'danger-line': '#5c3530',
        whatsapp: '#5ec98a',
        paper: '#0b120f',
        scrim: '#050404',
      },
      onInk: { gold: '#735c27', 'gold-light': '#62501f' },
      onGold: '#0b120f',
    },
  },
  'sand-rose': {
    id: 'sand-rose',
    name: 'Sand & Rose',
    description: 'Desert sand and blush with cocoa ink and rose gold; at night, cocoa with rose-gold lights.',
    light: {
      colors: {
        ivory: '#f8f2ec',
        surface: '#fefbf8',
        sand: '#f1e7dd',
        'sand-deep': '#e7d9cb',
        line: '#e6d8ca',
        'line-strong': '#cdb8a6',
        ink: '#2e211d',
        'ink-2': '#463531',
        'ink-soft': '#5d4b46',
        'ink-muted': '#6d5b55',
        gold: '#c79a82',
        'gold-light': '#eed5c7',
        'gold-deep': '#8a5240',
        rose: '#c99a95',
        'rose-soft': '#f5e6e2',
        'rose-deep': '#8c4f55',
        success: '#3d684c',
        'success-soft': '#eaf1ea',
        'success-line': '#c8dacb',
        warning: '#835e1d',
        'warning-soft': '#f7eedb',
        'warning-line': '#e8d3a6',
        danger: '#9a3e39',
        'danger-soft': '#f7e6e2',
        'danger-line': '#e7c3bc',
        whatsapp: '#1f7a47',
        paper: '#ffffff',
        scrim: '#2e211d',
      },
    },
    dark: {
      colors: {
        ivory: '#1b1412',
        surface: '#231a17',
        sand: '#2b201d',
        'sand-deep': '#362924',
        line: '#3d2f2a',
        'line-strong': '#614d45',
        ink: '#f5ebe4',
        'ink-2': '#e8dbd2',
        'ink-soft': '#d4c3b9',
        'ink-muted': '#bfaca2',
        gold: '#d3a98f',
        'gold-light': '#eed5c7',
        'gold-deep': '#e2b9a3',
        rose: '#c99a95',
        'rose-soft': '#3b2629',
        'rose-deep': '#e7b7b6',
        success: '#a0ccab',
        'success-soft': '#1d2c22',
        'success-line': '#354f3d',
        warning: '#e2bf7d',
        'warning-soft': '#302516',
        'warning-line': '#5a4627',
        danger: '#efa198',
        'danger-soft': '#3a1f1d',
        'danger-line': '#64352f',
        whatsapp: '#5ec98a',
        paper: '#150f0d',
        scrim: '#050404',
      },
      onInk: { gold: '#85503b', 'gold-light': '#73452f' },
      onGold: '#150f0d',
    },
  },
  'jumeirah-azure': {
    id: 'jumeirah-azure',
    name: 'Jumeirah Azure',
    description: 'Sunlit white and pale sand with a turquoise-sea accent and soft gold; at night, a deep sea-blue with turquoise lights.',
    light: {
      colors: {
        ivory: '#fbf9f4',
        surface: '#fefdfb',
        sand: '#f4eee3',
        'sand-deep': '#e9e0d0',
        line: '#e4ddd0',
        'line-strong': '#c5bba9',
        ink: '#0f2f38',
        'ink-2': '#20434c',
        'ink-soft': '#365961',
        'ink-muted': '#4a6870',
        gold: '#c8a86b',
        'gold-light': '#ecdcb9',
        'gold-deep': '#0a6a72',
        rose: '#c9a093',
        'rose-soft': '#f6eae4',
        'rose-deep': '#8a5448',
        success: '#2f6a4f',
        'success-soft': '#e8f2ec',
        'success-line': '#c4dccd',
        warning: '#82601c',
        'warning-soft': '#f7efdc',
        'warning-line': '#e8d4a7',
        danger: '#9a3e39',
        'danger-soft': '#f7e6e2',
        'danger-line': '#e7c3bc',
        whatsapp: '#1f7a47',
        paper: '#ffffff',
        scrim: '#0f2f38',
      },
    },
    dark: {
      colors: {
        ivory: '#0d171b',
        surface: '#121f24',
        sand: '#18282e',
        'sand-deep': '#203339',
        line: '#263a41',
        'line-strong': '#435d65',
        ink: '#eef5f4',
        'ink-2': '#dbe7e6',
        'ink-soft': '#c0d2d2',
        'ink-muted': '#a3b8b9',
        gold: '#d2b47a',
        'gold-light': '#ecdcb9',
        'gold-deep': '#7fd2d0',
        rose: '#c9a093',
        'rose-soft': '#33272a',
        'rose-deep': '#e3b8ad',
        success: '#9bd0b0',
        'success-soft': '#15291f',
        'success-line': '#2e4b3b',
        warning: '#e0c07d',
        'warning-soft': '#2b2416',
        'warning-line': '#54462a',
        danger: '#efa198',
        'danger-soft': '#371f1e',
        'danger-line': '#60352f',
        whatsapp: '#5ec98a',
        paper: '#0a1215',
        scrim: '#030607',
      },
      onInk: { gold: '#7a5a22', 'gold-light': '#674b1b' },
      onGold: '#0a1215',
    },
  },
  'civic-gold': {
    id: 'civic-gold',
    name: 'Civic Gold',
    description: 'Crisp white with a warm desert gold and deep charcoal lettering, clean and clear; at night, charcoal with gold.',
    light: {
      colors: {
        ivory: '#f9f8f6',
        surface: '#fefefd',
        sand: '#f2efe9',
        'sand-deep': '#e6e1d8',
        line: '#e3dfd7',
        'line-strong': '#c3bcb0',
        ink: '#232528',
        'ink-2': '#36393d',
        'ink-soft': '#4c4f54',
        'ink-muted': '#5f6166',
        gold: '#b68a35',
        'gold-light': '#eadbb9',
        'gold-deep': '#7c5a1e',
        rose: '#c49c92',
        'rose-soft': '#f5e9e5',
        'rose-deep': '#87534d',
        success: '#2f6a4a',
        'success-soft': '#e8f1eb',
        'success-line': '#c4dbcc',
        warning: '#81601b',
        'warning-soft': '#f7efdc',
        'warning-line': '#e8d4a7',
        danger: '#9a3a35',
        'danger-soft': '#f7e6e2',
        'danger-line': '#e7c3bc',
        whatsapp: '#1f7a47',
        paper: '#ffffff',
        scrim: '#232528',
      },
    },
    dark: {
      colors: {
        ivory: '#141516',
        surface: '#1b1c1e',
        sand: '#222326',
        'sand-deep': '#2c2d30',
        line: '#333438',
        'line-strong': '#56575c',
        ink: '#f4f2ee',
        'ink-2': '#e3e1dc',
        'ink-soft': '#cbc8c2',
        'ink-muted': '#b1aea8',
        gold: '#d1a654',
        'gold-light': '#eadbb9',
        'gold-deep': '#e0bb72',
        rose: '#c49c92',
        'rose-soft': '#33282a',
        'rose-deep': '#dfb9b1',
        success: '#9bcdae',
        'success-soft': '#18291f',
        'success-line': '#30493a',
        warning: '#e0c07d',
        'warning-soft': '#2c2416',
        'warning-line': '#55462a',
        danger: '#efa198',
        'danger-soft': '#381f1d',
        'danger-line': '#61352f',
        whatsapp: '#5ec98a',
        paper: '#0f1011',
        scrim: '#050505',
      },
      onInk: { gold: '#78571a', 'gold-light': '#664a16' },
      onGold: '#0f1011',
    },
  },
  'digital-skyline': {
    id: 'digital-skyline',
    name: 'Digital Skyline',
    description: 'White and cool grey with a vivid teal-to-sky accent and navy ink, like a smart-city app; at night, navy with sky lights.',
    light: {
      colors: {
        ivory: '#f5f7fa',
        surface: '#fdfdfe',
        sand: '#ecf0f4',
        'sand-deep': '#dfe5ec',
        line: '#dde3ea',
        'line-strong': '#b6c0cc',
        ink: '#0d2340',
        'ink-2': '#1f3654',
        'ink-soft': '#38506d',
        'ink-muted': '#4c627d',
        gold: '#3cc0d2',
        'gold-light': '#c6edf3',
        'gold-deep': '#0a6584',
        rose: '#c29aa0',
        'rose-soft': '#f4e9ec',
        'rose-deep': '#86505b',
        success: '#2b6a4c',
        'success-soft': '#e7f2ec',
        'success-line': '#c2dccc',
        warning: '#80601b',
        'warning-soft': '#f6efdc',
        'warning-line': '#e6d4a8',
        danger: '#9b3a3a',
        'danger-soft': '#f7e6e5',
        'danger-line': '#e7c3c0',
        whatsapp: '#1f7a47',
        paper: '#ffffff',
        scrim: '#0d2340',
      },
    },
    dark: {
      colors: {
        ivory: '#0b1220',
        surface: '#101a2a',
        sand: '#162235',
        'sand-deep': '#1e2c41',
        line: '#24334a',
        'line-strong': '#41546f',
        ink: '#ecf3fa',
        'ink-2': '#d9e4f0',
        'ink-soft': '#bfcddd',
        'ink-muted': '#a2b2c6',
        gold: '#4fd0e0',
        'gold-light': '#c6edf3',
        'gold-deep': '#82dbe8',
        rose: '#c29aa0',
        'rose-soft': '#30252e',
        'rose-deep': '#e0b6bd',
        success: '#9bd0b0',
        'success-soft': '#14281f',
        'success-line': '#2d4a3b',
        warning: '#e0c07d',
        'warning-soft': '#2a2316',
        'warning-line': '#53452a',
        danger: '#f0a29c',
        'danger-soft': '#361e22',
        'danger-line': '#5e3536',
        whatsapp: '#5ec98a',
        paper: '#070d18',
        scrim: '#02040a',
      },
      onInk: { gold: '#0a5a73', 'gold-light': '#084b60' },
      onGold: '#070d18',
    },
  },
  'palm-fresh': {
    id: 'palm-fresh',
    name: 'Palm Fresh',
    description: 'Bright white with palm green and a coral accent, garden-terrace fresh; at night, deep palm with coral lights.',
    light: {
      colors: {
        ivory: '#f8f9f5',
        surface: '#fefefc',
        sand: '#eff2ea',
        'sand-deep': '#e2e8db',
        line: '#dfe4d8',
        'line-strong': '#bac4b1',
        ink: '#1a2e24',
        'ink-2': '#2b4135',
        'ink-soft': '#43584c',
        'ink-muted': '#55695d',
        gold: '#ee8c70',
        'gold-light': '#f9d8cc',
        'gold-deep': '#22694a',
        rose: '#e59a88',
        'rose-soft': '#fbebe5',
        'rose-deep': '#9b4430',
        success: '#2b6a4a',
        'success-soft': '#e7f1ea',
        'success-line': '#c2dbca',
        warning: '#80601b',
        'warning-soft': '#f7efdc',
        'warning-line': '#e8d4a7',
        danger: '#9b3a35',
        'danger-soft': '#f8e6e2',
        'danger-line': '#e8c3bc',
        whatsapp: '#1f7a47',
        paper: '#ffffff',
        scrim: '#1a2e24',
      },
    },
    dark: {
      colors: {
        ivory: '#0e1612',
        surface: '#141e19',
        sand: '#1a2620',
        'sand-deep': '#233029',
        line: '#2a3931',
        'line-strong': '#475a50',
        ink: '#eff4ee',
        'ink-2': '#dde6dc',
        'ink-soft': '#c3d0c4',
        'ink-muted': '#a7b6aa',
        gold: '#f09a80',
        'gold-light': '#f9d8cc',
        'gold-deep': '#8fd3ab',
        rose: '#e59a88',
        'rose-soft': '#38251f',
        'rose-deep': '#f3b6a6',
        success: '#9bd0b0',
        'success-soft': '#16291f',
        'success-line': '#2e4b3b',
        warning: '#e0c07d',
        'warning-soft': '#2b2416',
        'warning-line': '#54462a',
        danger: '#f0a29a',
        'danger-soft': '#381f1c',
        'danger-line': '#61352f',
        whatsapp: '#5ec98a',
        paper: '#0a110e',
        scrim: '#030504',
      },
      onInk: { gold: '#9a3f28', 'gold-light': '#853522' },
      onGold: '#0a110e',
    },
  },
};

export function isLookPreset(id: unknown): id is LookPresetId {
  return typeof id === 'string' && (LOOK_PRESET_IDS as readonly string[]).includes(id);
}
export function isLookMode(mode: unknown): mode is LookMode {
  return typeof mode === 'string' && (LOOK_MODES as readonly string[]).includes(mode);
}

/** "--color-ivory:#…;--color-surface:#…;…" for one variant (as CSS declarations). */
export function paletteDeclarations(colors: Palette): string {
  return (Object.keys(colors) as Token[]).map((t) => `--color-${t}:${colors[t]};`).join('');
}

/** The same, as a React style object (the admin's preview cards). */
export function paletteStyle(colors: Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of Object.keys(colors) as Token[]) out[`--color-${t}`] = colors[t];
  return out;
}

/**
 * A festival accent for dark surfaces: the light-mode accent (dark, for ivory) lifted toward
 * pearl until it reads at 4.5:1 or more on every dark variant's surfaces and on the greeting
 * band's dark tint. The festival catalogue and its dates are untouched; this is only the theme
 * layer's dark counterpart of each accent.
 */
export function festiveAccentForDark(accent: string): string {
  const darkest = Object.values(LOOK_PRESETS).flatMap((p) => [p.dark.colors.ivory, p.dark.colors.surface, p.dark.colors.sand]);
  for (let t = 0.3; t <= 1.0001; t += 0.02) {
    const c = mix(accent, '#f6efe4', t);
    const band = darkest.map((bg) => mix(c, bg, 1 - FESTIVE_SOFT_DARK_PCT / 100));
    if ([...darkest, ...band].every((bg) => contrast(c, bg) >= 4.6)) return c;
  }
  return '#f6efe4';
}

/** The greeting band in dark variants: this much of the dark accent over the card colour. */
export const FESTIVE_SOFT_DARK_PCT = 14;

/** The festival's glow (motif, story ring) on dark: a touch lighter so the fine line shows. */
export function festiveGlowForDark(glow: string): string {
  return mix(glow, '#f6efe4', 0.15);
}

/**
 * The stylesheet for the chosen look (served as /look.css, before the page paints). Light only,
 * dark only, or both with the device's choice deciding. `html:root` outranks globals.css's own
 * `:root` and `[data-festive]` rules whichever file the browser reads first.
 */
export function lookCss(preset: LookPresetId, mode: LookMode): string {
  const p = LOOK_PRESETS[preset] ?? LOOK_PRESETS[DEFAULT_LOOK_PRESET];
  const light = `html:root{color-scheme:light;${paletteDeclarations(p.light.colors)}}`;
  const dark = darkRules(p.dark);
  const head = `/* Beautiful UAE Home: ${p.name}, ${MODE_LABELS[mode] ?? mode} */\n`;
  if (mode === 'light') return head + light + '\n';
  if (mode === 'dark') return head + dark + '\n';
  return `${head}${light}\n@media (prefers-color-scheme: dark){${dark}}\n`;
}

function darkRules(v: LookVariant): string {
  const onInk = v.onInk ? `html:root .bg-ink,html:root .bg-ink-2{--color-gold:${v.onInk.gold};--color-gold-light:${v.onInk['gold-light']};}` : '';
  // A gold button inside an ink panel keeps the look's own champagne (not the panel's deeper gold).
  const onGold = v.onGold ? `html:root .bg-gold{--color-ink:${v.onGold};}html:root .bg-ink .bg-gold,html:root .bg-ink-2 .bg-gold{--color-gold:${v.colors.gold};--color-gold-light:${v.colors["gold-light"]};}` : "";
  return (
    `html:root{color-scheme:dark;${paletteDeclarations(v.colors)}}` +
    // Festival accents: the lifted dark counterparts set beside the light ones (festiveVars).
    `html:root [data-festive]{--festive-now:var(--festive-dark);--festive-soft-now:color-mix(in srgb,var(--festive-dark) ${FESTIVE_SOFT_DARK_PCT}%,var(--color-surface));--festive-glow-now:var(--festive-glow-dark);}` +
    // Photos sit on their own, not glaring out of the dark page.
    `html:root img.photo{filter:brightness(.94);}` +
    onInk +
    onGold
  );
}

/* ---- small colour helpers (no dependency on the festival catalogue) ---- */

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function hex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
/** a mixed toward b by t (0 = a, 1 = b), in sRGB like CSS color-mix(in srgb). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}
function lum(c: string): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(c);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
