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
 */
export function renderRasterJob(
  documents: readonly Document[],
  jobId: number,
  prefix: string,
  logger?: Logger
): RenderedPage[] {
  const written: RenderedPage[] = [];
  let pageNum = 0;

  for (const doc of documents) {
    const pages = decodeRasterPages(doc.bytes);
    if (!pages) continue; // not a raster document

    for (const page of pages) {
      pageNum++;
      const path = `${prefix}-job${jobId}-p${pageNum}.png`;
      try {
        const png = page.isColor
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
          color: page.isColor,
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
