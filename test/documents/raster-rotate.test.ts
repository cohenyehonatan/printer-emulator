import { describe, it, expect } from 'vitest';
import {
  renderRasterJob,
  rotatePixels,
  orientationToDegrees,
} from '../../src/documents/raster-render.js';
import { OrientationRequested } from '../../src/ipp/constants.js';
import type { Document } from '../../src/documents/document.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Read a PNG IHDR's width/height/color-type. (Signature is 8 bytes; IHDR data
 * starts at byte 16: width@16, height@20, bit-depth@24, color-type@25.)
 */
function pngHeader(png: Buffer): {
  width: number;
  height: number;
  colorType: number;
} {
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png.readUInt8(25),
  };
}

/**
 * Build a single-page PWG-Raster blob whose pixels are taken verbatim from
 * `rows` (one number per pixel for gray, or three per pixel for rgb). Each line
 * is a literal run so the decoded buffer equals the input exactly. width =
 * pixels per row; height = rows.length.
 */
function pwgFromRows(rows: number[][], color: boolean): Buffer {
  const bpp = color ? 3 : 1;
  const width = rows[0].length / bpp;
  const height = rows.length;

  const header = Buffer.alloc(1796);
  header.writeUInt32BE(300, 276); // dpiX
  header.writeUInt32BE(300, 280); // dpiY
  header.writeUInt32BE(width, 372); // cupsWidth
  header.writeUInt32BE(height, 376); // cupsHeight
  header.writeUInt32BE(8, 384); // bitsPerColor
  header.writeUInt32BE(color ? 24 : 8, 388); // bitsPerPixel
  header.writeUInt32BE(width * bpp, 392); // cupsBytesPerLine
  header.writeUInt32BE(color ? 19 : 18, 400); // colorSpace: sRGB / sGray

  const lines: number[] = [];
  for (const row of rows) {
    // lineRepeat=1 (byte 0), literal control = (#groups - 1), then the bytes.
    lines.push(0, width - 1, ...row);
  }

  return Buffer.concat([
    Buffer.from('RaS2', 'ascii'),
    header,
    Buffer.from(lines),
  ]);
}

describe('rotatePixels', () => {
  it('returns the input unchanged at 0°', () => {
    const px = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const r = rotatePixels(px, 3, 2, 1, 0);
    expect(r.width).toBe(3);
    expect(r.height).toBe(2);
    expect(Array.from(r.pixels)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rotates a 3x2 gray buffer 90° CW (dims swap to 2x3)', () => {
    // Source 3 wide × 2 tall:
    //   1 2 3
    //   4 5 6
    // 90° CW → 2 wide × 3 tall:
    //   4 1
    //   5 2
    //   6 3
    const src = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const r = rotatePixels(src, 3, 2, 1, 90);
    expect(r.width).toBe(2);
    expect(r.height).toBe(3);
    expect(Array.from(r.pixels)).toEqual([4, 1, 5, 2, 6, 3]);
  });

  it('rotates a 3x2 gray buffer 270° CW (dims swap to 2x3)', () => {
    // 270° CW (= 90° CCW) →
    //   3 6
    //   2 5
    //   1 4
    const src = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const r = rotatePixels(src, 3, 2, 1, 270);
    expect(r.width).toBe(2);
    expect(r.height).toBe(3);
    expect(Array.from(r.pixels)).toEqual([3, 6, 2, 5, 1, 4]);
  });

  it('rotates a 3x2 gray buffer 180° (dims unchanged)', () => {
    // 180° →
    //   6 5 4
    //   3 2 1
    const src = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const r = rotatePixels(src, 3, 2, 1, 180);
    expect(r.width).toBe(3);
    expect(r.height).toBe(2);
    expect(Array.from(r.pixels)).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('rotates an RGB (3bpp) buffer 90° keeping channels together', () => {
    // 2 wide × 1 tall, pixels A=(1,2,3) B=(4,5,6):
    //   A B
    // 90° CW → 1 wide × 2 tall:
    //   A
    //   B
    const src = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const r = rotatePixels(src, 2, 1, 3, 90);
    expect(r.width).toBe(1);
    expect(r.height).toBe(2);
    expect(Array.from(r.pixels)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rotates an RGB (3bpp) 2x2 buffer 90° CW', () => {
    // 2×2 RGB, pixels:
    //   A B
    //   C D
    // 90° CW → 2×2:
    //   C A
    //   D B
    const A = [10, 11, 12];
    const B = [20, 21, 22];
    const C = [30, 31, 32];
    const D = [40, 41, 42];
    const src = Uint8Array.from([...A, ...B, ...C, ...D]);
    const r = rotatePixels(src, 2, 2, 3, 90);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect(Array.from(r.pixels)).toEqual([...C, ...A, ...D, ...B]);
  });

  it('rotating 90° then 270° round-trips to the original', () => {
    const src = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const once = rotatePixels(src, 3, 2, 1, 90);
    const back = rotatePixels(once.pixels, once.width, once.height, 1, 270);
    expect(back.width).toBe(3);
    expect(back.height).toBe(2);
    expect(Array.from(back.pixels)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('pads a short source buffer with 0 instead of throwing', () => {
    const src = Uint8Array.from([1, 2]); // only 2 of 6 samples
    expect(() => rotatePixels(src, 3, 2, 1, 90)).not.toThrow();
    const r = rotatePixels(src, 3, 2, 1, 90);
    expect(r.width).toBe(2);
    expect(r.height).toBe(3);
    // 90° CW of [1,2,_,_,_,_] → [4,1,5,2,6,3] with missing → 0.
    expect(Array.from(r.pixels)).toEqual([0, 1, 0, 2, 0, 0]);
  });

  it('treats a degenerate dimension as a 0° pass-through', () => {
    const src = Uint8Array.from([]);
    const r = rotatePixels(src, 0, 5, 1, 90);
    expect(r.width).toBe(0);
    expect(r.height).toBe(5);
  });
});

describe('orientationToDegrees', () => {
  it('maps each orientation-requested value to a rotation', () => {
    expect(orientationToDegrees(OrientationRequested.PORTRAIT)).toBe(0);
    expect(orientationToDegrees(OrientationRequested.LANDSCAPE)).toBe(90);
    expect(orientationToDegrees(OrientationRequested.REVERSE_LANDSCAPE)).toBe(
      270
    );
    expect(orientationToDegrees(OrientationRequested.REVERSE_PORTRAIT)).toBe(
      180
    );
  });

  it('falls back to 0° for undefined', () => {
    expect(orientationToDegrees(undefined)).toBe(0);
  });

  it('landscape and reverse-landscape differ by 180°', () => {
    const a = orientationToDegrees(OrientationRequested.LANDSCAPE);
    const b = orientationToDegrees(OrientationRequested.REVERSE_LANDSCAPE);
    expect(Math.abs(a - b)).toBe(180);
  });
});

describe('renderRasterJob — orientation rotates the emitted PNG', () => {
  it('landscape swaps a non-square page\'s PNG width/height', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-rotate-'));
    try {
      // 4 wide × 2 tall grayscale page.
      const rows = [
        [10, 20, 30, 40],
        [50, 60, 70, 80],
      ];
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwgFromRows(rows, false),
      };

      const portrait = renderRasterJob(
        [doc],
        1,
        join(dir, 'portrait'),
        undefined,
        false,
        OrientationRequested.PORTRAIT
      );
      const ph = pngHeader(readFileSync(portrait[0].path));
      expect(ph.width).toBe(4);
      expect(ph.height).toBe(2);

      const landscape = renderRasterJob(
        [doc],
        2,
        join(dir, 'landscape'),
        undefined,
        false,
        OrientationRequested.LANDSCAPE
      );
      const lh = pngHeader(readFileSync(landscape[0].path));
      // 90° rotation transposes dims: 4x2 → 2x4.
      expect(lh.width).toBe(2);
      expect(lh.height).toBe(4);
      // The render result reports the rotated dimensions too.
      expect(landscape[0].widthPx).toBe(2);
      expect(landscape[0].heightPx).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reverse-portrait keeps dims but flips content (180°)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-rotate-180-'));
    try {
      const rows = [
        [10, 20, 30, 40],
        [50, 60, 70, 80],
      ];
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwgFromRows(rows, false),
      };

      const flipped = renderRasterJob(
        [doc],
        1,
        join(dir, 'flip'),
        undefined,
        false,
        OrientationRequested.REVERSE_PORTRAIT
      );
      const fh = pngHeader(readFileSync(flipped[0].path));
      // 180° keeps the 4x2 dimensions.
      expect(fh.width).toBe(4);
      expect(fh.height).toBe(2);
      expect(flipped[0].widthPx).toBe(4);
      expect(flipped[0].heightPx).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates a color page and keeps it RGB (color-type 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-rotate-rgb-'));
    try {
      // 2 wide × 1 tall RGB page: red, green.
      const rows = [[0xff, 0x00, 0x00, 0x00, 0xff, 0x00]];
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwgFromRows(rows, true),
      };

      const landscape = renderRasterJob(
        [doc],
        1,
        join(dir, 'rgb'),
        undefined,
        false,
        OrientationRequested.LANDSCAPE
      );
      const h = pngHeader(readFileSync(landscape[0].path));
      expect(h.colorType).toBe(2); // still truecolor RGB
      // 2x1 → 1x2 under 90°.
      expect(h.width).toBe(1);
      expect(h.height).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
