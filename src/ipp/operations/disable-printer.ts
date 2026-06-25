/**
 * Disable-Printer operation (0x0023) — RFC 3998 §3.1.2. WORKING.
 *
 * Sets `printer-is-accepting-jobs = false` (RFC 8011 §5.4.20). While disabled,
 * the printer still processes already-queued jobs (Disable-Printer does NOT
 * pause processing — that is Pause-Printer's job), but it REJECTS new job
 * submissions: Print-Job, Create-Job, Print-URI, Send-URI, and Validate-Job
 * return server-error-not-accepting-jobs (0x0507). The inverse of
 * Enable-Printer (0x0022). It does NOT change printer-state. Idempotent.
 *
 * Returns successful-ok plus a printer-attributes group carrying the now-live
 * printer-state, printer-state-reasons, and printer-is-accepting-jobs (now
 * false) so the caller observes the flip.
 *
 * Never throws. The state change is applied through the OperationContext's
 * disablePrinter() hook; bare unit-test contexts that omit it still get
 * successful-ok with current state.
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

export function handleDisablePrinter(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.disablePrinter?.();

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
