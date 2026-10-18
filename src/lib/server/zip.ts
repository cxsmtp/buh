import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * A minimal ZIP writer (the accountant's export): written straight to a file one entry at a time,
 * so only one file (a bill, at most 10 MB) is ever in memory. Text is deflated; photos and PDFs,
 * already compressed, are stored. UTF-8 names. Opens in Windows Explorer, macOS, Android and iOS
 * Files. No ZIP64: refused past 65,000 files or 4 GB (the bills folder stops at 2 GB).
 */

const LIMIT = 0xffffffff;

function dosTime(d: Date): { time: number; date: number } {
  // The UAE's wall clock (UTC+4), which is what people expect to see in Explorer.
  const t = new Date(d.getTime() + 4 * 3600_000);
  return {
    time: (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | Math.floor(t.getUTCSeconds() / 2),
    date: ((Math.max(1980, t.getUTCFullYear()) - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate(),
  };
}

interface Central {
  name: Buffer;
  crc: number;
  csize: number;
  size: number;
  method: number;
  time: number;
  date: number;
  offset: number;
}

export class ZipWriter {
  private fd: number;
  private offset = 0;
  private entries: Central[] = [];
  private names = new Set<string>();

  constructor(file: string) {
    this.fd = fs.openSync(file, 'wx', 0o600);
  }

  private write(buf: Buffer) {
    let done = 0;
    while (done < buf.length) done += fs.writeSync(this.fd, buf, done, buf.length - done);
    this.offset += buf.length;
  }

  /** Add one file. `compress: false` for data that is already compressed (photos, PDFs). */
  add(name: string, data: Buffer, { compress = true, mtime = new Date() }: { compress?: boolean; mtime?: Date } = {}): void {
    if (!name || name.startsWith('/') || name.split('/').includes('..') || this.names.has(name)) throw new Error(`Bad or repeated name in ZIP: ${name}`);
    if (this.entries.length >= 65_000) throw new Error('Too many files for one ZIP.');
    this.names.add(name);
    const body = compress ? zlib.deflateRawSync(data, { level: 6 }) : data;
    const method = compress ? 8 : 0;
    const crc = zlib.crc32(data);
    const { time, date } = dosTime(mtime);
    const nameBuf = Buffer.from(name, 'utf8');
    if (this.offset + 30 + nameBuf.length + body.length > LIMIT) throw new Error('The ZIP would be larger than 4 GB.');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const offset = this.offset;
    this.write(head);
    this.write(nameBuf);
    this.write(body);
    this.entries.push({ name: nameBuf, crc, csize: body.length, size: data.length, method, time, date, offset });
  }

  /** Write the central directory and close the file. */
  close(): void {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // made by
      h.writeUInt16LE(20, 6); // needed
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      // extra, comment, disk, internal attributes: 0; external attributes: 0; then the offset.
      h.writeUInt32LE(e.offset, 42);
      this.write(h);
      this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
  }

  /** Give up: close the file (the caller removes it). */
  abort(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}

/** Read a ZIP back (tests, and checking an export): name → bytes. */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a ZIP file.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged ZIP (central directory).');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (zlib.crc32(data) !== crc) throw new Error(`Damaged ZIP: ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
