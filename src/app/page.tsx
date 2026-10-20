import type { Metadata } from 'next';
import Link from 'next/link';
import { ShopApp } from '@/components/ShopApp';

/**
 * The shop's front page. Its title and description switch to the live festival by themselves
 * ("Diwali gift bedsheets & bed sets in the UAE | …") and back after it (src/lib/server/seo.ts);
 * the page carries the shop as schema.org data, the Search Console / Bing verification codes, and
 * plain links to the category pages and the live festival's gift page, so crawlers find them.
 *
 * Kept as fast as a static page: built once, then rebuilt in the background at most every 5
 * minutes (and right after Settings → Search (SEO) is saved). The build itself has no shop
 * database, so it renders the everyday defaults; the first visit after a start brings it up to date.
 */
export const revalidate = 300;

const building = () => process.env.NEXT_PHASE === 'phase-production-build';

const FALLBACK: Metadata = {
  title: 'Beautiful UAE Home | Bedsheets & bed sets in the UAE',
  description: 'Hand block and machine printed bedsheets, duvet covers and bed sets, fitted for deep UAE mattresses. Delivered to Dubai, Abu Dhabi, Sharjah and all the UAE.',
};

export async function generateMetadata(): Promise<Metadata> {
  if (building()) return FALLBACK;
  try {
    (await import('@/lib/server/pageCache')).buildingKeptPage();
    const { homeTexts, shopName } = await import('@/lib/server/seo');
    const { getSettings } = await import('@/lib/server/settings');
    const { shopUrl } = await import('@/lib/server/runtimeConfig');
    const { title, description } = homeTexts();
    const s = getSettings('seo');
    const base = shopUrl();
    return {
      title: { absolute: title },
      description,
      ...(base ? { alternates: { canonical: `${base}/` } } : {}),
      openGraph: { type: 'website', siteName: shopName(), title, description, ...(base ? { url: `${base}/` } : {}) },
      ...(s.googleVerification || s.bingVerification
        ? { verification: { ...(s.googleVerification ? { google: s.googleVerification } : {}), ...(s.bingVerification ? { other: { 'msvalidate.01': s.bingVerification } } : {}) } }
        : {}),
    };
  } catch {
    return FALLBACK;
  }
}

/** The structured data and links for crawlers (rendered on the server, inside the shop's page). */
async function SeoParts(): Promise<{ jsonLd: string[]; festival: React.ReactNode; explore: React.ReactNode }> {
  if (building()) return { jsonLd: [], festival: null, explore: null };
  try {
    const { exploreLinks, homeTexts, jsonLdString, siteJsonLd } = await import('@/lib/server/seo');
    const { shopUrl } = await import('@/lib/server/runtimeConfig');
    const base = shopUrl();
    const { festival } = homeTexts();
    const links = exploreLinks(new Date(), { liveOnly: true });
    return {
      jsonLd: base ? siteJsonLd(base).map((x) => jsonLdString(x)) : [],
      festival: festival ? (
        <Link href={`/gifts/${festival.id}`} className="inline-flex items-center gap-1 min-h-11 px-4 rounded-full border border-line-strong bg-surface text-sm text-ink hover:border-ink-muted" data-testid="festival-gifts-link">
          {festival.giftName} gifts: bedsheets &amp; bed sets <span aria-hidden="true">→</span>
        </Link>
      ) : null,
      explore:
        links.categories.length || links.festivals.length ? (
          <nav aria-label="Categories and gift pages" className="space-y-2" data-testid="home-explore">
            <h2 className="label-caps text-ink-muted">Shop by category</h2>
            <ul className="flex flex-wrap gap-2">
              {[...links.festivals, ...links.categories].map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="inline-flex items-center min-h-11 px-4 rounded-full border border-line-strong bg-surface text-sm text-ink hover:border-ink-muted">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null,
    };
  } catch {
    return { jsonLd: [], festival: null, explore: null };
  }
}

export default async function HomePage() {
  const parts = await SeoParts();
  return (
    <>
      {parts.jsonLd.map((json, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
      ))}
      <ShopApp festivalLink={parts.festival} explore={parts.explore} />
    </>
  );
}
