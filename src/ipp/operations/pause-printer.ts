/**
 * Pause-Printer operation (0x0010) — RFC 8011 §4.2.7. WORKING.
 *
 * Pauses the printer: drives `printer-state` to `stopped` (5) and defers job
 * execution. While paused, the job-running paths (Print-Job after enqueue;
 * Send-Document/Close-Job/Release-Job on release) leave their jobs `pending`
 * rather than printing them; Resume-Printer (0x0011) later runs the deferred
 * jobs. Idempotent — pausing an already-paused printer is a successful no-op.
 *
 * Returns successful-ok plus a printer-attributes group carrying the now-live
 * printer-state (`stopped`) and printer-state-reasons (`paused`).
 *
 * Never throws. The pause action is applied through the OperationContext's
 * pausePrinter() hook; in contexts that don't supply it (unit tests with a bare
 * context) the operation still returns successful-ok with current state.
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

export function handlePausePrinter(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.pausePrinter?.();

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
