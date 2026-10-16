'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { searchAreas, type UAEArea } from '@/data/uaeAreas';

/**
 * Area / neighbourhood: free text with suggestions from every emirate (the chosen one first).
 *
 * A small ARIA 1.2 combobox rather than a <datalist>: a datalist can't match aliases ("JVC"),
 * matches differently in each browser (Firefox and Safari only by the start of the value), can't
 * say which emirate a suggestion is in, and is hard to use on iOS. Here: type any part of a name or
 * alias, ↑/↓ to move, Enter to choose, Escape to close; tap works the same on a phone. Whatever the
 * customer types is kept as their area: the list only suggests.
 */
interface Props {
  id: string;
  value: string;
  emirate: string;
  placeholder?: string;
  className?: string;
  required?: boolean;
  onChange: (text: string) => void;
  /** A suggestion was chosen (it may be in another emirate). */
  onPick: (area: UAEArea) => void;
}

export function AreaCombobox({ id, value, emirate, placeholder, className, required, onChange, onPick }: Props) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const matches = useMemo(() => searchAreas(value, emirate, 60), [value, emirate]);
  const shown = open && matches.length > 0;

  useEffect(() => {
    if (!shown || active < 0) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, shown]);

  const pick = (i: number) => {
    const m = matches[i];
    if (!m) return;
    onPick(m.area);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === 'Enter') {
      if (shown && active >= 0) {
        e.preventDefault();
        pick(active);
      } else if (shown) {
        // Keep what was typed; Enter only closes the list here (it doesn't send the order).
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      if (shown) {
        // Close the list, not the checkout.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        setActive(-1);
      }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const firstOther = matches.findIndex((m) => m.area.emirate !== emirate);

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-o${active}` : undefined}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="next"
        maxLength={120}
        required={required}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        className={className}
      />
      <ul
        id={listId}
        ref={listRef}
        role="listbox"
        aria-label="Area suggestions"
        hidden={!shown}
        className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-xl border border-stone-300 bg-white py-1 shadow-xl"
      >
        {shown &&
          matches.map((m, i) => {
            const other = m.area.emirate !== emirate;
            const hint = [m.via && !m.area.name.toLowerCase().includes(m.via.toLowerCase()) ? `“${m.via}”` : '', m.area.region ?? '', other && !m.area.name.includes(m.area.emirate) ? m.area.emirate : '']
              .filter(Boolean)
              .join(' · ');
            return (
              <li
                key={`${m.area.emirate}|${m.area.name}`}
                id={`${listId}-o${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                // Keep focus in the field, so the list doesn't close before the tap lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                onMouseMove={() => active !== i && setActive(i)}
                className={`flex cursor-pointer items-baseline justify-between gap-2 px-3 py-2.5 text-xs ${i === firstOther && i > 0 ? 'border-t border-stone-200' : ''} ${
                  i === active ? 'bg-amber-100 text-stone-900' : 'bg-white text-stone-900'
                }`}
              >
                <span className="min-w-0 font-semibold break-words">{m.area.name}</span>
                {hint && <span className="shrink-0 text-[11px] text-stone-600">{hint}</span>}
              </li>
            );
          })}
      </ul>
      <span className="sr-only" aria-live="polite">
        {shown ? `${matches.length} suggestion${matches.length === 1 ? '' : 's'}` : ''}
      </span>
    </div>
  );
}
