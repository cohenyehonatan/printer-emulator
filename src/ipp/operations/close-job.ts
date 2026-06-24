/**
 * Close-Job operation (0x003B) — PWG 5100.11 §4.3. WORKING.
 *
 * Closes an open multi-document job created by Create-Job — equivalent to a
 * final Send-Document with `last-document=true` and no further document data.
 * Identifies the target job from `job-id` (or the trailing `/jobs/<id>` of a
 * `job-uri`).
 *
 * On close:
 *   - if any documents were sent, the held job is released and the emulated
 *     print runs (pending → processing → completed);
 *   - if no documents were sent, the empty held job is aborted (job-state
 *     aborted) — there is nothing to print.
 *
 * Errors (never throws):
 *   - client-error-not-found (0x0406): the job-id is absent or unknown.
 *   - client-error-not-possible (0x0405): the job is not open (already closed,
 *     a single-shot Print-Job, or terminal).
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
  integerAttr,
  enumAttr,
  uriAttr,
  firstString,
  firstNumber,
  findAttr,
} from '../attribute.js';
import {
  operationGroup,
  jobGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handleCloseJob(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );

  const jobId =
    firstNumber(findAttr(opAttrs, 'job-id')) ??
    jobIdFromUri(firstString(findAttr(opAttrs, 'job-uri')));

  const job = jobId !== undefined ? ctx.queue.get(jobId) : undefined;
  if (!job) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_FOUND);
  }

  // close() returns false when the job was not open (single-shot, already
  // closed, or terminal) — Close-Job is not possible in that case. When the
  // printer is paused the close defers the run (job released to `pending` but
  // not printed) for Resume-Printer's runPendingJobs().
  const paused = ctx.isPaused?.() ?? false;
  if (!job.close(paused)) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_POSSIBLE);
  }

  // The closed job has run to completion: render its raster pages when an
  // output target is configured (no-op for empty/non-raster jobs). Skipped
  // while paused — the deferred run renders later.
  if (!paused) ctx.renderRaster?.(job);

  const jobUri = `${ctx.identity.uri}/jobs/${job.id}`;

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
      jobGroup([
        uriAttr('job-uri', jobUri),
        integerAttr('job-id', job.id),
        enumAttr('job-state', job.stateValue),
      ]),
    ],
  };
}

/** Extract the numeric job-id from the trailing `/jobs/<id>` of a job-uri. */
function jobIdFromUri(uri: string | undefined): number | undefined {
  if (!uri) return undefined;
  const match = /\/jobs\/(\d+)\/?$/.exec(uri);
  return match ? Number(match[1]) : undefined;
}

/** Build an operation-only error response (no job group). */
function errorResponse(request: IppRequest, status: number): IppResponse {
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
