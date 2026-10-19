'use client';

import React, { useState } from 'react';

/**
 * The settings console: one place for every option, grouped into sections
 * (store & contact, catalogue, branding & bank, themes, phone verification,
 * couriers, system). A row of pills on a phone, a side list on a computer.
 * The open section is remembered for this browser.
 */

export interface SettingsSection {
  id: string;
  label: string;
  /** A line icon (lucide). */
  icon: React.ReactNode;
  /** One line under the title. */
  hint: string;
  content: React.ReactNode;
}

const KEY = 'buh_settings_section';

export function SettingsConsole({ sections, openId }: { sections: SettingsSection[]; /** Open this section first (e.g. from the version badge). */ openId?: string }) {
  const [active, setActive] = useState(() => {
    if (openId && sections.some((s) => s.id === openId)) return openId;
    try {
      const saved = typeof window === 'undefined' ? null : localStorage.getItem(KEY);
      return saved && sections.some((s) => s.id === saved) ? saved : sections[0]?.id;
    } catch {
      return sections[0]?.id;
    }
  });
  const current = sections.find((s) => s.id === active) ?? sections[0];

  const open = (id: string) => {
    setActive(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // not essential
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-[210px_1fr] gap-3">
      <nav aria-label="Settings sections" className="min-w-0 flex md:flex-col gap-1.5 overflow-x-auto no-scrollbar md:overflow-visible -mx-1 px-1 md:mx-0 md:px-0">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => open(s.id)}
            aria-current={s.id === current?.id ? 'page' : undefined}
            className={`shrink-0 text-left px-3 py-2 rounded-xl text-xs font-medium flex items-center gap-2 transition-colors ${
              s.id === current?.id ? 'bg-ink text-paper' : 'bg-surface text-ink-soft border border-line hover:bg-ivory'
            }`}
          >
            <span aria-hidden="true" className="shrink-0 [&>svg]:w-4 [&>svg]:h-4 [&>svg]:stroke-[1.5]">{s.icon}</span>
            <span className="whitespace-nowrap">{s.label}</span>
          </button>
        ))}
      </nav>
      {current && (
        <section className="bg-surface rounded-2xl border border-line p-4 min-w-0" aria-labelledby="settings-title">
          <h2 id="settings-title" className="font-serif font-bold text-lg text-ink">{current.label}</h2>
          <p className="text-xs text-ink-muted mb-4">{current.hint}</p>
          {current.content}
        </section>
      )}
    </div>
  );
}
