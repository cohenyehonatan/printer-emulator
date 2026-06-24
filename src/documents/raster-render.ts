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
 * Opt-in only: the print handlers invoke this just when a render target is
 * configured (RASTER_OUT env / --raster-out flag), so default runs, tests, and
 * CI write nothing. Writing never throws — a failed write is logged and the job
 * still completes normally.
 */

import { writeFileSync } from 'fs';
import { decodeRasterPages } from './raster-decode.js';
import { encodeGrayPng, encodeRgbPng } from '../utils/png.js';
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
 */
export function renderRasterJob(
  documents: readonly Document[],
  jobId: number,
  prefix: string,
  logger?: Logger,
  forceGrayscale = false
): RenderedPage[] {
  const written: RenderedPage[] = [];
  let pageNum = 0;

  for (const doc of documents) {
    const pages = decodeRasterPages(doc.bytes);
    if (!pages) continue; // not a raster document

    for (const page of pages) {
      pageNum++;
      const path = `${prefix}-job${jobId}-p${pageNum}.png`;
      // monochrome mode: a color page is reduced to luma and emitted grayscale.
      const emitGray = !page.isColor || forceGrayscale;
      try {
        const png =
          emitGray && page.isColor
            ? encodeGrayPng(
                page.widthPx,
                page.heightPx,
                rgbToLuma(page.rgb, page.widthPx * page.heightPx)
              )
            : page.isColor
              ? encodeRgbPng(page.widthPx, page.heightPx, page.rgb)
              : encodeGrayPng(page.widthPx, page.heightPx, page.gray);
        writeFileSync(path, png);
        written.push({
          page: pageNum,
          path,
          widthPx: page.widthPx,
          heightPx: page.heightPx,
        });
        logger?.info('Rendered raster page to PNG', {
          path,
          width: page.widthPx,
          height: page.heightPx,
          dpi: page.dpi,
          color: page.isColor && !forceGrayscale,
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
