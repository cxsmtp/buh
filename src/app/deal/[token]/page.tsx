import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShopApp } from '@/components/ShopApp';

/**
 * A photo deal's private page (/deal/<token>, src/lib/server/photoDeals.ts): the owner's pictures
 * and fixed price, delivery included, then the customer's address and one of the ways to pay the
 * owner allowed. The front gate answers a token that opens no deal with the shop's ordinary 404 and
 * sends this page with no-referrer, noindex and no-store; it is never in the sitemap.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { shopName } = await import('@/lib/server/seo');
  return {
    title: { absolute: `Your order | ${shopName()}` },
    robots: { index: false, follow: false, nocache: true },
    referrer: 'no-referrer',
  };
}

export default async function DealPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { dealView } = await import('@/lib/server/photoDeals');
  const deal = dealView(token);
  if (!deal) notFound();
  return <ShopApp deal={deal} />;
}
