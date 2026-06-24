/**
 * Cancel-Job operation (0x0008) — RFC 8011 §4.3.3. STUB.
 *
 * Looks up the job-id operation attribute and attempts a CANCEL transition.
 * Returns successful-ok when the job is found (whether or not it was in a
 * cancelable state — a fuller implementation would distinguish
 * client-error-not-possible), and client-error-not-found otherwise. Never
 * throws.
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
      // TODO: distinguish already-completed (client-error-not-possible).
      job.cancel();
      status = StatusCodes.SUCCESSFUL_OK;
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
