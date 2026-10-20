'use client';

import React from 'react';
import { PictureStudio } from './PictureStudio';

/**
 * AI pictures in the product editor's Photos step: the same Picture studio as Inventory → Make
 * pictures (src/components/admin/inventory/PictureStudio.tsx), adding the pictures to the editor's
 * photos (saved with the product). The note is kept with the editor's draft.
 */
export function StageInBedroom({
  photos,
  originals,
  room,
  notes,
  onNotes,
  context,
  onAdd,
  onOpenSettings,
}: {
  /** The editor's photos (uploaded URLs; first = cover). */
  photos: string[];
  /** Photos added in this session, as taken (data URLs). */
  originals: Record<string, string>;
  /** How many more photos the product can take. */
  room: number;
  /** The owner's note (kept with the editor's draft, so it is there next time). */
  notes: string;
  onNotes: (v: string) => void;
  /** The product's own words, so the setting suits it (never changes the product). */
  context: { title?: string; motif?: string; colors?: string[]; design?: string };
  /** Add the styled photo after the one it was made from. */
  onAdd: (url: string, after: string) => void;
  onOpenSettings?: () => void;
}) {
  return (
    <PictureStudio
      photos={photos}
      originals={originals}
      room={room}
      notes={notes}
      onNotes={onNotes}
      context={context}
      onOpenSettings={onOpenSettings}
      onAdd={async (urls, source) => {
        // Added in order, each after the original (so the last added sits right after it): reversed here.
        for (const url of [...urls].reverse()) onAdd(url, source);
        return { added: urls };
      }}
    />
  );
}
