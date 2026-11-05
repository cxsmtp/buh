import type { Metadata } from 'next';
import { TermsView } from '@/components/TermsView';

/**
 * Terms & Conditions (/terms), in English and Arabic: linked from the shop's footer and checkout.
 * The seller's details (legal name, trade licence, address, contact) come from Settings → Store &
 * contact, so they stay right when the owner changes them. Dynamic: read on each visit.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { shopName } = await import('@/lib/server/seo');
  return {
    title: { absolute: `Terms & Conditions | ${shopName()}` },
    description: 'How ordering, payment, delivery, our no-returns policy for personal and made-to-order bedding, and faulty items work.',
    alternates: { canonical: '/terms' },
  };
}

export default async function TermsPage() {
  const { getSettings, contactEmail } = await import('@/lib/server/settings');
  const { appUrl } = await import('@/lib/server/runtimeConfig');
  const store = getSettings('store');
  const brand = getSettings('brand');
  const courier = getSettings('courier');
  const legal = store.legalName?.trim() || courier.jeebly?.pickupLocationName?.trim() || brand.storeName || 'Beautiful UAE Home';
  const site = (appUrl() || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return (
    <TermsView
      seller={{
        legal,
        ...(store.tradeLicenceNumber?.trim() ? { licence: store.tradeLicenceNumber.trim() } : {}),
        ...(store.tradeLicenceAuthority?.trim() ? { authority: store.tradeLicenceAuthority.trim() } : {}),
        ...(store.storeAddress?.trim() ? { address: store.storeAddress.trim() } : {}),
        ...(store.whatsappNumber ? { phone: store.whatsappNumber } : {}),
        ...(contactEmail() ? { email: contactEmail() } : {}),
        site,
      }}
    />
  );
}
