/**
 * The shop's Content Security Policy, sent on every page (next.config.ts).
 *
 * Scripts are limited to this site; inline scripts are allowed because
 * Next.js bootstraps with them. Everything else is locked down: no plugins,
 * no <base> hijack, no framing, forms and fetches only to this site.
 *
 * A per-request nonce policy also blocks injected inline scripts, but a page
 * can only carry a nonce when it is rendered for each request. Measured on this
 * shop, rendering the storefront's kept pages per request took them from ~790
 * to ~145 requests/s, and even an idle proxy cost ~35%. So: the pages that are
 * rendered per request anyway (the Admin Hub, the private pay, deal and
 * tracking pages, a shared selection, the terms, order-by-photo) get the nonce
 * policy, set by the front gate with no proxy (src/lib/server/cspNonce.ts,
 * frontGate.ts); the kept pages (home, category, festival, product) keep this
 * static one. Their inline scripts are the framework's page data, different
 * for every page and every rebuild, so a fixed list of hashes cannot cover
 * them. React escapes all rendered text and the shop has no raw-HTML sinks.
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

/** The whole policy around one script-src (the rest is the same for every page). */
export function policyWithScripts(scriptSrc: string): string {
  const isDev = process.env.NODE_ENV === 'development';
  const fb = FIREBASE_PHONE_AUTH_SOURCES;
  const st = STRIPE_SOURCES;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}${isDev ? " 'unsafe-eval'" : ''}`,
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

/** The other sites' scripts the shop's checkout may load (Firebase's reCAPTCHA, Stripe.js). */
export const CHECKOUT_SCRIPT_HOSTS = [...FIREBASE_PHONE_AUTH_SOURCES.script, ...STRIPE_SOURCES.script].join(' ');

/**
 * The policy of the pages built ahead of time (the home, category, festival and product pages),
 * fixed at build time (next.config.ts). Pages built for each request get a stricter one, with a
 * per-request nonce and no 'unsafe-inline' for scripts: src/lib/server/cspNonce.ts.
 */
export function contentSecurityPolicy(): string {
  return policyWithScripts(`'self' 'unsafe-inline' ${CHECKOUT_SCRIPT_HOSTS}`);
}

/**
 * A bill's photo, opened on its own from the hub (src/app/api/admin/expenses/[id]/bills/[bill]):
 * the image itself and nothing else; sandboxed, so nothing in it can ever run; never framed. Set
 * for that path in next.config.ts (after the API's own policy, so it is the one sent) and by the
 * route. PDFs are downloaded, not shown: browsers don't open a PDF under a sandbox policy.
 */
/** A PDF opened on its own (an invoice): the browser's PDF viewer, nothing else. */
export const PDF_CSP = "default-src 'none'; object-src 'self'; frame-ancestors 'none'";

export const BILL_CSP = "default-src 'none'; img-src 'self'; frame-ancestors 'none'; sandbox";
