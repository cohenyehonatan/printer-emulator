/**
 * Restart-Job operation (0x000E) — RFC 8011 §4.3.7. WORKING.
 *
 * Identifies the target job from `job-id` (or the trailing `/jobs/<id>` of a
 * `job-uri`) and restarts it: a retained job in a TERMINAL state (completed /
 * canceled / aborted) is re-queued to `pending` (JobEvent.RESTART) and then run
 * again through the same completion path Print-Job/Release-Job use (pending →
 * processing → completed), so a restarted job actually re-prints. Returns
 * successful-ok plus the job-state group.
 *
 * Per RFC 8011 §4.3.7, Restart-Job applies only to a retained completed (or
 * otherwise terminal) job: a job that is NOT terminal — `pending`,
 * `pending-held`, or `processing` — cannot be restarted and yields
 * client-error-not-possible. The paused-deferral is respected: while the
 * printer is paused the restarted job is left `pending` for Resume-Printer's
 * runPendingJobs() to run.
 *
 * Errors (never throws):
 *   - client-error-not-found (0x0406): the job-id is absent or unknown.
 *   - client-error-not-possible (0x0405): the job is not in a terminal state.
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

export function handleRestartJob(
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

  // restart() returns false only when the job is NOT terminal (pending /
  // pending-held / processing), which is not a legal Restart-Job target. When
  // the printer is paused the re-run is deferred (job left `pending`) for
  // Resume-Printer's runPendingJobs().
  const paused = ctx.isPaused?.() ?? false;
  if (!job.restart(paused)) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_POSSIBLE);
  }

  // A restarted job has run again to completion: render its raster pages when
  // an output target is configured (no-op for non-raster jobs). Skipped while
  // paused — the deferred run renders later.
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
