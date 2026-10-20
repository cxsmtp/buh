import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/server/siteUrl';

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
  const base = await siteUrl();
  return { rules: [{ userAgent: '*', allow: '/', disallow: ROBOTS_DISALLOW }], sitemap: `${base}/sitemap.xml`, host: base };
}
