import type { MetadataRoute } from 'next';
import { sitemapEntries, sitemapXmlEntries } from '@/lib/server/seo';
import { publicSiteUrl } from '@/lib/server/siteUrl';

/**
 * /sitemap.xml: the shop, its category pages, the festival gift pages (a high priority and a
 * fresh date while live, a lower one between seasons; switched-off ones left out) and every
 * product on sale, with its photos. Never hidden or removed products, shared selections, private
 * pages, the APIs or anything of the Admin Hub (src/lib/server/seo.ts).
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // A sitemap lists full addresses, so it needs the shop's own (NEXT_PUBLIC_APP_URL): never an
  // unknown Host header. Without it the sitemap is valid and empty, rather than naming another site.
  const base = await publicSiteUrl();
  return base ? sitemapXmlEntries(sitemapEntries(base)) : [];
}
