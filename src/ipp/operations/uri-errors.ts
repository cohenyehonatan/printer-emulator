/**
 * Shared mapping from a local-only fetch failure reason to its IPP status code.
 *
 * Print-URI (0x0003) and Send-URI (0x0007) both call fetchLocalDocument() and
 * must turn its coarse failure reason into the same RFC 8011 client error, so
 * the mapping lives here once:
 *   - 'scheme'    → client-error-uri-scheme-not-supported (0x040C): the URI's
 *     scheme/host is not on the local-only allowlist (the anti-SSRF refusal).
 *   - 'access'    → client-error-document-access-error (0x0411): allowed but the
 *     document could not be retrieved (missing file / http error).
 *   - 'too-large' → client-error-request-entity-too-large (0x040D): over cap.
 */

import { StatusCodes } from '../constants.js';
import type { FetchResult } from '../../documents/uri-fetch.js';

type FetchFailReason = Extract<FetchResult, { ok: false }>['reason'];

export function fetchReasonToStatus(reason: FetchFailReason): number {
  switch (reason) {
    case 'scheme':
      return StatusCodes.CLIENT_ERROR_URI_SCHEME_NOT_SUPPORTED;
    case 'too-large':
      return StatusCodes.CLIENT_ERROR_REQUEST_ENTITY_TOO_LARGE;
    case 'access':
    default:
      return StatusCodes.CLIENT_ERROR_DOCUMENT_ACCESS_ERROR;
  }
}
