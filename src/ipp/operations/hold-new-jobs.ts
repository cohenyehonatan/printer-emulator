/**
 * Hold-New-Jobs operation (0x0025) — RFC 3998 §3.3.4. WORKING.
 *
 * Puts the printer into a "hold new jobs" mode: every job submitted AFTER this
 * operation is held (`job-state = pending-held`, reason `job-hold-until-
 * specified`) instead of being processed, and the printer advertises the
 * `hold-new-jobs` printer-state-reason (RFC 8011 §5.4.12 / RFC 3998). Jobs
 * already queued are unaffected. Release-Held-New-Jobs (0x0026) leaves the mode
 * and runs the held jobs. Idempotent — calling it again while already holding
 * is a successful no-op.
 *
 * Unlike Pause-Printer, the printer-state itself is NOT driven to `stopped`;
 * Hold-New-Jobs only gates NEW jobs into the held state. It is the printer-wide
 * analogue of submitting each job with a holding `job-hold-until`.
 *
 * Returns successful-ok plus the now-live printer-state / printer-state-reasons
 * (which will include `hold-new-jobs`). Never throws. The mode change is applied
 * through the OperationContext's holdNewJobs() hook; bare unit-test contexts
 * that omit it still get successful-ok.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  enumAttr,
  keywordAttr,
} from '../attribute.js';
import {
  operationGroup,
  printerGroup,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handleHoldNewJobs(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.holdNewJobs?.();

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
      printerGroup([
        enumAttr('printer-state', ctx.printerState()),
        keywordAttr(
          'printer-state-reasons',
          ...(ctx.printerStateReasons?.() ?? ['none'])
        ),
      ]),
    ],
  };
}
