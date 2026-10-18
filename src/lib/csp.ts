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

/**
 * Card payments (Settings → Payments) use Stripe's own script and frames, so card numbers are typed
 * into Stripe, never into this shop (PCI SAQ A). Stripe.js is only loaded at checkout, when card
 * payments are on; like Firebase, the hosts are always listed because the policy is fixed at build
 * time. These are the hosts Stripe documents for Elements: Apple Pay and Google Pay run inside
 * Stripe's frames (js.stripe.com; hooks.stripe.com for 3-D Secure), which next.config.ts also lets
 * use the browser's payment sheet (Permissions-Policy payment), with Google Pay's own pay.google.com.
 */
export const STRIPE_SOURCES = {
  script: ['https://js.stripe.com', 'https://*.js.stripe.com'],
  frame: ['https://js.stripe.com', 'https://*.js.stripe.com', 'https://hooks.stripe.com'],
  connect: ['https://api.stripe.com'],
};

export function contentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === 'development';
  const fb = FIREBASE_PHONE_AUTH_SOURCES;
  const st = STRIPE_SOURCES;
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} ${fb.script.join(' ')} ${st.script.join(' ')}`,
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
    `connect-src 'self'${isDev ? ' ws: wss:' : ''} ${fb.connect.join(' ')} ${st.connect.join(' ')}`,
    `frame-src 'self' ${fb.frame.join(' ')} ${st.frame.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
