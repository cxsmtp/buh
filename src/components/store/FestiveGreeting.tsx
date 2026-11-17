import React from 'react';
import type { FestivalTheme } from '@/lib/festivals/catalog';
import { festiveAccentForDark, festiveGlowForDark } from '@/lib/design/themes';
import { FestiveMotif, FestivePattern } from './FestiveMotif';

/**
 * The festival's three colours as CSS variables (the `festive` tokens in globals.css), with their
 * dark-look counterparts (src/lib/design/themes.ts). Put on an element marked `data-festive`.
 */
export function festiveVars(theme: Pick<FestivalTheme, 'accent' | 'accentSoft' | 'glow'>): React.CSSProperties {
  return {
    ['--festive' as string]: theme.accent,
    ['--festive-soft' as string]: theme.accentSoft,
    ['--festive-glow' as string]: theme.glow,
    ['--festive-dark' as string]: festiveAccentForDark(theme.accent),
    ['--festive-glow-dark' as string]: festiveGlowForDark(theme.glow),
  };
}

/**
 * The festive greeting at the top of the shop: a soft tint of the festival's accent, its motif in
 * a fine ring, a short gracious greeting in the serif and one quiet line, with the motif repeated
 * faintly behind. Solemn days get the same calm band in stone grey.
 */
export function FestiveGreeting({
  theme,
  className = '',
  compact = false,
  grand = false,
  note,
  gifts,
}: {
  theme: FestivalTheme;
  className?: string;
  compact?: boolean;
  /** The fuller festive look at the top of the shop: the greeting larger, with `note` and `gifts`. */
  grand?: boolean;
  /** A short line beside the greeting ("In 15 days"). */
  note?: string;
  /** The link to the festival's gift page, shown inside the band (so the top of the shop stays short). */
  gifts?: React.ReactNode;
}) {
  // Compact (the shop's top): one slim line, so the photos start right below it.
  if (compact) {
    return (
      <div role="note" data-festive="" style={festiveVars(theme)} className={`relative overflow-hidden rounded-xl border border-festive-glow/40 bg-festive-soft px-3 py-1.5 ${className}`}>
        <div className="relative flex items-center gap-2.5 min-w-0">
          <FestiveMotif motif={theme.motif} className="w-4 h-4 shrink-0 text-festive" />
          <p className="min-w-0 text-[13px] leading-snug">
            <span className="font-serif text-base text-festive">{theme.greeting}</span>
            {theme.headline && <span className="text-ink-soft"> · {theme.headline}</span>}
          </p>
        </div>
      </div>
    );
  }
  // The fuller festive look at the top of the shop. Kept as short as the slim line with the gift
  // link under it was (the owner asked for the first pieces to show on the first screen): the
  // gift link sits inside the band, beside the greeting on a wide screen and under it on a phone.
  if (grand) {
    return (
      <div role="note" data-festive="" style={festiveVars(theme)} className={`relative overflow-hidden rounded-2xl border border-festive-glow/50 bg-festive-soft px-3 py-1.5 sm:px-5 sm:py-2 ${className}`}>
        <FestivePattern motif={theme.motif} className="absolute inset-y-0 end-0 w-2/3 sm:w-1/2 text-festive-glow opacity-40 pointer-events-none [mask-image:linear-gradient(to_left,black,transparent)] rtl:[mask-image:linear-gradient(to_right,black,transparent)]" />
        <div className="relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-festive-glow/70 bg-surface/60 text-festive sm:h-11 sm:w-11 ${gifts ? 'row-span-2 sm:row-span-1' : ''}`}>
            <FestiveMotif motif={theme.motif} className="h-6 w-6 sm:h-7 sm:w-7" />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
              <span className="font-serif text-xl leading-tight text-festive break-anywhere sm:text-[1.7rem]">{theme.greeting}</span>
              {/* On a phone the days to go sit beside the gift link (below), so the greeting keeps to one line and the top stays short. */}
              {note && (
                <span data-testid="festive-countdown" className="hidden shrink-0 rounded-full border border-festive-glow/70 bg-surface/70 px-2 py-0.5 text-[11px] font-semibold text-festive sm:inline-block">
                  {note}
                </span>
              )}
            </p>
            {theme.headline && <p className={`text-[13px] leading-snug text-ink-soft ${gifts ? 'hidden sm:block' : ''}`}>{theme.headline}</p>}
          </div>
          {gifts && (
            <div className="col-start-2 flex min-w-0 items-center gap-2 sm:col-start-3 sm:row-start-1">
              {gifts}
              {note && <span className="shrink-0 text-[11px] font-semibold text-festive sm:hidden">{note}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div role="note" data-festive="" style={festiveVars(theme)} className={`relative overflow-hidden rounded-2xl border border-festive-glow/40 bg-festive-soft px-4 py-3.5 sm:px-5 ${className}`}>
      <FestivePattern motif={theme.motif} className="absolute inset-y-0 end-0 w-2/3 sm:w-1/2 text-festive-glow opacity-[0.22] pointer-events-none [mask-image:linear-gradient(to_left,black,transparent)] rtl:[mask-image:linear-gradient(to_right,black,transparent)]" />
      <div className="relative flex items-center gap-3.5 min-w-0">
        <span className="shrink-0 w-11 h-11 rounded-full border border-festive-glow/70 bg-surface/60 text-festive flex items-center justify-center">
          <FestiveMotif motif={theme.motif} className="w-6 h-6" />
        </span>
        <div className="min-w-0">
          <p className="font-serif text-xl leading-tight text-festive break-anywhere">{theme.greeting}</p>
          {theme.headline && <p className="text-[13px] text-ink-soft leading-snug mt-0.5">{theme.headline}</p>}
        </div>
      </div>
    </div>
  );
}
