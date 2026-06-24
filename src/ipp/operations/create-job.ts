/**
 * Create-Job operation (0x0005) — RFC 8011 §4.2.4. WORKING.
 *
 * Creates a Job with NO document data yet, returning successful-ok plus a
 * job-attributes group (job-uri, job-id, job-state). The job is allocated
 * "open" and starts life in `pending-held` (job-state 4): per RFC 8011 a job
 * created by Create-Job waits for its documents, which arrive via one or more
 * Send-Document operations and are released by `last-document`/Close-Job. The
 * job is enqueued so Get-Jobs/Get-Job-Attributes can see it immediately.
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
  integerAttr,
  enumAttr,
  uriAttr,
  keywordAttr,
  firstString,
  findAttr,
} from '../attribute.js';
import { readJobHoldUntil } from '../hold-until.js';
import {
  operationGroup,
  jobGroup,
  getGroupAttributes,
  type IppRequest,
  type IppResponse,
} from '../message.js';
import type { OperationContext } from '../dispatcher.js';

export function handleCreateJob(
  request: IppRequest,
  ctx: OperationContext
): IppResponse {
  const opAttrs = getGroupAttributes(
    request,
    DelimiterTags.OPERATION_ATTRIBUTES
  );
  const jobAttrs = getGroupAttributes(request, DelimiterTags.JOB_ATTRIBUTES);

  // A Create-Job job is always `pending-held` until its documents arrive, so
  // `job-hold-until` doesn't change the initial state here; it is recorded so
  // Get-Job-Attributes echoes it. (last-document / Close-Job releases the job
  // as today; an explicit Hold-Job can re-hold it with a value.)
  const holdUntil = readJobHoldUntil(opAttrs, jobAttrs);

  // Allocate an open job with no documents yet (pending-held).
  const job = ctx.queue.enqueue({
    printerUri: ctx.identity.uri,
    jobName: firstString(findAttr(opAttrs, 'job-name')),
    requestingUserName: firstString(findAttr(opAttrs, 'requesting-user-name')),
    open: true,
    holdUntil,
  });

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
