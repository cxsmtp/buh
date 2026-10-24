'use client';

import React, { useId } from 'react';
import { Camera, ImagePlus, Loader2, X } from 'lucide-react';

export type SetPieceKind = 'pillow' | 'comforter';

/** A piece's photo as shown here: its preview, and whether it is still uploading. */
export interface SetPieceView {
  preview: string;
  busy?: boolean;
}

const PIECES: Record<SetPieceKind, { name: string; hint: string }> = {
  pillow: { name: 'Pillow cover photo', hint: 'The AI pictures copy the pillow covers from this photo (their own design), and the bedsheet from the main photo. Without it, the pillow covers copy the main photo.' },
  comforter: { name: 'Comforter photo', hint: 'The AI pictures copy the comforter from this photo. Without a comforter, the pictures show none.' },
};

/**
 * The set's other pieces (quick add and the product editor): a real photo of the pillow cover, and
 * (off by default) the comforter. The main photo is the bedsheet. The AI pictures copy each piece
 * from its own photo; a set without a comforter has none in its pictures.
 */
export function SetPiecesField({
  pieces,
  hasComforter,
  onComforter,
  onPick,
  onRemove,
}: {
  pieces: Partial<Record<SetPieceKind, SetPieceView>>;
  hasComforter: boolean;
  onComforter: (on: boolean) => void;
  onPick: (kind: SetPieceKind, file: File) => void;
  onRemove: (kind: SetPieceKind) => void;
}) {
  const id = useId();
  const slot = (kind: SetPieceKind) => {
    const p = pieces[kind];
    const info = PIECES[kind];
    return (
      <div className="space-y-1" data-testid={`set-piece-${kind}`}>
        <p className="text-sm font-semibold text-ink" id={`${id}-${kind}`}>
          {info.name} <span className="font-normal text-ink-soft">(optional)</span>
        </p>
        <p className="text-xs text-ink-soft">{info.hint}</p>
        {p ? (
          <div className="relative w-20">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.preview} alt={info.name} className="w-20 aspect-[4/5] object-cover rounded-xl border border-line" />
            {p.busy && (
              <span className="absolute inset-0 flex items-center justify-center bg-surface/60 rounded-xl" role="status" aria-label="Uploading">
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
              </span>
            )}
            <button type="button" onClick={() => onRemove(kind)} className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-surface border border-line-strong flex items-center justify-center" aria-label={`Remove the ${info.name.toLowerCase()}`}>
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2" role="group" aria-labelledby={`${id}-${kind}`}>
            <label className="min-h-11 rounded-xl border border-ink bg-surface text-ink text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-gold">
              <Camera className="w-4 h-4" aria-hidden="true" /> Camera
              <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label={`${info.name}: take it with the camera`} onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(kind, f); e.target.value = ''; }} />
            </label>
            <label className="min-h-11 rounded-xl border border-ink bg-surface text-ink text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer focus-within:ring-2 focus-within:ring-gold">
              <ImagePlus className="w-4 h-4" aria-hidden="true" /> Gallery
              <input type="file" accept="image/*" className="sr-only" aria-label={`${info.name}: choose it from the gallery`} onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(kind, f); e.target.value = ''; }} />
            </label>
          </div>
        )}
      </div>
    );
  };
  return (
    <section className="space-y-3 rounded-xl border border-line bg-sand p-3" aria-label="Set pieces" data-testid="set-pieces">
      <p className="text-xs text-ink-soft">The main photo is the bedsheet. Add the set&rsquo;s other pieces so the AI pictures show each one in its own design.</p>
      {slot('pillow')}
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" className="mt-0.5 w-5 h-5 shrink-0" checked={hasComforter} onChange={(e) => onComforter(e.target.checked)} data-testid="set-has-comforter" />
        <span>
          <span className="font-semibold">This set has a comforter</span>
          <span className="block text-xs text-ink-soft">Off: the AI pictures show no comforter.</span>
        </span>
      </label>
      {hasComforter && slot('comforter')}
    </section>
  );
}
