import type { Metadata } from 'next';
import Link from 'next/link';
import { ShopApp } from '@/components/ShopApp';
import { publicCollection } from '@/lib/server/collections';
import { getProduct } from '@/lib/server/products';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * A shared selection (/c/<slug>, made in Inventory → Share these): just those products, in the
 * shop's look, with add to bag. Only products on sale are shown (hidden and removed ones never are);
 * the preview on WhatsApp and Instagram shows the title and the first product's photo. After its
 * last day, or for an address that names none, a friendly page with a way into the shop. Not for
 * search engines: these links are made to be sent, and they end.
 */
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

const shopName = () => getSettings('brand').storeName || 'Beautiful UAE Home';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const c = publicCollection(slug);
  const brand = shopName();
  const robots = { index: false, follow: true };
  if (!c || c.ended) return { title: `This selection has ended | ${brand}`, robots };
  const base = await siteUrl();
  const first = c.productIds.map((id) => getProduct(id)).find(Boolean);
  const image = first ? first.aiTransformedImage || first.featuredImage : '';
  const description = `${c.productIds.length} ${c.productIds.length === 1 ? 'piece' : 'pieces'} chosen for you by ${brand}.`;
  return {
    title: `${c.title} | ${brand}`,
    description,
    robots,
    alternates: { canonical: `${base}/c/${c.slug}` },
    openGraph: {
      type: 'website',
      siteName: brand,
      title: c.title,
      description,
      url: `${base}/c/${c.slug}`,
      images: image ? [{ url: image.startsWith('http') ? image : `${base}${image}`, alt: first?.title ?? c.title }] : undefined,
    },
    twitter: { card: 'summary_large_image', title: c.title, description },
  };
}

export default async function CollectionPage({ params }: Props) {
  const { slug } = await params;
  const c = publicCollection(slug);
  if (!c || c.ended) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-4 py-16 text-center bg-ivory" data-testid="collection-ended">
        <p className="label-caps text-gold-deep">{shopName()}</p>
        <h1 className="mt-3 font-serif text-3xl sm:text-4xl text-ink">{c ? 'This selection has ended' : 'This selection isn’t available'}</h1>
        <p className="mt-3 max-w-sm text-sm text-ink-soft leading-relaxed">
          {c ? 'The pieces chosen here were only shown for a while.' : 'The link may have been changed or taken down.'} Have a look at everything in the shop instead.
        </p>
        <Link href="/" className="mt-6 inline-flex items-center justify-center min-h-12 rounded-full bg-ink text-paper text-sm font-semibold px-6">
          Browse the shop
        </Link>
      </main>
    );
  }
  return <ShopApp collection={{ slug: c.slug, title: c.title, productIds: c.productIds, expiresOn: c.expiresOn }} />;
}
