import { describe, it, expect } from 'vitest';
import { parseRasterInfo } from '../../src/documents/raster-info.js';
import { Mime } from '../../src/documents/formats.js';

/**
 * Build one PWG-Raster page-data run: a single line (line-repeat byte = 0)
 * encoding `width` pixels as one repeat run (control = width-1, then one pixel
 * byte). Mirrors the PackBits skip the parser must perform to find the next
 * page header. Assumes 1 byte per pixel and height = 1.
 */
function pwgPageData(width: number): Buffer {
  return Buffer.from([0x00, width - 1, 0xff]);
}

/**
 * Build a synthetic PWG-Raster page header (1796 bytes) with the geometry
 * fields the parser reads. width/height = 1px, 1 byte/line keeps the line
 * stream minimal. bitsPerColor/bitsPerPixel default to 8-bit (the common path);
 * pass 1 for 1-bit so the skipper sizes the packed line stream correctly.
 */
function pwgPageHeader(
  widthPx: number,
  heightPx: number,
  dpiX: number,
  dpiY: number,
  bytesPerLine: number,
  bitsPerColor = 8,
  bitsPerPixel = 8
): Buffer {
  const h = Buffer.alloc(1796);
  h.writeUInt32BE(dpiX, 276); // HWResolution[0]
  h.writeUInt32BE(dpiY, 280); // HWResolution[1]
  h.writeUInt32BE(widthPx, 372); // cupsWidth
  h.writeUInt32BE(heightPx, 376); // cupsHeight
  h.writeUInt32BE(bitsPerColor, 384); // cupsBitsPerColor
  h.writeUInt32BE(bitsPerPixel, 388); // cupsBitsPerPixel
  h.writeUInt32BE(bytesPerLine, 392); // cupsBytesPerLine
  return h;
}

/**
 * Build a 1-bit PWG line-data run for a single line (height contribution = 1):
 * a line-repeat byte (0) then one repeat run covering `ceil(width/8)` packed
 * color-value bytes (each byte = up to 8 pixels MSB-first). Mirrors the existing
 * `pwgPageData` builder's repeat encoding (control = count-1, one value byte).
 *
 * The number of color values per line is `ceil(width / 8)` — for width=10 that
 * is 2, NOT round(bytesPerLine/width)=round(2/10)=0→1. The old skipper math
 * sized each line as a single packed byte, mis-counting the stream and losing
 * the next page; the corrected pixelsPerGroup=8 stride lands on it exactly.
 */
function pwg1BitLine(width: number): Buffer {
  const groups = Math.ceil(width / 8); // packed color-value bytes this line
  const repeatControl = groups - 1; // control <= 127 ⇒ one value, `groups` reps
  return Buffer.from([0x00, repeatControl, 0xff]);
}

/** Build a synthetic URF page header (32 bytes). bpp at byte 0. */
function urfPageHeader(
  widthPx: number,
  heightPx: number,
  dpi: number,
  bpp = 8
): Buffer {
  const h = Buffer.alloc(32);
  h.writeUInt8(bpp, 0);
  h.writeUInt32BE(widthPx, 12);
  h.writeUInt32BE(heightPx, 16);
  h.writeUInt32BE(dpi, 20);
  return h;
}

describe('parseRasterInfo — PWG Raster', () => {
  it('parses page count + dimensions from two synthetic page headers', () => {
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      pwgPageHeader(2, 1, 300, 600, 2),
      pwgPageData(2),
      pwgPageHeader(4, 1, 150, 150, 4),
      pwgPageData(4),
    ]);

    const info = parseRasterInfo(blob);
    expect(info).toBeDefined();
    expect(info?.format).toBe(Mime.PWG_RASTER);
    expect(info?.pages).toHaveLength(2);
    expect(info?.pages[0]).toEqual({
      widthPx: 2,
      heightPx: 1,
      dpiX: 300,
      dpiY: 600,
    });
    expect(info?.pages[1]).toEqual({
      widthPx: 4,
      heightPx: 1,
      dpiX: 150,
      dpiY: 150,
    });
  });

  it('counts two 1-bit pages (sub-byte stride; regression for round() math)', () => {
    // width=10 at 1bpp → ceil(10/8) = 2 bytes/line, NOT round(2/10)=0→1.
    // The old round(bytesPerLine/width) approximation (0, clamped to 1) sized
    // each line as one packed byte = 8 pixels, so it would under-count the
    // line stream and land mid-data on the second page header — losing page 2.
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      pwgPageHeader(10, 1, 300, 300, 2, 1, 1),
      pwg1BitLine(10),
      pwgPageHeader(10, 1, 600, 600, 2, 1, 1),
      pwg1BitLine(10),
    ]);

    const info = parseRasterInfo(blob);
    expect(info).toBeDefined();
    expect(info?.format).toBe(Mime.PWG_RASTER);
    expect(info?.pages).toHaveLength(2);
    expect(info?.pages[0]).toEqual({
      widthPx: 10,
      heightPx: 1,
      dpiX: 300,
      dpiY: 300,
    });
    expect(info?.pages[1]).toEqual({
      widthPx: 10,
      heightPx: 1,
      dpiX: 600,
      dpiY: 600,
    });
  });

  it('counts a multi-page 8-bit gray doc (common-path guard)', () => {
    // 3 pages, width=3 8-bit gray. Each line: one repeat run covering 3 pixels
    // (control = 3-1 = 2, one following value byte). groupBytes=1, no packing.
    const gray8Line = Buffer.from([0x00, /* run=3 */ 2, 0x11]);
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      pwgPageHeader(3, 1, 300, 300, 3),
      gray8Line,
      pwgPageHeader(3, 1, 300, 300, 3),
      gray8Line,
      pwgPageHeader(3, 1, 300, 300, 3),
      gray8Line,
    ]);

    const info = parseRasterInfo(blob);
    expect(info?.pages).toHaveLength(3);
    expect(info?.pages.every((p) => p.widthPx === 3 && p.heightPx === 1)).toBe(
      true
    );
  });

  it('returns parsed pages when the second page is truncated mid-stream', () => {
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      pwgPageHeader(10, 1, 300, 300, 2, 1, 1),
      pwg1BitLine(10),
      pwgPageHeader(10, 1, 600, 600, 2, 1, 1),
      // second page's line data is cut off before the line-repeat byte
    ]);

    expect(() => parseRasterInfo(blob)).not.toThrow();
    const info = parseRasterInfo(blob);
    // Page 2's header is complete (geometry recovered) but its stream is gone,
    // so we keep both headers and stop cleanly.
    expect(info?.pages).toHaveLength(2);
    expect(info?.pages[0].dpiX).toBe(300);
    expect(info?.pages[1].dpiX).toBe(600);
  });

  it('does not throw on a truncated PWG page header', () => {
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      Buffer.alloc(50), // far short of a full 1796-byte header
    ]);
    expect(() => parseRasterInfo(blob)).not.toThrow();
    expect(parseRasterInfo(blob)?.pages).toHaveLength(0);
  });

  it('does not throw when the line data is truncated mid-page', () => {
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      pwgPageHeader(2, 1, 300, 300, 2),
      // first page parses its header but the run-length data is missing
    ]);
    expect(() => parseRasterInfo(blob)).not.toThrow();
    // The header was complete, so page 1 geometry is recovered.
    expect(parseRasterInfo(blob)?.pages).toHaveLength(1);
  });
});

describe('parseRasterInfo — URF', () => {
  it('parses page count + dimensions from the declared count', () => {
    const header = Buffer.alloc(12);
    header.write('UNIRAST\0', 0, 'binary');
    header.writeUInt32BE(2, 8); // page count = 2

    const blob = Buffer.concat([
      header,
      urfPageHeader(2, 1, 300),
      pwgPageData(2), // URF shares the PWG-style line encoding
      urfPageHeader(4, 1, 600),
      pwgPageData(4),
    ]);

    const info = parseRasterInfo(blob);
    expect(info).toBeDefined();
    expect(info?.format).toBe(Mime.URF);
    expect(info?.pages).toHaveLength(2);
    expect(info?.pages[0]).toEqual({
      widthPx: 2,
      heightPx: 1,
      dpiX: 300,
      dpiY: 300,
    });
    expect(info?.pages[1]).toEqual({
      widthPx: 4,
      heightPx: 1,
      dpiX: 600,
      dpiY: 600,
    });
  });

  it('does not throw on a truncated URF blob', () => {
    const blob = Buffer.from('UNIRAST\0', 'binary'); // magic only, no count
    expect(() => parseRasterInfo(blob)).not.toThrow();
    expect(parseRasterInfo(blob)?.pages).toHaveLength(0);
  });
});

describe('parseRasterInfo — non-raster input', () => {
  it('returns undefined for bytes with no raster magic', () => {
    expect(parseRasterInfo(Buffer.from('%PDF-1.7', 'ascii'))).toBeUndefined();
    expect(parseRasterInfo(Buffer.alloc(0))).toBeUndefined();
  });
});
