import { describe, it, expect } from 'vitest';
import { decodeRasterPages } from '../../src/documents/raster-decode.js';

/**
 * Build a synthetic PWG-Raster page header (1796 bytes) with the geometry
 * fields the decoder reads: HWResolution, cupsWidth/Height, bitsPerColor,
 * bitsPerPixel, cupsBytesPerLine, cupsColorSpace.
 */
function pwgPageHeader(opts: {
  width: number;
  height: number;
  dpiX: number;
  dpiY: number;
  bitsPerColor: number;
  bitsPerPixel: number;
  bytesPerLine: number;
  colorSpace: number;
}): Buffer {
  const h = Buffer.alloc(1796);
  h.writeUInt32BE(opts.dpiX, 276);
  h.writeUInt32BE(opts.dpiY, 280);
  h.writeUInt32BE(opts.width, 372);
  h.writeUInt32BE(opts.height, 376);
  h.writeUInt32BE(opts.bitsPerColor, 384);
  h.writeUInt32BE(opts.bitsPerPixel, 388);
  h.writeUInt32BE(opts.bytesPerLine, 392);
  h.writeUInt32BE(opts.colorSpace, 400);
  return h;
}

/** Build a synthetic URF page header (32 bytes). bpp at byte 0. */
function urfPageHeader(
  width: number,
  height: number,
  dpi: number,
  bpp = 8
): Buffer {
  const h = Buffer.alloc(32);
  h.writeUInt8(bpp, 0);
  h.writeUInt32BE(width, 12);
  h.writeUInt32BE(height, 16);
  h.writeUInt32BE(dpi, 20);
  return h;
}

/** Line-repeat byte (emit line `count` times). */
function lineRepeat(count: number): number {
  return count - 1;
}

/** Repeat control: one pixel group repeated `count` times. */
function repeatControl(count: number): number {
  return 257 - count;
}

/** Literal control: `count` distinct pixel groups follow. */
function literalControl(count: number): number {
  return count - 1;
}

describe('decodeRasterPages — PWG Raster (8-bit grayscale)', () => {
  it('decodes a 2x2 page: one repeated line + one literal-run line', () => {
    // Page: width=2, height=2, 8-bit gray (1 byte/pixel).
    // Line A (emitted once): a 2-pixel repeat run of value 0x10  -> [0x10,0x10]
    // Line B (emitted once): a 2-pixel literal run [0x20, 0x30]
    const header = pwgPageHeader({
      width: 2,
      height: 2,
      dpiX: 300,
      dpiY: 600,
      bitsPerColor: 8,
      bitsPerPixel: 8,
      bytesPerLine: 2,
      colorSpace: 18, // sGray (grayscale)
    });
    const lineA = [lineRepeat(1), repeatControl(2), 0x10];
    const lineB = [lineRepeat(1), literalControl(2), 0x20, 0x30];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from([...lineA, ...lineB]),
    ]);

    const pages = decodeRasterPages(blob);
    expect(pages).toBeDefined();
    expect(pages).toHaveLength(1);
    const page = pages![0];
    expect(page.widthPx).toBe(2);
    expect(page.heightPx).toBe(2);
    expect(page.dpi).toBe(450); // (300 + 600) / 2
    expect(Array.from(page.gray)).toEqual([0x10, 0x10, 0x20, 0x30]);
  });

  it('decodes a repeated line (line-repeat byte > 0) into multiple rows', () => {
    // width=2, height=3; a single encoded line repeated 3 times.
    const header = pwgPageHeader({
      width: 2,
      height: 3,
      dpiX: 200,
      dpiY: 200,
      bitsPerColor: 8,
      bitsPerPixel: 8,
      bytesPerLine: 2,
      colorSpace: 18,
    });
    // line emitted 3 times: literal [0x40, 0x50]
    const line = [lineRepeat(3), literalControl(2), 0x40, 0x50];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.dpi).toBe(200);
    expect(Array.from(page.gray)).toEqual([
      0x40, 0x50, // row 0
      0x40, 0x50, // row 1 (repeat)
      0x40, 0x50, // row 2 (repeat)
    ]);
  });

  it('down-converts sRGB24 pixels to grayscale luma', () => {
    // width=1, height=1, 24-bit sRGB (3 bytes/pixel). Pure red 0xFF0000.
    // luma = 0.299*255 ≈ 76.
    const header = pwgPageHeader({
      width: 1,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 24,
      bytesPerLine: 3,
      colorSpace: 19, // sRGB
    });
    const line = [lineRepeat(1), repeatControl(1), 0xff, 0x00, 0x00];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.widthPx).toBe(1);
    expect(page.gray).toHaveLength(1);
    expect(page.gray[0]).toBe(Math.round(0.299 * 255)); // 76
  });

  it('does not throw on truncated line data (pads what it cannot decode)', () => {
    const header = pwgPageHeader({
      width: 4,
      height: 2,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 8,
      bytesPerLine: 4,
      colorSpace: 18,
    });
    // Start a line but cut off before the pixels arrive.
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from([lineRepeat(1), literalControl(4)]), // missing 4 pixel bytes
    ]);

    expect(() => decodeRasterPages(blob)).not.toThrow();
    const page = decodeRasterPages(blob)![0];
    // Buffer is sized to the full page; undecoded pixels are 0.
    expect(page.gray).toHaveLength(4 * 2);
    expect(Array.from(page.gray)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('decodeRasterPages — PWG Raster (1-bit / 16-bit / CMYK)', () => {
  it('unpacks 1-bit sGray pixels MSB-first and ignores last-byte padding', () => {
    // width=10 → 2 bytes per row; the 2nd byte holds only 2 real pixels + 6
    // padding bits that must be dropped. sGray polarity: bit set = white.
    // byte0 = 0xB2 = 1011 0010 → W B W W B B W B
    // byte1 = 0x40 = 0100 0000 → bit7=0 (black), bit6=1 (white), rest padding
    const header = pwgPageHeader({
      width: 10,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 1,
      bitsPerPixel: 1,
      bytesPerLine: 2, // ceil(10/8)
      colorSpace: 18, // sGray
    });
    // 2 color-value bytes per row (one literal run of 2).
    const line = [lineRepeat(1), literalControl(2), 0xb2, 0x40];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.widthPx).toBe(10);
    expect(page.heightPx).toBe(1);
    expect(Array.from(page.gray)).toEqual([
      0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0xff, 0x00, // byte0: 1011 0010
      0x00, 0xff, // byte1: bit7=0→black, bit6=1→white (6 padding bits ignored)
    ]);
  });

  it('inverts 1-bit black (K) polarity: set bit = black ink = 0x00', () => {
    // Same bits as above but colorSpace=K (subtractive): set bit = black.
    const header = pwgPageHeader({
      width: 8,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 1,
      bitsPerPixel: 1,
      bytesPerLine: 1,
      colorSpace: 3, // CUPS_CSPACE_K (black)
    });
    // byte 0xB2 = 1011 0010 → with K polarity: B W B B W W B W
    const line = [lineRepeat(1), repeatControl(1), 0xb2];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(Array.from(page.gray)).toEqual([
      0x00, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0xff,
    ]);
  });

  it('downsamples 16-bit big-endian grayscale to the high byte', () => {
    // width=2, 16-bit gray (2 bytes/pixel, big-endian). Pixels 0xABCD, 0x1234
    // → high bytes 0xAB, 0x12.
    const header = pwgPageHeader({
      width: 2,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 16,
      bitsPerPixel: 16,
      bytesPerLine: 4, // 2 px * 2 bytes
      colorSpace: 18, // sGray
    });
    const line = [
      lineRepeat(1),
      literalControl(2),
      0xab, 0xcd, // pixel 0 = 0xABCD → 0xAB
      0x12, 0x34, // pixel 1 = 0x1234 → 0x12
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(Array.from(page.gray)).toEqual([0xab, 0x12]);
  });

  it('converts CMYK pixels to grayscale luma (CMYK→RGB→Rec.601)', () => {
    // width=3, CMYK (4 bytes/pixel).
    //  px0: 0,0,0,0      → R=G=B=255 → luma 255 (white)
    //  px1: 255,255,255,0 → R=G=B=0   → luma 0   (black)
    //  px2: 0,0,0,128    → kf=1-128/255≈0.498; R=G=B=255*0.498≈127 → luma 127
    const header = pwgPageHeader({
      width: 3,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 32,
      bytesPerLine: 12, // 3 px * 4 bytes
      colorSpace: 6, // CUPS_CSPACE_CMYK
    });
    const line = [
      lineRepeat(1),
      literalControl(3),
      0x00, 0x00, 0x00, 0x00, // white
      0xff, 0xff, 0xff, 0x00, // black
      0x00, 0x00, 0x00, 0x80, // 50% black
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    // Mirror the decoder's exact arithmetic for px2.
    const kf = 1 - 128 / 255;
    const mid = Math.round((0.299 + 0.587 + 0.114) * (255 * kf)) & 0xff;

    const page = decodeRasterPages(blob)![0];
    expect(Array.from(page.gray)).toEqual([0xff, 0x00, mid]);
  });
});

describe('decodeRasterPages — URF', () => {
  it('decodes an 8-bit grayscale URF page', () => {
    const fileHeader = Buffer.alloc(12);
    fileHeader.write('UNIRAST\0', 0, 'binary');
    fileHeader.writeUInt32BE(1, 8); // 1 page

    const header = urfPageHeader(2, 1, 300, 8);
    const line = [lineRepeat(1), literalControl(2), 0x11, 0x22];

    const blob = Buffer.concat([fileHeader, header, Buffer.from(line)]);

    const pages = decodeRasterPages(blob);
    expect(pages).toHaveLength(1);
    const page = pages![0];
    expect(page.widthPx).toBe(2);
    expect(page.heightPx).toBe(1);
    expect(page.dpi).toBe(300);
    expect(Array.from(page.gray)).toEqual([0x11, 0x22]);
  });

  it('does not throw on a truncated URF blob', () => {
    const blob = Buffer.from('UNIRAST\0', 'binary');
    expect(() => decodeRasterPages(blob)).not.toThrow();
    expect(decodeRasterPages(blob)).toEqual([]);
  });
});

describe('decodeRasterPages — non-raster input', () => {
  it('returns undefined for bytes with no raster magic', () => {
    expect(decodeRasterPages(Buffer.from('%PDF-1.7', 'ascii'))).toBeUndefined();
    expect(decodeRasterPages(Buffer.alloc(0))).toBeUndefined();
  });
});
