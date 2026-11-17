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
export function FestiveGreeting({ theme, className = '', compact = false, grand = false, note }: { theme: FestivalTheme; className?: string; compact?: boolean; /** The fuller festive look: a taller band, the greeting larger. */ grand?: boolean; /** A short line beside the greeting ("In 15 days"). */ note?: string }) {
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
  return (
    <div role="note" data-festive="" style={festiveVars(theme)} className={`relative overflow-hidden rounded-2xl border border-festive-glow/40 bg-festive-soft px-4 sm:px-5 ${grand ? 'py-5 sm:py-7' : 'py-3.5'} ${className}`}>
      <FestivePattern motif={theme.motif} className={`absolute inset-y-0 end-0 w-2/3 sm:w-1/2 text-festive-glow pointer-events-none [mask-image:linear-gradient(to_left,black,transparent)] rtl:[mask-image:linear-gradient(to_right,black,transparent)] ${grand ? 'opacity-40' : 'opacity-[0.22]'}`} />
      <div className="relative flex items-center gap-3.5 min-w-0">
        <span className={`shrink-0 rounded-full border border-festive-glow/70 bg-surface/60 text-festive flex items-center justify-center ${grand ? 'w-14 h-14 sm:w-16 sm:h-16' : 'w-11 h-11'}`}>
          <FestiveMotif motif={theme.motif} className={grand ? 'w-8 h-8 sm:w-9 sm:h-9' : 'w-6 h-6'} />
        </span>
        <div className="min-w-0">
          <p className={`font-serif leading-tight text-festive break-anywhere ${grand ? 'text-2xl sm:text-4xl' : 'text-xl'}`}>{theme.greeting}</p>
          {theme.headline && <p className={`text-ink-soft leading-snug ${grand ? 'text-sm sm:text-base mt-1' : 'text-[13px] mt-0.5'}`}>{theme.headline}</p>}
        </div>
        {note && (
          <span data-testid="festive-countdown" className="ms-auto shrink-0 rounded-full border border-festive-glow/70 bg-surface/70 px-2.5 py-1 text-[11px] font-semibold text-festive">
            {note}
          </span>
        )}
      </div>
    </div>
  );
}
