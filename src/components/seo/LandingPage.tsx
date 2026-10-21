import Link from 'next/link';
import { photoSources } from '@/lib/client/photos';
import { isOnSale, productPhoto } from '@/lib/catalogFilter';
import type { Product } from '@/types';
import { priceLabel, wasLabel } from '@/lib/money';

/**
 * A landing page for search engines and shoppers alike (/shop/<category>, /gifts/<festival>):
 * rendered on the server, so the heading, the words and every product are in the page itself
 * (crawlers that do not run scripts see them all), with photos of a fixed shape (no layout shift),
 * lazy below the first row. Each product links to its own page; the foot links to the other
 * landing pages. Nothing here needs the shop's scripts.
 */

export interface LandingItem {
  product: Product;
  /** A gift line written for this festival (shown under the price). */
  giftLine?: string;
  alt: string;
}

export interface LandingLink {
  href: string;
  label: string;
  note?: string;
}

export function LandingPage(props: {
  shop: string;
  crumbs: Array<{ name: string; href: string }>;
  h1: string;
  intro: string;
  /** A line above the heading (the festival's dates, "Next: …"). */
  notice?: { text: string; live: boolean } | null;
  items: LandingItem[];
  categories: LandingLink[];
  festivals: LandingLink[];
  jsonLd: string[];
  delivery: string;
  testId: string;
}) {
  const { shop, crumbs, h1, intro, notice, items, categories, festivals, jsonLd, delivery, testId } = props;
  return (
    <div className="min-h-screen flex flex-col bg-ivory text-ink" data-testid={testId}>
      {jsonLd.map((json, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
      ))}
      <header className="border-b border-line bg-surface">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <Link href="/" className="font-serif text-lg sm:text-xl text-ink truncate min-w-0">
            {shop}
          </Link>
          <Link href="/" className="shrink-0 inline-flex items-center min-h-11 px-4 rounded-full bg-ink text-paper text-sm font-semibold">
            Shop all
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-4 sm:px-6 py-5 sm:py-8 space-y-6">
        <nav aria-label="Breadcrumb" className="text-xs text-ink-soft">
          <ol className="flex flex-wrap items-center gap-1">
            {crumbs.map((c, i) => (
              <li key={c.href} className="flex items-center gap-1 min-w-0">
                {i > 0 && <span aria-hidden="true">›</span>}
                {i === crumbs.length - 1 ? (
                  <span aria-current="page" className="text-ink break-words">{c.name}</span>
                ) : (
                  <Link href={c.href} className="underline underline-offset-4 hover:text-ink">{c.name}</Link>
                )}
              </li>
            ))}
          </ol>
        </nav>

        <section className="space-y-3 max-w-3xl">
          {notice && (
            <p className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${notice.live ? 'bg-gold/15 text-gold-deep' : 'bg-sand text-ink-soft'}`} data-testid="landing-notice">
              {notice.text}
            </p>
          )}
          <h1 className="font-serif text-3xl sm:text-4xl leading-tight text-ink break-words">{h1}</h1>
          <p className="text-sm sm:text-base text-ink-soft leading-relaxed break-words">{intro}</p>
        </section>

        {items.length ? (
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-3 gap-y-6 sm:gap-x-5" data-testid="landing-products">
            {items.map(({ product: p, giftLine, alt }, i) => {
              const photo = photoSources(productPhoto(p));
              const soldOut = p.stockCount === 0;
              return (
                <li key={p.id} className="min-w-0">
                  <a href={`/p/${encodeURIComponent(p.id)}`} className="group block rounded-lg focus-visible:outline-offset-4">
                    <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-sand-deep">
                      {photo.src && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={photo.src}
                          srcSet={photo.srcSet}
                          sizes={photo.srcSet ? '(min-width: 1024px) 270px, (min-width: 640px) 33vw, 50vw' : undefined}
                          alt={alt}
                          width={540}
                          height={675}
                          loading={i < 2 ? 'eager' : 'lazy'}
                          decoding="async"
                          className={`absolute inset-0 w-full h-full object-cover ${soldOut ? 'grayscale-[60%]' : ''}`}
                        />
                      )}
                    </div>
                    <div className="pt-2.5 space-y-1">
                      <h2 className="font-serif text-base leading-snug text-ink line-clamp-2 group-hover:text-gold-deep">{p.title}</h2>
                      <p className="text-sm text-ink">
                        {priceLabel(p)}
                        {isOnSale(p) && <span className="ml-2 text-xs text-ink-muted line-through">{wasLabel(p)}</span>}
                      </p>
                      {giftLine && <p className="text-[12px] text-gold-deep line-clamp-3 break-words" data-testid="landing-gift-line">{giftLine}</p>}
                      {soldOut && <p className="text-[11px] text-ink-muted">Sold out</p>}
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-2xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink">
            New pieces are on their way. <Link href="/" className="underline underline-offset-4">See everything in the shop</Link>.
          </p>
        )}

        {(categories.length > 0 || festivals.length > 0) && (
          <nav aria-label="More to explore" className="border-t border-line pt-6 grid gap-6 sm:grid-cols-2">
            {categories.length > 0 && (
              <div className="space-y-2 min-w-0">
                <h2 className="label-caps text-ink-muted">Shop by category</h2>
                <ul className="flex flex-wrap gap-2">
                  {categories.map((c) => (
                    <li key={c.href}>
                      <Link href={c.href} className="inline-flex items-center min-h-11 px-4 rounded-full border border-line-strong bg-surface text-sm text-ink hover:border-ink-muted">
                        {c.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {festivals.length > 0 && (
              <div className="space-y-2 min-w-0">
                <h2 className="label-caps text-ink-muted">Gifts for the festivals</h2>
                <ul className="flex flex-wrap gap-2">
                  {festivals.map((f) => (
                    <li key={f.href}>
                      <Link href={f.href} className="inline-flex flex-col justify-center min-h-11 px-4 py-1 rounded-2xl border border-line-strong bg-surface text-sm text-ink hover:border-ink-muted">
                        <span>{f.label}</span>
                        {f.note && <span className="text-[11px] text-ink-muted">{f.note}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </nav>
        )}
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-xs text-ink-soft space-y-1">
          <p className="font-serif text-base text-ink">{shop}</p>
          <p>{delivery}</p>
        </div>
      </footer>
    </div>
  );
}
