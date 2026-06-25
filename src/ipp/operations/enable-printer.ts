/**
 * Enable-Printer operation (0x0022) — RFC 3998 §3.1.1. WORKING.
 *
 * Sets `printer-is-accepting-jobs = true` (RFC 8011 §5.4.20) so the printer
 * once again accepts new Print-Job/Create-Job submissions. The inverse of
 * Disable-Printer (0x0023). It does NOT touch printer-state — a paused printer
 * stays paused; it only governs whether new jobs are admitted. Idempotent.
 *
 * Returns successful-ok plus a printer-attributes group carrying the now-live
 * printer-state, printer-state-reasons, and printer-is-accepting-jobs so the
 * caller observes the flip without a follow-up Get-Printer-Attributes.
 *
 * Never throws. The state change is applied through the OperationContext's
 * enablePrinter() hook; in bare unit-test contexts that omit it the operation
 * still returns successful-ok with current state.
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

export function handleEnablePrinter(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.enablePrinter?.();

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
