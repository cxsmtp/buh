'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

/** A shared selection as its page gets it from the server (only products on sale). */
export interface ShopCollection {
  slug: string;
  title: string;
  productIds: string[];
  /** The last day it opens (YYYY-MM-DD, UAE), when the owner set one. */
  expiresOn: string | null;
}

/** "Until 30 Mar" for a last day (a UAE calendar date). */
function lastDayText(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The top of a shared selection's page (/c/<slug>): its title, how many pieces, and a way into the whole shop. */
export function CollectionHeader({ collection, pieces }: { collection: ShopCollection; pieces: number | null }) {
  return (
    <section aria-labelledby="collection-title" className="space-y-2 pt-1" data-testid="collection-header">
      <p className="label-caps text-gold-deep">A selection for you</p>
      <h1 id="collection-title" className="font-serif text-3xl sm:text-4xl leading-tight text-ink break-anywhere">
        {collection.title}
      </h1>
      <p className="text-[13px] text-ink-soft flex flex-wrap items-center gap-x-3 gap-y-1">
        {pieces !== null && (
          <span>
            <span className="text-ink font-medium">{pieces}</span> {pieces === 1 ? 'piece' : 'pieces'}
          </span>
        )}
        {collection.expiresOn && <span>Until {lastDayText(collection.expiresOn)}</span>}
        <Link href="/" className="inline-flex items-center gap-1 min-h-11 text-ink underline underline-offset-4">
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> Browse the whole shop
        </Link>
      </p>
    </section>
  );
}
