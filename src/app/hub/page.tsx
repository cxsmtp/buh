import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { HUB_HEADER, hubHeaderMatches } from '@/lib/server/adminLink';
import { HubLoader } from './HubLoader';

/**
 * The Admin Hub. Only ever served through the private admin link: src/lib/server/frontGate.ts
 * hands that link on to this page (with a value only the server can make) and
 * answers this page's own name with the shop's ordinary 404.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Admin Hub',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default async function HubPage() {
  if (!hubHeaderMatches((await headers()).get(HUB_HEADER))) notFound();
  return <HubLoader />;
}
