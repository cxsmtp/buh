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
 *
 * Firebase Phone Authentication (an optional SMS method) needs Google's
 * reCAPTCHA scripts and frames and Firebase's auth APIs. The policy is fixed
 * at build time, so these few Google hosts are always listed, even while
 * Firebase is off (docs/security.md explains the trade).
 */
export const FIREBASE_PHONE_AUTH_SOURCES = {
  script: ['https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/', 'https://apis.google.com'],
  frame: ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/', 'https://*.firebaseapp.com'],
  connect: ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://www.google.com/recaptcha/'],
};

export function contentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === 'development';
  const fb = FIREBASE_PHONE_AUTH_SOURCES;
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} ${fb.script.join(' ')}`,
    // React style attributes need inline styles.
    "style-src 'self' 'unsafe-inline'",
    // Product photos come from https hosts; admin uploads are data:/blob: URLs.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // The shop's own service worker (/sw.js) and the order-confirmation confetti, which draws in a
    // worker created from a blob: URL. Nothing from other sites.
    "worker-src 'self' blob:",
    // The installable app's manifest (/manifest.webmanifest), from this site only.
    "manifest-src 'self'",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''} ${fb.connect.join(' ')}`,
    `frame-src 'self' ${fb.frame.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
