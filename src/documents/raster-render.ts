/**
 * Raster job → PNG rendering (opt-in side effect).
 *
 * Bridges the decode layer (`raster-decode.ts`) and the PNG encoder
 * (`utils/png.ts`) to the print path: given a finished raster job, decode each
 * page and write one PNG per page to a caller-supplied path prefix. Color (RGB)
 * pages go through the truecolor encoder; grayscale pages through the grayscale
 * encoder. This is the emulator "actually printing" — a submitted raster job
 * lands as visible images on disk.
 *
 * `print-color-mode=monochrome` (PWG 5100.13) actually changes the output: when
 * `forceGrayscale` is set, a decoded *color* page is converted to grayscale
 * (Rec. 601 luma) and written through the grayscale encoder, so a color source
 * prints monochrome. `color`/`auto` leave the source untouched (color → color,
 * gray → gray). See rgbToLuma().
 *
 * `orientation-requested` (RFC 8011 §5.2.10) also changes the output: the
 * decoded page's pixel buffer is rotated before encoding — portrait (3) = no
 * rotation, landscape (4) = 90°, reverse-landscape (5) = 270°, reverse-portrait
 * (6) = 180°. 90°/270° swap the page's width and height, so a landscape job's
 * PNG comes out with its dimensions transposed. The rotation runs after any
 * grayscale luma conversion, on whichever buffer (gray or rgb) is emitted. An
 * unknown/absent orientation leaves the page unrotated. See rotatePixels() and
 * orientationToDegrees().
 *
 * `page-ranges` (RFC 8011 §5.2.7) selects which pages are emitted: only pages
 * whose 1-based index (counted across all of the job's raster documents, in
 * submission order) falls inside any requested `{lower, upper}` range are
 * written. The emitted PNG's `-p<n>` suffix carries the page's ACTUAL 1-based
 * index — `page-ranges=2-3` of a 4-page job writes `…-p2.png` and `…-p3.png`,
 * not renumbered `-p1`/`-p2` — so a page's filename always identifies the
 * source page. An out-of-bounds upper bound simply emits the pages that exist
 * (no throw). Absent/empty page-ranges renders every page.
 *
 * `number-up` (RFC 8011 §5.2.15) tiles N consecutive source pages onto ONE
 * output sheet in a grid. After decoding, filtering (`page-ranges`), and
 * rotating, the surviving pages are grouped into batches of N and each batch is
 * composited into a single sheet image (see compositeNUp / numberUpGrid). The
 * grid is cols = ceil(sqrt(N)), rows = ceil(N/cols) (so 2→1×2, 4→2×2, 6→2×3,
 * 9→3×3, 16→4×4). Each cell is the size of the FIRST page in the batch; every
 * source page in the batch is scaled (nearest-neighbor) to fit its cell, so the
 * sheet is `cellW*cols × cellH*rows`. A short final batch (fewer than N pages)
 * just leaves its trailing cells white. The emitted PNG's suffix becomes
 * `-p<sheetIndex>` with `sheetIndex` starting at 1 (sheet, not source-page,
 * numbering). `number-up` ≤ 1 (or absent) keeps the one-PNG-per-page behavior.
 *
 * Opt-in only: the print handlers invoke this just when a render target is
 * configured (RASTER_OUT env / --raster-out flag), so default runs, tests, and
 * CI write nothing. Writing never throws — a failed write is logged and the job
 * still completes normally.
 */

import { writeFileSync } from 'fs';
import { decodeRasterPages } from './raster-decode.js';
import { encodeGrayPng, encodeRgbPng } from '../utils/png.js';
import { OrientationRequested } from '../ipp/constants.js';
import type { OrientationRequestedValue } from '../ipp/constants.js';
import type { PageRange } from '../ipp/job-template.js';
import type { Document } from './document.js';
import type { Logger } from '../logging/logger.js';

/** One written page image. */
export interface RenderedPage {
  page: number; // 1-based
  path: string;
  widthPx: number;
  heightPx: number;
}

/**
 * Decode a job's raster documents and write a PNG per page as
 * `<prefix>-job<jobId>-p<n>.png`. Returns the pages written (empty when the
 * document isn't PWG/URF or nothing decoded). Never throws; per-file write
 * failures are logged and skipped.
 *
 * `forceGrayscale` honors `print-color-mode=monochrome`: a decoded color page is
 * converted to grayscale (luma) and written through the grayscale encoder, so a
 * color source prints monochrome. When false (color/auto), the page's own color
 * is preserved.
 *
 * `orientation` honors `orientation-requested`: the decoded (and possibly
 * grayscaled) page is rotated before encoding — portrait → no rotation,
 * landscape → 90°, reverse-landscape → 270°, reverse-portrait → 180° (see
 * orientationToDegrees / rotatePixels). 90°/270° swap the emitted width/height.
 * An undefined/unknown orientation leaves the page unrotated.
 *
 * `pageRanges` honors `page-ranges`: when supplied, only pages whose 1-based
 * index (across all the job's raster documents) falls in some `{lower, upper}`
 * range are written; the rest are skipped. The emitted PNG's `-p<n>` suffix is
 * the page's ACTUAL 1-based index, not a renumbering of the selected subset.
 * An undefined/empty list renders every page; an out-of-bounds range just emits
 * the pages that exist (never throws). See inSelectedRanges().
 *
 * `numberUp` honors `number-up`: when > 1, the surviving (post-filter,
 * post-rotate) pages are grouped into batches of N and each batch is composited
 * into ONE sheet PNG via compositeNUp(). The sheet's `-p<n>` suffix is the
 * 1-based SHEET index (not source-page index); a 4-page job at number-up=2 emits
 * `-p1.png` and `-p2.png`, two pages tiled each. `numberUp` ≤ 1 / undefined
 * keeps one PNG per page (the source-page index suffix above).
 */
export function renderRasterJob(
  documents: readonly Document[],
  jobId: number,
  prefix: string,
  logger?: Logger,
  forceGrayscale = false,
  orientation?: OrientationRequestedValue,
  pageRanges?: PageRange[],
  numberUp?: number
): RenderedPage[] {
  const degrees = orientationToDegrees(orientation);

  // ── Pass 1: decode + page-ranges filter + monochrome/rotate, collecting the
  // emit-ready pixel buffers (in source order). Keeping the prepared pages lets
  // the N-up tiling step group them without re-decoding.
  const prepared: PreparedPage[] = [];
  let pageNum = 0;
  for (const doc of documents) {
    const pages = decodeRasterPages(doc.bytes);
    if (!pages) continue; // not a raster document

    for (const page of pages) {
      pageNum++;
      // page-ranges filter: skip a page whose 1-based index isn't selected. The
      // counter still advances so the emitted `-p<n>` reflects the real index.
      if (!inSelectedRanges(pageNum, pageRanges)) continue;
      // monochrome mode: a color page is reduced to luma and emitted grayscale.
      const emitGray = !page.isColor || forceGrayscale;
      // Pick the source pixel buffer + samples-per-pixel for the emit path:
      // monochrome forces color→luma (1 bpp); else color stays RGB (3 bpp),
      // gray stays gray (1 bpp).
      const isRgb = page.isColor && !emitGray;
      const bytesPerPixel = isRgb ? 3 : 1;
      const sourcePixels = isRgb
        ? page.rgb
        : page.isColor
          ? rgbToLuma(page.rgb, page.widthPx * page.heightPx)
          : page.gray;

      // Rotate the page per orientation-requested before encoding. 90°/270°
      // swap width/height; 0° is a cheap pass-through.
      const rotated = rotatePixels(
        sourcePixels,
        page.widthPx,
        page.heightPx,
        bytesPerPixel,
        degrees
      );

      prepared.push({
        index: pageNum,
        width: rotated.width,
        height: rotated.height,
        bytesPerPixel,
        isRgb,
        pixels: rotated.pixels,
        dpi: page.dpi,
      });
    }
  }

  // ── Pass 2: emit. number-up ≤ 1 (or undefined) → one PNG per page (suffix =
  // source-page index). number-up > 1 → tile N pages per sheet (suffix = sheet
  // index, starting at 1).
  const nup = numberUp !== undefined && numberUp > 1 ? Math.trunc(numberUp) : 1;
  if (nup <= 1) {
    return emitPerPage(prepared, jobId, prefix, degrees, logger);
  }
  return emitNUp(prepared, nup, jobId, prefix, degrees, logger);
}

/**
 * An emit-ready page: the (already monochrome-reduced and rotated) pixel buffer
 * plus its dimensions, samples-per-pixel, color flag, source 1-based index, and
 * resolution. Produced by renderRasterJob's decode pass and consumed by the
 * per-page or N-up emit step.
 */
interface PreparedPage {
  /** 1-based source-page index (across all the job's raster documents). */
  index: number;
  width: number;
  height: number;
  /** 1 for grayscale, 3 for RGB. */
  bytesPerPixel: number;
  isRgb: boolean;
  pixels: Uint8Array;
  dpi: number;
}

/**
 * Emit one PNG per prepared page (`number-up` ≤ 1) as `…-p<sourceIndex>.png`,
 * preserving the original per-page filename + dimensions. Never throws; a failed
 * write is logged and skipped.
 */
function emitPerPage(
  prepared: readonly PreparedPage[],
  jobId: number,
  prefix: string,
  degrees: 0 | 90 | 180 | 270,
  logger?: Logger
): RenderedPage[] {
  const written: RenderedPage[] = [];
  for (const p of prepared) {
    const path = `${prefix}-job${jobId}-p${p.index}.png`;
    try {
      const png = p.isRgb
        ? encodeRgbPng(p.width, p.height, p.pixels)
        : encodeGrayPng(p.width, p.height, p.pixels);
      writeFileSync(path, png);
      written.push({
        page: p.index,
        path,
        widthPx: p.width,
        heightPx: p.height,
      });
      logger?.info('Rendered raster page to PNG', {
        path,
        width: p.width,
        height: p.height,
        dpi: p.dpi,
        color: p.isRgb,
        rotation: degrees,
      });
    } catch (err) {
      logger?.warn('Failed to write raster PNG', {
        path,
        error: (err as Error).message,
      });
    }
  }
  return written;
}

/**
 * Emit one composited sheet PNG per batch of `n` prepared pages
 * (`number-up` > 1) as `…-p<sheetIndex>.png` with `sheetIndex` starting at 1.
 * Each batch is laid out by compositeNUp() into a single sheet; a short final
 * batch leaves its trailing cells white. The `page` field of each RenderedPage
 * is the 1-based sheet index. Never throws; a failed write is logged and skipped.
 */
function emitNUp(
  prepared: readonly PreparedPage[],
  n: number,
  jobId: number,
  prefix: string,
  degrees: 0 | 90 | 180 | 270,
  logger?: Logger
): RenderedPage[] {
  const written: RenderedPage[] = [];
  const grid = numberUpGrid(n);
  let sheetIndex = 0;
  for (let start = 0; start < prepared.length; start += n) {
    sheetIndex++;
    const batch = prepared.slice(start, start + n);
    const sheet = compositeNUp(batch, grid);
    const path = `${prefix}-job${jobId}-p${sheetIndex}.png`;
    try {
      const png = sheet.isRgb
        ? encodeRgbPng(sheet.width, sheet.height, sheet.pixels)
        : encodeGrayPng(sheet.width, sheet.height, sheet.pixels);
      writeFileSync(path, png);
      written.push({
        page: sheetIndex,
        path,
        widthPx: sheet.width,
        heightPx: sheet.height,
      });
      logger?.info('Rendered N-up raster sheet to PNG', {
        path,
        width: sheet.width,
        height: sheet.height,
        numberUp: n,
        cols: grid.cols,
        rows: grid.rows,
        pages: batch.length,
        color: sheet.isRgb,
        rotation: degrees,
      });
    } catch (err) {
      logger?.warn('Failed to write N-up raster PNG', {
        path,
        error: (err as Error).message,
      });
    }
  }
  return written;
}

/** A grid layout for `number-up`: `cols` columns × `rows` rows. */
export interface NUpGrid {
  cols: number;
  rows: number;
}

/**
 * Grid layout for `number-up=n`: `cols = ceil(sqrt(n))`, `rows = ceil(n/cols)`.
 * This yields the conventional near-square arrangements — 1→1×1, 2→1×2, 4→2×2,
 * 6→2×3, 9→3×3, 16→4×4 — filling row-major (left→right, top→bottom). A value < 1
 * or non-finite clamps to 1 (a single 1×1 cell). Never throws. Pure.
 */
export function numberUpGrid(n: number): NUpGrid {
  const count = Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  return { cols, rows };
}

/** A composited N-up sheet: the combined pixel buffer plus its dimensions. */
export interface CompositedSheet {
  width: number;
  height: number;
  /** True when the sheet is RGB (3 bpp); false for grayscale (1 bpp). */
  isRgb: boolean;
  pixels: Uint8Array;
}

/**
 * Composite a batch of prepared pages into ONE sheet using `grid` (cols×rows,
 * row-major). The cell size is the FIRST page's dimensions (cellW×cellH); the
 * sheet is `cellW*cols × cellH*rows`. Every page in the batch is scaled
 * (nearest-neighbor) to fit its cell and written at the cell's pixel offset.
 *
 * Color normalization: if any page in the batch is RGB the whole sheet is RGB
 * (3 bpp) and grayscale pages are promoted to RGB (r=g=b=gray); otherwise the
 * sheet is grayscale (1 bpp). Empty cells (a short final batch, or a page with a
 * degenerate size) are left white (0xff) so an under-full sheet reads as blank
 * paper rather than black. Never throws; an empty batch yields a 0×0 sheet.
 */
export function compositeNUp(
  batch: readonly PreparedPage[],
  grid: NUpGrid
): CompositedSheet {
  const cols = Math.max(1, Math.trunc(grid.cols));
  const rows = Math.max(1, Math.trunc(grid.rows));

  // Cell = first page's dims (assume roughly uniform pages; differing pages are
  // each scaled into this cell). A degenerate/empty batch → 0×0 sheet.
  const first = batch[0];
  const cellW = first ? Math.max(0, Math.trunc(first.width)) : 0;
  const cellH = first ? Math.max(0, Math.trunc(first.height)) : 0;
  const isRgb = batch.some((p) => p.isRgb);
  const bpp = isRgb ? 3 : 1;

  const sheetW = cellW * cols;
  const sheetH = cellH * rows;
  // White background (0xff) so empty/short-batch cells read as blank paper.
  const pixels = new Uint8Array(sheetW * sheetH * bpp).fill(0xff);
  if (sheetW === 0 || sheetH === 0) {
    return { width: sheetW, height: sheetH, isRgb, pixels };
  }

  batch.forEach((page, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const offX = col * cellW;
    const offY = row * cellH;
    blitScaled(page, pixels, sheetW, offX, offY, cellW, cellH, isRgb);
  });

  return { width: sheetW, height: sheetH, isRgb, pixels };
}

/**
 * Scale one prepared page (nearest-neighbor) into a `cellW×cellH` cell of the
 * sheet at pixel offset (`offX`,`offY`), writing into the row-major `dst` buffer
 * (`sheetW` wide, `bpp` = 3 when `sheetIsRgb` else 1). A grayscale page written
 * into an RGB sheet is promoted to RGB (r=g=b). A degenerate page size leaves
 * the cell untouched (white). Bounds-safe: missing source samples read as 0.
 */
function blitScaled(
  page: PreparedPage,
  dst: Uint8Array,
  sheetW: number,
  offX: number,
  offY: number,
  cellW: number,
  cellH: number,
  sheetIsRgb: boolean
): void {
  const srcW = Math.max(0, Math.trunc(page.width));
  const srcH = Math.max(0, Math.trunc(page.height));
  if (srcW === 0 || srcH === 0 || cellW === 0 || cellH === 0) return;
  const dstBpp = sheetIsRgb ? 3 : 1;
  const srcBpp = page.bytesPerPixel;

  for (let dy = 0; dy < cellH; dy++) {
    // Nearest-neighbor source row for this destination row.
    const sy = Math.min(srcH - 1, Math.floor((dy * srcH) / cellH));
    for (let dx = 0; dx < cellW; dx++) {
      const sx = Math.min(srcW - 1, Math.floor((dx * srcW) / cellW));
      const sBase = (sy * srcW + sx) * srcBpp;
      const dBase = ((offY + dy) * sheetW + (offX + dx)) * dstBpp;
      if (sheetIsRgb) {
        if (srcBpp === 3) {
          dst[dBase] = page.pixels[sBase] ?? 0;
          dst[dBase + 1] = page.pixels[sBase + 1] ?? 0;
          dst[dBase + 2] = page.pixels[sBase + 2] ?? 0;
        } else {
          // Promote grayscale → RGB (r=g=b).
          const g = page.pixels[sBase] ?? 0;
          dst[dBase] = g;
          dst[dBase + 1] = g;
          dst[dBase + 2] = g;
        }
      } else {
        dst[dBase] = page.pixels[sBase] ?? 0;
      }
    }
  }
}

/**
 * Map an `orientation-requested` enum value to a clockwise rotation in degrees
 * applied to the decoded raster page:
 *   portrait (3)          → 0°   (no rotation)
 *   landscape (4)         → 90°  (clockwise)
 *   reverse-landscape (5) → 270° (clockwise = 90° counter-clockwise)
 *   reverse-portrait (6)  → 180°
 * Anything else (undefined / unrecognized) → 0°.
 *
 * CW vs CCW choice: we rotate *clockwise* by the mapped angle. IPP conventionally
 * treats landscape (4) as a 90° counter-clockwise rotation of the imaged page,
 * but for this emulator the only hard requirement is that landscape (4) and
 * reverse-landscape (5) differ by 180° — which 90°-CW vs 270°-CW satisfies. The
 * choice is documented here and in the README.
 */
export function orientationToDegrees(
  orientation: OrientationRequestedValue | undefined
): 0 | 90 | 180 | 270 {
  switch (orientation) {
    case OrientationRequested.LANDSCAPE:
      return 90;
    case OrientationRequested.REVERSE_LANDSCAPE:
      return 270;
    case OrientationRequested.REVERSE_PORTRAIT:
      return 180;
    case OrientationRequested.PORTRAIT:
    default:
      return 0;
  }
}

/**
 * Whether a 1-based page index is selected by `page-ranges`. An undefined or
 * empty range list means "no filter" — every page is selected. Otherwise the
 * page is selected when its index falls within any inclusive `{lower, upper}`
 * range. Pure predicate; never throws.
 */
export function inSelectedRanges(
  pageIndex: number,
  ranges: PageRange[] | undefined
): boolean {
  if (!ranges || ranges.length === 0) return true;
  return ranges.some((r) => pageIndex >= r.lower && pageIndex <= r.upper);
}

/** A rotated pixel buffer plus its (possibly transposed) dimensions. */
export interface RotatedPixels {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Rotate a row-major pixel buffer clockwise by `degrees` (0/90/180/270),
 * preserving `bytesPerPixel` samples per pixel (1 for grayscale, 3 for RGB).
 * 90° and 270° transpose the dimensions (returned `width`/`height` are swapped);
 * 0° and 180° keep them. Source pixels beyond `pixels.length` read as 0, so a
 * short buffer rotates safely (mirrors the encoders' padding contract).
 *
 * Never throws: a degenerate size or an angle outside {90,180,270} returns the
 * input as-is (a 0° pass-through), so an invalid orientation is a no-op.
 */
export function rotatePixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
  degrees: 0 | 90 | 180 | 270
): RotatedPixels {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const bpp = Math.max(1, Math.floor(bytesPerPixel));
  if (degrees === 0 || w === 0 || h === 0) {
    return { width: w, height: h, pixels };
  }

  // Read one pixel's `bpp` samples from source (x,y) into dst at sample base d.
  const out = new Uint8Array(w * h * bpp);
  const copy = (sx: number, sy: number, d: number): void => {
    const s = (sy * w + sx) * bpp;
    for (let b = 0; b < bpp; b++) out[d + b] = pixels[s + b] ?? 0;
  };

  if (degrees === 180) {
    // (x,y) → (W-1-x, H-1-y); dims unchanged.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = ((h - 1 - y) * w + (w - 1 - x)) * bpp;
        copy(x, y, d);
      }
    }
    return { width: w, height: h, pixels: out };
  }

  // 90°/270° transpose: new image is h wide, w tall.
  const newW = h;
  const newH = w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 90° CW: source (x,y) → dest (newW-1-y, x).
      // 270° CW: source (x,y) → dest (y, newH-1-x).
      const dx = degrees === 90 ? newW - 1 - y : y;
      const dy = degrees === 90 ? x : newH - 1 - x;
      copy(x, y, (dy * newW + dx) * bpp);
    }
  }
  return { width: newW, height: newH, pixels: out };
}

/**
 * Convert an RGB pixel buffer (3 bytes/pixel) to an 8-bit grayscale buffer of
 * `pixels` samples using the Rec. 601 luma weights (0.299 R, 0.587 G, 0.114 B).
 * Missing trailing channels are treated as 0. Used to force a color page to
 * grayscale for `print-color-mode=monochrome`.
 */
export function rgbToLuma(rgb: Uint8Array, pixels: number): Uint8Array {
  const gray = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b) & 0xff;
  }
  return gray;
}
