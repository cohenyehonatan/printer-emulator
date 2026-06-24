/**
 * Resume-Printer operation (0x0011) — RFC 8011 §4.2.8. WORKING.
 *
 * Resumes a paused printer: clears the paused flag and runs any jobs that were
 * deferred while paused (those left `pending` — released, not held) through the
 * existing run-to-completion path. `printer-state` returns to `idle` (3), or
 * `processing` (4) if a job is mid-run. Idempotent — resuming an
 * already-running printer is a successful no-op.
 *
 * Returns successful-ok plus a printer-attributes group carrying the now-live
 * printer-state and printer-state-reasons (`none`).
 *
 * Never throws. The resume action is applied through the OperationContext's
 * resumePrinter() hook; in contexts that don't supply it (unit tests with a
 * bare context) the operation still returns successful-ok with current state.
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

export function handleResumePrinter(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.resumePrinter?.();

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
