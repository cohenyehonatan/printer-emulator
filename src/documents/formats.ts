/**
 * Document format sniffing.
 *
 * Maps a leading magic-byte signature to an IPP document-format MIME type.
 * Covers the formats an IPP Everywhere printer is expected to advertise:
 * PDF, PostScript, PWG Raster, Apple URF, and PCL. Falls back to the IPP
 * "application/octet-stream" auto-sense type when nothing matches.
 */

export const Mime = {
  PDF: 'application/pdf',
  POSTSCRIPT: 'application/postscript',
  PWG_RASTER: 'image/pwg-raster',
  URF: 'image/urf',
  PCL: 'application/vnd.hp-pcl',
  OCTET_STREAM: 'application/octet-stream',
} as const;

export type DocumentMime = (typeof Mime)[keyof typeof Mime];

const ESC = 0x1b;

/**
 * Detect the document format from its leading bytes.
 * Returns an IPP document-format MIME type; never throws.
 */
export function detectFormat(bytes: Buffer): DocumentMime {
  if (bytes.length === 0) return Mime.OCTET_STREAM;

  // PDF: "%PDF"
  if (startsWithAscii(bytes, '%PDF')) return Mime.PDF;

  // PostScript: "%!"
  if (startsWithAscii(bytes, '%!')) return Mime.POSTSCRIPT;

  // PWG Raster: sync word "RaS2" (also RaS1 big-endian / 2SaR little-endian)
  if (
    startsWithAscii(bytes, 'RaS2') ||
    startsWithAscii(bytes, 'RaS1') ||
    startsWithAscii(bytes, '2SaR') ||
    startsWithAscii(bytes, '1SaR')
  ) {
    return Mime.PWG_RASTER;
  }

  // Apple URF: "UNIRAST\0"
  if (startsWithAscii(bytes, 'UNIRAST')) return Mime.URF;

  // PCL: ESC 'E' (printer reset) is the canonical PCL stream prefix.
  if (bytes.length >= 2 && bytes[0] === ESC && bytes[1] === 0x45 /* 'E' */) {
    return Mime.PCL;
  }

  return Mime.OCTET_STREAM;
}

function startsWithAscii(bytes: Buffer, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}
