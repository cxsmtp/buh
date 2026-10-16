import { ImageResponse } from 'next/og';
import { ICON_FILES, iconVersion, safeColor } from '@/lib/server/appManifest';
import { readImage } from '@/lib/server/images';
import { getSettings } from '@/lib/server/settings';

/**
 * The app's home-screen icons (/icons/icon-192.png, icon-512, maskable-192, maskable-512,
 * apple-touch-icon), drawn when asked: the uploaded logo (PNG or JPEG) on white, or the logo's
 * letters on the brand colour. "Maskable" icons fill the square edge to edge with the mark inside
 * the middle 80%, so Android can cut them into a circle or a squircle without losing anything.
 * Drawn once per logo and size, then kept in memory.
 */

export const dynamic = 'force-dynamic';

const drawn = new Map<string, Uint8Array>();

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const file = ICON_FILES[(await params).file];
  if (!file) return new Response('Not found', { status: 404 });
  const brand = getSettings('brand');
  const key = `${(await params).file}:${iconVersion(brand)}`;
  let png = drawn.get(key);
  if (!png) {
    png = await draw(brand, file.size, file.maskable);
    if (drawn.size > 40) drawn.clear();
    drawn.set(key, png);
  }
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      // The manifest asks for ?v=<logo version>, so a new logo is a new address.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function draw(brand: ReturnType<typeof getSettings<'brand'>>, size: number, maskable: boolean): Promise<Uint8Array> {
  const accent = safeColor(brand.accentColor);
  // The uploaded logo, read from the shop's own image store (PNG or JPEG: what the drawing library reads).
  let logo: string | null = null;
  const m = brand.logoType === 'image' ? /^\/api\/images\/([a-f0-9]{64}\.(png|jpg))$/.exec(brand.logoImageUrl || '') : null;
  if (m) {
    const img = readImage(m[1]);
    if (img) logo = `data:${img.mime};base64,${img.bytes.toString('base64')}`;
  }
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
