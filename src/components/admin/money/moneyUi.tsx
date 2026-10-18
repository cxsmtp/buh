'use client';

import React from 'react';

/** AED with two decimals and thousands separators, from whole fils ("1,250.50"). */
export function aed(fils: number): string {
  const sign = fils < 0 ? '−' : '';
  const abs = Math.abs(Math.round(fils));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** A date (YYYY-MM-DD) as "5 Oct 2026". */
export function niceDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

/** A moment in UAE time ("5 Oct 2026, 14:03"). */
export function uaeTime(iso: string): string {
  const t = new Date(Date.parse(iso) + 4 * 3600_000).toISOString();
  return `${niceDate(t.slice(0, 10))}, ${t.slice(11, 16)}`;
}

export const inputClass = 'w-full min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-sm text-ink focus:outline-none focus:ring-2 focus:ring-gold';
export const labelClass = 'block text-xs font-semibold text-ink-soft mb-1';
export const primaryButton = 'min-h-11 px-4 rounded-xl bg-ink text-white text-sm font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';
export const secondaryButton = 'min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';

export function Card({ children, className = '', ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`rounded-2xl border border-line bg-surface p-3.5 ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** A line of a total: label on the left, amount on the right (wraps instead of overflowing). */
export function Line({ label, value, strong = false, testId }: { label: React.ReactNode; value: React.ReactNode; strong?: boolean; testId?: string }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1 text-sm ${strong ? 'font-bold text-ink' : 'text-ink-soft'}`}>
      <span className="min-w-0 break-words">{label}</span>
      <span className="shrink-0 tabular-nums text-ink" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}
