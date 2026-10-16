import crypto from 'node:crypto';
import type { MetadataRoute } from 'next';
import type { BrandSettings } from '@/types';
import { APP_BACKGROUND_COLOR, PALETTE, THEME_COLOR } from '@/lib/design/tokens';

/**
 * The installable app (web app manifest) and its icons, from Settings → Branding: the shop's name
 * on the home screen, and the logo (or its letters on the brand colour) as the icon.
 */

export const APP_BACKGROUND = APP_BACKGROUND_COLOR;
export const APP_THEME = THEME_COLOR;
const DEFAULT_NAME = 'Beautiful UAE Home';

/** "BEAUTIFUL UAE HOME" reads better as "Beautiful UAE Home" under an icon (short words stay as typed). */
export function displayName(storeName: string | undefined): string {
  const name = (storeName || '').replace(/\s+/g, ' ').trim().slice(0, 60) || DEFAULT_NAME;
  if (name !== name.toUpperCase() || !/[A-Z]/.test(name)) return name;
  return name
    .split(' ')
    .map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()))
    .join(' ');
}

/** The label under the icon: phones show about 12 letters, so drop words from the front until it fits. */
export function shortName(name: string): string {
  if (name.length <= 12) return name;
  const words = name.split(' ');
  for (let i = 1; i < words.length; i++) {
    const rest = words.slice(i).join(' ');
    if (rest.length <= 12 && rest.length >= 4) return rest;
  }
  return name.slice(0, 12).trim();
}

/** Changes when the logo, its letters or the colour change, so phones fetch the new icon. */
export function iconVersion(brand: Pick<BrandSettings, 'logoType' | 'logoText' | 'logoImageUrl' | 'accentColor'>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([brand.logoType, brand.logoText, brand.logoImageUrl, brand.accentColor]))
    .digest('hex')
    .slice(0, 10);
}

/** A phone (not a tablet or computer): Android phones say "Mobile", iPhones "iPhone". */
export function isPhoneAgent(ua: string): boolean {
  return /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua));
}

export function buildManifest(brand: BrandSettings, userAgent: string): MetadataRoute.Manifest {
  const name = displayName(brand.storeName);
  const v = iconVersion(brand);
  const icon = (file: string, size: number, purpose: 'any' | 'maskable') => ({ src: `/icons/${file}?v=${v}`, sizes: `${size}x${size}`, type: 'image/png', purpose });
  return {
    id: '/',
    name,
    short_name: shortName(name),
    description: (brand.tagline || 'Bed linen delivered across the UAE').slice(0, 200),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // Upright on phones, like a shopping app; tablets turn freely (the product shows side by side when wide).
    orientation: isPhoneAgent(userAgent) ? 'portrait-primary' : 'any',
    background_color: APP_BACKGROUND,
    theme_color: APP_THEME,
    lang: 'en',
    dir: 'ltr',
    categories: ['shopping', 'lifestyle'],
    icons: [icon('icon-192.png', 192, 'any'), icon('icon-512.png', 512, 'any'), icon('maskable-192.png', 192, 'maskable'), icon('maskable-512.png', 512, 'maskable')],
    shortcuts: [
      { name: 'Bag', short_name: 'Bag', description: 'Your shopping bag', url: '/?open=bag', icons: [{ src: `/icons/icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png' }] },
      { name: 'Track Order', short_name: 'Track', description: 'Where your order is', url: '/?open=track', icons: [{ src: `/icons/icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png' }] },
    ],
  };
}

/** The icon files the app offers: name → size, and whether it is the full-bleed "maskable" kind. */
export const ICON_FILES: Record<string, { size: number; maskable: boolean }> = {
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'maskable-192.png': { size: 192, maskable: true },
  'maskable-512.png': { size: 512, maskable: true },
  'apple-touch-icon.png': { size: 180, maskable: true },
};

/** A colour safe to put in an image: #rgb or #rrggbb, else the brand gold. */
export function safeColor(c: string | undefined, fallback: string = PALETTE.gold): string {
  return c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : fallback;
}
