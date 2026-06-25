import { describe, it, expect } from 'vitest';
import {
  renderRasterJob,
  downscalePixels,
  printQualityToFactor,
} from '../../src/documents/raster-render.js';
import { OrientationRequested, PrintQuality } from '../../src/ipp/constants.js';
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
 * pixels per row; height = rows.length. (Mirrors raster-rotate.test.ts.)
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
    lines.push(0, width - 1, ...row); // lineRepeat=1, literal control, bytes
  }

  return Buffer.concat([
    Buffer.from('RaS2', 'ascii'),
    header,
    Buffer.from(lines),
  ]);
}

describe('printQualityToFactor', () => {
  it('maps draft → 0.5, normal/high → 1.0', () => {
    expect(printQualityToFactor(PrintQuality.DRAFT)).toBe(0.5);
    expect(printQualityToFactor(PrintQuality.NORMAL)).toBe(1.0);
    expect(printQualityToFactor(PrintQuality.HIGH)).toBe(1.0);
  });

  it('treats an undefined/unknown quality as normal (1.0)', () => {
    expect(printQualityToFactor(undefined)).toBe(1.0);
    // An out-of-set numeric (not a PrintQualityValue) still falls through to 1.0.
    expect(printQualityToFactor(99 as never)).toBe(1.0);
  });
});

describe('downscalePixels', () => {
  it('halves a 4x2 gray buffer (nearest-neighbor) to 2x1', () => {
    // Source 4 wide × 2 tall:
    //   10 20 30 40
    //   50 60 70 80
    // factor 0.5 → 2 wide × 1 tall. Nearest-neighbor samples sx = floor(dx*4/2),
    // sy = floor(dy*2/1): (0,0)→src(0,0)=10, (1,0)→src(2,0)=30.
    const src = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const r = downscalePixels(src, 4, 2, 1, 0.5);
    expect(r.width).toBe(2);
    expect(r.height).toBe(1);
    expect(Array.from(r.pixels)).toEqual([10, 30]);
  });

  it('halves a 2x2 RGB buffer keeping channels together (→ 1x1)', () => {
    // 2×2 RGB: A B / C D. factor 0.5 → 1×1; nearest-neighbor picks src(0,0)=A.
    const A = [10, 11, 12];
    const B = [20, 21, 22];
    const C = [30, 31, 32];
    const D = [40, 41, 42];
    const src = Uint8Array.from([...A, ...B, ...C, ...D]);
    const r = downscalePixels(src, 2, 2, 3, 0.5);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
    expect(Array.from(r.pixels)).toEqual(A);
  });

  it('preserves 16-bit (bytesPerPixel 2) big-endian sample bytes', () => {
    // 4 wide × 1 tall gray16: samples 0x0102, 0x0304, 0x0506, 0x0708 (BE bytes).
    const src = Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const r = downscalePixels(src, 4, 1, 2, 0.5);
    expect(r.width).toBe(2);
    expect(r.height).toBe(1);
    // sx = floor(dx*4/2): dx0→0 (0x0102), dx1→2 (0x0506).
    expect(Array.from(r.pixels)).toEqual([0x01, 0x02, 0x05, 0x06]);
  });

  it('is a no-op for factor 1.0 (returns the input buffer + dims)', () => {
    const src = Uint8Array.from([1, 2, 3, 4]);
    const r = downscalePixels(src, 2, 2, 1, 1.0);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect(r.pixels).toBe(src); // same reference (untouched)
  });

  it('never shrinks a non-empty page below 1×1', () => {
    const src = Uint8Array.from([42]);
    const r = downscalePixels(src, 1, 1, 1, 0.5);
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);
    expect(Array.from(r.pixels)).toEqual([42]);
  });

  it('treats a non-finite / non-shrinking factor as a no-op', () => {
    const src = Uint8Array.from([1, 2, 3, 4]);
    expect(downscalePixels(src, 2, 2, 1, NaN).pixels).toBe(src);
    expect(downscalePixels(src, 2, 2, 1, 2).pixels).toBe(src);
    expect(downscalePixels(src, 2, 2, 1, 0).pixels).toBe(src);
  });
});

describe('renderRasterJob — print-quality scales the emitted PNG resolution', () => {
  it('draft halves a page; high === normal === full (same dims as today)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-quality-'));
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

      // No print-quality → baseline full resolution (4x2).
      const baseline = renderRasterJob([doc], 1, join(dir, 'base'));
      const baseBytes = readFileSync(baseline[0].path);
      const bh = pngHeader(baseBytes);
      expect(bh.width).toBe(4);
      expect(bh.height).toBe(2);

      // high → full resolution, byte-identical to the baseline no-quality PNG.
      const high = renderRasterJob(
        [doc],
        2,
        join(dir, 'high'),
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        PrintQuality.HIGH
      );
      const highBytes = readFileSync(high[0].path);
      expect(pngHeader(highBytes)).toEqual({ width: 4, height: 2, colorType: 0 });
      expect(highBytes.equals(baseBytes)).toBe(true);

      // normal → full resolution, also byte-identical to the baseline.
      const normal = renderRasterJob(
        [doc],
        3,
        join(dir, 'normal'),
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        PrintQuality.NORMAL
      );
      expect(readFileSync(normal[0].path).equals(baseBytes)).toBe(true);

      // draft → 0.5× downscale: 4x2 → 2x1.
      const draft = renderRasterJob(
        [doc],
        4,
        join(dir, 'draft'),
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        PrintQuality.DRAFT
      );
      const dh = pngHeader(readFileSync(draft[0].path));
      expect(dh.width).toBe(2);
      expect(dh.height).toBe(1);
      expect(draft[0].widthPx).toBe(2);
      expect(draft[0].heightPx).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composes draft + landscape: rotate then halve (4x2 → 2x4 → 1x2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-quality-rot-'));
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

      const draftLandscape = renderRasterJob(
        [doc],
        1,
        join(dir, 'dl'),
        undefined,
        false,
        OrientationRequested.LANDSCAPE,
        undefined,
        undefined,
        PrintQuality.DRAFT
      );
      const h = pngHeader(readFileSync(draftLandscape[0].path));
      // landscape (90°) transposes 4x2 → 2x4; draft (0.5×) halves → 1x2.
      expect(h.width).toBe(1);
      expect(h.height).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('composes draft + color: keeps the page RGB (color-type 2) when shrunk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-quality-rgb-'));
    try {
      // 4 wide × 2 tall RGB page (8 pixels).
      const rows = [
        [0xff, 0, 0, 0, 0xff, 0, 0, 0, 0xff, 0xff, 0xff, 0],
        [0, 0xff, 0xff, 0xff, 0, 0xff, 0x80, 0x80, 0x80, 0x10, 0x20, 0x30],
      ];
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwgFromRows(rows, true),
      };

      const draft = renderRasterJob(
        [doc],
        1,
        join(dir, 'rgb'),
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        PrintQuality.DRAFT
      );
      const h = pngHeader(readFileSync(draft[0].path));
      expect(h.colorType).toBe(2); // still truecolor RGB
      expect(h.width).toBe(2);
      expect(h.height).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
