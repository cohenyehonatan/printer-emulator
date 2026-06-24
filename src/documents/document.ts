/**
 * Document model + format-handling interface.
 *
 * A Document is the unit of printable data carried by a Print-Job operation:
 * the raw bytes plus the negotiated/detected MIME type and a friendly name.
 * The DocumentHandler interface is the seam for format-specific processing;
 * actual rasterization to per-page PNGs happens on the print path (opt-in via
 * RASTER_OUT): PWG/URF raster is decoded in-process (`raster-render.ts`), and
 * PDF/PostScript is rendered through the system Ghostscript binary
 * (`gs-raster.ts`), the same approach CUPS uses in its filter chain. Formats
 * with no rasterizer stay passthrough (byte-size reporting only).
 */

import { parseRasterInfo, type RasterDocumentInfo } from './raster-info.js';

export interface Document {
  /** document-name from the operation attributes, if supplied. */
  name?: string;
  /** Negotiated or detected MIME type (e.g. application/pdf). */
  format: string;
  /** Raw document bytes. */
  bytes: Buffer;
}

/**
 * Seam for format-specific processing. The emulator ships a no-op handler;
 * a real device would render/raster here.
 */
export interface DocumentHandler {
  readonly format: string;
  /** Returns a short human-readable description of the document. */
  describe(doc: Document): string;
}

/**
 * Default handler for formats with no rasterizer (raw / octet-stream, JPEG,
 * PCL, …): reports byte size only. Rasterizable formats are handled off this
 * seam on the print path — PWG/URF in `raster-render.ts`, PDF/PostScript via
 * Ghostscript in `gs-raster.ts`. Never throws.
 */
export class PassthroughHandler implements DocumentHandler {
  constructor(public readonly format: string = '*/*') {}

  describe(doc: Document): string {
    return `${doc.format} (${doc.bytes.length} bytes)`;
  }
}

/**
 * Handler for raster page-description languages (PWG Raster, Apple URF). Still
 * does not render pixels — it parses only the fixed-layout page headers to
 * surface page count + per-page geometry, falling back to byte-size reporting
 * when the bytes don't parse. Never throws.
 */
export class RasterDocumentHandler implements DocumentHandler {
  constructor(public readonly format: string = 'image/pwg-raster') {}

  /** Parse the page headers; undefined when the bytes aren't PWG/URF. */
  info(doc: Document): RasterDocumentInfo | undefined {
    return parseRasterInfo(doc.bytes);
  }

  /** Parsed page count, or 0 when the document didn't parse as raster. */
  pageCount(doc: Document): number {
    return this.info(doc)?.pages.length ?? 0;
  }

  describe(doc: Document): string {
    const parsed = this.info(doc);
    if (!parsed) return `${doc.format} (${doc.bytes.length} bytes)`;
    return `${doc.format} (${parsed.pages.length} page(s), ${doc.bytes.length} bytes)`;
  }
}
