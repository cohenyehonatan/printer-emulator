/**
 * Cancel-Job operation (0x0008) — RFC 8011 §4.3.3. WORKING.
 *
 * Looks up the job-id operation attribute and attempts a CANCEL transition via
 * the job state machine. Returns:
 *   - client-error-not-found (0x0406) when the job-id is absent or unknown;
 *   - client-error-not-possible (0x0405) when the job is already in a terminal
 *     state (completed / canceled / aborted) and so cannot be canceled;
 *   - successful-ok (0x0000) after transitioning a cancelable job to canceled.
 * Never throws.
 */

import {
  StatusCodes,
  DEFAULT_CHARSET,
  DEFAULT_NATURAL_LANGUAGE,
  DelimiterTags,
} from '../constants.js';
import {
  charsetAttr,
  naturalLanguageAttr,
  firstNumber,
  findAttr,
} from '../attribute.js';
import {
  operationGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handleCancelJob(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );
  const jobId = firstNumber(findAttr(opAttrs, 'job-id'));

  let status: number = StatusCodes.CLIENT_ERROR_NOT_FOUND;
  if (jobId !== undefined) {
    const job = ctx.queue.get(jobId);
    if (job) {
      // cancel() returns false when no CANCEL transition exists from the
      // current state — i.e. the job is already completed/canceled/aborted.
      status = job.cancel()
        ? StatusCodes.SUCCESSFUL_OK
        : StatusCodes.CLIENT_ERROR_NOT_POSSIBLE;
    }
  }

  return {
    versionMajor: request.versionMajor,
    versionMinor: request.versionMinor,
    operationIdOrStatusCode: status,
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
