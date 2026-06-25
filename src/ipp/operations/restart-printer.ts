/**
 * Restart-Printer operation (0x0029) — RFC 3998 §3.3.7. WORKING.
 *
 * Resets the printer to a clean running state, as if it had just been turned on
 * and initialized. Concretely this emulator resets the live administrative
 * flags:
 *   - printer-is-accepting-jobs → true   (undoes Disable-Printer)
 *   - paused → false                     (undoes Pause-Printer / -After-Current)
 *   - holding-new-jobs → false           (undoes Hold-New-Jobs)
 * which drives printer-state back to `idle` (3) and printer-state-reasons to
 * `none` (the transient `paused` / `hold-new-jobs` reasons are cleared).
 *
 * It does NOT purge the job queue: any retained jobs (completed/held/pending)
 * survive the restart, mirroring RFC 3998's note that Restart-Printer does not
 * affect already-submitted jobs. Any jobs that were deferred `pending` while
 * paused are run to completion as part of clearing the paused state. Idempotent.
 *
 * Returns successful-ok plus the now-live printer-state / printer-state-reasons
 * / printer-is-accepting-jobs. Never throws. The reset is applied through the
 * OperationContext's restartPrinter() hook; bare unit-test contexts that omit it
 * still get successful-ok with current state.
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
  booleanAttr,
} from '../attribute.js';
import {
  operationGroup,
  printerGroup,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handleRestartPrinter(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.restartPrinter?.();

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
        booleanAttr(
          'printer-is-accepting-jobs',
          ctx.isAcceptingJobs?.() ?? true
        ),
      ]),
    ],
  };
}
