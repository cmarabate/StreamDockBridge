import {
  imageDimensions,
  pngDimensions,
  jpegDimensions,
  icoDimensions,
  webpDimensions,
  dibDimensions,
} from './imageDimensions';

/**
 * A small file declaring enormous dimensions is a decompression bomb aimed at
 * whatever decodes it — here, VSD Craft's image decoder and the Property
 * Inspector's browser. Every accepted format has to be checked, not just PNG.
 */

function png(width: number, height: number): Buffer {
  const body = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    Buffer.alloc(8),
    Buffer.alloc(64),
  ]);
  body.writeUInt32BE(width, 16);
  body.writeUInt32BE(height, 20);
  return body;
}

/** SOI, a JFIF APP0, then a baseline SOF0 carrying the real dimensions. */
function jpeg(width: number, height: number, marker = 0xc0): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0'),
    Buffer.alloc(9),
    Buffer.from([
      0xff,
      marker,
      0x00,
      0x11,
      0x08,
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      0x03,
    ]),
    Buffer.alloc(9),
  ]);
}

/** A one-entry ICO directory whose payload is the given buffer. */
function ico(embedded: Buffer, declaredWidth = 0, declaredHeight = 0): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = declaredWidth;
  entry[1] = declaredHeight;
  entry.writeUInt32LE(embedded.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, embedded]);
}

function webpVp8x(width: number, height: number): Buffer {
  const body = Buffer.alloc(40);
  body.write('RIFF', 0);
  body.write('WEBP', 8);
  body.write('VP8X', 12);
  body.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  body[24] = w & 0xff;
  body[25] = (w >> 8) & 0xff;
  body[26] = (w >> 16) & 0xff;
  body[27] = h & 0xff;
  body[28] = (h >> 8) & 0xff;
  body[29] = (h >> 16) & 0xff;
  return body;
}

function webpVp8l(width: number, height: number): Buffer {
  const body = Buffer.alloc(40);
  body.write('RIFF', 0);
  body.write('WEBP', 8);
  body.write('VP8L', 12);
  body.writeUInt32LE(20, 16);
  body[20] = 0x2f;
  body.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return body;
}

describe('PNG', () => {
  it('reads the IHDR', () => {
    expect(pngDimensions(png(64, 64))).toEqual({ width: 64, height: 64 });
    expect(pngDimensions(png(30000, 30000))).toEqual({ width: 30000, height: 30000 });
  });

  it('refuses anything that is not a PNG header', () => {
    expect(pngDimensions(Buffer.alloc(4))).toBeNull();
    expect(pngDimensions(jpeg(10, 10))).toBeNull();
  });
});

describe('JPEG', () => {
  /** A ~2 KB JPEG declaring 65535x65535 demands roughly 12.9 GB from a decoder. */
  it('reads the frame header, including the bomb case', () => {
    expect(jpegDimensions(jpeg(120, 80))).toEqual({ width: 120, height: 80 });
    expect(jpegDimensions(jpeg(65535, 65535))).toEqual({ width: 65535, height: 65535 });
  });

  it('reads every real frame-header marker, not just SOF0', () => {
    // SOF2 (progressive) and SOF1 are as common in the wild as SOF0.
    expect(jpegDimensions(jpeg(300, 200, 0xc1))).toEqual({ width: 300, height: 200 });
    expect(jpegDimensions(jpeg(300, 200, 0xc2))).toEqual({ width: 300, height: 200 });
  });

  /** DHT, JPG and DAC share the marker range but are not frame headers. */
  it('does not mistake DHT/DAC for a frame header', () => {
    expect(jpegDimensions(jpeg(300, 200, 0xc4))).toBeNull();
    expect(jpegDimensions(jpeg(300, 200, 0xcc))).toBeNull();
  });

  it('refuses a truncated or non-JPEG buffer', () => {
    expect(jpegDimensions(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(jpegDimensions(png(10, 10))).toBeNull();
    expect(jpegDimensions(Buffer.alloc(0))).toBeNull();
  });
});

describe('ICO', () => {
  /**
   * The directory bounds an entry to 256px, but an entry may hold a whole PNG
   * whose IHDR declares anything — and the PNG is what actually gets decoded.
   */
  it('reads an embedded PNG header rather than the directory', () => {
    expect(icoDimensions(ico(png(30000, 30000)))).toEqual({ width: 30000, height: 30000 });
  });

  it('falls back to the directory entry for a BMP payload', () => {
    expect(icoDimensions(ico(Buffer.alloc(64), 32, 32))).toEqual({ width: 32, height: 32 });
    // 0 means 256 in the ICO directory.
    expect(icoDimensions(ico(Buffer.alloc(64), 0, 0))).toEqual({ width: 256, height: 256 });
  });

  it('refuses a malformed directory', () => {
    expect(icoDimensions(Buffer.alloc(4))).toBeNull();
    expect(icoDimensions(Buffer.from([0, 0, 1, 0, 0, 0]))).toBeNull();
  });
});

/**
 * A raw-DIB ICO entry is sized from its BITMAPINFOHEADER, not the directory's
 * single byte. An entry claiming 256x256 while its header declares 30000x60000
 * is exactly the file the dimension check exists to refuse.
 */
describe('ICO entries holding a raw DIB', () => {
  function dib(width: number, height: number, headerSize = 40): Buffer {
    const body = Buffer.alloc(Math.max(40, headerSize));
    body.writeUInt32LE(headerSize, 0);
    body.writeInt32LE(width, 4);
    // Icon DIBs stack the image and its mask, so the stored height is doubled.
    body.writeInt32LE(height * 2, 8);
    return body;
  }

  it('reads a BITMAPINFOHEADER and halves the stacked height', () => {
    expect(dibDimensions(dib(32, 32))).toEqual({ width: 32, height: 32 });
    expect(dibDimensions(dib(30000, 60000))).toEqual({ width: 30000, height: 60000 });
  });

  it('accepts the V4 and V5 header sizes too', () => {
    expect(dibDimensions(dib(48, 48, 108))).toEqual({ width: 48, height: 48 });
    expect(dibDimensions(dib(48, 48, 124))).toEqual({ width: 48, height: 48 });
  });

  it('refuses anything that is not a DIB header', () => {
    expect(dibDimensions(Buffer.alloc(8))).toBeNull();
    expect(dibDimensions(png(10, 10))).toBeNull();
  });

  it('takes the payload header over the directory byte', () => {
    const payload = dib(30000, 60000);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const entry = Buffer.alloc(16);
    entry[0] = 0; // directory claims 256
    entry[1] = 0;
    entry.writeUInt32LE(payload.length, 8);
    entry.writeUInt32LE(22, 12);
    const crafted = Buffer.concat([header, entry, payload]);

    const dims = icoDimensions(crafted)!;
    expect(dims.width).toBe(30000);
    expect(dims.height).toBe(60000);
  });
});

describe('WebP', () => {
  it('reads the VP8X canvas size', () => {
    expect(webpDimensions(webpVp8x(120, 90))).toEqual({ width: 120, height: 90 });
    expect(webpDimensions(webpVp8x(16777216, 16777216))).toEqual({
      width: 16777216,
      height: 16777216,
    });
  });

  it('reads the VP8L header', () => {
    expect(webpDimensions(webpVp8l(16383, 16383))).toEqual({ width: 16383, height: 16383 });
  });

  it('refuses a buffer that is not WebP', () => {
    expect(webpDimensions(Buffer.alloc(40))).toBeNull();
    expect(webpDimensions(png(10, 10))).toBeNull();
  });
});

describe('dispatch by declared type', () => {
  it('routes each accepted type to its own reader', () => {
    expect(imageDimensions(png(64, 64), 'image/png')).toEqual({ width: 64, height: 64 });
    expect(imageDimensions(jpeg(64, 48), 'image/jpeg')).toEqual({ width: 64, height: 48 });
    expect(imageDimensions(ico(png(300, 300)), 'image/x-icon')).toEqual({ width: 300, height: 300 });
    expect(imageDimensions(webpVp8x(70, 70), 'image/webp')).toEqual({ width: 70, height: 70 });
  });

  it('returns null for a type it does not handle', () => {
    expect(imageDimensions(Buffer.alloc(64), 'image/svg+xml')).toBeNull();
    expect(imageDimensions(Buffer.alloc(64), 'image/gif')).toBeNull();
  });
});
