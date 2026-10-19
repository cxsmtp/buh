'use client';

import React from 'react';
import { code128Bars } from '@/lib/code128';

/** A real Code 128 (set B) barcode as SVG, with its quiet zones; black on white. */
export function Barcode128({ value, height = 60, label, className = '' }: { value: string; height?: number; label: string; className?: string }) {
  let bars: Array<[number, number]> = [];
  let total = 0;
  try {
    ({ bars, total } = code128Bars(value));
  } catch {
    return null;
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${total} ${height}`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className={`block w-full ${className}`}
      style={{ height }}
      data-barcode={value}
    >
      <rect width={total} height={height} fill="#fff" />
      <g fill="#000">
        {bars.map(([x, w]) => (
          <rect key={x} x={x} y={0} width={w} height={height} />
        ))}
      </g>
    </svg>
  );
}
