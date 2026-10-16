/**
 * /reset-app: the emergency reset for phones that installed the shop as an app. Only while the
 * owner has set SW_RESET=true (otherwise 404, so nobody can wipe a shopper's bag with a link).
 *
 * It answers with `Clear-Site-Data: "cache", "storage"`: the browser deletes this site's offline
 * copy, the service worker, and what the shop kept on the phone (the bag, the delivery details,
 * the feed layout). Sign-in cookies are kept. Then it offers the shop again.
 */
import { PALETTE } from '@/lib/design/tokens';

export const dynamic = 'force-dynamic';

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>The app was reset</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: ${PALETTE.ivory}; color: ${PALETTE.ink}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; padding: 24px; box-sizing: border-box; }
  main { max-width: 22rem; text-align: center; }
  h1 { font-family: Georgia, serif; font-weight: 500; color: ${PALETTE.ink}; font-size: 1.4rem; }
  p { color: ${PALETTE['ink-soft']}; line-height: 1.55; }
  a { display: inline-block; margin-top: 12px; background: ${PALETTE.ink}; color: #fff; text-decoration: none; font-weight: 600; border-radius: 999px; padding: 14px 28px; }
</style>
</head>
<body>
<main>
  <h1>The app was reset</h1>
  <p>The shop’s saved copy on this phone has been removed. Open the shop to continue.</p>
  <a href="/">Open the shop</a>
</main>
</body>
</html>
`;

export function GET() {
  if ((process.env as Record<string, string | undefined>).SW_RESET?.trim().toLowerCase() !== 'true') {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new Response(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Clear-Site-Data': '"cache", "storage"',
    },
  });
}
