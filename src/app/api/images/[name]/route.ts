import { readImage } from '@/lib/server/images';

/** Uploaded product photos and logo. Content-addressed, so cached for a year. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const image = readImage((await params).name);
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
