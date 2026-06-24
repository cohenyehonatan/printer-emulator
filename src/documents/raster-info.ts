/**
 * PWG-Raster / Apple-URF page-header parser.
 *
 * Walks the fixed-layout page headers of a PWG Raster (PWG 5102.4) or Apple
 * URF (AppleRaster) document and extracts per-page metadata — page count and
 * each page's pixel dimensions + resolution. The raster *pixel* data is not
 * decoded into an image; the PackBits-like line stream is only consumed far
 * enough to skip from one page header to the next so multi-page documents are
 * counted correctly.
 *
 * Both formats share the same compressed line encoding (PWG 5102.4 §"Raster
 * Data"): each page is `cupsHeight` lines; a line group begins with a single
 * line-repeat byte (`count - 1`), then the line's `width` pixels are encoded as
 * PackBits runs — a control byte `c <= 127` introduces `c + 1` copies of one
 * following pixel, and `c >= 128` introduces `257 - c` literal pixels.
 *
 * Never throws: truncated or malformed input yields whatever pages could be
 * parsed up to the point of damage.
 */

import { Mime, type DocumentMime } from './formats.js';

/** Per-page geometry pulled from a raster page header. */
export interface RasterPageInfo {
  widthPx: number;
  heightPx: number;
  dpiX: number;
  dpiY: number;
}

/** Result of parsing a raster document's page headers. */
export interface RasterDocumentInfo {
  /** image/pwg-raster or image/urf. */
  format: DocumentMime;
  pages: RasterPageInfo[];
}

// ── PWG Raster (cups_page_header2_s) field layout ─────────────────────────
const PWG_SYNC_LEN = 4;
const PWG_PAGE_HEADER_LEN = 1796;
const PWG_OFF_HW_RESOLUTION = 276; // uint32[2]: cross-feed, feed dpi
const PWG_OFF_CUPS_WIDTH = 372; // uint32
const PWG_OFF_CUPS_HEIGHT = 376; // uint32
const PWG_OFF_BYTES_PER_LINE = 392; // uint32

// ── Apple URF layout ──────────────────────────────────────────────────────
const URF_MAGIC = 'UNIRAST\0';
const URF_FILE_HEADER_LEN = 12; // 8-byte magic + uint32 page count
const URF_PAGE_HEADER_LEN = 32;
const URF_OFF_WIDTH = 12; // uint32
const URF_OFF_HEIGHT = 16; // uint32
const URF_OFF_RESOLUTION = 20; // uint32 dpi (square)

/**
 * Parse PWG-Raster or URF document bytes into per-page metadata. Returns
 * undefined when the bytes are neither PWG nor URF (no magic match). Never
 * throws.
 */
export function parseRasterInfo(
  bytes: Buffer
): RasterDocumentInfo | undefined {
  if (isUrf(bytes)) return parseUrf(bytes);
  if (isPwg(bytes)) return parsePwg(bytes);
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

function isUrf(bytes: Buffer): boolean {
  return matchAscii(bytes, URF_MAGIC);
}

// ── PWG Raster ────────────────────────────────────────────────────────────

function parsePwg(bytes: Buffer): RasterDocumentInfo {
  const pages: RasterPageInfo[] = [];
  let pos = PWG_SYNC_LEN;

  // Each page = fixed header + compressed line data. Stop on any short read.
  while (pos + PWG_PAGE_HEADER_LEN <= bytes.length) {
    const header = bytes.subarray(pos, pos + PWG_PAGE_HEADER_LEN);
    const dpiX = readU32(header, PWG_OFF_HW_RESOLUTION);
    const dpiY = readU32(header, PWG_OFF_HW_RESOLUTION + 4);
    const widthPx = readU32(header, PWG_OFF_CUPS_WIDTH);
    const heightPx = readU32(header, PWG_OFF_CUPS_HEIGHT);
    const bytesPerLine = readU32(header, PWG_OFF_BYTES_PER_LINE);

    pages.push({ widthPx, heightPx, dpiX, dpiY });

    pos += PWG_PAGE_HEADER_LEN;
    const next = skipRasterData(bytes, pos, widthPx, heightPx, bytesPerLine);
    if (next === undefined) break; // truncated/garbage data — stop cleanly
    pos = next;
  }

  return { format: Mime.PWG_RASTER, pages };
}

// ── Apple URF ─────────────────────────────────────────────────────────────

function parseUrf(bytes: Buffer): RasterDocumentInfo {
  const pages: RasterPageInfo[] = [];
  if (bytes.length < URF_FILE_HEADER_LEN) {
    return { format: Mime.URF, pages };
  }

  // Declared page count bounds the walk, but we still stop early on short data.
  const declared = readU32(bytes, 8);
  let pos = URF_FILE_HEADER_LEN;

  for (
    let page = 0;
    page < declared && pos + URF_PAGE_HEADER_LEN <= bytes.length;
    page++
  ) {
    const header = bytes.subarray(pos, pos + URF_PAGE_HEADER_LEN);
    const widthPx = readU32(header, URF_OFF_WIDTH);
    const heightPx = readU32(header, URF_OFF_HEIGHT);
    const dpi = readU32(header, URF_OFF_RESOLUTION);

    pages.push({ widthPx, heightPx, dpiX: dpi, dpiY: dpi });

    pos += URF_PAGE_HEADER_LEN;
    // URF byte-per-pixel = bitsPerPixel/8 (header byte 0); rounded up.
    const bytesPerPixel = Math.max(1, Math.ceil((header[0] ?? 8) / 8));
    const bytesPerLine = widthPx * bytesPerPixel;
    const next = skipRasterData(bytes, pos, widthPx, heightPx, bytesPerLine);
    if (next === undefined) break;
    pos = next;
  }

  return { format: Mime.URF, pages };
}

// ── Shared PackBits line-stream skipper ───────────────────────────────────

/**
 * Consume one page of PWG/URF compressed line data starting at `pos`, returning
 * the offset just past it (the next page header). Returns undefined if the data
 * runs short or looks malformed, signalling the caller to stop. Decodes only
 * the run-length structure; pixel values are skipped, not stored.
 */
function skipRasterData(
  bytes: Buffer,
  pos: number,
  width: number,
  height: number,
  bytesPerLine: number
): number | undefined {
  // Degenerate geometry has no recoverable data stream.
  if (width <= 0 || height <= 0 || bytesPerLine <= 0) return undefined;

  const bytesPerPixel = Math.max(1, Math.round(bytesPerLine / width));
  let p = pos;
  let line = 0;

  while (line < height) {
    if (p >= bytes.length) return undefined; // missing line-repeat byte
    const lineRepeat = bytes[p] + 1; // stored as count-1
    p += 1;

    // Decode exactly `width` pixels for this (repeated) line.
    let pixels = 0;
    while (pixels < width) {
      if (p >= bytes.length) return undefined;
      const control = bytes[p];
      p += 1;
      if (control <= 127) {
        // Repeat: control+1 copies of a single following pixel.
        const run = control + 1;
        p += bytesPerPixel; // one pixel value
        pixels += run;
      } else {
        // Literal: 257-control distinct pixels, each its own value.
        const run = 257 - control;
        p += bytesPerPixel * run;
        pixels += run;
      }
      if (p > bytes.length) return undefined;
    }

    line += lineRepeat;
  }

  return p;
}

// ── Small byte helpers (bounds-safe; never throw) ─────────────────────────

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
