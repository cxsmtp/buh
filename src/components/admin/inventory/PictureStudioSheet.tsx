'use client';

import React, { useId, useState } from 'react';
import { X } from 'lucide-react';
import type { Product } from '@/types';
import { postJson } from '@/lib/apiClient';
import { Sheet } from '@/components/common/Sheet';
import { PictureStudio } from './PictureStudio';

/** A product holds at most 8 photos (the cover and 7 more). */
const MAX_PHOTOS = 8;

/**
 * Inventory → Make pictures: the Picture studio for a product already in the shop. The pictures the
 * owner adds go straight to the product's photos on the server, right after the photo they were
 * made from (POST /api/admin/products/<id>/styled-photos), and show below in "The product's photos".
 */
export function PictureStudioSheet({ product, onClose, onSaved, onOpenSettings }: { product: Product; onClose: () => void; onSaved: (p: Product) => void; onOpenSettings?: () => void }) {
  const titleId = useId();
  const [current, setCurrent] = useState<Product>(product);
  const photos = [current.featuredImage, ...(current.galleryImages ?? [])].filter(Boolean);

  const add = async (urls: string[]): Promise<{ added: string[]; message?: string }> => {
    const { ok, data } = await postJson<{ product?: Product; added?: string[]; full?: string[]; message?: string }>(`/api/admin/products/${encodeURIComponent(current.id)}/styled-photos`, { urls });
    if (!ok || !data.product) return { added: [], message: data.message || 'Could not add the pictures. Please try again.' };
    setCurrent(data.product);
    onSaved(data.product);
    const full = data.full?.length ?? 0;
    // Already there counts as added (sent twice: added once).
    const now = [data.product.featuredImage, ...(data.product.galleryImages ?? [])];
    return { added: urls.filter((u) => now.includes(u)), ...(full ? { message: `This product already has ${MAX_PHOTOS} photos: ${full === 1 ? 'one picture was' : `${full} pictures were`} not added. Remove a photo in Edit first.` } : {}) };
  };

  return (
    <Sheet labelledBy={titleId} onClose={onClose} variant="full" wide>
      <div className="px-4 pt-4 pb-2 flex items-start gap-2 border-b border-line">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="font-serif font-bold text-base text-ink">
            Picture studio
          </h3>
          <p className="text-xs text-ink-soft truncate">{current.title}</p>
        </div>
        <button type="button" onClick={onClose} className="min-h-11 min-w-11 flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="overflow-y-auto px-4 py-3 space-y-4">
        <PictureStudio
          testId="picture-studio"
          title="Make pictures"
          intro="New pictures of this product in beautiful settings, to help shoppers fall for it. Pick a photo and the scenes; the ones you add go straight to the product's photos (AI pictures first and your photo last, unless Settings → AI pictures says otherwise)."
          photos={photos}
          setPhotos={current.setPhotos}
          room={MAX_PHOTOS - photos.length}
          allowUpload
          context={{ title: current.title, colors: current.colors.map((c) => c.name).filter(Boolean), design: current.shortDescription }}
          onAdd={(urls) => add(urls)}
          onOpenSettings={onOpenSettings}
        />
        <section aria-labelledby={`${titleId}-g`} className="space-y-2">
          <h4 id={`${titleId}-g`} className="text-sm font-semibold text-ink">
            The product&rsquo;s photos ({photos.length} of {MAX_PHOTOS})
          </h4>
          <ol className="flex flex-wrap gap-2" aria-label="The product's photos" data-testid="product-gallery">
            {photos.map((src, i) => (
              <li key={src} className="relative w-20 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={i === 0 ? 'Cover photo' : `Photo ${i + 1}${current.stagedPhotos?.[src] ? ' (styled)' : ''}`} className={`w-full aspect-[4/5] object-cover rounded-lg border ${current.stagedPhotos?.[src] ? 'border-gold' : 'border-line'}`} />
                {current.stagedPhotos?.[src] && <span className="absolute bottom-1 left-1 text-[10px] font-bold bg-ink text-paper px-1 rounded">AI</span>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Sheet>
  );
}
