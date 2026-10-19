import zlib from 'node:zlib';

/** One PNG chunk (length, type, data, CRC). */
export function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A real, viewable RGB PNG drawn pixel by pixel, with extra chunks (e.g. tEXt metadata) placed
 * before the picture data.
 */
export function makePng(width: number, height: number, draw: (x: number, y: number) => [number, number, number], extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = draw(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A stand-in "bedroom" picture: a warm wall, a headboard, and an indigo-on-white made bed. */
export function bedroomPng(width = 320, height = 400, extra: Buffer[] = []): Buffer {
  return makePng(
    width,
    height,
    (x, y) => {
      const bedTop = Math.round(height * 0.5);
      const headTop = Math.round(height * 0.28);
      if (y < headTop) return [226 - Math.round((y / headTop) * 20), 211, 190];
      if (y < bedTop) return x > width * 0.12 && x < width * 0.88 ? [120, 92, 70] : [214, 199, 178];
      if (x < width * 0.06 || x > width * 0.94) return [168, 140, 110];
      // The sheet: indigo flowers on white, in a grid.
      const cx = (x % 40) - 20;
      const cy = ((y - bedTop) % 40) - 20;
      return cx * cx + cy * cy < 64 ? [47, 63, 122] : [246, 244, 238];
    },
    extra
  );
}
