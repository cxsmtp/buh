/**
 * Headers of a printable order document (src/lib/server/taxDocument.ts): HTML with its own inline
 * style and no scripts at all, never cached, never indexed, no referrer. next.config.ts sends the
 * same policy for these addresses (DOCUMENT_CSP).
 */
export const DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const DOCUMENT_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': DOCUMENT_CSP,
};
