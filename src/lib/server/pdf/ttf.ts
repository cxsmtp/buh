/**
 * Just enough TrueType for the invoice PDF: read a font's character map and advance widths, and
 * make a subset that keeps only the glyphs one document uses (the glyph ids stay the same, so the
 * PDF can use them directly with Identity-H; unused glyphs are emptied). No dependency.
 */

interface Table {
  offset: number;
  length: number;
}

export interface Font {
  name: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  /** Unicode code point → glyph id (format 4 and 12 cmaps). */
  cmap: Map<number, number>;
  /** Advance width per glyph id, in font units. */
  advances: Uint16Array;
  numGlyphs: number;
  data: Buffer;
  tables: Map<string, Table>;
  longLoca: boolean;
}

export function parseFont(data: Buffer, name: string): Font {
  const numTables = data.readUInt16BE(4);
  const tables = new Map<string, Table>();
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    tables.set(data.toString('latin1', p, p + 4), { offset: data.readUInt32BE(p + 8), length: data.readUInt32BE(p + 12) });
  }
  const t = (tag: string) => {
    const table = tables.get(tag);
    if (!table) throw new Error(`Font ${name}: no ${tag} table`);
    return table.offset;
  };
  const head = t('head');
  const unitsPerEm = data.readUInt16BE(head + 18);
  const bbox: Font['bbox'] = [data.readInt16BE(head + 36), data.readInt16BE(head + 38), data.readInt16BE(head + 40), data.readInt16BE(head + 42)];
  const longLoca = data.readInt16BE(head + 50) === 1;
  const hhea = t('hhea');
  const ascent = data.readInt16BE(hhea + 4);
  const descent = data.readInt16BE(hhea + 6);
  const numHMetrics = data.readUInt16BE(hhea + 34);
  const numGlyphs = data.readUInt16BE(t('maxp') + 4);
  const hmtx = t('hmtx');
  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numHMetrics) last = data.readUInt16BE(hmtx + g * 4);
    advances[g] = last;
  }
  const os2 = tables.get('OS/2');
  const capHeight = os2 && os2.length >= 90 ? data.readInt16BE(os2.offset + 88) : Math.round(ascent * 0.7);

  // The character map: Windows Unicode (3,10 full, else 3,1 BMP).
  const cmapAt = t('cmap');
  const subtables = data.readUInt16BE(cmapAt + 2);
  let best = -1;
  let bestRank = 0;
  for (let i = 0; i < subtables; i++) {
    const p = cmapAt + 4 + i * 8;
    const platform = data.readUInt16BE(p);
    const encoding = data.readUInt16BE(p + 2);
    const rank = platform === 3 && encoding === 10 ? 3 : platform === 3 && encoding === 1 ? 2 : platform === 0 ? 1 : 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = cmapAt + data.readUInt32BE(p + 4);
    }
  }
  if (best < 0) throw new Error(`Font ${name}: no Unicode cmap`);
  const cmap = new Map<number, number>();
  const format = data.readUInt16BE(best);
  if (format === 4) {
    const segX2 = data.readUInt16BE(best + 6);
    const ends = best + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = data.readUInt16BE(ends + s * 2);
      const start = data.readUInt16BE(starts + s * 2);
      const delta = data.readInt16BE(deltas + s * 2);
      const rangeAt = ranges + s * 2;
      const range = data.readUInt16BE(rangeAt);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g: number;
        if (range === 0) g = (c + delta) & 0xffff;
        else {
          g = data.readUInt16BE(rangeAt + range + (c - start) * 2);
          if (g !== 0) g = (g + delta) & 0xffff;
        }
        if (g) cmap.set(c, g);
      }
    }
  } else if (format === 12) {
    const groups = data.readUInt32BE(best + 12);
    for (let i = 0; i < groups; i++) {
      const p = best + 16 + i * 12;
      const start = data.readUInt32BE(p);
      const end = data.readUInt32BE(p + 4);
      const g0 = data.readUInt32BE(p + 8);
      for (let c = start; c <= end; c++) cmap.set(c, g0 + (c - start));
    }
  } else throw new Error(`Font ${name}: cmap format ${format} not read`);

  return { name, unitsPerEm, ascent, descent, capHeight, bbox, cmap, advances, numGlyphs, data, tables, longLoca };
}

function glyphRange(font: Font, g: number): [number, number] {
  const loca = font.tables.get('loca')!.offset;
  const glyf = font.tables.get('glyf')!.offset;
  if (font.longLoca) return [glyf + font.data.readUInt32BE(loca + g * 4), glyf + font.data.readUInt32BE(loca + g * 4 + 4)];
  return [glyf + font.data.readUInt16BE(loca + g * 2) * 2, glyf + font.data.readUInt16BE(loca + g * 2 + 2) * 2];
}

/** The glyphs a composite glyph is made of (so they are kept too). */
function components(font: Font, g: number): number[] {
  const [a, b] = glyphRange(font, g);
  if (b - a < 10 || font.data.readInt16BE(a) >= 0) return [];
  const out: number[] = [];
  let p = a + 10;
  for (;;) {
    const flags = font.data.readUInt16BE(p);
    out.push(font.data.readUInt16BE(p + 2));
    p += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) p += 2;
    else if (flags & 0x0040) p += 4;
    else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

const pad4 = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

function checksum(b: Buffer): number {
  const p = pad4(b);
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) sum = (sum + p.readUInt32BE(i)) >>> 0;
  return sum;
}

/** A font file with only these glyphs drawn (ids kept), for embedding. */
export function subsetFont(font: Font, used: Iterable<number>): Buffer {
  const keep = new Set<number>([0]);
  const queue = [...used];
  while (queue.length) {
    const g = queue.pop()!;
    if (keep.has(g) || g < 0 || g >= font.numGlyphs) continue;
    keep.add(g);
    queue.push(...components(font, g));
  }
  const parts: Buffer[] = [];
  const loca = Buffer.alloc((font.numGlyphs + 1) * 4);
  let at = 0;
  for (let g = 0; g < font.numGlyphs; g++) {
    loca.writeUInt32BE(at, g * 4);
    if (keep.has(g)) {
      const [a, b] = glyphRange(font, g);
      const glyph = pad4(font.data.subarray(a, b));
      parts.push(glyph);
      at += glyph.length;
    }
  }
  loca.writeUInt32BE(at, font.numGlyphs * 4);
  const glyf = Buffer.concat(parts);
  const copy = (tag: string) => {
    const t = font.tables.get(tag);
    return t ? Buffer.from(font.data.subarray(t.offset, t.offset + t.length)) : null;
  };
  const head = copy('head')!;
  head.writeUInt32BE(0, 8); // checksum adjustment, set below
  head.writeInt16BE(1, 50); // long loca
  const out: Array<[string, Buffer]> = [];
  for (const tag of ['OS/2', 'cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post', 'prep']) {
    const b = tag === 'glyf' ? glyf : tag === 'loca' ? loca : tag === 'head' ? head : copy(tag);
    if (b) out.push([tag, b]);
  }
  const n = out.length;
  const dir = Buffer.alloc(12 + n * 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(n, 4);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= n) {
    pow *= 2;
    log++;
  }
  dir.writeUInt16BE(pow * 16, 6);
  dir.writeUInt16BE(log, 8);
  dir.writeUInt16BE(n * 16 - pow * 16, 10);
  let offset = dir.length;
  const bodies: Buffer[] = [];
  out.forEach(([tag, b], i) => {
    const p = 12 + i * 16;
    dir.write(tag, p, 'latin1');
    dir.writeUInt32BE(checksum(b), p + 4);
    dir.writeUInt32BE(offset, p + 8);
    dir.writeUInt32BE(b.length, p + 12);
    const padded = pad4(b);
    bodies.push(padded);
    offset += padded.length;
  });
  const file = Buffer.concat([dir, ...bodies]);
  const headAt = file.readUInt32BE(12 + out.findIndex(([tag]) => tag === 'head') * 16 + 8);
  file.writeUInt32BE((0xb1b0afba - checksum(file)) >>> 0, headAt + 8);
  return file;
}
