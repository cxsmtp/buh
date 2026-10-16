'use client';

import React from 'react';
import type { Story } from '@/lib/catalogFilter';
import { photoSources } from '@/lib/client/photos';

interface StoryChipsProps {
  stories: Story[];
  activeId: string | null;
  onPick: (story: Story) => void;
  /** Shown in the "All" circle. */
  logo?: React.ReactNode;
}

/**
 * The round "story" chips at the top of the shop, like an Instagram profile's highlights: All,
 * New in, On sale and each category, with a photo from inside it. One tap shows just that.
 */
export function StoryChips({ stories, activeId, onPick, logo }: StoryChipsProps) {
  if (stories.length < 2) return null;
  return (
    <div role="group" aria-label="Collections" className="-mx-4 sm:mx-0">
      <ul className="flex gap-3 sm:gap-4 overflow-x-auto no-scrollbar px-4 sm:px-0 py-1 snap-x">
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
                className="w-[4.5rem] flex flex-col items-center gap-1.5 rounded-xl text-center"
              >
                <span
                  className={`block rounded-full p-[2.5px] ${active ? 'bg-gradient-to-tr from-[#9f7e38] via-[#c5a059] to-[#e8cf98]' : 'bg-[#e4dccd]'}`}
                >
                  <span className="block rounded-full p-[2px] bg-[#fbf9f5]">
                    <span className="relative flex w-16 h-16 rounded-full overflow-hidden bg-[#efe8dc] items-center justify-center text-2xl" aria-hidden="true">
                      {s.id === 'all' && logo ? (
                        logo
                      ) : photo?.src ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photo.src} srcSet={photo.srcSet} sizes="64px" alt="" width={64} height={64} loading="lazy" decoding="async" className="photo w-full h-full object-cover" />
                      ) : (
                        <span>{s.icon}</span>
                      )}
                    </span>
                  </span>
                </span>
                <span className={`block w-full text-[11px] leading-tight line-clamp-2 ${active ? 'font-semibold text-stone-900' : 'text-stone-700'}`}>{s.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
