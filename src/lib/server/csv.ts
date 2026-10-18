/**
 * CSV files anyone can open in Excel (backups, the accountant's export, the audit export):
 * UTF-8 with a BOM (so Arabic names read right), CRLF lines, and formula-safe cells.
 */

function cell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  // A cell starting with = + - @ (or tab/CR) would run as a formula in Excel.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  // BOM so Excel reads Arabic names as UTF-8.
  return '﻿' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Fils as a plain AED decimal with two places ("1250.50", "-3.05"), from whole numbers only (no float rounding). */
export function aedText(fils: number): string {
  const sign = fils < 0 ? '-' : '';
  const abs = Math.abs(Math.round(fils));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
