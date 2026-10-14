/**
 * Minimal POSIX ustar writer/reader for backup archives (regular files only,
 * names under 100 characters). Readable by any `tar` tool: `tar -xzf file`.
 */

export interface TarEntry {
  name: string;
  data: Buffer;
  mtime?: Date;
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(entry: TarEntry): Buffer {
  if (Buffer.byteLength(entry.name) >= 100) throw new Error(`Name too long for tar: ${entry.name}`);
  const h = Buffer.alloc(512, 0);
  h.write(entry.name, 0, 100, 'utf8');
  h.write(octal(0o600, 8), 100, 8, 'ascii'); // mode
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(entry.data.length, 12), 124, 12, 'ascii'); // size
  h.write(octal(Math.floor((entry.mtime ?? new Date()).getTime() / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder (spaces)
  h.write('0', 156, 1, 'ascii'); // regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

export function writeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e), e.data);
    const pad = (512 - (e.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0)); // end of archive
  return Buffer.concat(parts);
}

export function readTar(buf: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0[\s\S]*$/, '').trim() || '0', 8);
    const stored = parseInt(h.subarray(148, 156).toString('ascii').replace(/\0[\s\S]*$/, '').trim(), 8);
    const check = Buffer.from(h);
    check.write('        ', 148, 8, 'ascii');
    let sum = 0;
    for (const b of check) sum += b;
    if (sum !== stored) throw new Error(`Damaged archive (checksum) at ${name || off}`);
    if (!Number.isFinite(size) || size < 0 || off + 512 + size > buf.length) throw new Error(`Damaged archive (size) at ${name}`);
    out.push({ name, data: Buffer.from(buf.subarray(off + 512, off + 512 + size)) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
