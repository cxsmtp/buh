/**
 * The shop's Content Security Policy, sent on every page (next.config.ts).
 *
 * Scripts are limited to this site; inline scripts are allowed because
 * Next.js bootstraps with them. Everything else is locked down: no plugins,
 * no <base> hijack, no framing, forms and fetches only to this site.
 *
 * A per-request nonce policy would also block injected inline scripts, but it
 * forces every page to render per request. Measured on this shop: the
 * storefront fell from ~790 to ~145 requests/s, and even an idle proxy cost
 * ~35%. React escapes all rendered text and the shop has no raw-HTML sinks,
 * so the static policy is the better trade (docs/security.md).
 */
export function contentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
    // React style attributes need inline styles.
    "style-src 'self' 'unsafe-inline'",
    // Product photos come from https hosts; admin uploads are data:/blob: URLs.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // Order-confirmation confetti draws in a worker created from a blob: URL.
    "worker-src 'self' blob:",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
