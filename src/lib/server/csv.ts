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
  return '\ufeff' + [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** One CSV line (with its CRLF), for a file written a row at a time: start it with csvHead(). */
export function csvRow(row: unknown[]): string {
  return row.map(cell).join(',') + '\r\n';
}

/** The BOM and the header line of a CSV written a row at a time (the same bytes as toCsv). */
export function csvHead(headers: string[]): string {
  return '\ufeff' + csvRow(headers);
}

/** Fils as a plain AED decimal with two places ("1250.50", "-3.05"), from whole numbers only (no float rounding). */
export function aedText(fils: number): string {
  const sign = fils < 0 ? '-' : '';
  const abs = Math.abs(Math.round(fils));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
