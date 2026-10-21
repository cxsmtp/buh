import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LandingPage } from '@/components/seo/LandingPage';
import { breadcrumbJsonLd, categoryPages, categoryTexts, deliveryArea, exploreLinks, itemListJsonLd, jsonLdString, productAlt, productsIn, shopName } from '@/lib/server/seo';
import { buildingKeptPage } from '@/lib/server/pageCache';
import { shopUrl } from '@/lib/server/runtimeConfig';

/**
 * A category's own page (/shop/<category id>, one per category in Settings → Catalogue): its
 * products, rendered on the server, with a heading and a short introduction the owner can change
 * (Settings → Search (SEO)). Always indexed; an unknown category is not found.
 */
// Built on the first visit and kept for a minute (rebuilt in the background after that, and at
// once after a product or a setting changes, src/lib/server/pageCache.ts): as fast as a static
// page for crawlers. The shop's address comes from NEXT_PUBLIC_APP_URL only (no request headers,
// which would make it per request). Unknown ids are not found before any other work.
export const revalidate = 60;
export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ category: string }> };

const pageFor = async (params: Props['params']) => {
  buildingKeptPage();
  const id = (await params).category.slice(0, 60);
  return categoryPages().find((c) => c.id === id) ?? null;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = await pageFor(params);
  if (!c) return { title: shopName(), robots: { index: false, follow: true } };
  const base = shopUrl() ?? '';
  const list = productsIn(c.id);
  const t = categoryTexts(c, undefined, list);
  const url = `${base}${c.path}`;
  const image = list[0] ? list[0].aiTransformedImage || list[0].featuredImage : '';
  return {
    title: { absolute: t.title },
    description: t.description,
    // No products yet: reachable, but not offered to search engines (an empty page ranks badly).
    ...(list.length ? {} : { robots: { index: false, follow: true } }),
    ...(base ? { alternates: { canonical: url } } : {}),
    openGraph: { type: 'website', siteName: shopName(), title: t.title, description: t.description, ...(base ? { url } : {}), images: image ? [{ url: image.startsWith('http') ? image : `${base}${image}`, alt: list[0].title }] : undefined },
    twitter: { card: 'summary_large_image', title: t.title, description: t.description },
  };
}

export default async function CategoryPage({ params }: Props) {
  const c = await pageFor(params);
  if (!c) notFound();
  const base = shopUrl() ?? '';
  const list = productsIn(c.id);
  const t = categoryTexts(c, undefined, list);
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: c.label, href: c.path },
  ];
  const links = exploreLinks(new Date(), { exclude: c.path });
  const area = deliveryArea();
  // In stock first, then the owner's order.
  const ordered = [...list].sort((a, b) => (a.stockCount > 0 ? 0 : 1) - (b.stockCount > 0 ? 0 : 1));
  return (
    <LandingPage
      testId="category-page"
      shop={shopName()}
      crumbs={crumbs}
      h1={t.h1}
      intro={t.intro}
      items={ordered.map((product) => ({ product, alt: productAlt(product) }))}
      categories={links.categories}
      festivals={links.festivals}
      delivery={`Delivered to ${area.long} in ${area.days}.`}
      jsonLd={[jsonLdString(breadcrumbJsonLd(base, crumbs.map((x) => ({ name: x.name, path: x.href })))), jsonLdString(itemListJsonLd(base, t.h1, ordered))]}
    />
  );
}
