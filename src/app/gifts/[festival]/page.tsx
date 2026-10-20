import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LandingPage } from '@/components/seo/LandingPage';
import {
  breadcrumbJsonLd,
  dateText,
  deliveryArea,
  exploreLinks,
  festivalPageState,
  festivalProducts,
  festivalTexts,
  itemListJsonLd,
  jsonLdString,
  productAlt,
  shopName,
} from '@/lib/server/seo';
import { buildingKeptPage } from '@/lib/server/pageCache';
import { shopUrl } from '@/lib/server/runtimeConfig';

/**
 * A festival's gift page (/gifts/diwali, /gifts/eid-al-fitr…): the same address every year, so
 * what it earns in search stays. Live from N days before the festival until it ends; between
 * seasons it stays up (indexed) with the next dates; switched off by the owner: noindex
 * (src/lib/server/seo.ts). Products with a gift line for the festival come first, with the line.
 */
// Built on the first visit and kept for a minute (rebuilt in the background after that, and at
// once after a product or a setting changes, src/lib/server/pageCache.ts): as fast as a static
// page for crawlers. The shop's address comes from NEXT_PUBLIC_APP_URL only (no request headers,
// which would make it per request). Unknown ids are not found before any other work.
export const revalidate = 60;
export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ festival: string }> };

const stateFor = async (params: Props['params']) => {
  buildingKeptPage();
  return festivalPageState((await params).festival.slice(0, 60));
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const state = await stateFor(params);
  if (!state) return { title: shopName(), robots: { index: false, follow: true } };
  const base = shopUrl() ?? '';
  const t = festivalTexts(state);
  const url = `${base}/gifts/${state.id}`;
  const first = festivalProducts(state.id)[0]?.product;
  const image = first ? first.aiTransformedImage || first.featuredImage : '';
  return {
    title: { absolute: t.title },
    description: t.description,
    ...(base ? { alternates: { canonical: url } } : {}),
    robots: state.status === 'off' ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: { type: 'website', siteName: shopName(), title: t.title, description: t.description, ...(base ? { url } : {}), images: image ? [{ url: image.startsWith('http') ? image : `${base}${image}`, alt: first!.title }] : undefined },
    twitter: { card: 'summary_large_image', title: t.title, description: t.description },
  };
}

export default async function FestivalGiftsPage({ params }: Props) {
  const state = await stateFor(params);
  if (!state) notFound();
  const base = shopUrl() ?? '';
  const t = festivalTexts(state);
  const list = festivalProducts(state.id);
  const path = `/gifts/${state.id}`;
  const when = state.start && state.end ? dateText(state.start, state.end) : '';
  const notice =
    state.status === 'live'
      ? when
        ? { text: `${state.giftName}: ${when}`, live: true }
        : null
      : when
        ? { text: `Next: ${when}`, live: false }
        : null;
  const crumbs = [
    { name: 'Home', href: '/' },
    { name: `${state.giftName} gifts`, href: path },
  ];
  const links = exploreLinks(new Date(), { exclude: path });
  const area = deliveryArea();
  return (
    <LandingPage
      testId="festival-page"
      shop={shopName()}
      crumbs={crumbs}
      h1={t.h1}
      intro={t.intro}
      notice={notice}
      items={list.map(({ product, giftLine }) => ({ product, giftLine, alt: productAlt(product) }))}
      categories={links.categories}
      festivals={links.festivals}
      delivery={`Delivered to ${area.long} in ${area.days}.`}
      jsonLd={[
        jsonLdString(breadcrumbJsonLd(base, crumbs.map((c) => ({ name: c.name, path: c.href })))),
        jsonLdString(itemListJsonLd(base, t.h1, list.map((x) => x.product))),
      ]}
    />
  );
}
