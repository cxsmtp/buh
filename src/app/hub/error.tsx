'use client';

import { useEffect } from 'react';

/**
 * When something in the Admin Hub breaks: say so in the hub's own words, show what broke (so a
 * screenshot tells us), report it to the server's log, and offer to try again. Never the page's
 * address in the report: it is the private link.
 */
export default function HubError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    void fetch('/api/admin/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ message: String(error?.message || 'Unknown error').slice(0, 500) || 'Unknown error', stack: String(error?.stack || '').slice(0, 3000), where: error?.digest ? `digest ${error.digest}`.slice(0, 60) : 'hub' }),
    }).catch(() => undefined);
  }, [error]);

  return (
    <main className="min-h-screen bg-ivory flex items-center justify-center px-4">
      <div role="alert" className="max-w-sm w-full space-y-3 text-ink">
        <h1 className="font-serif text-2xl">Something went wrong in the Admin Hub</h1>
        <p className="text-sm text-ink-soft">Nothing was lost. Try again; if it happens again, send us a screenshot of this page.</p>
        <p className="text-xs text-ink-muted break-words font-mono bg-sand rounded-lg p-2">{error?.message || 'Unknown error'}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => retry()} className="px-4 py-2 rounded-full bg-ink text-paper text-sm font-semibold">Try again</button>
          <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-full border border-line-strong text-sm font-semibold">Reload</button>
        </div>
      </div>
    </main>
  );
}
