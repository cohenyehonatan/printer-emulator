/**
 * Minimal, dependency-free PNG encoder (8-bit grayscale).
 *
 * Writes a baseline PNG using only Node's built-in `zlib`: the 8-byte
 * signature, an IHDR chunk (bit-depth 8, color-type 0 = grayscale, no
 * interlace), a single deflated IDAT carrying the scanlines (each prefixed with
 * filter byte 0 = None), and IEND. Every chunk is length-prefixed and trailed
 * by its CRC-32 per the PNG spec (RFC 2083). 8-bit grayscale is the natural fit
 * for the luma we decode out of PWG/URF raster pages.
 *
 * Never throws on a well-sized buffer; callers size `gray` as width*height.
 */

import { deflateSync } from 'zlib';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * Encode a width×height 8-bit grayscale image (`gray`, row-major, one byte per
 * pixel) as a PNG. If `gray` is shorter than width*height the missing trailing
 * pixels are treated as 0 (black); excess bytes are ignored.
 */
export function encodeGrayPng(
  width: number,
  height: number,
  gray: Uint8Array
): Buffer {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));

  // IHDR: width, height, bit-depth=8, color-type=0 (grayscale), the three
  // fixed bytes (compression=0, filter=0, interlace=0).
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(0, 9); // color type: grayscale
  ihdr.writeUInt8(0, 10); // compression method
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace method

  // Raw scanlines: each row is [filter byte 0][w pixel bytes].
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      raw[rowStart + 1 + x] = gray[y * w + x] ?? 0;
    }
  }

  const idatData = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Build one PNG chunk: length(4) + type(4) + data + CRC-32(4). */
function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// ── CRC-32 (PNG/zlib polynomial 0xEDB88320), table-driven ─────────────────

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

/** Standard PNG CRC-32 over a byte sequence. */
export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
