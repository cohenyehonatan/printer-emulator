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

  it('preserves sRGB24 color pixels as RGB (isColor true)', () => {
    // width=2, height=1, 24-bit sRGB (3 bytes/pixel). Pixels red then green.
    const header = pwgPageHeader({
      width: 2,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 24,
      bytesPerLine: 6, // 2 px * 3 bytes
      colorSpace: 19, // sRGB
    });
    const line = [
      lineRepeat(1),
      literalControl(2),
      0xff, 0x00, 0x00, // pixel 0: red
      0x00, 0x80, 0x10, // pixel 1: arbitrary green-ish
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.widthPx).toBe(2);
    expect(page.isColor).toBe(true);
    expect(page.gray).toHaveLength(0);
    expect(Array.from(page.rgb)).toEqual([
      0xff, 0x00, 0x00, // pixel 0
      0x00, 0x80, 0x10, // pixel 1
    ]);
  });

  it('marks a grayscale page isColor false with rgb empty', () => {
    const header = pwgPageHeader({
      width: 2,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 8,
      bytesPerLine: 2,
      colorSpace: 18, // sGray
    });
    const line = [lineRepeat(1), literalControl(2), 0x11, 0x22];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.isColor).toBe(false);
    expect(page.rgb).toHaveLength(0);
    expect(Array.from(page.gray)).toEqual([0x11, 0x22]);
  });

  it('preserves 48-bit RGB at full 16-bit precision (no downsample)', () => {
    // width=2, 48-bit RGB (16-bit big-endian channels, 6 bytes/pixel). Channel
    // values DIFFER in the low byte to prove no high-byte truncation.
    // px0 = (0xAABB, 0xCCDD, 0xEEFF)
    // px1 = (0x1122, 0x3344, 0x5566)
    const header = pwgPageHeader({
      width: 2,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 16,
      bitsPerPixel: 48,
      bytesPerLine: 12, // 2 px * 6 bytes
      colorSpace: 19, // sRGB
    });
    const line = [
      lineRepeat(1),
      literalControl(2),
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, // px0
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, // px1
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.isColor).toBe(true);
    expect(page.bitDepth).toBe(16);
    expect(page.rgb).toHaveLength(0);
    expect(Array.from(page.rgb16)).toEqual([
      0xaabb, 0xccdd, 0xeeff, // px0 full 16-bit channels
      0x1122, 0x3344, 0x5566, // px1 full 16-bit channels
    ]);
  });

  it('does not throw on truncated color (RGB) line data', () => {
    const header = pwgPageHeader({
      width: 4,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 24,
      bytesPerLine: 12,
      colorSpace: 19, // sRGB
    });
    // Announce a 4-pixel literal run but cut off before the RGB bytes.
    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from([lineRepeat(1), literalControl(4)]),
    ]);

    expect(() => decodeRasterPages(blob)).not.toThrow();
    const page = decodeRasterPages(blob)![0];
    expect(page.isColor).toBe(true);
    // RGB buffer sized to the full page; undecoded samples are 0.
    expect(page.rgb).toHaveLength(4 * 1 * 3);
    expect(Array.from(page.rgb)).toEqual(new Array(12).fill(0));
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

  it('preserves 16-bit big-endian grayscale at full precision (no downsample)', () => {
    // width=2, 16-bit gray (2 bytes/pixel, big-endian). Pixel values differ in
    // the low byte to prove the low byte is not truncated away.
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
      0xab, 0xcd, // pixel 0 = 0xABCD
      0x12, 0x34, // pixel 1 = 0x1234
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.isColor).toBe(false);
    expect(page.bitDepth).toBe(16);
    expect(page.gray).toHaveLength(0);
    expect(Array.from(page.gray16)).toEqual([0xabcd, 0x1234]);
  });

  it('preserves 16-bit grayscale samples that differ only in the low byte', () => {
    // Values chosen so a high-byte downsample would collapse distinct samples:
    // 0x0102 and 0x0100 share high byte 0x01; 0x80FF and 0x8000 share 0x80.
    const header = pwgPageHeader({
      width: 4,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 16,
      bitsPerPixel: 16,
      bytesPerLine: 8, // 4 px * 2 bytes
      colorSpace: 18, // sGray
    });
    const line = [
      lineRepeat(1),
      literalControl(4),
      0x01, 0x02, // 0x0102
      0x01, 0x00, // 0x0100
      0x80, 0xff, // 0x80FF
      0x80, 0x00, // 0x8000
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.bitDepth).toBe(16);
    expect(Array.from(page.gray16)).toEqual([0x0102, 0x0100, 0x80ff, 0x8000]);
  });

  it('converts CMYK pixels to RGB color (isColor true)', () => {
    // width=4, CMYK (4 bytes/pixel). R=255*(1-C/255)*(1-K/255); G←M; B←Y.
    //  px0: C=M=Y=K=0       → 255,255,255 (white)
    //  px1: C=255,M=Y=K=0   → 0,255,255   (cyan)
    //  px2: C=M=Y=0,K=255   → 0,0,0       (black)
    //  px3: C=0,M=255,Y=255,K=0 → 255,0,0 (red)
    const header = pwgPageHeader({
      width: 4,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 32,
      bytesPerLine: 16, // 4 px * 4 bytes
      colorSpace: 6, // CUPS_CSPACE_CMYK
    });
    const line = [
      lineRepeat(1),
      literalControl(4),
      0x00, 0x00, 0x00, 0x00, // white
      0xff, 0x00, 0x00, 0x00, // cyan
      0x00, 0x00, 0x00, 0xff, // black (K=255)
      0x00, 0xff, 0xff, 0x00, // red
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.widthPx).toBe(4);
    expect(page.isColor).toBe(true);
    expect(page.gray).toHaveLength(0);
    expect(Array.from(page.rgb)).toEqual([
      0xff, 0xff, 0xff, // white
      0x00, 0xff, 0xff, // cyan
      0x00, 0x00, 0x00, // black
      0xff, 0x00, 0x00, // red
    ]);
  });

  it('downsamples 64-bit CMYK to RGB by taking each channel high byte', () => {
    // width=2, 64-bit CMYK (16-bit big-endian channels, 8 bytes/pixel).
    // High bytes drive the conversion R=255*(1-C/255)*(1-K/255); G←M; B←Y.
    //  px0: C=0xFFxx,M=Y=K=0x00xx → C=255,M=Y=K=0 → 0,255,255 (cyan)
    //  px1: C=M=Y=0x00xx,K=0x80xx → K=128 → kf≈0.498 → 127,127,127
    const header = pwgPageHeader({
      width: 2,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 16,
      bitsPerPixel: 64,
      bytesPerLine: 16, // 2 px * 8 bytes
      colorSpace: 6, // CUPS_CSPACE_CMYK
    });
    const line = [
      lineRepeat(1),
      literalControl(2),
      0xff, 0x11, 0x00, 0x22, 0x00, 0x33, 0x00, 0x44, // px0: C=255 rest 0
      0x00, 0x55, 0x00, 0x66, 0x00, 0x77, 0x80, 0x88, // px1: K=128 rest 0
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    // Mirror the decoder's exact arithmetic for px1 (K=0x80=128).
    const kf = 1 - 128 / 255;
    const mid = Math.round(255 * kf) & 0xff;

    const page = decodeRasterPages(blob)![0];
    expect(page.isColor).toBe(true);
    expect(page.gray).toHaveLength(0);
    expect(Array.from(page.rgb)).toEqual([
      0x00, 0xff, 0xff, // px0 cyan
      mid, mid, mid, // px1 50% black gray
    ]);
  });
});

describe('decodeRasterPages — AdobeRGB → sRGB ICC conversion', () => {
  // Independent reference (matches test/documents/icc.test.ts vectors): the
  // colorimetric AdobeRGB→sRGB transform maps (100,150,50)→≈(66,151,34) and
  // white→white, while an sRGB page is byte-identical to its input.
  const near = (got: number[], want: number[], tol = 2): void => {
    expect(got.length).toBe(want.length);
    for (let i = 0; i < got.length; i++) {
      expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(tol);
    }
  };

  it('converts an AdobeRGB (colorSpace 20) 8-bit page to sRGB pixels', () => {
    // width=2: px0 = AdobeRGB white (→ sRGB white), px1 = AdobeRGB (100,150,50)
    // (→ sRGB ≈ (66,151,34), notably ≠ the input).
    const header = pwgPageHeader({
      width: 2,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 24,
      bytesPerLine: 6,
      colorSpace: 20, // AdobeRGB
    });
    const line = [
      lineRepeat(1),
      literalControl(2),
      0xff, 0xff, 0xff, // px0: AdobeRGB white
      100, 150, 50, // px1: AdobeRGB green
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.isColor).toBe(true);
    const out = Array.from(page.rgb);
    near(out.slice(0, 3), [255, 255, 255]); // white → white
    near(out.slice(3, 6), [66, 151, 34]); // green shifted by the transform
    // The converted green is NOT the raw input (proves the transform ran).
    expect(out.slice(3, 6)).not.toEqual([100, 150, 50]);
  });

  it('leaves an sRGB (colorSpace 19) page byte-identical (passthrough)', () => {
    // Same pixel bytes as above but colorSpace=sRGB: no conversion, exact bytes.
    const header = pwgPageHeader({
      width: 2,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 8,
      bitsPerPixel: 24,
      bytesPerLine: 6,
      colorSpace: 19, // sRGB
    });
    const line = [
      lineRepeat(1),
      literalControl(2),
      0xff, 0xff, 0xff,
      100, 150, 50,
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(Array.from(page.rgb)).toEqual([0xff, 0xff, 0xff, 100, 150, 50]);
  });

  it('converts a 48-bit AdobeRGB page to 16-bit sRGB samples', () => {
    // width=1: AdobeRGB neutral gray 0x8000 in all channels → sRGB ≈ 0x80FC
    // (≈33030), near-identical (shared D50 white), full 16-bit precision.
    const header = pwgPageHeader({
      width: 1,
      height: 1,
      dpiX: 300,
      dpiY: 300,
      bitsPerColor: 16,
      bitsPerPixel: 48,
      bytesPerLine: 6,
      colorSpace: 20, // AdobeRGB
    });
    const line = [
      lineRepeat(1),
      repeatControl(1),
      0x80, 0x00, 0x80, 0x00, 0x80, 0x00, // (0x8000, 0x8000, 0x8000)
    ];

    const blob = Buffer.concat([
      Buffer.from('RaS2', 'ascii'),
      header,
      Buffer.from(line),
    ]);

    const page = decodeRasterPages(blob)![0];
    expect(page.isColor).toBe(true);
    expect(page.bitDepth).toBe(16);
    const out = Array.from(page.rgb16);
    near(out, [33030, 33030, 33030], 8);
    // Not a raw passthrough of 0x8000.
    expect(out[0]).not.toBe(0x8000);
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
