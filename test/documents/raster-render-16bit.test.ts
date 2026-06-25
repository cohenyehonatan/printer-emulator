import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { renderRasterJob } from '../../src/documents/raster-render.js';
import type { Document } from '../../src/documents/document.js';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * End-to-end coverage for true 16-bit raster → 16-bit PNG output: a synthetic
 * 16-bit PWG page (values that differ in the LOW byte, so a high-byte downsample
 * would be detectable) is rendered and the emitted PNG is asserted to be
 * bit-depth 16 with the exact 16-bit samples preserved in big-endian scanlines.
 */

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** IHDR fields (bit depth + color type live right after the IHDR data start). */
function pngHeader(png: Buffer): {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
} {
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png.readUInt8(24),
    colorType: png.readUInt8(25),
  };
}

/** Inflate the single IDAT chunk's raw scanline bytes. */
function idatScanlines(png: Buffer): number[] {
  let pos = PNG_SIGNATURE.length;
  while (pos + 8 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (type === 'IDAT') {
      return Array.from(inflateSync(png.subarray(dataStart, dataStart + length)));
    }
    pos = dataStart + length + 4;
  }
  return [];
}

/**
 * A single-page 16-bit PWG-Raster blob. `samples` is one uint16 per pixel for
 * gray, three per pixel for RGB; `bytes` are written big-endian.
 */
function pwg16(
  samples: number[],
  width: number,
  height: number,
  color: boolean
): Buffer {
  const samplesPerPixel = color ? 3 : 1;
  const bytesPerPixel = samplesPerPixel * 2;

  const header = Buffer.alloc(1796);
  header.writeUInt32BE(300, 276); // dpiX
  header.writeUInt32BE(300, 280); // dpiY
  header.writeUInt32BE(width, 372); // cupsWidth
  header.writeUInt32BE(height, 376); // cupsHeight
  header.writeUInt32BE(16, 384); // bitsPerColor
  header.writeUInt32BE(color ? 48 : 16, 388); // bitsPerPixel
  header.writeUInt32BE(width * bytesPerPixel, 392); // cupsBytesPerLine
  header.writeUInt32BE(color ? 19 : 18, 400); // colorSpace: sRGB / sGray

  // Big-endian sample bytes, one literal run per row.
  const groupsPerRow = width; // one color value per pixel
  const lines: number[] = [];
  let s = 0;
  for (let y = 0; y < height; y++) {
    lines.push(0, groupsPerRow - 1); // lineRepeat=1, literal control (count-1)
    for (let g = 0; g < groupsPerRow; g++) {
      for (let c = 0; c < samplesPerPixel; c++) {
        const v = samples[s++] ?? 0;
        lines.push((v >>> 8) & 0xff, v & 0xff); // big-endian
      }
    }
  }

  return Buffer.concat([Buffer.from('RaS2', 'ascii'), header, Buffer.from(lines)]);
}

describe('renderRasterJob — true 16-bit PNG output', () => {
  it('renders a 16-bit gray page as a bit-depth-16 PNG with exact samples', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-16bit-gray-'));
    try {
      // 2x2 gray; low bytes vary so a high-byte downsample would lose them.
      const samples = [0x0102, 0x80ff, 0x1234, 0xabcd];
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwg16(samples, 2, 2, false),
      };
      const prefix = join(dir, 'g16');
      const pages = renderRasterJob([doc], 1, prefix);
      expect(pages).toHaveLength(1);

      const png = readFileSync(pages[0].path);
      const h = pngHeader(png);
      expect(h.width).toBe(2);
      expect(h.height).toBe(2);
      expect(h.bitDepth).toBe(16);
      expect(h.colorType).toBe(0); // grayscale

      expect(idatScanlines(png)).toEqual([
        0, 0x01, 0x02, 0x80, 0xff, // row 0: 0x0102, 0x80FF (big-endian)
        0, 0x12, 0x34, 0xab, 0xcd, // row 1: 0x1234, 0xABCD
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders a 48-bit RGB page as a bit-depth-16 truecolor PNG', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-16bit-rgb-'));
    try {
      // 2x1 RGB; channel values differ in the low byte.
      const samples = [0xaabb, 0xccdd, 0xeeff, 0x1122, 0x3344, 0x5566];
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwg16(samples, 2, 1, true),
      };
      const prefix = join(dir, 'rgb16');
      const pages = renderRasterJob([doc], 1, prefix);
      expect(pages).toHaveLength(1);

      const png = readFileSync(pages[0].path);
      const h = pngHeader(png);
      expect(h.width).toBe(2);
      expect(h.height).toBe(1);
      expect(h.bitDepth).toBe(16);
      expect(h.colorType).toBe(2); // truecolor RGB

      expect(idatScanlines(png)).toEqual([
        0,
        0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, // px0 R,G,B (big-endian)
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, // px1
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forceGrayscale of a 16-bit color page stays 16-bit (luma at full depth)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-16bit-mono-'));
    try {
      // 1x1 RGB; monochrome → 16-bit gray PNG via Rec.601 luma at full precision.
      const r = 0x0102;
      const g = 0x8000;
      const b = 0x00ff;
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwg16([r, g, b], 1, 1, true),
      };
      const prefix = join(dir, 'mono16');
      const pages = renderRasterJob([doc], 1, prefix, undefined, true);
      expect(pages).toHaveLength(1);

      const png = readFileSync(pages[0].path);
      const h = pngHeader(png);
      expect(h.bitDepth).toBe(16);
      expect(h.colorType).toBe(0); // grayscale

      const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      expect(idatScanlines(png)).toEqual([
        0, (luma >>> 8) & 0xff, luma & 0xff,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates a 16-bit gray page (orientation) preserving precision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pe-16bit-rot-'));
    try {
      // 2x1 gray rotated 90° → 1x2; samples preserved, transposed.
      const samples = [0x0102, 0x80ff];
      const doc: Document = {
        format: 'image/pwg-raster',
        bytes: pwg16(samples, 2, 1, false),
      };
      const prefix = join(dir, 'rot16');
      // orientation-requested LANDSCAPE (4) → 90° clockwise.
      const pages = renderRasterJob([doc], 1, prefix, undefined, false, 4);
      expect(pages).toHaveLength(1);

      const png = readFileSync(pages[0].path);
      const h = pngHeader(png);
      expect(h.bitDepth).toBe(16);
      expect(h.width).toBe(1); // transposed
      expect(h.height).toBe(2);

      // 90° CW of [0x0102, 0x80FF] (a 2-wide row) → column [0x0102; 0x80FF].
      expect(idatScanlines(png)).toEqual([
        0, 0x01, 0x02, // row 0
        0, 0x80, 0xff, // row 1
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
