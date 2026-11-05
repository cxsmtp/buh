import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { visualLine } from './arabic';
import { parseFont, subsetFont, type Font } from './ttf';

/**
 * A small PDF writer for the shop's invoices: A4 pages, text in the bundled DejaVu Sans (regular
 * and bold, subset per document, so Arabic names and the sign print too), lines, filled boxes and
 * links. Every stream is compressed. No dependency, no browser.
 */

export type FontStyle = 'regular' | 'bold';
export type RGB = [number, number, number];

const FONT_FILES: Record<FontStyle, string> = { regular: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf' };
const fonts = new Map<FontStyle, Font>();

/** The bundled fonts: assets/fonts (in the image beside the server; FONTS_DIR for tests). */
function fontDir(): string {
  const candidates = [process.env.FONTS_DIR, path.join(process.cwd(), 'assets', 'fonts'), path.join(process.cwd(), '..', '..', 'assets', 'fonts')].filter(Boolean) as string[];
  for (const dir of candidates) if (fs.existsSync(path.join(dir, FONT_FILES.regular))) return dir;
  throw new Error('The invoice fonts (assets/fonts) are missing.');
}

export function loadFont(style: FontStyle): Font {
  let f = fonts.get(style);
  if (!f) {
    f = parseFont(fs.readFileSync(path.join(/* turbopackIgnore: true */ fontDir(), FONT_FILES[style])), style === 'bold' ? 'DejaVuSans-Bold' : 'DejaVuSans');
    fonts.set(style, f);
  }
  return f;
}

export const A4: [number, number] = [595.28, 841.89];

interface PageData {
  ops: string[];
  links: Array<{ rect: [number, number, number, number]; url: string }>;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '?')})`;

export class PdfDoc {
  private pages: PageData[] = [];
  private used: Record<FontStyle, Map<number, number>> = { regular: new Map(), bold: new Map() };
  readonly width = A4[0];
  readonly height = A4[1];

  constructor(private info: { title: string; author: string; subject?: string }) {}

  get pageCount() {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push({ ops: [], links: [] });
  }

  private get page(): PageData {
    if (!this.pages.length) this.addPage();
    return this.pages[this.pages.length - 1];
  }

  /** Glyph ids for a line of text (Arabic joined and ordered), noting which code point each draws. */
  private glyphs(text: string, style: FontStyle): number[] {
    const font = loadFont(style);
    const q = font.cmap.get(0x3f) ?? 0;
    return visualLine(text.replace(/[\u0000-\u001f\u007f]/g, ' ')).map((cp) => {
      const g = font.cmap.get(cp);
      if (g === undefined) return q;
      if (!this.used[style].has(g)) this.used[style].set(g, cp);
      return g;
    });
  }

  measure(text: string, size: number, style: FontStyle = 'regular'): number {
    const font = loadFont(style);
    let w = 0;
    for (const cp of visualLine(text)) w += font.advances[font.cmap.get(cp) ?? font.cmap.get(0x3f) ?? 0];
    return (w / font.unitsPerEm) * size;
  }

  /** Words wrapped to a width (a word longer than the width is cut). */
  wrap(text: string, size: number, width: number, style: FontStyle = 'regular'): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (this.measure(next, size, style) <= width) {
          line = next;
          continue;
        }
        if (line) out.push(line);
        let w = word;
        while (this.measure(w, size, style) > width && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && this.measure(w.slice(0, cut), size, style) > width) cut--;
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
      out.push(line);
    }
    return out;
  }

  /** Text with its baseline at y (from the top of the page). */
  text(text: string, x: number, y: number, opts: { size?: number; style?: FontStyle; color?: RGB; align?: 'left' | 'right' | 'center' } = {}): void {
    const size = opts.size ?? 10;
    const style = opts.style ?? 'regular';
    const w = opts.align && opts.align !== 'left' ? this.measure(text, size, style) : 0;
    const left = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    const hex = this.glyphs(text, style)
      .map((g) => g.toString(16).padStart(4, '0'))
      .join('');
    const [r, g, b] = opts.color ?? [0.13, 0.11, 0.11];
    this.page.ops.push(`BT ${num(r)} ${num(g)} ${num(b)} rg /${style === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf ${num(left)} ${num(this.height - y)} Td <${hex}> Tj ET`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: RGB = [0.85, 0.82, 0.78], width = 0.75): void {
    this.page.ops.push(`${num(color[0])} ${num(color[1])} ${num(color[2])} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
  }

  /** A filled box, its top-left at (x, y). */
  box(x: number, y: number, w: number, h: number, fill: RGB): void {
    this.page.ops.push(`${num(fill[0])} ${num(fill[1])} ${num(fill[2])} rg ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`);
  }

  /** A clickable area (an https link). */
  link(x: number, y: number, w: number, h: number, url: string): void {
    if (/^https?:\/\//.test(url)) this.page.links.push({ rect: [x, this.height - y - h, x + w, this.height - y], url });
  }

  /** The finished file. */
  render(): Buffer {
    if (!this.pages.length) this.addPage();
    const objects: Array<Buffer | string> = [];
    const add = (o: Buffer | string) => objects.push(o) as number; // its object number
    const stream = (dict: string, body: Buffer) => {
      const z = zlib.deflateSync(body);
      return Buffer.concat([Buffer.from(`<< ${dict} /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream', 'latin1')]);
    };
    const catalog = add('');
    const pagesObj = add('');
    const fontRefs: Record<FontStyle, number> = { regular: 0, bold: 0 };
    for (const style of ['regular', 'bold'] as FontStyle[]) {
      const font = loadFont(style);
      const used = this.used[style];
      const k = 1000 / font.unitsPerEm;
      const sub = subsetFont(font, used.keys());
      const file = add(stream(`/Length1 ${sub.length}`, sub));
      const desc = add(
        `<< /Type /FontDescriptor /FontName /${font.name} /Flags 32 /FontBBox [${font.bbox.map((v) => Math.round(v * k)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(font.ascent * k)} /Descent ${Math.round(font.descent * k)} /CapHeight ${Math.round(font.capHeight * k)} /StemV 80 /FontFile2 ${file} 0 R >>`
      );
      const gids = [...used.keys()].sort((a, b) => a - b);
      const widths = gids.map((g) => `${g} [${Math.round(font.advances[g] * k)}]`).join(' ');
      const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /W [${widths}] /DW ${Math.round(font.advances[0] * k)} /CIDToGIDMap /Identity >>`);
      // Copy and search: each glyph back to its character.
      const bf = gids.map((g) => {
        const cp = used.get(g)!;
        const u = cp > 0xffff ? String.fromCodePoint(cp) : String.fromCharCode(cp);
        const hex = Array.from(Buffer.from(u, 'utf16le'))
          .reduce<string[]>((acc, b, i, arr) => (i % 2 ? acc : [...acc, ((arr[i + 1] << 8) | b).toString(16).padStart(4, '0')]), [])
          .join('');
        return `<${g.toString(16).padStart(4, '0')}> <${hex}>`;
      });
      const chunks: string[] = [];
      for (let i = 0; i < bf.length; i += 100) chunks.push(`${Math.min(100, bf.length - i)} beginbfchar\n${bf.slice(i, i + 100).join('\n')}\nendbfchar`);
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
      const toUnicode = add(stream('', Buffer.from(cmap, 'latin1')));
      fontRefs[style] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${font.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
    }
    const pageRefs: number[] = [];
    for (const p of this.pages) {
      const content = add(stream('', Buffer.from(p.ops.join('\n'), 'latin1')));
      const annots = p.links.map((l) => add(`<< /Type /Annot /Subtype /Link /Rect [${l.rect.map(num).join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(l.url)} >> >>`));
      pageRefs.push(
        add(
          `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << /F1 ${fontRefs.regular} 0 R /F2 ${fontRefs.bold} 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`
        )
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
    const infoRef = add(`<< /Title ${pdfString(this.info.title)} /Author ${pdfString(this.info.author)}${this.info.subject ? ` /Subject ${pdfString(this.info.subject)}` : ''} /Producer (Beautiful UAE Home) >>`);

    const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const xref: number[] = [];
    objects.forEach((o, i) => {
      xref.push(offset);
      const body = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n', 'latin1')]);
      chunks.push(body);
      offset += body.length;
    });
    const xrefText = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoRef} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(Buffer.from(xrefText, 'latin1'));
    return Buffer.concat(chunks);
  }
}
