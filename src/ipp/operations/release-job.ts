/**
 * Release-Job operation (0x000D) — RFC 8011 §4.3.6. WORKING.
 *
 * Identifies the target job from `job-id` (or the trailing `/jobs/<id>` of a
 * `job-uri`) and releases it: a `pending-held` job is released to `pending`
 * (JobEvent.RELEASE) and then run through the same completion path
 * Close-Job/last-document uses (pending → processing → completed), so a held
 * job actually prints on release. Returns successful-ok plus the job-state
 * group.
 *
 * Releasing a job that is NOT held is treated as a successful no-op
 * (successful-ok), per RFC 8011 §4.3.6: Release-Job's purpose is to clear the
 * held state, so requesting it on an already-pending/processing job leaves the
 * job unchanged and still succeeds. Only a terminal job (completed / canceled /
 * aborted) cannot be released and yields client-error-not-possible.
 *
 * Errors (never throws):
 *   - client-error-not-found (0x0406): the job-id is absent or unknown.
 *   - client-error-not-possible (0x0405): the job is terminal.
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

export function handleReleaseJob(
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

  // release() returns false only for a terminal job (completed/canceled/
  // aborted), which cannot be released. A held job is released + run; a job
  // that is not held is a successful no-op. When the printer is paused the run
  // is deferred (job released to `pending`) for Resume-Printer's
  // runPendingJobs().
  const paused = ctx.isPaused?.() ?? false;
  if (!job.release(paused)) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_POSSIBLE);
  }

  // A released held job has run to completion: render its raster pages when an
  // output target is configured (no-op for non-raster / already-run jobs).
  // Skipped while paused — the deferred run renders later.
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
