'use client';

import React from 'react';

/**
 * The build version (BUH-xx.xx.xx), bottom left. In the shop it is plain text; in the hub
 * (onOpen) it opens Settings → Versions and floats above the hub's bottom bar (raised). In the shop (inFooter) it sits in the
 * page's footer on phones, under the last product, so it never covers the feed; from tablet
 * width up it floats bottom left.
 */
export function VersionBadge({ onOpen, raised = false, inFooter = false }: { onOpen?: () => void; /** Always above a bottom bar (the hub's phone view). */ raised?: boolean; inFooter?: boolean }) {
  const version = process.env.NEXT_PUBLIC_APP_VERSION;
  if (!version) return null;
  const place = inFooter ? 'inline-block md:fixed md:left-2 md:bottom-2' : `fixed left-2 ${raised ? 'bottom-[4.25rem]' : 'bottom-[4.25rem] md:bottom-2'}`;
  const cls = `${place} z-30 font-mono text-[10px] leading-none px-1.5 py-1 rounded-md bg-surface/80 text-ink-muted border border-line backdrop-blur-sm`;
  return onOpen ? (
    <button type="button" onClick={onOpen} className={`${cls} hover:text-ink`} title="Versions and what changed">
      {version}
    </button>
  ) : (
    <span className={`${cls} pointer-events-none select-none`} aria-label={`Version ${version}`}>
      {version}
    </span>
  );
}
