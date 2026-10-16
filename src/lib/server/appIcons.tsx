import { ImageResponse } from 'next/og';
import type { BrandSettings } from '@/types';
import { ICON_FILES, iconVersion, safeColor } from './appManifest';
import { LOGO_MAX_SIDE, readImage } from './images';
import { imageDimensions } from './imageInput';
import { getSettings } from './settings';

/**
 * The app's home-screen icons (/icons/icon-192.png, icon-512, maskable-192, maskable-512,
 * apple-touch-icon), drawn when asked: the uploaded logo (PNG or JPEG) on white, or the logo's
 * letters on the brand colour. "Maskable" icons fill the square edge to edge with the mark inside
 * the middle 80%, so Android can cut them into a circle or a squircle without losing anything.
 *
 * Drawn once per logo and size, then kept in memory. Requests that arrive while one is being drawn
 * (many phones at once after a restart or a new logo) wait for that drawing instead of starting
 * their own. A logo bigger than LOGO_MAX_SIDE on a side, or whose size can't be read from its
 * header, is never handed to the drawing library: the letters are drawn instead.
 */

const drawn = new Map<string, Promise<Uint8Array>>();
/** How many icons were actually drawn (for tests). */
export const iconStats = { draws: 0 };

/** The PNG for an icon file name, or null if there is no such icon. */
export function appIconPng(name: string): Promise<Uint8Array> | null {
  const file = ICON_FILES[name];
  if (!file) return null;
  const brand = getSettings('brand');
  const key = `${name}:${iconVersion(brand)}`;
  let pending = drawn.get(key);
  if (!pending) {
    if (drawn.size > 40) drawn.clear();
    pending = draw(brand, file.size, file.maskable);
    drawn.set(key, pending);
    // A failed drawing is not kept: the next request tries again.
    pending.catch(() => drawn.delete(key));
  }
  return pending;
}

/** The uploaded logo as a data URL, if it is one of ours, PNG or JPEG, and not oversized. */
export function logoForIcon(brand: Pick<BrandSettings, 'logoType' | 'logoImageUrl'>): string | null {
  const m = brand.logoType === 'image' ? /^\/api\/images\/([a-f0-9]{64}\.(png|jpg))$/.exec(brand.logoImageUrl || '') : null;
  if (!m) return null;
  const img = readImage(m[1]);
  const d = img ? imageDimensions(img.bytes) : null;
  if (!img || !d || d.width < 1 || d.height < 1 || d.width > LOGO_MAX_SIDE || d.height > LOGO_MAX_SIDE) return null;
  return `data:${img.mime};base64,${img.bytes.toString('base64')}`;
}

async function draw(brand: BrandSettings, size: number, maskable: boolean): Promise<Uint8Array> {
  iconStats.draws++;
  const accent = safeColor(brand.accentColor);
  const logo = logoForIcon(brand);
  const letters = (brand.logoText || 'BU').trim().slice(0, 3) || 'BU';
  // Maskable: the mark sits inside the middle 80% (the "safe zone"); plain icons fill more.
  const inner = Math.round(size * (maskable ? 0.62 : 0.8));
  const res = new ImageResponse(
    logo ? (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff', borderRadius: maskable ? 0 : size * 0.22 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" width={inner} height={inner} style={{ objectFit: 'contain' }} />
      </div>
    ) : (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${accent}, #9f7e38)`,
          borderRadius: maskable ? 0 : size * 0.22,
          color: '#ffffff',
          fontSize: Math.round(inner * (letters.length > 2 ? 0.36 : 0.46)),
          fontWeight: 700,
          letterSpacing: size * 0.01,
        }}
      >
        {letters}
      </div>
    ),
    { width: size, height: size }
  );
  return new Uint8Array(await res.arrayBuffer());
}
