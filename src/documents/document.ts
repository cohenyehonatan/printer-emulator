/**
 * Document model + format-handling interface.
 *
 * A Document is the unit of printable data carried by a Print-Job operation:
 * the raw bytes plus the negotiated/detected MIME type and a friendly name.
 * Real rendering is out of scope (this is an emulator) — the DocumentHandler
 * interface is the seam where a rasterizer/renderer would plug in.
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

/** Default handler: reports byte size only, never throws. */
export class PassthroughHandler implements DocumentHandler {
  constructor(public readonly format: string = '*/*') {}

  describe(doc: Document): string {
    // TODO: real rendering/rasterization would happen here.
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
