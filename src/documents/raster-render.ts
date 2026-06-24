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
 */
export function renderRasterJob(
  documents: readonly Document[],
  jobId: number,
  prefix: string,
  logger?: Logger,
  forceGrayscale = false,
  orientation?: OrientationRequestedValue
): RenderedPage[] {
  const written: RenderedPage[] = [];
  const degrees = orientationToDegrees(orientation);
  let pageNum = 0;

  for (const doc of documents) {
    const pages = decodeRasterPages(doc.bytes);
    if (!pages) continue; // not a raster document

    for (const page of pages) {
      pageNum++;
      const path = `${prefix}-job${jobId}-p${pageNum}.png`;
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

      try {
        const png = isRgb
          ? encodeRgbPng(rotated.width, rotated.height, rotated.pixels)
          : encodeGrayPng(rotated.width, rotated.height, rotated.pixels);
        writeFileSync(path, png);
        written.push({
          page: pageNum,
          path,
          widthPx: rotated.width,
          heightPx: rotated.height,
        });
        logger?.info('Rendered raster page to PNG', {
          path,
          width: rotated.width,
          height: rotated.height,
          dpi: page.dpi,
          color: isRgb,
          rotation: degrees,
        });
      } catch (err) {
        logger?.warn('Failed to write raster PNG', {
          path,
          error: (err as Error).message,
        });
      }
    }
  }

  return written;
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
