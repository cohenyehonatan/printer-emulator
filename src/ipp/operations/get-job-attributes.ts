/**
 * Get-Job-Attributes operation (0x0009) — RFC 8011 §4.3.4. WORKING.
 *
 * Identifies the target job from the `job-id` operation attribute (or, as a
 * fallback, the trailing `/jobs/<id>` of a `job-uri`), looks it up in the job
 * queue, and returns successful-ok plus a job-attributes group describing it
 * (job-id, job-uri, job-state, job-state-reasons, job-name, originating user,
 * timestamps, impressions-completed). Returns client-error-not-found when the
 * job-id is absent or unknown. Never throws.
 */

import {
  StatusCodes,
  JobStates,
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
  nameWithoutLangAttr,
  firstNumber,
  firstString,
  findAttr,
  type IppAttribute,
} from '../attribute.js';
import {
  operationGroup,
  jobGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import { applyRequestedAttributes } from '../requested-attributes.js';
import type { Job } from '../../printer/job.js';
import type { OperationContext } from '../dispatcher.js';

export function handleGetJobAttributes(
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
      jobGroup(applyRequestedAttributes(request, buildJobAttributes(job, ctx))),
    ],
  };
}

/** Build the job-attributes group for a single Job. */
function buildJobAttributes(job: Job, ctx: OperationContext): IppAttribute[] {
  const completed = job.stateValue === JobStates.COMPLETED;
  // RFC 8011 time-at-* are integers (seconds, here epoch seconds for the demo).
  const createdSecs = Math.floor(job.createdAt.getTime() / 1000);

  return [
    integerAttr('job-id', job.id),
    uriAttr('job-uri', `${ctx.identity.uri}/jobs/${job.id}`),
    uriAttr('job-printer-uri', ctx.identity.uri),
    enumAttr('job-state', job.stateValue),
    keywordAttr('job-state-reasons', completed ? 'job-completed-successfully' : 'none'),
    nameWithoutLangAttr('job-name', job.jobName),
    nameWithoutLangAttr('job-originating-user-name', job.requestingUserName),
    integerAttr('time-at-creation', createdSecs),
    integerAttr('time-at-completed', completed ? createdSecs : 0),
    integerAttr('job-impressions', job.impressions),
    integerAttr('job-impressions-completed', completed ? job.impressions : 0),
  ];
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
