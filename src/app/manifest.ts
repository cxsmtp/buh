import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { buildManifest } from '@/lib/server/appManifest';
import { getSettings } from '@/lib/server/settings';

/**
 * /manifest.webmanifest: what makes the shop installable as an app (name and icon from Settings →
 * Branding, full screen without the browser's bars, Bag and Track Order shortcuts on a long press).
 */
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const ua = (await headers()).get('user-agent') || '';
  return buildManifest(getSettings('brand'), ua, getSettings('look'));
}
