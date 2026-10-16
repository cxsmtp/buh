import { appIconPng } from '@/lib/server/appIcons';

/** The app's home-screen icons, drawn from the logo (src/lib/server/appIcons.tsx). */
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const pending = appIconPng((await params).file);
  if (!pending) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(await pending), {
    headers: {
      'Content-Type': 'image/png',
      // The manifest asks for ?v=<logo version>, so a new logo is a new address.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
