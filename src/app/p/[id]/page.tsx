import type { Metadata } from 'next';
import { ShopApp } from '@/components/ShopApp';
import { getProduct } from '@/lib/server/products';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * A product's own link (/p/<id>), for sharing on WhatsApp and Instagram: the
 * preview shows the product's photo, name and price, and opening it shows the
 * shop with that product open. Unknown or hidden products show the shop.
 */

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const product = getProduct(id);
  const brand = getSettings('brand');
  if (!product || !product.active || product.archived) return { title: brand.storeName };
  const base = await siteUrl();
  const image = product.aiTransformedImage || product.featuredImage;
  const title = `${product.title} · AED ${product.price}`;
  const description = (product.shortDescription || product.description).slice(0, 200);
  return {
    title: `${product.title} | ${brand.storeName}`,
    description,
    alternates: { canonical: `${base}/p/${product.id}` },
    openGraph: {
      type: 'website',
      siteName: brand.storeName,
      title,
      description,
      url: `${base}/p/${product.id}`,
      images: image ? [{ url: image.startsWith('http') ? image : `${base}${image}`, alt: product.title }] : undefined,
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function ProductPage({ params }: Props) {
  const { id } = await params;
  return <ShopApp initialProductId={id.slice(0, 80)} />;
}
