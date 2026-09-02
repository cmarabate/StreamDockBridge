/**
 * Reading an image's DECLARED dimensions without decoding it.
 *
 * A small file can declare enormous dimensions and demand gigabytes from
 * whatever decodes it — and here that is the host's own image decoder and the
 * Property Inspector's browser, neither of which we control. Every accepted
 * format is checked, not just PNG: a 2 KB JPEG declaring 65535x65535 is the
 * same attack as the PNG one.
 *
 * Nothing here decompresses anything. These are fixed-offset header reads.
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** PNG: IHDR is always the first chunk, at a fixed offset. */
export function pngDimensions(body: Buffer): Dimensions | null {
  if (body.length < 24) return null;
  if (body.slice(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

/**
 * JPEG: walk the marker segments to the frame header.
 *
 * SOF0-SOF15 carry the real dimensions; DHT/JPG/DAC share that marker range
 * but are not frame headers, so they are skipped like any other segment.
 */
export function jpegDimensions(body: Buffer): Dimensions | null {
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return null;

  let offset = 2;
  // Bounded by the buffer, and every step advances, so this cannot spin.
  while (offset + 9 < body.length) {
    if (body[offset] !== 0xff) {
      offset++; // fill byte or padding
      continue;
    }
    const marker = body[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers carry no length.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = body.readUInt16BE(offset + 2);
    if (length < 2) return null;

    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (offset + 9 >= body.length) return null;
      // length(2) precision(1) height(2) width(2)
      return { height: body.readUInt16BE(offset + 5), width: body.readUInt16BE(offset + 7) };
    }

    // Entropy-coded data follows the scan header and is not length-prefixed.
    if (marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * A Windows DIB header, as carried by a classic (non-PNG) ICO entry.
 *
 * `biHeight` is doubled for an icon because the DIB holds both the colour image
 * and its AND mask stacked, so the real height is half. It may also be negative
 * for a top-down bitmap.
 */
export function dibDimensions(body: Buffer): Dimensions | null {
  if (body.length < 16) return null;
  const headerSize = body.readUInt32LE(0);
  // BITMAPINFOHEADER (40), BITMAPV4HEADER (108), BITMAPV5HEADER (124).
  if (headerSize !== 40 && headerSize !== 108 && headerSize !== 124) return null;

  const width = Math.abs(body.readInt32LE(4));
  const storedHeight = Math.abs(body.readInt32LE(8));
  if (width <= 0 || storedHeight <= 0) return null;

  return { width, height: Math.ceil(storedHeight / 2) };
}

/**
 * ICO: the directory bounds each entry to 256px, but that byte is only a hint.
 * An entry may hold a whole PNG whose IHDR declares anything, or a raw DIB
 * whose BITMAPINFOHEADER does. The payload is what a decoder sizes its
 * allocation from, so the payload is what must be judged.
 */
export function icoDimensions(body: Buffer): Dimensions | null {
  if (body.length < 6) return null;
  const count = body.readUInt16LE(4);
  if (count === 0 || count > 64) return null;

  let largest: Dimensions | null = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > body.length) break;

    const offset = body.readUInt32LE(entry + 12);
    const size = body.readUInt32LE(entry + 8);
    let dims: Dimensions | null = null;

    if (offset + 24 <= body.length && size > 0) {
      const embedded = body.subarray(offset, offset + Math.min(size, body.length - offset));
      // A PNG-compressed entry is decoded as a PNG, so read its real header.
      if (embedded.length >= 24 && embedded[0] === 0x89 && embedded.slice(1, 4).toString('ascii') === 'PNG') {
        dims = pngDimensions(embedded);
      } else {
        dims = dibDimensions(embedded);
      }
    }

    /**
     * The directory byte is a HINT; the payload header is what a decoder sizes
     * its allocation from. Take whichever is larger, because an entry claiming
     * 256x256 in the directory while its BITMAPINFOHEADER declares 30000x60000
     * is exactly the file this check exists to refuse.
     */
    const declared = { width: body[entry] || 256, height: body[entry + 1] || 256 };
    if (!dims) {
      dims = declared;
    } else {
      dims = {
        width: Math.max(dims.width, declared.width),
        height: Math.max(dims.height, declared.height),
      };
    }

    if (!largest || dims.width * dims.height > largest.width * largest.height) largest = dims;
  }
  return largest;
}

/** WebP: three container variants, each with the canvas size in its header. */
export function webpDimensions(body: Buffer): Dimensions | null {
  if (body.length < 30) return null;
  const chunk = body.slice(12, 16).toString('ascii');

  if (chunk === 'VP8X') {
    // 24-bit little-endian, stored as size-1.
    const width = 1 + (body[24] | (body[25] << 8) | (body[26] << 16));
    const height = 1 + (body[27] | (body[28] << 8) | (body[29] << 16));
    return { width, height };
  }

  if (chunk === 'VP8L') {
    if (body.length < 25 || body[20] !== 0x2f) return null;
    const bits = body.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }

  if (chunk === 'VP8 ') {
    // Lossy keyframe: start code 9d 01 2a, then two 16-bit fields.
    if (body.length < 30) return null;
    if (body[23] !== 0x9d || body[24] !== 0x01 || body[25] !== 0x2a) return null;
    return {
      width: body.readUInt16LE(26) & 0x3fff,
      height: body.readUInt16LE(28) & 0x3fff,
    };
  }

  return null;
}

/**
 * Declared dimensions for any type this service accepts.
 *
 * Returns null when they cannot be determined. Callers treat that as "cannot
 * be proven safe" for formats that are supposed to carry dimensions.
 */
export function imageDimensions(body: Buffer, mime: string): Dimensions | null {
  switch (mime) {
    case 'image/png':
      return pngDimensions(body);
    case 'image/jpeg':
      return jpegDimensions(body);
    case 'image/x-icon':
      return icoDimensions(body);
    case 'image/webp':
      return webpDimensions(body);
    default:
      return null;
  }
}
