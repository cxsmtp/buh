'use client';

import { useEffect, useState } from 'react';
import { reloadOnceForChunk } from '@/lib/client/chunkReload';
import { PALETTE } from '@/lib/design/tokens';

/**
 * The last safety net: the page's own frame (the root layout) broke, so this draws its own page,
 * with no styles of the shop to lean on. Same promise as src/app/error.tsx: a missing piece of the
 * shop (after an update) reloads the page once by itself, and otherwise a Reload button, in English
 * and Arabic. The bag and the details typed at checkout are saved in the browser.
 */
export default function GlobalError({ error }: { error: unknown; retry: () => void }) {
  const [reloading, setReloading] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReloading(reloadOnceForChunk(error));
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: PALETTE.ivory, color: PALETTE.ink, fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif', textAlign: 'center' }}>
        {reloading ? (
          <p role="status">One moment…</p>
        ) : (
          <div role="alert" data-testid="shop-error" style={{ maxWidth: 360 }}>
            <h1 style={{ fontSize: 22, margin: '0 0 8px' }}>Please reload the page</h1>
            <p style={{ fontSize: 14, margin: '0 0 6px' }}>Something went wrong while showing this page. Your bag and your details are saved.</p>
            <p style={{ fontSize: 14, margin: '0 0 16px' }} dir="rtl" lang="ar-AE">حدث خطأ أثناء عرض هذه الصفحة. حقيبتك وبياناتك محفوظة.</p>
            <button type="button" onClick={() => window.location.reload()} style={{ minHeight: 44, padding: '0 20px', borderRadius: 999, border: 0, background: PALETTE.ink, color: PALETTE.paper, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Reload · إعادة التحميل
            </button>
          </div>
        )}
      </body>
    </html>
  );
}
