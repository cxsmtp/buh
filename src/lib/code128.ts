/**
 * Code 128, code set B (printable ASCII 32–126): the barcode couriers scan on a label.
 *
 * A symbol is: quiet zone, Start B, one symbol per character, a checksum symbol, Stop, quiet zone.
 * Each symbol is 6 alternating bar/space widths (3 bars, 3 spaces) totalling 11 modules; Stop is
 * 7 widths (13 modules, ending in a bar). Checksum = (104 + Σ position × value) mod 103, where a
 * character's value in set B is its char code − 32. Widths below are the reference table from
 * ISO/IEC 15417, indexed by symbol value.
 */
export const PATTERNS: readonly string[] = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

export const START_B = 104;
export const STOP = 106;
/** Quiet zone each side, in modules (the standard asks for at least 10). */
export const QUIET = 10;

/** The symbol values for `text` in code set B: Start B, the characters, checksum, Stop. */
export function code128Values(text: string): number[] {
  if (!text) throw new Error('Nothing to encode.');
  const values = [START_B];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch.length !== 1 || code < 32 || code > 126) throw new Error(`Code 128B cannot encode ${JSON.stringify(ch)}.`);
    values.push(code - 32);
  }
  const sum = values.reduce((acc, v, i) => acc + v * (i === 0 ? 1 : i), 0);
  values.push(sum % 103, STOP);
  return values;
}

/** Bar/space widths, starting with a bar (no quiet zones). */
export function code128Widths(text: string): string {
  return code128Values(text).map((v) => PATTERNS[v]).join('');
}

/** The bars as [x, width] in modules, with the quiet zone before them; `total` includes both quiet zones. */
export function code128Bars(text: string): { bars: Array<[number, number]>; total: number } {
  const widths = code128Widths(text);
  const bars: Array<[number, number]> = [];
  let x = QUIET;
  for (let i = 0; i < widths.length; i++) {
    const w = Number(widths[i]);
    if (i % 2 === 0) bars.push([x, w]);
    x += w;
  }
  return { bars, total: x + QUIET };
}

/** A standalone SVG string (black bars on white), scaled by the viewBox to any width. */
export function code128Svg(text: string, height = 60): string {
  const { bars, total } = code128Bars(text);
  const rects = bars.map(([x, w]) => `<rect x="${x}" y="0" width="${w}" height="${height}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges"><rect width="${total}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
