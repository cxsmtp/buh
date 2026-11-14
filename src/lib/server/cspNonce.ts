import { createHash, randomBytes } from 'node:crypto';
import { CHECKOUT_SCRIPT_HOSTS, policyWithScripts } from '../csp';
import { LOCALE_BOOT_SCRIPT } from '../i18n/boot';
import { HUB_ROUTE } from './adminLink';
import { PAY_ROUTE } from './bankPay';
import { DEAL_ROUTE } from './photoDeals';

/**
 * The stricter Content Security Policy of the pages rendered for each request: scripts run only
 * with this request's nonce (no 'unsafe-inline'), so an inline script someone managed to inject
 * does not run. The front gate (frontGate.ts) makes the nonce, puts the policy on the request
 * (Next.js reads the nonce from the request's Content-Security-Policy header and attaches it to
 * its own scripts) and on the answer. Pages built ahead of time cannot carry a nonce: they keep
 * the static policy (src/lib/csp.ts).
 */

/** The one fixed inline script of the shop's own (the language direction, before paint): allowed by its hash. */
export const LOCALE_BOOT_HASH = `'sha256-${createHash('sha256').update(LOCALE_BOOT_SCRIPT).digest('base64')}'`;

export type NonceKind = 'private' | 'shop';

/**
 * Which per-request pages get the nonce policy, by their (normalised) path:
 * - 'private': the Admin Hub and a bank transfer's private pay page. No other site's script is
 *   ever needed there: this site's own files and scripts carrying the nonce, nothing else.
 * - 'shop': the storefront pages rendered per request (a product's page, a tracking link, a shared
 *   selection, a photo deal's private page, the terms, order-by-photo). They hold the checkout, so Stripe.js and Firebase's
 *   reCAPTCHA stay allowed by host exactly as on the kept pages; only 'unsafe-inline' is gone.
 *
 * No 'strict-dynamic': it would let any running script add scripts from anywhere (it switches the
 * host list off), and this app needs nothing from outside its short list. Tried in a browser: with
 * it, a script added by script from another site ran; without it, it is refused.
 */
export function nonceKindFor(path: string): NonceKind | null {
  if (path === HUB_ROUTE || path.startsWith(`${PAY_ROUTE}/`)) return 'private';
  if (path.startsWith(`${DEAL_ROUTE}/`) || path.startsWith('/track/') || path.startsWith('/c/') || path.startsWith('/p/') || path === '/terms' || path === '/order-by-photo') return 'shop';
  return null;
}

export function newNonce(): string {
  return randomBytes(18).toString('base64');
}

export function nonceContentSecurityPolicy(nonce: string, kind: NonceKind): string {
  return policyWithScripts(`'self' 'nonce-${nonce}' ${LOCALE_BOOT_HASH}${kind === 'shop' ? ` ${CHECKOUT_SCRIPT_HOSTS}` : ''}`);
}
