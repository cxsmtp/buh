import fs from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

/**
 * A minimal ZIP writer (the accountant's export): written straight to a file one entry at a time,
 * asynchronously (the shop keeps answering while it is made), so no whole file is ever in memory:
 * a bill is copied a piece at a time, a long CSV is deflated as it is made. Text is deflated;
 * photos and PDFs, already compressed, are stored. UTF-8 names. Opens in Windows Explorer, macOS,
 * Android and iOS Files. No ZIP64: refused past 65,000 files or 4 GB.
 */

const LIMIT = 0xffffffff;
const deflateRaw = promisify(zlib.deflateRaw);
/** Bit 3: sizes and CRC follow the data (for an entry deflated as it is made); bit 11: UTF-8 names. */
const UTF8 = 0x0800;
const DESCRIPTOR = 0x0008;

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
  flags: number;
  crc: number;
  csize: number;
  size: number;
  method: number;
  time: number;
  date: number;
  offset: number;
}

function localHeader(e: Omit<Central, 'offset' | 'name'> & { nameLength: number }): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(e.flags, 6);
  head.writeUInt16LE(e.method, 8);
  head.writeUInt16LE(e.time, 10);
  head.writeUInt16LE(e.date, 12);
  head.writeUInt32LE(e.crc, 14);
  head.writeUInt32LE(e.csize, 18);
  head.writeUInt32LE(e.size, 22);
  head.writeUInt16LE(e.nameLength, 26);
  head.writeUInt16LE(0, 28);
  return head;
}

export class ZipWriter {
  private offset = 0;
  private entries: Central[] = [];
  private names = new Set<string>();

  private constructor(private fh: fs.promises.FileHandle) {}

  /** A new ZIP file (it must not exist yet). */
  static async create(file: string): Promise<ZipWriter> {
    return new ZipWriter(await fs.promises.open(file, 'wx', 0o600));
  }

  private async write(buf: Buffer) {
    if (this.offset + buf.length > LIMIT) throw new Error('The ZIP would be larger than 4 GB.');
    let done = 0;
    while (done < buf.length) done += (await this.fh.write(buf, done, buf.length - done)).bytesWritten;
    this.offset += buf.length;
  }

  private claim(name: string): Buffer {
    if (!name || name.startsWith('/') || name.split('/').includes('..') || this.names.has(name)) throw new Error(`Bad or repeated name in ZIP: ${name}`);
    if (this.entries.length >= 65_000) throw new Error('Too many files for one ZIP.');
    this.names.add(name);
    return Buffer.from(name, 'utf8');
  }

  /** Add one file from memory. `compress: false` for data that is already compressed. */
  async add(name: string, data: Buffer, { compress = true, mtime = new Date() }: { compress?: boolean; mtime?: Date } = {}): Promise<void> {
    const nameBuf = this.claim(name);
    // Deflated off the main thread (libuv's pool).
    const body = compress ? await deflateRaw(data, { level: 6 }) : data;
    const e = { flags: UTF8, crc: zlib.crc32(data), csize: body.length, size: data.length, method: compress ? 8 : 0, ...dosTime(mtime) };
    const offset = this.offset;
    await this.write(localHeader({ ...e, nameLength: nameBuf.length }));
    await this.write(nameBuf);
    await this.write(body);
    this.entries.push({ ...e, name: nameBuf, offset });
  }

  /** Add a file from disk, stored as it is (a photo or a PDF), copied a piece at a time. */
  async addFile(name: string, file: string, { mtime = new Date() }: { mtime?: Date } = {}): Promise<void> {
    // The CRC first (one read), then the copy (a second read): the header needs it before the data.
    let crc = 0;
    let size = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
    }
    const nameBuf = this.claim(name);
    const e = { flags: UTF8, crc, csize: size, size, method: 0, ...dosTime(mtime) };
    const offset = this.offset;
    await this.write(localHeader({ ...e, nameLength: nameBuf.length }));
    await this.write(nameBuf);
    let copied = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 }) as AsyncIterable<Buffer>) {
      copied += chunk.length;
      if (copied > size) throw new Error(`${name} changed while it was added.`);
      await this.write(chunk);
    }
    if (copied !== size) throw new Error(`${name} changed while it was added.`);
    this.entries.push({ ...e, name: nameBuf, offset });
  }

  /** Add a text made a piece at a time (a long CSV), deflated as it comes: never all in memory. */
  async addStream(name: string, pieces: Iterable<string | Buffer> | AsyncIterable<string | Buffer>, { mtime = new Date() }: { mtime?: Date } = {}): Promise<void> {
    const nameBuf = this.claim(name);
    const t = dosTime(mtime);
    const offset = this.offset;
    await this.write(localHeader({ flags: UTF8 | DESCRIPTOR, crc: 0, csize: 0, size: 0, method: 8, ...t, nameLength: nameBuf.length }));
    await this.write(nameBuf);
    let crc = 0;
    let size = 0;
    const start = this.offset;
    async function* source() {
      for await (const p of pieces) {
        const b = typeof p === 'string' ? Buffer.from(p, 'utf8') : p;
        crc = zlib.crc32(b, crc);
        size += b.length;
        yield b;
        // Between pieces, the shop answers other requests.
        await new Promise((r) => setImmediate(r));
      }
    }
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.write(chunk).then(() => cb(), cb);
      },
    });
    await pipeline(source, zlib.createDeflateRaw({ level: 6 }), sink);
    const csize = this.offset - start;
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(csize, 8);
    desc.writeUInt32LE(size, 12);
    await this.write(desc);
    this.entries.push({ name: nameBuf, flags: UTF8 | DESCRIPTOR, crc, csize, size, method: 8, ...t, offset });
  }

  /** Write the central directory and close the file. */
  async close(): Promise<void> {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // made by
      h.writeUInt16LE(20, 6); // needed
      h.writeUInt16LE(e.flags, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.name.length, 28);
      // extra, comment, disk, internal attributes: 0; external attributes: 0; then the offset.
      h.writeUInt32LE(e.offset, 42);
      await this.write(h);
      await this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    await this.fh.close();
  }

  /** Give up: close the file (the caller removes it). */
  async abort(): Promise<void> {
    try {
      await this.fh.close();
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
