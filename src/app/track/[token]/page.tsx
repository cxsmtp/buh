import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShopApp } from '@/components/ShopApp';

/**
 * An order's private tracking page (/track/<order>.<mac>, src/lib/server/orders.ts trackPath): the
 * link the shop sends on WhatsApp once the order is confirmed. Opens Track Order with that order,
 * no phone number needed, any time. Not for search engines; no referrer; never cached.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { shopName } = await import('@/lib/server/seo');
  return {
    title: { absolute: `Track your order | ${shopName()}` },
    robots: { index: false, follow: false, nocache: true },
    referrer: 'no-referrer',
  };
}

export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { openTrackOrderId } = await import('@/lib/server/orders');
  if (!openTrackOrderId(decodeURIComponent(token))) notFound();
  return <ShopApp trackToken={decodeURIComponent(token)} />;
}
