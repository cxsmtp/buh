import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShopApp } from '@/components/ShopApp';

/**
 * "Order from your photo" (/order-by-photo): the link the owner shares on WhatsApp for a piece
 * agreed there that is not in the shop. Opens the shop with the photo order open: photos, the
 * agreed amount, then address, payment and the WhatsApp confirmation. Only while Settings → Store
 * & contact → "Order from your photo" is on (otherwise: not found). Not for search engines.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { shopName } = await import('@/lib/server/seo');
  return {
    title: { absolute: `Order from your photo | ${shopName()}` },
    description: 'Agreed a piece with us on WhatsApp? Upload its photo, the amount we agreed and your address, then confirm on WhatsApp.',
    robots: { index: false, follow: true },
  };
}

export default async function OrderByPhotoPage() {
  const { getSettings } = await import('@/lib/server/settings');
  if (!getSettings('store').photoOrders) notFound();
  return <ShopApp openPhotoOrder />;
}
