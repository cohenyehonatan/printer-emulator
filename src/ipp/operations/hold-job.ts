/**
 * Hold-Job operation (0x000C) — RFC 8011 §4.3.5. WORKING.
 *
 * Identifies the target job from `job-id` (or the trailing `/jobs/<id>` of a
 * `job-uri`) and holds it: a `pending` job is driven to `pending-held` via the
 * job state machine's HOLD path; a job already `pending-held` is left held
 * (idempotent). Returns successful-ok plus the job-state group.
 *
 * `job-hold-until` (RFC 8011 §5.2.2) is honored as the optional operation
 * attribute it is: its keyword is recorded on the job (echoed by
 * Get-Job-Attributes) and decides whether the request holds or releases —
 *   - `no-hold` ⇒ Hold-Job RELEASES the hold (equivalent to Release-Job, per
 *     §4.3.5): the held job is released to pending and run (deferred while the
 *     printer is paused), then rendered when an output target is configured;
 *   - any other value (`indefinite`, a named time value, or an unrecognized
 *     keyword) ⇒ the job is held as `pending-held`;
 *   - absent ⇒ the job is held indefinitely (unchanged default).
 * The named time values (`day-time` … `third-shift`) are held until an explicit
 * Release-Job — this emulator has no wall-clock release policy and arms no timer
 * (RFC-acceptable for an emulator; see README).
 *
 * Errors (never throws):
 *   - client-error-not-found (0x0406): the job-id is absent or unknown.
 *   - client-error-not-possible (0x0405): the job is processing or in a terminal
 *     state (completed / canceled / aborted) where the hold/release is
 *     impossible.
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
  keywordAttr,
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
import { readJobHoldUntil, holdUntilHolds } from '../hold-until.js';
import type { OperationContext } from '../dispatcher.js';

export function handleHoldJob(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );
  const jobAttrs = getGroupAttributes(request, DelimiterTags.JOB_ATTRIBUTES);

  const jobId =
    firstNumber(findAttr(opAttrs, 'job-id')) ??
    jobIdFromUri(firstString(findAttr(opAttrs, 'job-uri')));

  const job = jobId !== undefined ? ctx.queue.get(jobId) : undefined;
  if (!job) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_FOUND);
  }

  // job-hold-until decides hold-vs-release. Absent ⇒ hold indefinitely
  // (unchanged default); `no-hold` ⇒ release; any other value ⇒ hold.
  const holdUntil = readJobHoldUntil(opAttrs, jobAttrs);
  const releasing = holdUntil !== undefined && !holdUntilHolds(holdUntil);
  const paused = ctx.isPaused?.() ?? false;

  // No value supplied ⇒ plain indefinite hold (unchanged default). A value
  // supplied ⇒ holdWith() holds or releases per the keyword. Both return false
  // only when the transition is impossible (processing or terminal job).
  const ok =
    holdUntil === undefined ? job.hold() : job.holdWith(holdUntil, paused);
  if (!ok) {
    return errorResponse(request, StatusCodes.CLIENT_ERROR_NOT_POSSIBLE);
  }

  // A `no-hold` Hold-Job released + ran the job (like Release-Job): render its
  // raster pages when an output target is configured, unless deferred (paused).
  if (releasing && !paused) ctx.renderRaster?.(job);

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
        ...(job.holdUntil !== undefined
          ? [keywordAttr('job-hold-until', job.holdUntil)]
          : []),
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
