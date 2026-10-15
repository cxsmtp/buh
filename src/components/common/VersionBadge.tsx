'use client';

import React from 'react';

/**
 * The build version (BUH-xx.xx.xx), bottom left on every page, above the
 * phone's bottom bar. For the owner it opens Settings → Versions.
 */
export function VersionBadge({ onOpen, raised = false }: { onOpen?: () => void; /** Always above a bottom bar (the admin's shows on every width). */ raised?: boolean }) {
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  if (!version) return null;
  const cls = `fixed left-2 ${raised ? 'bottom-[4.25rem]' : 'bottom-[4.25rem] md:bottom-2'} z-30 font-mono text-[10px] leading-none px-1.5 py-1 rounded-md bg-white/80 text-stone-500 border border-stone-200 backdrop-blur-sm`;
  return onOpen ? (
    <button type="button" onClick={onOpen} className={`${cls} hover:text-stone-800`} title="Versions and what changed">
      {version}
    </button>
  ) : (
    <span className={`${cls} pointer-events-none select-none`} aria-label={`Version ${version}`}>
      {version}
    </span>
  );
}
