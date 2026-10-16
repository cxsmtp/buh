import React, { useId } from 'react';
import type { MotifId } from '@/lib/festivals/catalog';

/**
 * One delicate ornament per festival, drawn as a fine line in the current colour: a crescent and
 * star for Eid, a diya for Diwali, a snowflake for Christmas, a lantern for Ramadan… Used small
 * beside the festive greeting and in the story ring, and as a faint repeating pattern behind the
 * greeting (`pattern`). Always decorative (hidden from screen readers).
 */
const PATHS: Record<MotifId, React.ReactNode> = {
  sparkle: <path d="M12 3.5 13.2 10.8 20.5 12 13.2 13.2 12 20.5 10.8 13.2 3.5 12 10.8 10.8Z" />,
  crescent: (
    <>
      <path d="M14.6 4.2a8 8 0 1 0 5.2 12.6 6.4 6.4 0 1 1-5.2-12.6Z" />
      <path d="M18.2 5.2l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z" />
    </>
  ),
  lantern: (
    <>
      <path d="M12 2.5v2.2M9.5 5.2h5M8.6 5.2 7.2 8.4h9.6l-1.4-3.2" />
      <path d="M7.2 8.4c-1.3 3.4-1.3 7 .6 10.1h8.4c1.9-3.1 1.9-6.7.6-10.1" />
      <path d="M8.3 18.5h7.4l-.9 2h-5.6ZM12 10.5v5.5M10 13.2h4" />
    </>
  ),
  diya: (
    <>
      <path d="M3.5 13.5c1.8 4.4 5 6 8.5 6s6.7-1.6 8.5-6Z" />
      <path d="M12 3.2c1.9 2.4 2.1 5 0 7.1-2.1-2.1-1.9-4.7 0-7.1Z" />
      <path d="M8.5 16.4h7" />
    </>
  ),
  lotus: (
    <>
      <path d="M12 4.5c2.4 2.8 2.4 7.3 0 11-2.4-3.7-2.4-8.2 0-11Z" />
      <path d="M12 15.5c-3.4-.6-6.2-3.3-6.8-6.6 3 .3 5.6 2.8 6.8 6.6ZM12 15.5c3.4-.6 6.2-3.3 6.8-6.6-3 .3-5.6 2.8-6.8 6.6Z" />
      <path d="M4.5 17.8c4.6 2.3 10.4 2.3 15 0" />
    </>
  ),
  rangoli: (
    <>
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.5c1.6 1.6 1.6 3.4 0 5-1.6-1.6-1.6-3.4 0-5ZM12 15.5c1.6 1.6 1.6 3.4 0 5-1.6-1.6-1.6-3.4 0-5ZM3.5 12c1.6-1.6 3.4-1.6 5 0-1.6 1.6-3.4 1.6-5 0ZM15.5 12c1.6-1.6 3.4-1.6 5 0-1.6 1.6-3.4 1.6-5 0Z" />
      <path d="M6.2 6.2h.01M17.8 6.2h.01M6.2 17.8h.01M17.8 17.8h.01" strokeWidth="2" />
    </>
  ),
  snowflake: (
    <>
      <path d="M12 2.8v18.4M4 7.4l16 9.2M4 16.6l16-9.2" />
      <path d="M9.8 4.6 12 6.4l2.2-1.8M9.8 19.4 12 17.6l2.2 1.8M4.6 10.4l2.6-.6-.6-2.6M19.4 13.6l-2.6.6.6 2.6M4.6 13.6l2.6.6-.6 2.6M19.4 10.4l-2.6-.6.6-2.6" />
    </>
  ),
  star: (
    <>
      <path d="M6.3 6.3h11.4v11.4H6.3Z" />
      <path d="M12 3.9 20.1 12 12 20.1 3.9 12Z" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  blossom: (
    <>
      <circle cx="12" cy="12" r="1.8" />
      <path d="M12 10.2c-1.9-2-1.9-4.4 0-6.2 1.9 1.8 1.9 4.2 0 6.2ZM13.7 11.4c1.2-2.5 3.5-3.3 5.9-2.4-.6 2.6-2.8 3.7-5.9 2.4ZM13.1 13.6c2.7.5 4 2.5 3.6 5-2.6.1-4.2-1.7-3.6-5ZM10.9 13.6c.6 3.3-1 5.1-3.6 5-.4-2.5.9-4.5 3.6-5ZM10.3 11.4c-3.1 1.3-5.3.2-5.9-2.4 2.4-.9 4.7-.1 5.9 2.4Z" />
    </>
  ),
  dove: <path d="M3.5 14.5c3.2.2 5.4-1.4 6.6-4.8.9 2.4 2.9 3.6 5.6 3.4l3.8-3.4-.6 4.1c-2.2 4.3-7.6 5.6-11.6 3.4L5 19.5l.9-3.2Z" />,
  olive: (
    <>
      <path d="M5 19.5c3.5-3.7 8-8.4 14-14" />
      <path d="M8.6 15.8c-2.6-.2-3.8-1.6-3.7-3.6 2.3-.1 3.6 1.2 3.7 3.6ZM11.5 12.8c.2-2.6 1.6-3.8 3.6-3.7.1 2.3-1.2 3.6-3.6 3.7ZM12.4 11.8c-2.6-.2-3.8-1.6-3.7-3.6 2.3-.1 3.6 1.2 3.7 3.6ZM15.4 8.7c.2-2.6 1.6-3.8 3.6-3.7.1 2.3-1.2 3.6-3.6 3.7Z" />
    </>
  ),
  wheat: (
    <>
      <path d="M12 21V6" />
      <path d="M12 8c-1.8-.4-2.6-1.6-2.4-3.4 1.8.3 2.6 1.5 2.4 3.4ZM12 8c1.8-.4 2.6-1.6 2.4-3.4-1.8.3-2.6 1.5-2.4 3.4ZM12 12c-1.8-.4-2.6-1.6-2.4-3.4 1.8.3 2.6 1.5 2.4 3.4ZM12 12c1.8-.4 2.6-1.6 2.4-3.4-1.8.3-2.6 1.5-2.4 3.4ZM12 16c-1.8-.4-2.6-1.6-2.4-3.4 1.8.3 2.6 1.5 2.4 3.4ZM12 16c1.8-.4 2.6-1.6 2.4-3.4-1.8.3-2.6 1.5-2.4 3.4Z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
    </>
  ),
  // A quiet nod to the flag: four fine bands in muted versions of its colours.
  flag: (
    <>
      <path d="M6 5v14" stroke="var(--color-danger)" strokeWidth="2.2" />
      <path d="M8.6 7.5H19" stroke="var(--color-success)" strokeWidth="1.8" />
      <path d="M8.6 12H19" stroke="var(--color-line-strong)" strokeWidth="1.8" />
      <path d="M8.6 16.5H19" stroke="var(--color-ink)" strokeWidth="1.8" />
    </>
  ),
  cloud: (
    <>
      <path d="M5.5 17.5h11.8a3 3 0 0 0 .4-6 4.5 4.5 0 0 0-8.6-1.3 3.4 3.4 0 0 0-3.6 7.3Z" />
      <path d="M10.4 14.4a1.6 1.6 0 1 1 1.6 1.6" />
    </>
  ),
  heart: <path d="M12 19.5s-7-4.3-7-9.4A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.1c0 5.1-7 9.4-7 9.4Z" />,
  sprout: (
    <>
      <path d="M12 20.5v-9" />
      <path d="M12 12.5c-.3-3.3-2.6-5.4-6.5-5.5.1 3.8 2.4 5.8 6.5 5.5ZM12 11c.4-3.6 2.8-5.8 6.8-5.9-.1 4-2.6 6.1-6.8 5.9Z" />
      <path d="M8 20.5h8" />
    </>
  ),
};

export function FestiveMotif({ motif, className = 'w-5 h-5', strokeWidth = 1.25 }: { motif: MotifId; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[motif] ?? PATHS.sparkle}
    </svg>
  );
}

/** The motif as a faint repeating pattern (a background behind the greeting). */
export function FestivePattern({ motif, className = '' }: { motif: MotifId; className?: string }) {
  const id = `festive-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg className={className} aria-hidden="true" focusable="false" width="100%" height="100%">
      <defs>
        <pattern id={id} width="44" height="44" patternUnits="userSpaceOnUse" patternTransform="rotate(-8)">
          <g transform="translate(4 4) scale(0.75)" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            {PATHS[motif] ?? PATHS.sparkle}
          </g>
          <g transform="translate(26 26) scale(0.5)" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            {PATHS[motif] ?? PATHS.sparkle}
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
