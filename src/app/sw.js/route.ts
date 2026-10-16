import { serviceWorkerSource } from '@/lib/serviceWorker';

/**
 * /sw.js: the shop's service worker (src/lib/serviceWorker.ts says what it caches and what it never
 * touches). Built once per release with that release's version in it, so each release is a new
 * worker. Browsers always check it with the server (no-cache), and it may control the whole site.
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(serviceWorkerSource(process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev'), {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
