import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { encodeGrayPng, crc32 } from '../../src/utils/png.js';

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
