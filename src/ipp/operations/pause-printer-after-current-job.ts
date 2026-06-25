/**
 * Pause-Printer-After-Current-Job operation (0x0024) — RFC 3998 §3.3.2.
 * WORKING.
 *
 * Like Pause-Printer (0x0010), but the stop is meant to take effect only AFTER
 * the job currently being processed finishes — leaving printer-state at
 * `processing` (with the `moving-to-paused` state-reason) until that job
 * completes, then transitioning to `stopped`/`paused`.
 *
 * This emulator runs every job synchronously to completion within the single
 * operation that submits it (pending → processing → completed in one call), so
 * no job is ever mid-flight between operations: there is never a "current job"
 * still processing when this operation arrives. The "after current job" wait
 * therefore collapses to zero, and this operation behaves exactly like
 * Pause-Printer — the printer goes `stopped` immediately with state-reason
 * `paused` (the `moving-to-paused` transient is never observable). Subsequent
 * job submissions are deferred (left `pending`) and run by Resume-Printer, just
 * as with Pause-Printer. Idempotent.
 *
 * Returns successful-ok plus the now-live printer-state / printer-state-reasons.
 * Never throws. The pause is applied through the OperationContext's
 * pausePrinterAfterCurrentJob() hook (which maps onto the same pause used by
 * Pause-Printer); bare unit-test contexts that omit it still get successful-ok.
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

export function handlePausePrinterAfterCurrentJob(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.pausePrinterAfterCurrentJob?.();

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
