import { currentLookCss } from '@/lib/server/look';
import { logEvent } from '@/lib/server/log';

/**
 * /look.css: the chosen look's colours (Settings → Look), linked in every page's head so the page
 * paints in the right look at once, light or dark as the device or the owner says, with no
 * script. The front page stays a static page (it is the same for every visitor); only this small
 * file follows the setting. Checked with the server on every page load (an unchanged look is a
 * 304), so a change shows on the next page load. Nothing in it is private.
 */
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  let css = '';
  let etag = '"none"';
  try {
    ({ css, etag } = currentLookCss());
  } catch (err) {
    // Never let a settings problem unstyle the shop: globals.css already holds Ivory & Gold.
    logEvent('warn', 'look_css_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  const headers = {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'public, max-age=0, must-revalidate',
    ETag: etag,
  };
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(css, { headers });
}
