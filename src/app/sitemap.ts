import type { MetadataRoute } from 'next';
import { sitemapEntries, sitemapXmlEntries } from '@/lib/server/seo';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * /sitemap.xml: the shop, its category pages, the festival gift pages (a high priority and a
 * fresh date while live, a lower one between seasons; switched-off ones left out) and every
 * product on sale, with its photos. Never hidden or removed products, shared selections, private
 * pages, the APIs or anything of the Admin Hub (src/lib/server/seo.ts).
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await siteUrl();
  return sitemapXmlEntries(sitemapEntries(base));
}
