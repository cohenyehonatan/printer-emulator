/**
 * Raster job → PNG rendering (opt-in side effect).
 *
 * Bridges the decode layer (`raster-decode.ts`) and the PNG encoder
 * (`utils/png.ts`) to the print path: given a finished raster job, decode each
 * page and write one PNG per page to a caller-supplied path prefix. Color (RGB)
 * pages go through the truecolor encoder; grayscale pages through the grayscale
 * encoder. 16-bit grayscale and 48-bit RGB pages keep their full precision and
 * route to the 16-bit encoders (`encodeGray16Png` / `encodeRgb16Png`), emitting
 * true bit-depth-16 PNGs. This is the emulator "actually printing" — a submitted
 * raster job lands as visible images on disk.
 *
 * `print-color-mode=monochrome` (PWG 5100.13) actually changes the output: when
 * `forceGrayscale` is set, a decoded *color* page is converted to grayscale
 * (Rec. 601 luma) and written through the grayscale encoder, so a color source
 * prints monochrome. `color`/`auto` leave the source untouched (color → color,
 * gray → gray). See rgbToLuma() / rgb16ToLuma(). A 16-bit color page forced to
 * monochrome stays 16-bit: luma is computed at full precision and emitted as a
 * 16-bit gray PNG (no downgrade to 8-bit).
 *
 * Bit depth (RFC-agnostic, sourced from the raster header): 16-bit grayscale and
 * 48-bit RGB pages carry full 16-bit precision end to end. The rotate/composite
 * helpers are byte-generic (they operate on the pixel buffer + bytesPerPixel), so
 * a 16-bit page is carried as big-endian sample bytes with bytesPerPixel 2
 * (gray16) or 6 (rgb16) — orientation and page-ranges work on 16-bit pages
 * unchanged, and the per-page emit step routes a 16-bit page to encodeGray16Png /
 * encodeRgb16Png. One documented downgrade: `number-up` tiling DOWNSAMPLES 16-bit
 * pages to 8-bit (high byte) before compositing, so N-up sheets are always 8-bit
 * (the tiling scales/promotes heterogeneous pages into one sheet; keeping it
 * 8-bit avoids a depth cross-product in the nearest-neighbor blit). 16-bit
 * fidelity is therefore preserved on the one-PNG-per-page path, not in N-up.
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
 * `print-quality` (RFC 8011 §5.2.13) also changes the output by mapping the
 * requested quality to an output-resolution scale factor: draft (3) → 0.5×
 * (the page is nearest-neighbor DOWNSCALED to half resolution, so its PNG comes
 * out with roughly halved dimensions), normal (4) → 1.0× (full resolution, a
 * no-op), high (5) → 1.0× (full resolution). high === normal because the
 * emulator can't synthesize detail it never received — there is no honest way to
 * make "high" sharper than the source raster, so it is full-res like normal (the
 * mapping is documented here and in the README). The downscale is applied PER
 * SOURCE PAGE, after monochrome/luma reduction and AFTER orientation rotation
 * (rotate then downscale), and BEFORE number-up tiling — so each tile is already
 * downscaled when it is composited. The byte-generic helper preserves
 * bytesPerPixel (1/3 for 8-bit, 2/6 for 16-bit big-endian), so draft composes
 * with monochrome, orientation, number-up, and 16-bit pages. A factor of 1.0 is
 * a no-op (normal/high are byte-identical to a job with no print-quality), and
 * an unknown/absent print-quality is treated as normal (1.0). See
 * printQualityToFactor() and downscalePixels().
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
import {
  encodeGrayPng,
  encodeRgbPng,
  encodeGray16Png,
  encodeRgb16Png,
} from '../utils/png.js';
import { OrientationRequested, PrintQuality } from '../ipp/constants.js';
import type {
  OrientationRequestedValue,
  PrintQualityValue,
} from '../ipp/constants.js';
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
 *
 * `printQuality` honors `print-quality`: the resolved quality maps to an
 * output-resolution scale factor (draft → 0.5×, normal/high → 1.0×) and each
 * source page's pixel buffer + dims are nearest-neighbor DOWNSCALED by that
 * factor — applied after orientation rotation and before number-up tiling. A
 * factor of 1.0 (normal/high, or an unknown/absent value) leaves pages
 * unchanged, so a job with no print-quality renders byte-identically to before.
 * See printQualityToFactor() / downscalePixels().
 */
export function renderRasterJob(
  documents: readonly Document[],
  jobId: number,
  prefix: string,
  logger?: Logger,
  forceGrayscale = false,
  orientation?: OrientationRequestedValue,
  pageRanges?: PageRange[],
  numberUp?: number,
  printQuality?: PrintQualityValue
): RenderedPage[] {
  const degrees = orientationToDegrees(orientation);
  const qualityFactor = printQualityToFactor(printQuality);

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
      const isRgb = page.isColor && !emitGray;
      const is16 = page.bitDepth === 16;
      const pixelCount = page.widthPx * page.heightPx;

      // Resolve the emit-path pixel buffer as big-endian sample BYTES so the
      // byte-generic rotate/composite helpers handle both depths uniformly:
      //   8-bit:  1 byte/sample → bytesPerPixel 1 (gray) / 3 (rgb).
      //   16-bit: 2 bytes/sample (big-endian) → bytesPerPixel 2 (gray) / 6 (rgb).
      // monochrome forces color→luma (1 sample/pixel) at the page's own depth.
      const bytesPerSample = is16 ? 2 : 1;
      const samplesPerPixel = isRgb ? 3 : 1;
      const bytesPerPixel = samplesPerPixel * bytesPerSample;

      let sourcePixels: Uint8Array;
      if (is16) {
        const samples = isRgb
          ? page.rgb16
          : page.isColor
            ? rgb16ToLuma(page.rgb16, pixelCount)
            : page.gray16;
        sourcePixels = u16ToBigEndianBytes(samples);
      } else {
        sourcePixels = isRgb
          ? page.rgb
          : page.isColor
            ? rgbToLuma(page.rgb, pixelCount)
            : page.gray;
      }

      // Rotate the page per orientation-requested before encoding. 90°/270°
      // swap width/height; 0° is a cheap pass-through.
      const rotated = rotatePixels(
        sourcePixels,
        page.widthPx,
        page.heightPx,
        bytesPerPixel,
        degrees
      );

      // Downscale per print-quality (draft → 0.5×; normal/high → 1.0× = no-op).
      // Applied after rotation so the order is rotate→downscale; a factor of 1.0
      // returns the buffer unchanged. The byte-generic scaler preserves
      // bytesPerPixel (incl. 16-bit's 2/6), so depth/color survive the shrink.
      const scaled = downscalePixels(
        rotated.pixels,
        rotated.width,
        rotated.height,
        bytesPerPixel,
        qualityFactor
      );

      prepared.push({
        index: pageNum,
        width: scaled.width,
        height: scaled.height,
        bytesPerPixel,
        isRgb,
        bitDepth: page.bitDepth,
        pixels: scaled.pixels,
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
  /**
   * Bytes per pixel in `pixels`: 1 (gray8), 3 (rgb8), 2 (gray16), 6 (rgb16).
   * For 16-bit pages the samples are stored big-endian (2 bytes/sample).
   */
  bytesPerPixel: number;
  isRgb: boolean;
  /** Per-sample bit depth (8 or 16); selects the 8- vs 16-bit PNG encoder. */
  bitDepth: 8 | 16;
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
      const png = encodePreparedPng(p.width, p.height, p.isRgb, p.bitDepth, p.pixels);
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
    // N-up sheets are always 8-bit: downsample any 16-bit page (high byte)
    // before compositing so the nearest-neighbor blit never crosses depths.
    const batch = prepared.slice(start, start + n).map(downsampleTo8Bit);
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
 * Map a `print-quality` enum value to an output-resolution scale factor:
 *   draft (3)  → 0.5  (downscale to half resolution)
 *   normal (4) → 1.0  (full resolution, no-op)
 *   high (5)   → 1.0  (full resolution, no-op)
 * Anything else (undefined / unrecognized) → 1.0 (treated as normal).
 *
 * high === normal (both 1.0) on purpose: the emulator can't synthesize detail
 * the source raster never carried, so there is no honest way to render "high"
 * sharper than "normal" — it stays full-resolution. Documented here and in the
 * README. Pure; never throws.
 */
export function printQualityToFactor(
  quality: PrintQualityValue | undefined
): number {
  switch (quality) {
    case PrintQuality.DRAFT:
      return 0.5;
    case PrintQuality.NORMAL:
    case PrintQuality.HIGH:
    default:
      return 1.0;
  }
}

/** A downscaled pixel buffer plus its (reduced) dimensions. */
export interface DownscaledPixels {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Downscale a row-major pixel buffer by `factor` using nearest-neighbor
 * sampling, preserving `bytesPerPixel` samples per pixel (1 gray8 / 3 rgb8 /
 * 2 gray16 / 6 rgb16, big-endian sample bytes for the 16-bit forms). The new
 * dimensions are `floor(width*factor) × floor(height*factor)` (each floored to
 * at least 1 when the source is non-empty, so a tiny page never shrinks to 0).
 * Source samples beyond `pixels.length` read as 0 (mirrors rotatePixels' padding
 * contract).
 *
 * A `factor` ≥ 1 (or non-finite/≤ 0) is a no-op: the input buffer + dims are
 * returned unchanged (so `print-quality=normal`/`high` leaves the page exactly
 * as today). A degenerate source dimension is likewise returned as-is. Never
 * throws. Pure.
 */
export function downscalePixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
  factor: number
): DownscaledPixels {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const bpp = Math.max(1, Math.floor(bytesPerPixel));
  // No-op for a non-shrinking factor or a degenerate page (return as-is).
  if (!Number.isFinite(factor) || factor >= 1 || factor <= 0 || w === 0 || h === 0) {
    return { width: w, height: h, pixels };
  }

  const newW = Math.max(1, Math.floor(w * factor));
  const newH = Math.max(1, Math.floor(h * factor));
  const out = new Uint8Array(newW * newH * bpp);
  for (let dy = 0; dy < newH; dy++) {
    // Nearest-neighbor source row/col for this destination pixel.
    const sy = Math.min(h - 1, Math.floor((dy * h) / newH));
    for (let dx = 0; dx < newW; dx++) {
      const sx = Math.min(w - 1, Math.floor((dx * w) / newW));
      const sBase = (sy * w + sx) * bpp;
      const dBase = (dy * newW + dx) * bpp;
      for (let b = 0; b < bpp; b++) out[dBase + b] = pixels[sBase + b] ?? 0;
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

/**
 * Convert a 16-bit RGB sample buffer (3 uint16/pixel) to a 16-bit grayscale
 * buffer of `pixels` samples using the Rec. 601 luma weights (0.299 R, 0.587 G,
 * 0.114 B), clamped to the 0..65535 range. Missing trailing channels are treated
 * as 0. Used to force a 16-bit color page to grayscale for
 * `print-color-mode=monochrome` without dropping to 8-bit precision.
 */
export function rgb16ToLuma(rgb: Uint16Array, pixels: number): Uint16Array {
  const gray = new Uint16Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    gray[i] = v < 0 ? 0 : v > 0xffff ? 0xffff : v;
  }
  return gray;
}

/**
 * Pack a uint16 sample buffer into big-endian bytes (high byte first) — the form
 * the byte-generic rotate/composite pipeline and the 16-bit PNG encoders both
 * consume. The result is twice the input length.
 */
function u16ToBigEndianBytes(samples: Uint16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    out[i * 2] = (samples[i] >>> 8) & 0xff;
    out[i * 2 + 1] = samples[i] & 0xff;
  }
  return out;
}

/**
 * Reassemble big-endian sample bytes (high byte first) back into uint16 samples
 * — the inverse of u16ToBigEndianBytes, used at encode time to hand the 16-bit
 * PNG encoders their `Uint16Array`. A trailing odd byte (never produced here) is
 * ignored.
 */
function bigEndianBytesToU16(bytes: Uint8Array): Uint16Array {
  const out = new Uint16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = ((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0);
  }
  return out;
}

/**
 * Encode a prepared page's pixel buffer to a PNG, routing by color + bit depth:
 * 8-bit → encodeGrayPng / encodeRgbPng (1/3 bytes/pixel); 16-bit → reassemble the
 * big-endian sample bytes into uint16 and use encodeGray16Png / encodeRgb16Png.
 */
function encodePreparedPng(
  width: number,
  height: number,
  isRgb: boolean,
  bitDepth: 8 | 16,
  pixels: Uint8Array
): Buffer {
  if (bitDepth === 16) {
    const samples = bigEndianBytesToU16(pixels);
    return isRgb
      ? encodeRgb16Png(width, height, samples)
      : encodeGray16Png(width, height, samples);
  }
  return isRgb
    ? encodeRgbPng(width, height, pixels)
    : encodeGrayPng(width, height, pixels);
}

/**
 * Downsample a prepared page to 8-bit (high byte of each big-endian 16-bit
 * sample), returning a new PreparedPage with bytesPerPixel 1 (gray) / 3 (rgb)
 * and bitDepth 8. An already-8-bit page is returned unchanged. Used by the N-up
 * path so heterogeneous-depth batches composite at a single (8-bit) depth.
 */
function downsampleTo8Bit(page: PreparedPage): PreparedPage {
  if (page.bitDepth === 8) return page;
  const samples = page.pixels.length >> 1;
  const out = new Uint8Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = page.pixels[i * 2] ?? 0; // high byte
  }
  return {
    ...page,
    bytesPerPixel: page.isRgb ? 3 : 1,
    bitDepth: 8,
    pixels: out,
  };
}
