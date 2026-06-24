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
const PWG_OFF_BITS_PER_COLOR = 384; // uint32
const PWG_OFF_BITS_PER_PIXEL = 388; // uint32
const PWG_OFF_BYTES_PER_LINE = 392; // uint32

// ── Apple URF layout ──────────────────────────────────────────────────────
const URF_MAGIC = 'UNIRAST\0';
const URF_FILE_HEADER_LEN = 12; // 8-byte magic + uint32 page count
const URF_PAGE_HEADER_LEN = 32;
const URF_OFF_BPP = 0; // uint8 bits-per-pixel
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
    const bitsPerColor = readU32(header, PWG_OFF_BITS_PER_COLOR);
    const bitsPerPixel = readU32(header, PWG_OFF_BITS_PER_PIXEL);
    const bytesPerLine = readU32(header, PWG_OFF_BYTES_PER_LINE);

    pages.push({ widthPx, heightPx, dpiX, dpiY });

    pos += PWG_PAGE_HEADER_LEN;
    const geom = rasterGeometry(
      widthPx,
      bitsPerPixel,
      bitsPerColor,
      bytesPerLine
    );
    const next = skipRasterData(bytes, pos, widthPx, heightPx, geom);
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
    const bpp = header[URF_OFF_BPP] || 8;
    const widthPx = readU32(header, URF_OFF_WIDTH);
    const heightPx = readU32(header, URF_OFF_HEIGHT);
    const dpi = readU32(header, URF_OFF_RESOLUTION);

    pages.push({ widthPx, heightPx, dpiX: dpi, dpiY: dpi });

    pos += URF_PAGE_HEADER_LEN;
    // URF carries no cupsBytesPerLine; derive stride from bits-per-pixel alone.
    // 1-bit packs 8 pixels per byte (pixelsPerGroup=8); wider depths are one
    // pixel per group of ceil(bpp/8) bytes.
    const geom = urfGeometry(bpp);
    const next = skipRasterData(bytes, pos, widthPx, heightPx, geom);
    if (next === undefined) break;
    pos = next;
  }

  return { format: Mime.URF, pages };
}

// ── Raster line-stream geometry ───────────────────────────────────────────

/**
 * RLE-stream geometry for the PackBits skipper. A "color value" is the RLE unit
 * the run-length controls count.
 *
 * NOTE: this MUST stay in sync with `raster-decode.ts`'s `resolveGeometry` /
 * `urfGeometry` (its `PageGeometry.groupBytes` / `pixelsPerGroup`). That module
 * decodes pixels; this one only skips the stream — but both must size each line
 * identically or they will disagree on where the next page header begins.
 */
interface LineGeometry {
  /** Bytes consumed per RLE color value in the encoded stream. */
  groupBytes: number;
  /** Pixels produced per color value (1, or up to 8 for 1-bit packing). */
  pixelsPerGroup: number;
}

/**
 * Derive the PWG line-stream geometry from header fields. The RLE color value is
 * `ceil(bitsPerPixel / 8)` bytes; for 1-bit depths that single byte packs up to
 * 8 pixels (so `pixelsPerGroup = 8`). For whole-byte depths we trust
 * cupsBytesPerLine to size the value width, falling back to ceil(bitsPerPixel/8)
 * then 1. Mirrors `raster-decode.ts:resolveGeometry`.
 */
function rasterGeometry(
  width: number,
  bitsPerPixel: number,
  bitsPerColor: number,
  bytesPerLine: number
): LineGeometry {
  // 1-bit sub-byte packing: one byte per RLE value holds 8 pixels.
  if (bitsPerColor === 1 && bitsPerPixel <= 1) {
    return { groupBytes: 1, pixelsPerGroup: 8 };
  }

  // Whole-byte color values (one pixel each).
  let groupBytes = 0;
  if (width > 0 && bytesPerLine > 0) {
    groupBytes = Math.round(bytesPerLine / width);
  }
  if (groupBytes <= 0 && bitsPerPixel > 0) {
    groupBytes = Math.ceil(bitsPerPixel / 8);
  }
  if (groupBytes <= 0) groupBytes = 1;

  return { groupBytes, pixelsPerGroup: 1 };
}

/**
 * URF line-stream geometry from bits-per-pixel alone (no colorspace field).
 * Mirrors `raster-decode.ts:urfGeometry`'s `groupBytes`/`pixelsPerGroup`.
 */
function urfGeometry(bpp: number): LineGeometry {
  if (bpp <= 1) return { groupBytes: 1, pixelsPerGroup: 8 };
  return { groupBytes: Math.max(1, Math.ceil(bpp / 8)), pixelsPerGroup: 1 };
}

// ── Shared PackBits line-stream skipper ───────────────────────────────────

/**
 * Consume one page of PWG/URF compressed line data starting at `pos`, returning
 * the offset just past it (the next page header). Returns undefined if the data
 * runs short or looks malformed, signalling the caller to stop. Decodes only
 * the run-length structure; pixel values are skipped, not stored.
 *
 * Each line is `ceil(width / pixelsPerGroup)` RLE color values — for 1-bit that
 * is `ceil(width / 8)` packed bytes, NOT `width` pixels — so the per-line stride
 * is sized correctly for sub-byte depths and the walk lands exactly on the next
 * page header.
 */
function skipRasterData(
  bytes: Buffer,
  pos: number,
  width: number,
  height: number,
  geom: LineGeometry
): number | undefined {
  const { groupBytes, pixelsPerGroup } = geom;
  // Degenerate geometry has no recoverable data stream.
  if (width <= 0 || height <= 0 || groupBytes <= 0 || pixelsPerGroup <= 0) {
    return undefined;
  }

  // Color values per line (1 per pixel, or ceil(width/8) for 1-bit packing).
  const groupsPerRow = Math.ceil(width / pixelsPerGroup);
  let p = pos;
  let line = 0;

  while (line < height) {
    if (p >= bytes.length) return undefined; // missing line-repeat byte
    const lineRepeat = bytes[p] + 1; // stored as count-1
    p += 1;

    // Consume exactly `groupsPerRow` color values for this (repeated) line.
    let groups = 0;
    while (groups < groupsPerRow) {
      if (p >= bytes.length) return undefined;
      const control = bytes[p];
      p += 1;
      if (control <= 127) {
        // Repeat: control+1 copies of a single following color value.
        const run = control + 1;
        p += groupBytes; // one color value
        groups += run;
      } else {
        // Literal: 257-control distinct color values, each its own bytes.
        const run = 257 - control;
        p += groupBytes * run;
        groups += run;
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
