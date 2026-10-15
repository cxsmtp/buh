import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/server/siteUrl';

/** /robots.txt: the shop is public; the APIs and admin are not for crawlers. */
export const dynamic = 'force-dynamic';

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = await siteUrl();
  return { rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }], sitemap: `${base}/sitemap.xml` };
}
