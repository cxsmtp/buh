'use client';

import React from 'react';
import type { Story } from '@/lib/catalogFilter';
import type { MotifId } from '@/lib/festivals/catalog';
import { photoSources } from '@/lib/client/photos';
import { FestiveMotif } from './FestiveMotif';

interface StoryChipsProps {
  stories: Story[];
  activeId: string | null;
  onPick: (story: Story) => void;
  /** Shown in the "All" circle. */
  logo?: React.ReactNode;
  /** During a festival: its motif, set in the chosen circle's ring. */
  motif?: MotifId | null;
}

/**
 * The round "story" chips at the top of the shop, like a boutique's highlights: All, New in, On
 * sale and each category, with a photo from inside it (or its initial, set in the serif). One tap
 * shows just that. The chosen one has a fine gold ring (in the festival's colour while one is on,
 * with its motif).
 */
export function StoryChips({ stories, activeId, onPick, logo, motif }: StoryChipsProps) {
  if (stories.length < 2) return null;
  return (
    <div role="group" aria-label="Collections" className="-mx-4 sm:mx-0">
      <ul className="flex gap-4 sm:gap-5 overflow-x-auto no-scrollbar px-4 sm:px-0 py-1.5 snap-x">
        {stories.map((s) => {
          const active = s.id === activeId;
          const photo = s.image ? photoSources(s.image, [128, 192]) : null;
          return (
            <li key={s.id} className="snap-start shrink-0">
              <button
                type="button"
                aria-pressed={active}
                aria-label={s.label}
                onClick={() => onPick(s)}
                className="w-[4.5rem] flex flex-col items-center gap-2 rounded-xl text-center"
              >
                <span className={`relative block rounded-full p-[1.5px] transition-colors ${active ? 'bg-gradient-to-tr from-gold-deep via-festive-glow to-gold-light' : 'bg-line'}`}>
                  <span className="block rounded-full p-[3px] bg-ivory">
                    <span className="relative flex w-16 h-16 rounded-full overflow-hidden bg-sand items-center justify-center" aria-hidden="true">
                      {s.id === 'all' && logo ? (
                        logo
                      ) : photo?.src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photo.src} srcSet={photo.srcSet} sizes="64px" alt="" width={64} height={64} loading="lazy" decoding="async" className="photo w-full h-full object-cover" />
                      ) : (
                        <span className="font-serif text-2xl text-gold-deep">{s.label.trim().charAt(0)}</span>
                      )}
                    </span>
                  </span>
                  {active && motif && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full bg-ivory border border-festive-glow text-festive flex items-center justify-center" aria-hidden="true">
                      <FestiveMotif motif={motif} className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </span>
                  )}
                </span>
                <span className={`block w-full text-[11px] leading-tight line-clamp-2 tracking-[0.02em] ${active ? 'text-ink font-medium' : 'text-ink-soft'}`}>{s.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
