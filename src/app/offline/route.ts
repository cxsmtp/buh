/**
 * /offline: what the installed app shows when a page is opened without a connection (the service
 * worker keeps a copy). One small self-contained page, no scripts or styles from the app, so it
 * works on its own: it says what happened, that the bag is safe, and tries again by itself when
 * the phone is back online.
 */
import { PALETTE } from '@/lib/design/tokens';

export const dynamic = 'force-static';

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${PALETTE.ink}">
<meta name="robots" content="noindex">
<title>You are offline</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; height: 100%; }
  body {
    background: ${PALETTE.ivory}; color: ${PALETTE.ink};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: max(24px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
    box-sizing: border-box; -webkit-tap-highlight-color: transparent; overscroll-behavior: none;
  }
  main { max-width: 22rem; text-align: center; }
  .mark { width: 72px; height: 72px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; background: ${PALETTE.sand}; color: ${PALETTE['gold-deep']}; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 500; font-size: 1.5rem; line-height: 1.25; margin: 0 0 10px; color: ${PALETTE.ink}; }
  p { font-size: 0.95rem; line-height: 1.55; margin: 0 0 12px; color: ${PALETTE['ink-soft']}; }
  button { margin-top: 12px; font: inherit; font-weight: 600; font-size: 0.95rem; color: #fff; background: ${PALETTE.ink}; border: 0; border-radius: 999px; padding: 14px 28px; min-height: 48px; cursor: pointer; touch-action: manipulation; }
  button:focus-visible { outline: 2px solid ${PALETTE['gold-deep']}; outline-offset: 3px; }
  .small { font-size: 0.8rem; color: ${PALETTE['ink-muted']}; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M5 12.86a10 10 0 0 1 5.17-2.69"/><path d="M19 12.86a10 10 0 0 0-2-1.41"/><path d="M2 8.82a15 15 0 0 1 4.18-2.65"/><path d="M22 8.82a15 15 0 0 0-11.29-3.76"/><path d="m2 2 20 20"/></svg>
  </div>
  <h1>You are offline</h1>
  <p>The shop needs a connection to show today’s pieces and prices.</p>
  <p>Your bag is saved on this phone. We will open the shop again as soon as you are back online.</p>
  <button type="button" id="retry">Try again</button>
  <p class="small" role="status" id="note"></p>
</main>
<script>
  (function () {
    var note = document.getElementById('note');
    function retry() { note.textContent = 'Trying again…'; location.reload(); }
    document.getElementById('retry').addEventListener('click', retry);
    window.addEventListener('online', retry);
  })();
</script>
</body>
</html>
`;

export function GET() {
  return new Response(HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
