/**
 * Shared `compression` operation-attribute decoding (RFC 8011 §5.2.3).
 *
 * The job-document operations — Print-Job (0x0002), Send-Document (0x0006), and
 * Print-URI (0x0003) — may carry a `compression` operation attribute (keyword)
 * declaring that the document octets are compressed. The printer must decompress
 * them BEFORE format sniffing / rasterization so the rest of the pipeline sees
 * the original document.
 *
 * Supported keywords (mirrors `compression-supported` advertised in
 * Get-Printer-Attributes):
 *   - `none`    : the bytes are returned unchanged (the absent-attribute path is
 *                 byte-identical to this).
 *   - `gzip`    : RFC 1952 — `zlib.gunzipSync`.
 *   - `deflate` : RFC 1951 — the IPP keyword. RFC 8011 names this "deflate" but
 *                 in practice both zlib-wrapped (RFC 1950) and raw (RFC 1951)
 *                 streams appear; we try `inflateSync` first (zlib header) and
 *                 fall back to `inflateRawSync` (no header) for robustness.
 *
 * Failure handling (never throws):
 *   - An unknown/unsupported keyword → CLIENT_ERROR_COMPRESSION_NOT_SUPPORTED
 *     (0x040E, RFC 8011 §14.1.4.14).
 *   - An advertised method whose octets cannot be decompressed →
 *     CLIENT_ERROR_DOCUMENT_FORMAT_ERROR (0x040A, RFC 8011 §14.1.4.11): the
 *     printer accepted the compression keyword but the body is not a valid
 *     stream for it. (document-format-error is the closest fit — the document
 *     octets are malformed for their declared encoding; there is no dedicated
 *     "decompression failed" status, and compression-not-supported would wrongly
 *     imply the method itself is unsupported.)
 */

import zlib from 'node:zlib';
import { StatusCodes } from '../constants.js';

/** Result of decoding a (possibly compressed) document body. */
export type DecompressResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: number };

/**
 * Decode `bytes` according to the `compression` operation-attribute keyword.
 * `compression` undefined or `none` returns the input buffer unchanged (the
 * fast/identity path). Any other keyword is decompressed; failures map to the
 * appropriate IPP status. Never throws.
 */
export function decodeCompression(
  bytes: Buffer,
  compression: string | undefined
): DecompressResult {
  if (compression === undefined || compression === 'none') {
    return { ok: true, bytes };
  }

  switch (compression) {
    case 'gzip':
      try {
        return { ok: true, bytes: zlib.gunzipSync(bytes) };
      } catch {
        return {
          ok: false,
          status: StatusCodes.CLIENT_ERROR_DOCUMENT_FORMAT_ERROR,
        };
      }
    case 'deflate':
      // RFC 1951. Try the zlib-wrapped form (RFC 1950) first, then raw.
      try {
        return { ok: true, bytes: zlib.inflateSync(bytes) };
      } catch {
        try {
          return { ok: true, bytes: zlib.inflateRawSync(bytes) };
        } catch {
          return {
            ok: false,
            status: StatusCodes.CLIENT_ERROR_DOCUMENT_FORMAT_ERROR,
          };
        }
      }
    default:
      return {
        ok: false,
        status: StatusCodes.CLIENT_ERROR_COMPRESSION_NOT_SUPPORTED,
      };
  }
}
