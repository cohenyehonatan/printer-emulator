import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import {
  encodeGrayPng,
  encodeRgbPng,
  encodeGray16Png,
  encodeRgb16Png,
  crc32,
} from '../../src/utils/png.js';

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Walk PNG chunks: returns [{ type, data, declaredCrc, offsetOfTypePlusData }]. */
function readChunks(
  png: Buffer
): { type: string; data: Buffer; crc: number; crcInput: Buffer }[] {
  const chunks: {
    type: string;
    data: Buffer;
    crc: number;
    crcInput: Buffer;
  }[] = [];
  let pos = PNG_SIGNATURE.length;
  while (pos + 8 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const data = png.subarray(dataStart, dataStart + length);
    const crc = png.readUInt32BE(dataStart + length);
    const crcInput = png.subarray(pos + 4, dataStart + length); // type + data
    chunks.push({ type, data, crc, crcInput });
    pos = dataStart + length + 4;
  }
  return chunks;
}

describe('encodeGrayPng', () => {
  it('writes a valid PNG signature', () => {
    const png = encodeGrayPng(2, 2, new Uint8Array([0, 1, 2, 3]));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('writes IHDR with the right width/height/bit-depth/color-type', () => {
    const png = encodeGrayPng(3, 2, new Uint8Array(6));
    const ihdr = readChunks(png).find((c) => c.type === 'IHDR');
    expect(ihdr).toBeDefined();
    expect(ihdr!.data).toHaveLength(13);
    expect(ihdr!.data.readUInt32BE(0)).toBe(3); // width
    expect(ihdr!.data.readUInt32BE(4)).toBe(2); // height
    expect(ihdr!.data.readUInt8(8)).toBe(8); // bit depth
    expect(ihdr!.data.readUInt8(9)).toBe(0); // color type: grayscale
    expect(ihdr!.data.readUInt8(12)).toBe(0); // interlace: none
  });

  it('emits IHDR, IDAT, IEND in order, ending with IEND', () => {
    const png = encodeGrayPng(1, 1, new Uint8Array([42]));
    const types = readChunks(png).map((c) => c.type);
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('writes a correct CRC-32 on every chunk', () => {
    const png = encodeGrayPng(4, 3, new Uint8Array(12).fill(99));
    for (const chunk of readChunks(png)) {
      expect(chunk.crc).toBe(crc32(chunk.crcInput));
    }
  });

  it('IDAT inflates to scanlines with a per-row filter byte 0', () => {
    // 3x2 image with known values.
    const gray = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const png = encodeGrayPng(3, 2, gray);
    const idat = readChunks(png).find((c) => c.type === 'IDAT');
    expect(idat).toBeDefined();

    const raw = inflateSync(idat!.data);
    // Each row is [filter=0][3 pixel bytes] => 2 rows * 4 = 8 bytes.
    expect(Array.from(raw)).toEqual([
      0, 10, 20, 30, // row 0: filter + pixels
      0, 40, 50, 60, // row 1: filter + pixels
    ]);
  });

  it('pads missing trailing pixels with 0 (black)', () => {
    const png = encodeGrayPng(2, 2, new Uint8Array([1, 2])); // only 2 of 4
    const idat = readChunks(png).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);
    expect(Array.from(raw)).toEqual([
      0, 1, 2, // row 0
      0, 0, 0, // row 1 padded
    ]);
  });
});

describe('encodeRgbPng', () => {
  it('writes a valid PNG signature', () => {
    const png = encodeRgbPng(1, 1, new Uint8Array([1, 2, 3]));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('writes IHDR with bit-depth 8 and color-type 2 (truecolor)', () => {
    const png = encodeRgbPng(3, 2, new Uint8Array(18));
    const ihdr = readChunks(png).find((c) => c.type === 'IHDR');
    expect(ihdr).toBeDefined();
    expect(ihdr!.data).toHaveLength(13);
    expect(ihdr!.data.readUInt32BE(0)).toBe(3); // width
    expect(ihdr!.data.readUInt32BE(4)).toBe(2); // height
    expect(ihdr!.data.readUInt8(8)).toBe(8); // bit depth
    expect(ihdr!.data.readUInt8(9)).toBe(2); // color type: truecolor RGB
    expect(ihdr!.data.readUInt8(12)).toBe(0); // interlace: none
  });

  it('emits IHDR, IDAT, IEND in order, ending with IEND', () => {
    const png = encodeRgbPng(1, 1, new Uint8Array([7, 8, 9]));
    const types = readChunks(png).map((c) => c.type);
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('writes a correct CRC-32 on every chunk', () => {
    const png = encodeRgbPng(2, 2, new Uint8Array(12).fill(77));
    for (const chunk of readChunks(png)) {
      expect(chunk.crc).toBe(crc32(chunk.crcInput));
    }
  });

  it('IDAT inflates to RGB scanlines with a per-row filter byte 0', () => {
    // 2x2 image: each pixel 3 bytes (R,G,B).
    const rgb = new Uint8Array([
      10, 11, 12, 20, 21, 22, // row 0: 2 pixels
      30, 31, 32, 40, 41, 42, // row 1: 2 pixels
    ]);
    const png = encodeRgbPng(2, 2, rgb);
    const idat = readChunks(png).find((c) => c.type === 'IDAT');
    expect(idat).toBeDefined();

    const raw = inflateSync(idat!.data);
    // Each row is [filter=0][2*3 pixel bytes] => 2 rows * 7 = 14 bytes.
    expect(Array.from(raw)).toEqual([
      0, 10, 11, 12, 20, 21, 22, // row 0: filter + 2 RGB pixels
      0, 30, 31, 32, 40, 41, 42, // row 1: filter + 2 RGB pixels
    ]);
  });

  it('pads missing trailing RGB samples with 0 (black)', () => {
    // 1x2: only the first pixel's 3 bytes provided.
    const png = encodeRgbPng(1, 2, new Uint8Array([5, 6, 7]));
    const idat = readChunks(png).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);
    expect(Array.from(raw)).toEqual([
      0, 5, 6, 7, // row 0
      0, 0, 0, 0, // row 1 padded
    ]);
  });
});

describe('encodeGray16Png', () => {
  it('writes a valid PNG signature', () => {
    const png = encodeGray16Png(2, 1, new Uint16Array([0x0102, 0x80ff]));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('writes IHDR with bit-depth 16 and color-type 0 (grayscale)', () => {
    const png = encodeGray16Png(3, 2, new Uint16Array(6));
    const ihdr = readChunks(png).find((c) => c.type === 'IHDR');
    expect(ihdr).toBeDefined();
    expect(ihdr!.data).toHaveLength(13);
    expect(ihdr!.data.readUInt32BE(0)).toBe(3); // width
    expect(ihdr!.data.readUInt32BE(4)).toBe(2); // height
    expect(ihdr!.data.readUInt8(8)).toBe(16); // bit depth
    expect(ihdr!.data.readUInt8(9)).toBe(0); // color type: grayscale
    expect(ihdr!.data.readUInt8(12)).toBe(0); // interlace: none
  });

  it('emits IHDR, IDAT, IEND in order, ending with IEND', () => {
    const png = encodeGray16Png(1, 1, new Uint16Array([0x1234]));
    const types = readChunks(png).map((c) => c.type);
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('writes a correct CRC-32 on every chunk', () => {
    const png = encodeGray16Png(4, 3, new Uint16Array(12).fill(0xabcd));
    for (const chunk of readChunks(png)) {
      expect(chunk.crc).toBe(crc32(chunk.crcInput));
    }
  });

  it('IDAT inflates to big-endian 16-bit scanlines with a filter byte 0', () => {
    // 2x2 image; values chosen to differ in the low byte (proving full 16-bit).
    const samples = new Uint16Array([0x0102, 0x80ff, 0x1234, 0xabcd]);
    const png = encodeGray16Png(2, 2, samples);
    const idat = readChunks(png).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);
    // Each row = [filter=0][2 px * 2 bytes big-endian] = 5 bytes; 2 rows = 10.
    expect(Array.from(raw)).toEqual([
      0, 0x01, 0x02, 0x80, 0xff, // row 0: 0x0102, 0x80FF (high byte first)
      0, 0x12, 0x34, 0xab, 0xcd, // row 1: 0x1234, 0xABCD
    ]);
  });

  it('pads missing trailing pixels with 0 (black)', () => {
    const png = encodeGray16Png(2, 2, new Uint16Array([0x0a0b, 0x0c0d]));
    const idat = readChunks(png).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);
    expect(Array.from(raw)).toEqual([
      0, 0x0a, 0x0b, 0x0c, 0x0d, // row 0
      0, 0x00, 0x00, 0x00, 0x00, // row 1 padded
    ]);
  });
});

describe('encodeRgb16Png', () => {
  it('writes a valid PNG signature', () => {
    const png = encodeRgb16Png(1, 1, new Uint16Array([0x0102, 0x0304, 0x0506]));
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('writes IHDR with bit-depth 16 and color-type 2 (truecolor)', () => {
    const png = encodeRgb16Png(3, 2, new Uint16Array(18));
    const ihdr = readChunks(png).find((c) => c.type === 'IHDR');
    expect(ihdr).toBeDefined();
    expect(ihdr!.data).toHaveLength(13);
    expect(ihdr!.data.readUInt32BE(0)).toBe(3); // width
    expect(ihdr!.data.readUInt32BE(4)).toBe(2); // height
    expect(ihdr!.data.readUInt8(8)).toBe(16); // bit depth
    expect(ihdr!.data.readUInt8(9)).toBe(2); // color type: truecolor RGB
    expect(ihdr!.data.readUInt8(12)).toBe(0); // interlace: none
  });

  it('emits IHDR, IDAT, IEND in order, ending with IEND', () => {
    const png = encodeRgb16Png(1, 1, new Uint16Array([1, 2, 3]));
    const types = readChunks(png).map((c) => c.type);
    expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('writes a correct CRC-32 on every chunk', () => {
    const png = encodeRgb16Png(2, 2, new Uint16Array(12).fill(0x7788));
    for (const chunk of readChunks(png)) {
      expect(chunk.crc).toBe(crc32(chunk.crcInput));
    }
  });

  it('IDAT inflates to big-endian 16-bit RGB scanlines with a filter byte 0', () => {
    // 2x1 image: 2 pixels, 3 uint16 channels each; low bytes vary.
    const samples = new Uint16Array([
      0xaabb, 0xccdd, 0xeeff, // px0
      0x1122, 0x3344, 0x5566, // px1
    ]);
    const png = encodeRgb16Png(2, 1, samples);
    const idat = readChunks(png).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);
    // Row = [filter=0][2 px * 3 ch * 2 bytes big-endian] = 13 bytes.
    expect(Array.from(raw)).toEqual([
      0,
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, // px0 R,G,B (high byte first)
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, // px1
    ]);
  });

  it('pads missing trailing RGB samples with 0 (black)', () => {
    // 1x2: only px0's 3 channels provided; row 1 padded.
    const png = encodeRgb16Png(1, 2, new Uint16Array([0x0102, 0x0304, 0x0506]));
    const idat = readChunks(png).find((c) => c.type === 'IDAT')!;
    const raw = inflateSync(idat.data);
    expect(Array.from(raw)).toEqual([
      0, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, // row 0
      0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // row 1 padded
    ]);
  });
});
