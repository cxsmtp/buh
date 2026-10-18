import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PayTransfer } from '@/components/store/PayTransfer';
import { openPayOrderId } from '@/lib/server/bankPay';
import { getOrder } from '@/lib/server/orders';
import { getSettings } from '@/lib/server/settings';

/**
 * A bank-transfer order's private page (src/lib/server/bankPay.ts): the order number and amount
 * (from the server), the shop's bank details (only here, never on the public website), the
 * reference to use, and an upload for the transfer screenshot. The front gate answers a token
 * that opens no order with the shop's ordinary 404, and sends this page with no-referrer,
 * noindex and no-store; it is never in the sitemap.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `Bank transfer | ${getSettings('brand').storeName || 'Beautiful UAE Home'}`,
    robots: { index: false, follow: false, nocache: true },
    referrer: 'no-referrer',
  };
}

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const orderId = openPayOrderId(token);
  const order = orderId ? getOrder(orderId) : undefined;
  if (!order?.bankTransfer) notFound();
  const bank = getSettings('bank');
  return (
    <PayTransfer
      token={token}
      shopName={getSettings('brand').storeName || 'Beautiful UAE Home'}
      order={{ id: order.id, total: order.total, firstName: order.customer.fullName.split(/\s+/)[0], state: order.bankTransfer.state, uploads: order.bankTransfer.uploads }}
      bank={{ bankName: bank.bankName, accountName: bank.accountName, iban: bank.iban, accountNumber: bank.accountNumber, swiftCode: bank.swiftCode, branch: bank.branch, instructions: bank.instructions }}
    />
  );
}
