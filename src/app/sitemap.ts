import type { MetadataRoute } from 'next';
import { listProducts } from '@/lib/server/products';
import { siteUrl } from '@/lib/server/siteUrl';

/** /sitemap.xml: the shop and every product page, so search engines find them. */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await siteUrl();
  return [
    { url: `${base}/`, changeFrequency: 'daily', priority: 1 },
    ...listProducts().map((p) => ({ url: `${base}/p/${encodeURIComponent(p.id)}`, changeFrequency: 'weekly' as const, priority: 0.8 })),
  ];
}
