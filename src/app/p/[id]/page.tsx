import { priceLabel } from '@/lib/money';
import type { Metadata } from 'next';
import { ShopApp } from '@/components/ShopApp';
import { getProduct } from '@/lib/server/products';
import { breadcrumbJsonLd, jsonLdString, productAlt, productDescription, productImages, productJsonLd, productTitle, shopName } from '@/lib/server/seo';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * A product's own link (/p/<id>), for sharing on WhatsApp and Instagram and for search engines:
 * the preview shows the product's photo, name and price; the page carries the product as
 * schema.org data (price and stock per size, no ratings); opening it shows the shop with that
 * product open. Unknown or hidden products show the shop, and are not for search engines.
 * Title and description: the owner's own (product editor → Publish), else made by the shop
 * (src/lib/server/seo.ts).
 */

type Props = { params: Promise<{ id: string }> };

const onSale = (id: string) => {
  const product = getProduct(id);
  return product && product.active && !product.archived ? product : null;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const product = onSale(id);
  if (!product) return { title: shopName(), robots: { index: false, follow: true } };
  const base = await siteUrl();
  const image = productImages(product, base)[0];
  const share = `${product.title} · ${priceLabel(product)}`;
  const description = productDescription(product);
  const url = `${base}/p/${encodeURIComponent(product.id)}`;
  return {
    title: { absolute: productTitle(product) },
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: shopName(),
      title: share,
      description,
      url,
      images: image ? [{ url: image, alt: productAlt(product) }] : undefined,
    },
    twitter: { card: 'summary_large_image', title: share, description },
  };
}

export default async function ProductPage({ params }: Props) {
  const { id } = await params;
  const product = onSale(id);
  let jsonLd: string[] = [];
  if (product) {
    const base = await siteUrl();
    const category = getSettings('catalog').categories.find((c) => c.id === product.category);
    jsonLd = [
      jsonLdString(productJsonLd(product, base)),
      jsonLdString(
        breadcrumbJsonLd(base, [
          { name: 'Home', path: '/' },
          ...(category ? [{ name: category.label, path: `/shop/${category.id}` }] : []),
          { name: product.title, path: `/p/${encodeURIComponent(product.id)}` },
        ]),
      ),
    ];
  }
  return (
    <>
      {jsonLd.map((json, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
      ))}
      <ShopApp initialProductId={id.slice(0, 80)} />
    </>
  );
}
