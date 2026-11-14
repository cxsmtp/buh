import type { MetadataRoute } from 'next';
import { publicSiteUrl } from '@/lib/server/siteUrl';

/**
 * /robots.txt: the shop is open to crawlers; the APIs and the private pages a customer is sent
 * (a bank transfer's /pay, an invoice) are not. The Admin Hub is never named here: its address is
 * private, and naming any admin path would only tell a stranger where to look. Shared selections
 * (/c/…) stay crawlable on purpose: each says noindex itself, which a crawler can only read if it
 * may fetch the page. Points to the sitemap.
 */
export const dynamic = 'force-dynamic';

const ROBOTS_DISALLOW = ['/api/', '/pay/', '/invoice/'];

export default async function robots(): Promise<MetadataRoute.Robots> {
  // The shop's own address, never an unknown Host header: without one, the rules alone (no
  // Sitemap or Host line; crawlers still find /sitemap.xml by its usual name).
  const base = await publicSiteUrl();
  return { rules: [{ userAgent: '*', allow: '/', disallow: ROBOTS_DISALLOW }], ...(base ? { sitemap: `${base}/sitemap.xml`, host: base } : {}) };
}
