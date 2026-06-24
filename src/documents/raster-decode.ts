/**
 * PWG-Raster / Apple-URF page pixel decoder.
 *
 * Where `raster-info.ts` only *skips* the compressed line stream to count
 * pages, this module actually decodes the pixels of each page into an 8-bit
 * grayscale buffer suitable for emitting an image. It re-walks the same
 * fixed-layout page headers (PWG 5102.4 `cups_page_header2_s` / Apple URF
 * 32-byte header) but, per page, expands the PackBits-style line encoding into
 * real pixel rows.
 *
 * Line encoding (shared by both formats, PWG 5102.4 §"Raster Data"):
 *   - Each line group starts with a line-repeat byte: the decoded line is
 *     emitted `repeat + 1` times.
 *   - The line's pixels are then a sequence of (control byte → run):
 *       control 0x00..0x7f  → literal:  `control + 1` distinct pixel groups
 *                                        follow, one group each.
 *       control 0x80..0xff  → repeat:   the next single pixel group, repeated
 *                                        `257 - control` times.
 *   - A "color value" (the RLE unit) is `ceil(bitsPerPixel / 8)` bytes. For
 *     depths >= 8 bits this is one pixel (1 byte for 8-bit gray, 2 for 16-bit
 *     gray, 3 for sRGB24, 4 for CMYK). For sub-byte depths (1-bit) it is a
 *     single byte that *packs multiple pixels* (eight 1-bit pixels, MSB-first);
 *     the RLE run count then counts these packed bytes, not individual pixels.
 *
 * Color/bit-depth handling (all reduced to one 8-bit gray sample per pixel):
 *   - 8-bit grayscale (sGray / device-gray / black): pass the byte through
 *     (black colorSpace is inverted so 0 ink = white).
 *   - 1-bit (sGray / gray / black): unpack 8 pixels per byte, MSB-first,
 *     honoring cupsWidth so trailing padding bits in the last byte are ignored.
 *     Polarity by colorSpace: additive W/sGray → 0=black, 1=white; subtractive
 *     black (K) → 1=black, 0=white.
 *   - 16-bit grayscale: each pixel is 2 bytes big-endian; downsample to 8 bits
 *     by taking the high byte.
 *   - sRGB24 / device-RGB (3 bytes): Rec.601 luma.
 *   - CMYK (4 bytes, 8-bit channels): convert to RGB via
 *     R=255*(1-C/255)*(1-K/255) (and G,B) then Rec.601 luma.
 *
 * Robustness: truncated or malformed input never throws. Whatever rows/pixels
 * could be decoded are kept; the rest of the page is left as padding (0) and
 * decoding stops cleanly at the point of damage.
 */

/** A decoded page: 8-bit grayscale pixels, row-major, length width*height. */
export interface DecodedRasterPage {
  widthPx: number;
  heightPx: number;
  /** Resolution in DPI (feed/cross-feed averaged to a single number). */
  dpi: number;
  /** width*height grayscale samples (0 = black, 255 = white). */
  gray: Uint8Array;
}

// ── PWG Raster (cups_page_header2_s) field layout ─────────────────────────
const PWG_SYNC_LEN = 4;
const PWG_PAGE_HEADER_LEN = 1796;
const PWG_OFF_HW_RESOLUTION = 276; // uint32[2]: cross-feed, feed dpi
const PWG_OFF_CUPS_WIDTH = 372; // uint32
const PWG_OFF_CUPS_HEIGHT = 376; // uint32
const PWG_OFF_BITS_PER_COLOR = 384; // uint32
const PWG_OFF_BITS_PER_PIXEL = 388; // uint32
const PWG_OFF_BYTES_PER_LINE = 392; // uint32
const PWG_OFF_COLOR_SPACE = 400; // uint32 cupsColorSpace enum

// ── Apple URF layout ──────────────────────────────────────────────────────
const URF_MAGIC = 'UNIRAST\0';
const URF_FILE_HEADER_LEN = 12; // 8-byte magic + uint32 page count
const URF_PAGE_HEADER_LEN = 32;
const URF_OFF_BPP = 0; // uint8 bits-per-pixel
const URF_OFF_WIDTH = 12; // uint32
const URF_OFF_HEIGHT = 16; // uint32
const URF_OFF_RESOLUTION = 20; // uint32 dpi (square)

// cupsColorSpace values we care about distinguishing (PWG 5102.4 / CUPS table).
// Grayscale-ish (1 sample) vs RGB-ish (3 samples) vs CMYK (4 samples) governs
// the per-pixel reduction; black (K) is grayscale but inverted polarity.
const COLORSPACE_RGB_LIKE = new Set<number>([
  1, // RGB
  19, // sRGB
  20, // AdobeRGB
  48, // DEVRGB (device RGB)
]);
const COLORSPACE_CMYK = 6; // CUPS_CSPACE_CMYK (4 samples: C, M, Y, K)
// Subtractive single-channel "black" spaces: value = ink amount, so 0 = white.
// (CUPS_CSPACE_K = 3.) Additive gray (W=0, sGray=18) is the opposite: 0 = black.
const COLORSPACE_BLACK = 3;

/** How a decoded color value (RLE unit) maps to gray pixel sample(s). */
const enum PixelKind {
  /** 8-bit additive gray: byte passes through (0 = black). */
  Gray8,
  /** 8-bit subtractive black (K): inverted (0 = white). */
  Black8,
  /** 1-bit additive gray packed 8/byte, MSB-first (bit set = white). */
  Gray1,
  /** 1-bit subtractive black packed 8/byte, MSB-first (bit set = black). */
  Black1,
  /** 16-bit big-endian gray: take the high byte. */
  Gray16,
  /** 24-bit RGB → Rec.601 luma. */
  Rgb,
  /** 32-bit CMYK → RGB → Rec.601 luma. */
  Cmyk,
}

/**
 * Decode every page of a PWG-Raster or URF document to grayscale pixel
 * buffers. Returns undefined when the bytes are neither format. Never throws.
 */
export function decodeRasterPages(
  bytes: Buffer
): DecodedRasterPage[] | undefined {
  if (matchAscii(bytes, URF_MAGIC)) return decodeUrf(bytes);
  if (isPwg(bytes)) return decodePwg(bytes);
  return undefined;
}

function isPwg(bytes: Buffer): boolean {
  return (
    matchAscii(bytes, 'RaS2') ||
    matchAscii(bytes, 'RaS1') ||
    matchAscii(bytes, '2SaR') ||
    matchAscii(bytes, '1SaR')
  );
}

// ── PWG Raster ────────────────────────────────────────────────────────────

function decodePwg(bytes: Buffer): DecodedRasterPage[] {
  const pages: DecodedRasterPage[] = [];
  let pos = PWG_SYNC_LEN;

  while (pos + PWG_PAGE_HEADER_LEN <= bytes.length) {
    const header = bytes.subarray(pos, pos + PWG_PAGE_HEADER_LEN);
    const dpiX = readU32(header, PWG_OFF_HW_RESOLUTION);
    const dpiY = readU32(header, PWG_OFF_HW_RESOLUTION + 4);
    const widthPx = readU32(header, PWG_OFF_CUPS_WIDTH);
    const heightPx = readU32(header, PWG_OFF_CUPS_HEIGHT);
    const bitsPerColor = readU32(header, PWG_OFF_BITS_PER_COLOR);
    const bitsPerPixel = readU32(header, PWG_OFF_BITS_PER_PIXEL);
    const bytesPerLine = readU32(header, PWG_OFF_BYTES_PER_LINE);
    const colorSpace = readU32(header, PWG_OFF_COLOR_SPACE);

    pos += PWG_PAGE_HEADER_LEN;

    const geom = resolveGeometry(
      widthPx,
      heightPx,
      bitsPerPixel,
      bitsPerColor,
      bytesPerLine,
      colorSpace
    );
    const result = decodePage(bytes, pos, widthPx, heightPx, geom);
    pages.push({
      widthPx,
      heightPx,
      dpi: averageDpi(dpiX, dpiY),
      gray: result.gray,
    });
    if (result.next === undefined) break; // truncated/garbage — stop cleanly
    pos = result.next;
  }

  return pages;
}

// ── Apple URF ─────────────────────────────────────────────────────────────

function decodeUrf(bytes: Buffer): DecodedRasterPage[] {
  const pages: DecodedRasterPage[] = [];
  if (bytes.length < URF_FILE_HEADER_LEN) return pages;

  const declared = readU32(bytes, 8);
  let pos = URF_FILE_HEADER_LEN;

  for (
    let page = 0;
    page < declared && pos + URF_PAGE_HEADER_LEN <= bytes.length;
    page++
  ) {
    const header = bytes.subarray(pos, pos + URF_PAGE_HEADER_LEN);
    const bpp = header[URF_OFF_BPP] || 8;
    const widthPx = readU32(header, URF_OFF_WIDTH);
    const heightPx = readU32(header, URF_OFF_HEIGHT);
    const dpi = readU32(header, URF_OFF_RESOLUTION);

    pos += URF_PAGE_HEADER_LEN;

    // URF carries no explicit colorspace field here; infer from bits-per-pixel.
    // 1-bit ⇒ packed gray, 24-bit ⇒ RGB, 32-bit ⇒ CMYK, 16-bit ⇒ wide gray,
    // otherwise 8-bit gray passthrough.
    const geom: PageGeometry = urfGeometry(bpp);
    const result = decodePage(bytes, pos, widthPx, heightPx, geom);
    pages.push({
      widthPx,
      heightPx,
      dpi,
      gray: result.gray,
    });
    if (result.next === undefined) break;
    pos = result.next;
  }

  return pages;
}

// ── Shared PackBits line decoder ──────────────────────────────────────────

interface PageGeometry {
  /** Bytes consumed per RLE color value in the encoded stream. */
  groupBytes: number;
  /** Pixels produced per color value (1, or up to 8 for 1-bit packing). */
  pixelsPerGroup: number;
  /** How to reduce one color value to gray sample(s). */
  kind: PixelKind;
}

interface DecodeResult {
  /** width*height grayscale buffer (padded with 0 where data was missing). */
  gray: Uint8Array;
  /** Offset just past this page's line data, or undefined if truncated. */
  next: number | undefined;
}

/**
 * Derive the RLE stream geometry from the PWG header fields, with sane
 * fallbacks. The RLE color value is `ceil(bitsPerPixel / 8)` bytes; for 1-bit
 * depths that one byte packs up to 8 pixels (MSB-first). We trust bitsPerColor
 * when present to disambiguate 1-/16-bit; otherwise we infer the per-value byte
 * width from cupsBytesPerLine/width, falling back to bitsPerPixel/8, then 1.
 */
function resolveGeometry(
  width: number,
  height: number,
  bitsPerPixel: number,
  bitsPerColor: number,
  bytesPerLine: number,
  colorSpace: number
): PageGeometry {
  // ── 1-bit sub-byte packing: one byte per RLE value holds 8 pixels. ──
  if (bitsPerColor === 1 && bitsPerPixel <= 1) {
    const kind =
      colorSpace === COLORSPACE_BLACK ? PixelKind.Black1 : PixelKind.Gray1;
    return { groupBytes: 1, pixelsPerGroup: 8, kind };
  }

  // ── Whole-byte color values (one pixel each). ──
  let groupBytes = 0;
  if (width > 0 && bytesPerLine > 0) {
    groupBytes = Math.round(bytesPerLine / width);
  }
  if (groupBytes <= 0 && bitsPerPixel > 0) {
    groupBytes = Math.ceil(bitsPerPixel / 8);
  }
  if (groupBytes <= 0) groupBytes = 1;

  const isRgb =
    COLORSPACE_RGB_LIKE.has(colorSpace) ||
    // Heuristic backstop: 3 device bytes with 8-bit channels ⇒ RGB.
    (groupBytes >= 3 && (bitsPerColor === 0 || bitsPerColor === 8));

  let kind: PixelKind;
  if (colorSpace === COLORSPACE_CMYK || groupBytes === 4) {
    kind = PixelKind.Cmyk;
  } else if (isRgb) {
    kind = PixelKind.Rgb;
  } else if (bitsPerColor === 16 || groupBytes === 2) {
    kind = PixelKind.Gray16;
  } else if (colorSpace === COLORSPACE_BLACK) {
    kind = PixelKind.Black8;
  } else {
    kind = PixelKind.Gray8;
  }

  return { groupBytes, pixelsPerGroup: 1, kind };
}

/**
 * URF geometry from bits-per-pixel alone (no colorspace field). URF is always
 * additive gray/RGB/CMYK, never the subtractive "black" space, so no inversion.
 */
function urfGeometry(bpp: number): PageGeometry {
  if (bpp <= 1) {
    return { groupBytes: 1, pixelsPerGroup: 8, kind: PixelKind.Gray1 };
  }
  if (bpp >= 32) {
    return { groupBytes: 4, pixelsPerGroup: 1, kind: PixelKind.Cmyk };
  }
  if (bpp >= 24) {
    return { groupBytes: 3, pixelsPerGroup: 1, kind: PixelKind.Rgb };
  }
  if (bpp >= 16) {
    return { groupBytes: 2, pixelsPerGroup: 1, kind: PixelKind.Gray16 };
  }
  return { groupBytes: 1, pixelsPerGroup: 1, kind: PixelKind.Gray8 };
}

/**
 * Decode one page's line stream into a grayscale buffer. Returns the decoded
 * pixels plus the offset of the next page header (or undefined on truncation).
 * Degenerate geometry yields an empty buffer and a stop signal.
 */
function decodePage(
  bytes: Buffer,
  pos: number,
  width: number,
  height: number,
  geom: PageGeometry
): DecodeResult {
  if (width <= 0 || height <= 0) {
    return { gray: new Uint8Array(0), next: undefined };
  }

  const gray = new Uint8Array(width * height);
  const { groupBytes, pixelsPerGroup, kind } = geom;
  // Each line is this many RLE color values (1 per pixel, or ceil(width/8) for
  // 1-bit packing). Trailing padding pixels in the last group are clamped off.
  const groupsPerRow = Math.ceil(width / pixelsPerGroup);
  let p = pos;
  let line = 0;

  while (line < height) {
    if (p >= bytes.length) return { gray, next: undefined };
    const lineRepeat = bytes[p] + 1; // stored as count-1
    p += 1;

    // Decode exactly `groupsPerRow` color values for this line into a row.
    const row = new Uint8Array(width);
    let groups = 0; // color values consumed
    let pixels = 0; // gray pixels written
    while (groups < groupsPerRow) {
      if (p >= bytes.length) return { gray, next: undefined };
      const control = bytes[p];
      p += 1;

      if (control <= 127) {
        // Literal: control+1 distinct color values, one byte-group each.
        const run = control + 1;
        for (let i = 0; i < run && groups < groupsPerRow; i++, groups++) {
          if (p + groupBytes > bytes.length) {
            return { gray, next: undefined };
          }
          pixels = expandGroup(bytes, p, kind, row, pixels, width);
          p += groupBytes;
        }
      } else {
        // Repeat: one color value repeated (257-control) times.
        const run = 257 - control;
        if (p + groupBytes > bytes.length) {
          return { gray, next: undefined };
        }
        for (let i = 0; i < run && groups < groupsPerRow; i++, groups++) {
          pixels = expandGroup(bytes, p, kind, row, pixels, width);
        }
        p += groupBytes;
      }
    }

    // Emit this row `lineRepeat` times (clamped to the page height).
    for (let r = 0; r < lineRepeat && line < height; r++, line++) {
      gray.set(row, line * width);
    }
  }

  return { gray, next: p };
}

/**
 * Expand one color value at `off` into 1+ gray pixels written into `row`
 * starting at cursor `pixels`, clamped at `width`. Returns the advanced cursor.
 *
 * Most kinds yield one pixel; 1-bit kinds unpack up to 8 pixels (MSB-first)
 * from the single byte, the last group's trailing bits clamped off by `width`.
 */
function expandGroup(
  bytes: Buffer,
  off: number,
  kind: PixelKind,
  row: Uint8Array,
  pixels: number,
  width: number
): number {
  switch (kind) {
    case PixelKind.Gray1:
    case PixelKind.Black1: {
      const byte = bytes[off] ?? 0;
      const black = kind === PixelKind.Black1;
      for (let bit = 7; bit >= 0 && pixels < width; bit--) {
        const set = (byte >> bit) & 1;
        // Gray1: set bit = white (additive). Black1: set bit = black ink.
        const isWhite = black ? set === 0 : set === 1;
        row[pixels++] = isWhite ? 0xff : 0x00;
      }
      return pixels;
    }
    case PixelKind.Gray16:
      // Big-endian 16-bit gray: keep the high byte.
      row[pixels++] = bytes[off] ?? 0;
      return pixels;
    case PixelKind.Rgb: {
      const r = bytes[off] ?? 0;
      const g = bytes[off + 1] ?? 0;
      const b = bytes[off + 2] ?? 0;
      row[pixels++] = luma601(r, g, b);
      return pixels;
    }
    case PixelKind.Cmyk: {
      // CMYK (8-bit subtractive) → RGB → Rec.601 luma.
      // R = 255*(1-C/255)*(1-K/255); G,B analogously.
      const c = bytes[off] ?? 0;
      const m = bytes[off + 1] ?? 0;
      const y = bytes[off + 2] ?? 0;
      const k = bytes[off + 3] ?? 0;
      const kf = 1 - k / 255;
      const r = 255 * (1 - c / 255) * kf;
      const g = 255 * (1 - m / 255) * kf;
      const b = 255 * (1 - y / 255) * kf;
      row[pixels++] = luma601(r, g, b);
      return pixels;
    }
    case PixelKind.Black8:
      // Subtractive black: byte = ink amount, so invert (0 ink = white).
      row[pixels++] = (255 - (bytes[off] ?? 0)) & 0xff;
      return pixels;
    case PixelKind.Gray8:
    default:
      row[pixels++] = bytes[off] ?? 0;
      return pixels;
  }
}

/** Rec.601 luma of RGB (each 0..255, may be fractional) → 0..255 byte. */
function luma601(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b) & 0xff;
}

// ── Helpers (bounds-safe; never throw) ────────────────────────────────────

function averageDpi(dpiX: number, dpiY: number): number {
  if (dpiX > 0 && dpiY > 0) return Math.round((dpiX + dpiY) / 2);
  return dpiX > 0 ? dpiX : dpiY;
}

function readU32(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) return 0;
  return buf.readUInt32BE(offset);
}

function matchAscii(bytes: Buffer, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}
