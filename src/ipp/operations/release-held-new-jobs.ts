/**
 * Release-Held-New-Jobs operation (0x0026) — RFC 3998 §3.3.5. WORKING.
 *
 * Leaves the "hold new jobs" mode entered by Hold-New-Jobs (0x0025): clears the
 * `hold-new-jobs` printer-state-reason and RELEASES the jobs that were held by
 * that mode (those `pending-held` purely because they arrived while holding) —
 * running each to completion through the existing pending → processing →
 * completed path. Jobs held for other reasons (an explicit `job-hold-until`, or
 * an open Create-Job awaiting documents) are left untouched. Idempotent — when
 * the printer is not holding new jobs this is a successful no-op.
 *
 * Returns successful-ok plus the now-live printer-state / printer-state-reasons
 * (the `hold-new-jobs` reason is gone). Never throws. The mode change + release
 * is applied through the OperationContext's releaseHeldNewJobs() hook; bare
 * unit-test contexts that omit it still get successful-ok.
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

export function handleReleaseHeldNewJobs(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  ctx.releaseHeldNewJobs?.();

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
