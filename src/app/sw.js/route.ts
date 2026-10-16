import { resetWorkerSource, serviceWorkerSource, SW_RESET_HEADER } from '@/lib/serviceWorker';

/**
 * /sw.js: the shop's service worker (src/lib/serviceWorker.ts says what it caches and what it never
 * touches). Built once per release with that release's version in it, so each release is a new
 * worker. Browsers always check it with the server (no-cache), and it may control the whole site.
 *
 * Emergency (docs/user-guide.md, "If the app misbehaves"): with SW_RESET=true in the server's
 * settings it is instead a worker that removes itself and the shop's offline copy from every phone
 * that opens the shop, at once.
 */
export const dynamic = 'force-dynamic';

const runtimeEnv = (name: string) => (process.env as Record<string, string | undefined>)[name]?.trim().toLowerCase();

export function GET() {
  const reset = runtimeEnv('SW_RESET') === 'true';
  return new Response(reset ? resetWorkerSource() : serviceWorkerSource(process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev'), {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, max-age=0, must-revalidate',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
      [SW_RESET_HEADER]: reset ? 'reset' : 'app',
    },
  });
}
