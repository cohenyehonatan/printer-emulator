/**
 * Document model + format-handling interface.
 *
 * A Document is the unit of printable data carried by a Print-Job operation:
 * the raw bytes plus the negotiated/detected MIME type and a friendly name.
 * Real rendering is out of scope (this is an emulator) — the DocumentHandler
 * interface is the seam where a rasterizer/renderer would plug in.
 */

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
