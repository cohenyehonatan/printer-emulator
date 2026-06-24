/**
 * Purge-Jobs operation (0x0012) — RFC 8011 §4.2.9. WORKING.
 *
 * Removes ALL jobs from the printer's queue — including retained terminal jobs
 * (completed / canceled / aborted), not just the active ones. This is the
 * administrative "empty the queue entirely" operation: after a Purge-Jobs a
 * Get-Jobs (with any `which-jobs` filter) returns nothing. Always returns
 * successful-ok. Never throws.
 *
 * Auth caveat: a real IPP implementation gates Purge-Jobs behind operation
 * policy / operator authorization (RFC 8011 §4.2.9 — it is an administrative
 * operation). This emulator has no auth layer, so it simply performs the purge
 * unconditionally.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
} from '../constants.js';
import { charsetAttr, naturalLanguageAttr } from '../attribute.js';
import {
  operationGroup,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handlePurgeJobs(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  // Empty the queue entirely — terminal (retained) jobs included.
  ctx.queue.clear();

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: StatusCodes.SUCCESSFUL_OK,
    requestId: request.requestId,
    groups: [
      operationGroup([
        charsetAttr('attributes-charset', DEFAULT_CHARSET),
        naturalLanguageAttr(
          'attributes-natural-language',
          DEFAULT_NATURAL_LANGUAGE
        ),
      ]),
    ],
  };
}
