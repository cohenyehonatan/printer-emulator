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
 *   - A "pixel group" is `bitsPerPixel / 8` bytes (1 for 8-bit gray, 3 for
 *     sRGB24). RGB groups are down-converted to grayscale luma; grayscale
 *     groups pass through (first byte).
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

// cupsColorSpace values we care about distinguishing (PWG 5102.4 table).
// Grayscale-ish (1 sample) vs RGB-ish (3 samples) is what governs luma.
const COLORSPACE_RGB_LIKE = new Set<number>([
  1, // RGB
  19, // sRGB
  20, // AdobeRGB
  48, // DEVRGB (device RGB)
]);

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

    // URF carries no explicit colorspace field here; infer sample count from
    // bytes-per-pixel (3 bytes ⇒ RGB, otherwise grayscale).
    const bytesPerPixel = Math.max(1, Math.ceil(bpp / 8));
    const geom: PageGeometry = {
      bytesPerPixel,
      isRgb: bytesPerPixel >= 3,
    };
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
  /** Bytes consumed per pixel group in the encoded stream. */
  bytesPerPixel: number;
  /** Whether a pixel group is RGB (≥3 bytes → luma) vs grayscale. */
  isRgb: boolean;
}

interface DecodeResult {
  /** width*height grayscale buffer (padded with 0 where data was missing). */
  gray: Uint8Array;
  /** Offset just past this page's line data, or undefined if truncated. */
  next: number | undefined;
}

/**
 * Derive the per-pixel stream geometry from the PWG header fields, with sane
 * fallbacks: prefer bytesPerLine/width, else bitsPerPixel/8, else 1.
 */
function resolveGeometry(
  width: number,
  height: number,
  bitsPerPixel: number,
  bitsPerColor: number,
  bytesPerLine: number,
  colorSpace: number
): PageGeometry {
  let bytesPerPixel = 0;
  if (width > 0 && bytesPerLine > 0) {
    bytesPerPixel = Math.round(bytesPerLine / width);
  }
  if (bytesPerPixel <= 0 && bitsPerPixel > 0) {
    bytesPerPixel = Math.ceil(bitsPerPixel / 8);
  }
  if (bytesPerPixel <= 0) bytesPerPixel = 1;

  const isRgb =
    COLORSPACE_RGB_LIKE.has(colorSpace) ||
    // Heuristic backstop: 3 device bytes with 8-bit channels ⇒ RGB.
    (bytesPerPixel >= 3 && (bitsPerColor === 0 || bitsPerColor === 8));

  return { bytesPerPixel, isRgb };
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
  const { bytesPerPixel, isRgb } = geom;
  let p = pos;
  let line = 0;

  while (line < height) {
    if (p >= bytes.length) return { gray, next: undefined };
    const lineRepeat = bytes[p] + 1; // stored as count-1
    p += 1;

    // Decode exactly `width` pixels for this line into a scratch row.
    const row = new Uint8Array(width);
    let pixels = 0;
    while (pixels < width) {
      if (p >= bytes.length) return { gray, next: undefined };
      const control = bytes[p];
      p += 1;

      if (control <= 127) {
        // Literal: control+1 distinct pixel groups, one value each.
        const run = control + 1;
        for (let i = 0; i < run && pixels < width; i++) {
          if (p + bytesPerPixel > bytes.length) {
            return { gray, next: undefined };
          }
          row[pixels++] = sampleLuma(bytes, p, bytesPerPixel, isRgb);
          p += bytesPerPixel;
        }
      } else {
        // Repeat: one pixel group repeated (257-control) times.
        const run = 257 - control;
        if (p + bytesPerPixel > bytes.length) {
          return { gray, next: undefined };
        }
        const value = sampleLuma(bytes, p, bytesPerPixel, isRgb);
        p += bytesPerPixel;
        for (let i = 0; i < run && pixels < width; i++) {
          row[pixels++] = value;
        }
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
 * Read one pixel group at `off` and reduce it to an 8-bit gray sample. RGB
 * groups use the Rec.601 luma weighting; grayscale groups pass the first byte
 * through.
 */
function sampleLuma(
  bytes: Buffer,
  off: number,
  bytesPerPixel: number,
  isRgb: boolean
): number {
  if (isRgb && bytesPerPixel >= 3) {
    const r = bytes[off];
    const g = bytes[off + 1];
    const b = bytes[off + 2];
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b) & 0xff;
  }
  return bytes[off] ?? 0;
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
