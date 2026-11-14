import { readImage } from '@/lib/server/images';
import { readImageVariant, variantWidth } from '@/lib/server/imageVariants';

/**
 * Uploaded product photos and logo. Content-addressed, so cached for a year.
 * ?w=240|540|1080: a smaller copy for a phone card (made once, then kept; never bigger than the
 * original). Any other width, or none, is the original. Both are sent with the same headers.
 */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const width = variantWidth(new URL(req.url).searchParams.get('w'));
  const image = width ? await readImageVariant(name, width) : readImage(name);
  if (!image) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(image.bytes), {
    headers: {
      'Content-Type': image.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
