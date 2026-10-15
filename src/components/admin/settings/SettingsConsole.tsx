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
  icon: string;
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
      <nav aria-label="Settings sections" className="flex md:flex-col gap-1.5 overflow-x-auto no-scrollbar md:overflow-visible -mx-1 px-1 md:mx-0 md:px-0">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => open(s.id)}
            aria-current={s.id === current?.id ? 'page' : undefined}
            className={`shrink-0 text-left px-3 py-2 rounded-xl text-xs font-bold flex items-center gap-2 transition-colors ${
              s.id === current?.id ? 'bg-[#0f1c2e] text-white' : 'bg-white text-stone-700 border border-stone-200 hover:bg-stone-50'
            }`}
          >
            <span aria-hidden="true">{s.icon}</span>
            <span className="whitespace-nowrap">{s.label}</span>
          </button>
        ))}
      </nav>
      {current && (
        <section className="bg-white rounded-2xl border border-stone-200 p-4 min-w-0" aria-labelledby="settings-title">
          <h2 id="settings-title" className="font-serif font-bold text-lg text-[#0f1c2e]">{current.label}</h2>
          <p className="text-xs text-stone-500 mb-4">{current.hint}</p>
          {current.content}
        </section>
      )}
    </div>
  );
}
